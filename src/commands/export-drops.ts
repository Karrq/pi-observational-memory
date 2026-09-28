import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { readDropScores, type DropScoreRow } from "../drop-scores.js";
import { fullProjection, type Entry, type Observation, type Reflection } from "../session-ledger/index.js";

export const DEFAULT_EXPORT_PATH = "om-drop-scores.jsonl";

/**
 * One labelable row: the endpoint's signals for an observation, the decision
 * that was applied, and enough text to judge whether that decision was right.
 */
export interface ExportedDropRow extends DropScoreRow {
	content: string;
	timestamp: string;
	/** Reflections citing this observation, the evidence a drop is supposed to rest on. */
	supportingReflections: string[];
	/** Left empty for a human or a script to fill in with "drop" or "keep". */
	label: "";
}

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") {
		const trimmed = args.trim();
		return trimmed ? trimmed.split(/\s+/)[0] : undefined;
	}
	return undefined;
}

export function buildExportRows(
	rows: readonly DropScoreRow[],
	observations: readonly Observation[],
	reflections: readonly Reflection[],
): { exported: ExportedDropRow[]; missing: number } {
	const byId = new Map(observations.map((observation) => [observation.id, observation]));
	const exported: ExportedDropRow[] = [];
	let missing = 0;

	for (const row of rows) {
		const observation = byId.get(row.observationId);
		if (!observation) {
			// Recorded in an earlier branch, or the session file no longer holds it.
			missing++;
			continue;
		}
		exported.push({
			...row,
			content: observation.content,
			timestamp: observation.timestamp,
			supportingReflections: reflections
				.filter((reflection) => reflection.supportingObservationIds.includes(row.observationId))
				.map((reflection) => reflection.content),
			label: "",
		});
	}
	return { exported, missing };
}

export function summarize(rows: readonly ExportedDropRow[]): string {
	const scored = rows.filter((row) => row.signals !== undefined);
	const labelled = rows.filter((row) => row.llmDecision !== undefined);
	const agreed = labelled.filter((row) =>
		row.llmDecision === (row.systemOneDecision === "drop" ? "drop" : "keep"),
	);
	const lines = [
		`Exported ${rows.length} row${rows.length === 1 ? "" : "s"} (${scored.length} scored by the endpoint).`,
	];
	if (labelled.length > 0) {
		const percent = Math.round((agreed.length / labelled.length) * 100);
		lines.push(
			`${labelled.length} carry an LLM dropper verdict; the endpoint agreed on ${agreed.length} (${percent}%).`,
		);
	} else {
		lines.push("No LLM dropper verdicts recorded. Run in shadow mode to collect distillation labels.");
	}
	return lines.join("\n");
}

export function registerExportDropsCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:export-drops", {
		description: "Export recorded dropper scores joined with observation text, for calibration",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId?.();
			const rows = readDropScores(sessionId);
			if (rows.length === 0) {
				ctx.ui.notify(
					"Observational memory: no dropper scores recorded for this session. Set systemOneDropper.mode to \"shadow\" or \"primary\" and run a consolidation first.",
					"info",
				);
				return;
			}

			const entries = ctx.sessionManager.getBranch() as Entry[];
			// Full projection, not visible: dropped observations are exactly the
			// ones worth labelling, and they are absent from the visible view.
			const projection = fullProjection(entries);
			const { exported, missing } = buildExportRows(rows, projection.observations, projection.reflections);
			if (exported.length === 0) {
				ctx.ui.notify("Observational memory: no recorded scores matched observations in this session.", "info");
				return;
			}

			const target = resolve(ctx.cwd, firstArg(args) ?? DEFAULT_EXPORT_PATH);
			try {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, exported.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
			} catch (error) {
				ctx.ui.notify(`Observational memory: failed to write ${target}: ${String(error)}`, "warning");
				return;
			}

			const notes = [summarize(exported), `Written to ${target}.`];
			if (missing > 0) notes.push(`${missing} recorded score${missing === 1 ? "" : "s"} had no matching observation in this session and were skipped.`);
			ctx.ui.notify(notes.join("\n"), "info");
		},
	});
}
