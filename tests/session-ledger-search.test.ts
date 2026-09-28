import { describe, expect, it } from "vitest";

import { buildSearchCorpus, searchSession } from "../src/session-ledger/index.js";
import {
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
} from "./fixtures/session.js";

describe("session search", () => {
	const entries = [
		rawMessage("aaaa0001", "We chose sqlite over postgres because the tool runs offline."),
		rawMessage("aaaa0002", `${"filler line about nothing\n".repeat(80)}The sqlite migration failed with SQLITE_BUSY.`),
		observationsRecordedEntry("om-1", {
			observations: [observation("aaaaaaaaaaaa", { content: "User chose sqlite for offline use." })],
			coversUpToId: "aaaa0001",
		}),
		observationsDroppedEntry("om-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "aaaa0001" }),
		reflectionsRecordedEntry("om-3", { reflections: [reflection("bbbbbbbbbbbb", ["aaaaaaaaaaaa"], { content: "Project targets offline use." })], coversUpToId: "aaaa0001" }),
		rawMessage("aaaa0003", "Visible tail mentions sqlite too."),
		compactionEntry("cmp-1", { firstKeptEntryId: "aaaa0003" }),
	];

	it("indexes all memory and only the transcript hidden by compaction", () => {
		const docs = buildSearchCorpus(entries);

		expect(docs.filter((doc) => doc.kind === "entry").map((doc) => doc.id)).not.toContain("aaaa0003");
		expect(docs.find((doc) => doc.id === "aaaaaaaaaaaa")).toMatchObject({ kind: "observation", dropped: true });
		expect(buildSearchCorpus(entries.slice(0, -1)).some((doc) => doc.kind === "entry")).toBe(false);
	});

	it("ranks matches and returns each transcript entry once", () => {
		const hits = searchSession(entries, "sqlite busy", 8);

		expect(hits[0]).toMatchObject({ kind: "entry", id: "aaaa0002" });
		expect(hits.filter((hit) => hit.id === "aaaa0002")).toHaveLength(1);
		expect(hits.map((hit) => hit.id)).toContain("aaaaaaaaaaaa");
		expect(searchSession(entries, "kubernetes", 8)).toEqual([]);
	});
});
