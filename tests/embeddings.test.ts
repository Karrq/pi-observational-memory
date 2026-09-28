import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/unused" }));

import { SessionEmbeddings, type Embedder } from "../src/embeddings.js";
import { buildSearchCorpus, fuseScores, rankLexical, topHits } from "../src/session-ledger/index.js";
import { compactionEntry, rawMessage } from "./fixtures/session.js";

const config = { enabled: true, model: "fake", pooling: "cls" as const, queryPrefix: "" };

// Two-dimensional "meaning": texts about storage point one way, everything else the other.
const fakeEmbedder: Embedder = {
	embed: async (texts) => texts.map((text) => /database|sqlite|storage/i.test(text) ? Float32Array.of(1, 0) : Float32Array.of(0, 1)),
};

describe("recall embeddings", () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

	const entries = [
		rawMessage("aaaa0001", "We picked sqlite because the tool runs offline."),
		rawMessage("aaaa0002", "Renamed the button label."),
		rawMessage("aaaa0003", "Recent turn."),
		compactionEntry("cmp-1", { firstKeptEntryId: "aaaa0003" }),
	];

	it("indexes in the background, persists vectors, and scores only embedded documents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "om-emb-"));
		dirs.push(dir);
		const load = vi.fn(async () => fakeEmbedder);
		const embeddings = new SessionEmbeddings(() => config, load, () => dir);
		const docs = buildSearchCorpus(entries);

		expect(await embeddings.vectorScores("s1", docs, "database choice")).toEqual([undefined, undefined]);
		await embeddings.scheduleIndex("s1", entries);

		const reloaded = new SessionEmbeddings(() => config, async () => fakeEmbedder, () => dir);
		expect(await reloaded.vectorScores("s1", docs, "database choice")).toEqual([1, 0]);

		const failing = new SessionEmbeddings(() => config, async () => { throw new Error("no runtime"); }, () => dir);
		await failing.scheduleIndex("s2", entries);
		expect(failing.failure).toBe("no runtime");
		expect(await failing.vectorScores("s1", docs, "database choice")).toBeUndefined();
	});

	it("surfaces semantic matches that share no keywords with the query", () => {
		const docs = buildSearchCorpus(entries);
		const lexical = rankLexical(docs, "database choice");
		expect(topHits(docs, lexical, 8)).toEqual([]);

		const hits = topHits(docs, fuseScores(lexical, [1, 0]), 8);
		expect(hits[0]).toMatchObject({ id: "aaaa0001" });
	});
});
