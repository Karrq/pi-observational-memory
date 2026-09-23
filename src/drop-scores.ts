import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { safeDebugLogSessionId } from "./debug-log.js";
import type { ObservationSignals } from "./agents/dropper/system-one/questions.js";
import type { ReflectionCoverageTier } from "./agents/dropper/coverage.js";
import type { Relevance } from "./session-ledger/index.js";

export const DROP_SCORES_RELATIVE_DIR = join("observational-memory", "drop-scores");

/**
 * One scored observation from one dropper run.
 *
 * Content is deliberately absent: these rows carry ids and numbers only, and
 * `/om:export-drops` rejoins them with observation text from the local session
 * file when you sit down to label. That keeps the long-lived log free of
 * conversation content while still supporting calibration.
 */
export interface DropScoreRow {
	ts: string;
	sessionId?: string;
	runId?: string;
	observationId: string;
	relevance: Relevance;
	coverage: ReflectionCoverageTier;
	/** Undefined when the endpoint did not return a usable answer for every signal. */
	signals?: ObservationSignals;
	dropProbability?: number;
	/** What the endpoint would do at the configured thresholds. */
	systemOneDecision: "drop" | "keep" | "vetoed" | "unscored";
	/**
	 * What the tool-calling LLM dropper decided on the same pool, when it ran.
	 * This is the distillation label: in shadow mode it is the verdict a
	 * calibration map is fitted against.
	 */
	llmDecision?: "drop" | "keep";
	/**
	 * Whether the LLM dropper asked for this observation, regardless of whether it
	 * survived the cut. `llmDecision` is the outcome after `selectDropCandidates`
	 * applies the budget and sorts by coverage, then relevance, then age, so a
	 * proposal can be dropped from the set by the sort alone. Recording both
	 * separates the model's judgement from that ordering.
	 */
	llmProposed?: boolean;
	/**
	 * Rank the existing coverage/relevance/age heuristic would assign, lowest
	 * first. Recorded so the model can be compared against the heuristic it is
	 * meant to improve on, using the same labels.
	 */
	heuristicRank: number;
}

export function dropScoresRelativePath(sessionId: string | undefined): string {
	const safe = safeDebugLogSessionId(sessionId);
	return join(DROP_SCORES_RELATIVE_DIR, `${safe ?? "unknown-session"}.ndjson`);
}

export function dropScoresPath(sessionId: string | undefined): string {
	return join(getAgentDir(), dropScoresRelativePath(sessionId));
}

/**
 * Append one run's scores. Never throws: a failed write must not change what
 * the dropper does.
 */
export function appendDropScores(sessionId: string | undefined, rows: readonly DropScoreRow[]): boolean {
	if (rows.length === 0) return false;
	try {
		const path = dropScoresPath(sessionId);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** Read back every row for a session, skipping any line that is not valid JSON. */
export function readDropScores(sessionId: string | undefined): DropScoreRow[] {
	const path = dropScoresPath(sessionId);
	if (!existsSync(path)) return [];
	const rows: DropScoreRow[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as DropScoreRow;
			if (typeof parsed?.observationId === "string") rows.push(parsed);
		} catch {
			// A truncated final line from an interrupted write is expected; skip it.
		}
	}
	return rows;
}
