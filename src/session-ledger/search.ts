import { renderRecallSourceEntry } from "../serialize.js";
import { entryIndexForId, isSourceEntry } from "./progress.js";
import {
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsDroppedEntry,
	isReflectionsRecordedEntry,
	type Entry,
} from "./types.js";

export type SearchDocument =
	| { kind: "observation"; id: string; text: string; timestamp: string; relevance: string; dropped: boolean }
	| { kind: "reflection"; id: string; text: string; dropped: boolean }
	| { kind: "entry"; id: string; text: string; chunk: number };

export type SearchHit = SearchDocument & { score: number };

/** Transcript chunk size; small enough that one hit is readable, large enough to keep a tool call and its context together. */
export const SEARCH_CHUNK_CHARS = 1_200;

const STOPWORDS = new Set([
	"the", "and", "for", "are", "was", "were", "with", "that", "this", "from", "have", "has", "had", "not", "but",
	"you", "your", "our", "its", "into", "than", "then", "them", "they", "what", "when", "where", "which", "who",
	"will", "would", "can", "could", "should", "been", "being", "also", "about", "there", "their", "these", "those",
]);

export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 2 || STOPWORDS.has(raw)) continue;
		tokens.push(raw);
	}
	return tokens;
}

function chunkText(text: string): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(text.length, start + SEARCH_CHUNK_CHARS);
		if (end < text.length) {
			// Prefer a line break in the back half of the window.
			const newline = text.lastIndexOf("\n", end);
			if (newline > start + SEARCH_CHUNK_CHARS / 2) end = newline + 1;
		}
		const chunk = text.slice(start, end).trim();
		if (chunk) chunks.push(chunk);
		start = end;
	}
	return chunks;
}

/**
 * End of the hidden transcript among the first `length` entries: the latest
 * compaction's retained tail, or 0 when nothing is compacted yet.
 */
function hiddenEnd(entries: Entry[], length: number): number {
	let compactionIndex = length - 1;
	while (compactionIndex >= 0 && entries[compactionIndex].type !== "compaction") compactionIndex--;
	if (compactionIndex === -1) return 0;
	const firstKeptIndex = entryIndexForId(entries, entries[compactionIndex].firstKeptEntryId);
	return firstKeptIndex === -1 ? compactionIndex : firstKeptIndex;
}

/**
 * Transcript entries the agent cannot see: source entries before the latest
 * compaction's retained tail. Without a compaction the whole branch is in
 * context and nothing is hidden.
 */
export function hiddenSourceEntries(entries: Entry[]): Entry[] {
	return entries.slice(0, hiddenEnd(entries, entries.length)).filter(isSourceEntry);
}

/**
 * Every observation and reflection ever recorded on the branch, plus hidden transcript chunks.
 * With `from`, only what entries from that index on added: memory they record, and transcript
 * a compaction among them newly hid.
 */
export function buildSearchCorpus(entries: Entry[], from = 0): SearchDocument[] {
	const droppedObservations = new Set<string>();
	const droppedReflections = new Set<string>();
	for (const entry of entries) {
		if (isObservationsDroppedEntry(entry)) entry.data.observationIds.forEach((id) => droppedObservations.add(id));
		if (isReflectionsDroppedEntry(entry)) entry.data.reflectionIds.forEach((id) => droppedReflections.add(id));
	}

	const docs: SearchDocument[] = [];
	for (const entry of entries.slice(from)) {
		if (isObservationsRecordedEntry(entry)) {
			for (const observation of entry.data.observations) {
				docs.push({
					kind: "observation",
					id: observation.id,
					text: observation.content,
					timestamp: observation.timestamp,
					relevance: observation.relevance,
					dropped: droppedObservations.has(observation.id),
				});
			}
		} else if (isReflectionsRecordedEntry(entry)) {
			for (const reflection of entry.data.reflections) {
				docs.push({ kind: "reflection", id: reflection.id, text: reflection.content, dropped: droppedReflections.has(reflection.id) });
			}
		}
	}
	const hidden = entries.slice(from === 0 ? 0 : hiddenEnd(entries, from), hiddenEnd(entries, entries.length)).filter(isSourceEntry);
	for (const entry of hidden) {
		const rendered = renderRecallSourceEntry(entry);
		if (!rendered) continue;
		chunkText(rendered).forEach((text, chunk) => docs.push({ kind: "entry", id: entry.id, text, chunk }));
	}
	return docs;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** BM25 over the corpus; returns one score per document, 0 when no query term matches. */
export function rankLexical(docs: SearchDocument[], query: string): number[] {
	const terms = Array.from(new Set(tokenize(query)));
	if (terms.length === 0 || docs.length === 0) return docs.map(() => 0);

	const termCounts = docs.map((doc) => {
		const counts = new Map<string, number>();
		for (const token of tokenize(doc.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
		return counts;
	});
	const lengths = termCounts.map((counts) => Array.from(counts.values()).reduce((sum, n) => sum + n, 0));
	const averageLength = lengths.reduce((sum, n) => sum + n, 0) / docs.length || 1;
	const idf = new Map(terms.map((term) => {
		const containing = termCounts.filter((counts) => counts.has(term)).length;
		return [term, Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5))];
	}));

	return termCounts.map((counts, i) => {
		let score = 0;
		for (const term of terms) {
			const frequency = counts.get(term);
			if (!frequency) continue;
			const norm = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * lengths[i]) / averageLength);
			score += idf.get(term)! * ((frequency * (BM25_K1 + 1)) / norm);
		}
		return score;
	});
}

/** Semantic candidates admitted to fusion; the long tail of any embedding space is noise. */
export const VECTOR_CANDIDATES = 50;
const RRF_K = 60;

function ranksOf(scores: Array<number | undefined>, limit: number): Map<number, number> {
	const order = scores
		.map((score, i) => ({ score, i }))
		.filter((item): item is { score: number; i: number } => item.score !== undefined && item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
	return new Map(order.map((item, rank) => [item.i, rank]));
}

/**
 * Reciprocal rank fusion of lexical and vector scores. Documents without a
 * vector yet (still indexing) compete on lexical rank alone.
 */
export function fuseScores(lexical: number[], vector: Array<number | undefined>): number[] {
	const lexicalRanks = ranksOf(lexical, lexical.length);
	const vectorRanks = ranksOf(vector, VECTOR_CANDIDATES);
	return lexical.map((_, i) => {
		const l = lexicalRanks.get(i);
		const v = vectorRanks.get(i);
		return (l === undefined ? 0 : 1 / (RRF_K + l)) + (v === undefined ? 0 : 1 / (RRF_K + v));
	});
}

/** Highest-scoring documents, keeping only the best chunk of each transcript entry. */
export function topHits(docs: SearchDocument[], scores: number[], limit: number): SearchHit[] {
	const ranked = docs
		.map((doc, i) => ({ ...doc, score: scores[i] }))
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score);
	const seen = new Set<string>();
	const hits: SearchHit[] = [];
	for (const hit of ranked) {
		const key = `${hit.kind}:${hit.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		hits.push(hit);
		if (hits.length === limit) break;
	}
	return hits;
}

export function searchSession(entries: Entry[], query: string, limit: number): SearchHit[] {
	const docs = buildSearchCorpus(entries);
	return topHits(docs, rankLexical(docs, query), limit);
}
