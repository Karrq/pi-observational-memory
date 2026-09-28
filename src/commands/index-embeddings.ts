import { DynamicBorder, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { IndexOutcome, IndexProgress, SessionEmbeddings } from "../embeddings.js";
import type { Runtime } from "../runtime.js";
import type { Entry } from "../session-ledger/index.js";

function progressMessage(progress: IndexProgress | undefined): string {
	if (!progress) return "Observational memory: reading the session for recall indexing…";
	if (progress.total === 0) return "Observational memory: recall index is up to date";
	return `Observational memory: embedding recall documents ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`;
}

function outcomeMessage(outcome: IndexOutcome | undefined, progress: IndexProgress | undefined, failure: string | undefined): string {
	const embedded = `${(progress?.done ?? 0).toLocaleString()} of ${(progress?.total ?? 0).toLocaleString()}`;
	const pruned = progress?.pruned ? `, ${progress.pruned.toLocaleString()} orphaned pruned` : "";
	if (outcome === "complete") {
		return progress?.total
			? `Observational memory: recall index complete — ${embedded} documents embedded${pruned}`
			: `Observational memory: recall index is up to date${pruned}`;
	}
	if (outcome === "aborted") return `Observational memory: recall indexing stopped — ${embedded} documents embedded${pruned}; run /om:index to resume`;
	return `Observational memory: recall indexing failed${failure ? ` — ${failure}` : ""}`;
}

export function registerIndexCommand(pi: ExtensionAPI, runtime: Runtime, embeddings: SessionEmbeddings): void {
	pi.registerCommand("om:index", {
		description: "Build or update the recall embeddings index for this session",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			if (!runtime.config.recallEmbeddings.enabled) {
				ctx.ui.notify("Observational memory: recall embeddings are disabled (recallEmbeddings.enabled)", "warning");
				return;
			}
			if (embeddings.isIndexing) {
				ctx.ui.notify("Observational memory: recall indexing already running", "warning");
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const entries = ctx.sessionManager.getBranch() as Entry[];
			let progress: IndexProgress | undefined;

			if (!ctx.hasUI) {
				const outcome = await embeddings.scheduleIndex(sessionId, entries, { onProgress: (next) => (progress = next) });
				ctx.ui.notify(outcomeMessage(outcome, progress, embeddings.failure), outcome === "complete" ? "info" : "warning");
				return;
			}

			// Replaces the editor until the run ends, so the session is not driven while it
			// shares the process with the embedder.
			const outcome = await ctx.ui.custom<IndexOutcome | undefined>((tui, theme, _keybindings, done) => {
				const loader = new CancellableLoader(tui, (s) => theme.fg("accent", s), (s) => theme.fg("muted", s), progressMessage(undefined));
				const container = new Container();
				const border = (s: string) => theme.fg("border", s);
				container.addChild(new DynamicBorder(border));
				container.addChild(loader);
				container.addChild(new Spacer(1));
				container.addChild(new Text(keyHint("tui.select.cancel", "stop (progress is kept)"), 1, 0));
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder(border));
				loader.onAbort = () => loader.setMessage("Observational memory: stopping after the current batch…");

				// Reading the session is synchronous; let the loader paint before it starts.
				setTimeout(() => {
					const run = embeddings.scheduleIndex(sessionId, entries, {
						signal: loader.signal,
						onProgress: (next) => {
							progress = next;
							if (!loader.aborted) loader.setMessage(progressMessage(next));
						},
					});
					if (!run) done(undefined);
					else void run.then(done);
				}, 0);

				return Object.assign(container, {
					handleInput: (data: string) => loader.handleInput(data),
					dispose: () => loader.dispose(),
				});
			});
			ctx.ui.notify(outcomeMessage(outcome, progress, embeddings.failure), outcome === "complete" ? "info" : "warning");
		},
	});
}
