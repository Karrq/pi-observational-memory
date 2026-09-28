import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { RecallEmbeddingsConfig } from "./config.js";
import { safeDebugLogSessionId } from "./debug-log.js";
import { buildSearchCorpus, type Entry, type SearchDocument } from "./session-ledger/index.js";

export const EMBEDDINGS_RELATIVE_DIR = join("observational-memory", "embeddings");
export const MODELS_RELATIVE_DIR = join("observational-memory", "models");

const BATCH_SIZE = 16;
/** Persist partial progress so an exit mid-index keeps most of the work. */
const SAVE_EVERY_BATCHES = 20;

export type Embedder = { embed(texts: string[]): Promise<Float32Array[]> };
export type EmbedderLoader = (config: RecallEmbeddingsConfig) => Promise<Embedder>;

export const loadTransformersEmbedder: EmbedderLoader = async (config) => {
	const transformers = await import("@huggingface/transformers");
	transformers.env.cacheDir = join(getAgentDir(), MODELS_RELATIVE_DIR);
	const extract = await transformers.pipeline("feature-extraction", config.model, { dtype: "q8" });
	return {
		async embed(texts) {
			const output = await extract(texts, { pooling: config.pooling, normalize: true });
			const [count, dims] = output.dims as [number, number];
			const data = output.data as Float32Array;
			return Array.from({ length: count }, (_, i) => data.slice(i * dims, (i + 1) * dims));
		},
	};
};

export function docKey(doc: SearchDocument): string {
	return doc.kind === "entry" ? `entry:${doc.id}:${doc.chunk}` : `${doc.kind}:${doc.id}`;
}

/** Normalized vectors keyed by document, persisted as a JSON header plus a flat Float32 file. */
class VectorStore {
	private readonly index = new Map<string, number>();
	private keys: string[] = [];
	private vectors: Float32Array[] = [];
	dims = 0;

	constructor(private readonly basePath: string, private readonly model: string) {
		try {
			const header = JSON.parse(readFileSync(`${basePath}.json`, "utf-8")) as { model?: unknown; dims?: unknown; keys?: unknown };
			if (header.model !== model || typeof header.dims !== "number" || !Array.isArray(header.keys)) return;
			const buffer = readFileSync(`${basePath}.f32`);
			const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
			if (flat.length !== header.keys.length * header.dims) return;
			this.dims = header.dims;
			header.keys.forEach((key, i) => this.add(String(key), flat.slice(i * this.dims, (i + 1) * this.dims)));
		} catch {
			// Missing or unreadable stores rebuild from scratch.
		}
	}

	has(key: string): boolean {
		return this.index.has(key);
	}

	get(key: string): Float32Array | undefined {
		const i = this.index.get(key);
		return i === undefined ? undefined : this.vectors[i];
	}

	add(key: string, vector: Float32Array): void {
		if (this.index.has(key)) return;
		this.dims = vector.length;
		this.index.set(key, this.keys.length);
		this.keys.push(key);
		this.vectors.push(vector);
	}

	save(): void {
		const dir = join(this.basePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const flat = new Float32Array(this.keys.length * this.dims);
		this.vectors.forEach((vector, i) => flat.set(vector, i * this.dims));
		writeFileSync(`${this.basePath}.f32.tmp`, Buffer.from(flat.buffer));
		writeFileSync(`${this.basePath}.json.tmp`, JSON.stringify({ model: this.model, dims: this.dims, keys: this.keys }));
		renameSync(`${this.basePath}.f32.tmp`, `${this.basePath}.f32`);
		renameSync(`${this.basePath}.json.tmp`, `${this.basePath}.json`);
	}
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

/**
 * Per-session semantic index for recall. Indexing runs in the background and
 * queries score only documents already embedded, so search never waits on it.
 */
export class SessionEmbeddings {
	private embedder: Promise<Embedder> | undefined;
	private store: { sessionId: string; store: VectorStore } | undefined;
	private indexing: Promise<void> | undefined;
	failure: string | undefined;
	failureNotified = false;

	constructor(
		private readonly getConfig: () => RecallEmbeddingsConfig,
		private readonly loadEmbedder: EmbedderLoader = loadTransformersEmbedder,
		private readonly baseDir: () => string = () => join(getAgentDir(), EMBEDDINGS_RELATIVE_DIR),
	) {}

	private enabled(): boolean {
		return this.getConfig().enabled && this.failure === undefined;
	}

	private getEmbedder(): Promise<Embedder> {
		this.embedder ??= this.loadEmbedder(this.getConfig()).catch((error: unknown) => {
			this.failure = error instanceof Error ? error.message : String(error);
			throw error;
		});
		return this.embedder;
	}

	private storeFor(sessionId: string): VectorStore {
		if (this.store?.sessionId !== sessionId) {
			const safe = safeDebugLogSessionId(sessionId) ?? "unknown-session";
			this.store = { sessionId, store: new VectorStore(join(this.baseDir(), safe), this.getConfig().model) };
		}
		return this.store.store;
	}

	/** Start embedding documents that have no vector yet; a no-op while a run is active. */
	scheduleIndex(sessionId: string, entries: Entry[]): Promise<void> | undefined {
		if (!this.enabled() || this.indexing) return this.indexing;
		this.indexing = this.index(sessionId, entries).catch(() => {}).finally(() => { this.indexing = undefined; });
		return this.indexing;
	}

	private async index(sessionId: string, entries: Entry[]): Promise<void> {
		const store = this.storeFor(sessionId);
		const missing = buildSearchCorpus(entries).filter((doc) => !store.has(docKey(doc)));
		if (missing.length === 0) return;
		const embedder = await this.getEmbedder();
		for (let start = 0, batch = 1; start < missing.length; start += BATCH_SIZE, batch++) {
			// A session switch mid-run abandons the old session's remaining work.
			if (this.store?.sessionId !== sessionId) break;
			const docs = missing.slice(start, start + BATCH_SIZE);
			const vectors = await embedder.embed(docs.map((doc) => doc.text));
			docs.forEach((doc, i) => store.add(docKey(doc), vectors[i]));
			if (batch % SAVE_EVERY_BATCHES === 0) store.save();
		}
		store.save();
	}

	/** Cosine similarity per document, undefined for documents not embedded yet; undefined overall when disabled or failing. */
	async vectorScores(sessionId: string, docs: SearchDocument[], query: string): Promise<Array<number | undefined> | undefined> {
		if (!this.enabled()) return undefined;
		try {
			const store = this.storeFor(sessionId);
			const [queryVector] = await (await this.getEmbedder()).embed([`${this.getConfig().queryPrefix}${query}`]);
			return docs.map((doc) => {
				const vector = store.get(docKey(doc));
				return vector ? dot(queryVector, vector) : undefined;
			});
		} catch {
			return undefined;
		}
	}
}
