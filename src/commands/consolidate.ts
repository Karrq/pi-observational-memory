import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withDebugLogContext } from "../debug-log.js";
import { runConsolidationPipeline, type ConsolidationCtx } from "../hooks/consolidation-trigger.js";
import type { Runtime } from "../runtime.js";
import { foldLedger, type Entry } from "../session-ledger/index.js";

type LedgerCounts = {
	observations: number;
	reflections: number;
	droppedObservations: number;
	droppedReflections: number;
};

function ledgerCounts(entries: Entry[]): LedgerCounts {
	const folded = foldLedger(entries);
	return {
		observations: folded.observations.length,
		reflections: folded.reflections.length,
		droppedObservations: folded.droppedObservationIds.size,
		droppedReflections: folded.droppedReflectionIds.size,
	};
}

function plural(count: number, singular: string): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : `${singular}s`}`;
}

export function summarizeConsolidation(before: LedgerCounts, after: LedgerCounts, errors: string[]): string {
	const parts: string[] = [];
	const recordedObservations = after.observations - before.observations;
	const recordedReflections = after.reflections - before.reflections;
	const droppedObservations = after.droppedObservations - before.droppedObservations;
	const droppedReflections = after.droppedReflections - before.droppedReflections;

	if (recordedObservations > 0) parts.push(`${plural(recordedObservations, "observation")} recorded`);
	if (recordedReflections > 0) parts.push(`${plural(recordedReflections, "reflection")} recorded`);
	if (droppedReflections > 0) parts.push(`${plural(droppedReflections, "reflection")} dropped`);
	if (droppedObservations > 0) parts.push(`${plural(droppedObservations, "observation")} dropped`);

	const outcome = parts.length > 0 ? parts.join(", ") : "no memory changes";
	const failures = errors.length > 0 ? `; ${errors.join("; ")}` : "";
	return `Observational memory: consolidation complete — ${outcome}${failures}`;
}

const STATUS_KEY = "om:consolidate";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

type StatusUI = { setStatus?: (key: string, text: string | undefined) => void };

/**
 * Animate a footer status for the duration of a blocking run, labelled with the
 * live pipeline phase. Returns a stop function that also clears the status.
 */
function startStatusSpinner(ui: StatusUI, runtime: Runtime): () => void {
	if (typeof ui.setStatus !== "function") return () => {};
	let frame = 0;
	const render = () => {
		const phase = runtime.consolidationPhase;
		ui.setStatus?.(
			STATUS_KEY,
			`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} consolidating memory${phase ? ` (${phase})` : ""}`,
		);
		frame++;
	};
	render();
	const timer = setInterval(render, SPINNER_INTERVAL_MS);
	// Never let the animation hold the process open.
	timer.unref?.();
	return () => {
		clearInterval(timer);
		ui.setStatus?.(STATUS_KEY, undefined);
	};
}

function stageErrors(runtime: Runtime): string[] {
	const errors: string[] = [];
	if (runtime.lastObserverError) errors.push(`observer failed: ${runtime.lastObserverError}`);
	if (runtime.lastReflectorError) errors.push(`reflector failed: ${runtime.lastReflectorError}`);
	if (runtime.lastReflectionDropperError) errors.push(`reflection dropper failed: ${runtime.lastReflectionDropperError}`);
	if (runtime.lastDropperError) errors.push(`dropper failed: ${runtime.lastDropperError}`);
	return errors;
}

export function registerConsolidateCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:consolidate", {
		description: "Run observation, reflection, and memory pruning now, ignoring token thresholds",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);

			if (runtime.consolidationInFlight) {
				const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
				ctx.ui.notify(`Observational memory: consolidation already running${phase}; skipping manual run`, "warning");
				return;
			}

			const before = ledgerCounts(ctx.sessionManager.getBranch() as Entry[]);
			const consolidationCtx: ConsolidationCtx = {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				getContextUsage: () => ctx.getContextUsage(),
				sessionManager: ctx.sessionManager,
			};
			const sessionManager = ctx.sessionManager;
			const runId = `manual-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;

			ctx.ui.notify("Observational memory: consolidation started", "info");
			const stopSpinner = ctx.hasUI ? startStatusSpinner(ctx.ui, runtime) : () => {};

			try {
				await runtime.launchConsolidationTask(consolidationCtx, async () => withDebugLogContext({
					enabled: runtime.config.debugLog === true,
					cwd: ctx.cwd,
					sessionId: sessionManager.getSessionId?.(),
					sessionFile: sessionManager.getSessionFile?.(),
					runId,
				}, async () => {
					await runConsolidationPipeline(pi, runtime, consolidationCtx, { force: true });
				}));
			} finally {
				stopSpinner();
			}

			const after = ledgerCounts(sessionManager.getBranch() as Entry[]);
			ctx.ui.notify(summarizeConsolidation(before, after, stageErrors(runtime)), "info");
		},
	});
}
