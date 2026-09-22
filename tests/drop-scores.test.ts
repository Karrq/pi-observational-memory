import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const agentDir = { path: "" };
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { appendDropScores, dropScoresPath, readDropScores } = await import("../src/drop-scores.js");
type DropScoreRow = import("../src/drop-scores.js").DropScoreRow;

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

beforeEach(() => {
	agentDir.path = mkdtempSync(join(tmpdir(), "om-drop-scores-"));
});

afterEach(() => {
	rmSync(agentDir.path, { recursive: true, force: true });
});

describe("drop score log", () => {
	it("round-trips rows and appends across runs", () => {
		expect(appendDropScores("session-1", [row()])).toBe(true);
		expect(appendDropScores("session-1", [row({ observationId: "bbbbbbbbbbbb", llmDecision: "keep" })])).toBe(true);

		const rows = readDropScores("session-1");
		expect(rows.map((r) => r.observationId)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(rows[1].llmDecision).toBe("keep");
	});

	it("keeps sessions apart and returns nothing for an unwritten session", () => {
		appendDropScores("session-1", [row()]);

		expect(readDropScores("session-2")).toEqual([]);
	});

	it("writes nothing for an empty run", () => {
		expect(appendDropScores("session-1", [])).toBe(false);
		expect(readDropScores("session-1")).toEqual([]);
	});

	it("skips a truncated trailing line from an interrupted write", () => {
		appendDropScores("session-1", [row()]);
		appendFileSync(dropScoresPath("session-1"), '{"observationId":"bbbb', "utf-8");

		expect(readDropScores("session-1").map((r) => r.observationId)).toEqual(["aaaaaaaaaaaa"]);
	});

	it("confines a traversal-shaped session id to one file in the log directory", () => {
		const path = dropScoresPath("../../escape/../attempt");
		const expectedDir = join(agentDir.path, "observational-memory", "drop-scores");

		// Separators are stripped, so the id collapses to a single file name and
		// cannot climb out of the log directory.
		expect(dirname(path)).toBe(expectedDir);
		expect(path.slice(expectedDir.length + 1)).not.toContain("/");
	});

	it("reports failure rather than throwing when the path is unwritable", () => {
		const path = dropScoresPath("session-1");
		mkdirSync(dirname(path), { recursive: true });
		// A directory where the log file belongs makes the append fail.
		mkdirSync(path, { recursive: true });

		expect(appendDropScores("session-1", [row()])).toBe(false);
	});
});
