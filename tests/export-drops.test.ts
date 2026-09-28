import { describe, expect, it } from "vitest";

import { buildExportRows, summarize } from "../src/commands/export-drops.js";
import type { DropScoreRow } from "../src/drop-scores.js";
import { observation, reflection } from "./fixtures/session.js";

const SIGNALS = { floor: 0.02, redundant: 0.95, superseded: 0.1, lowSignal: 0.1, safety: 1 };

function row(overrides: Partial<DropScoreRow> = {}): DropScoreRow {
	return {
		ts: "2026-09-22T10:00:00.000Z",
		observationId: "aaaaaaaaaaaa",
		relevance: "medium",
		coverage: "partial",
		signals: SIGNALS,
		dropProbability: 0.95,
		systemOneDecision: "drop",
		heuristicRank: 0,
		...overrides,
	};
}

describe("drop score export", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });
	const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("attaches observation text and the reflections a drop would rest on", () => {
		const { exported, missing } = buildExportRows([row()], [obsA], [ref]);

		expect(missing).toBe(0);
		expect(exported[0]).toMatchObject({
			observationId: "aaaaaaaaaaaa",
			content: obsA.content,
			timestamp: obsA.timestamp,
			supportingReflections: [ref.content],
			label: "",
		});
	});

	it("leaves supporting reflections empty when nothing cites the observation", () => {
		const { exported } = buildExportRows([row({ observationId: "bbbbbbbbbbbb" })], [obsB], [ref]);

		expect(exported[0].supportingReflections).toEqual([]);
	});

	it("skips and counts scores with no matching observation in this session", () => {
		const { exported, missing } = buildExportRows([row(), row({ observationId: "cccccccccccc" })], [obsA], [ref]);

		expect(exported).toHaveLength(1);
		expect(missing).toBe(1);
	});

	it("preserves an unscored row so the export covers the whole pool", () => {
		const unscored = row({ signals: undefined, dropProbability: undefined, systemOneDecision: "unscored" });
		const { exported } = buildExportRows([unscored], [obsA], []);

		expect(exported[0].signals).toBeUndefined();
		expect(exported[0].systemOneDecision).toBe("unscored");
	});

	it("reports agreement against the LLM verdict, counting a veto as a keep", () => {
		const { exported } = buildExportRows(
			[
				row({ llmDecision: "drop" }),
				row({ observationId: "bbbbbbbbbbbb", systemOneDecision: "vetoed", llmDecision: "keep" }),
			],
			[obsA, obsB],
			[],
		);

		expect(summarize(exported)).toContain("the endpoint agreed on 2 (100%)");
	});

	it("says what is missing when no verdicts were recorded", () => {
		const { exported } = buildExportRows([row()], [obsA], []);

		expect(summarize(exported)).toContain("Run in shadow mode");
	});
});
