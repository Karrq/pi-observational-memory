import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerIndexCommand } from "./commands/index-embeddings.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { registerSelfCompact } from "./hooks/self-compact.js";
import { SessionEmbeddings } from "./embeddings.js";
import { Runtime } from "./runtime.js";
import { OM_EMBEDDINGS_INDEXED, type Entry } from "./session-ledger/index.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
	registerSelfCompact(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	const embeddings = new SessionEmbeddings(
		() => runtime.config.recallEmbeddings,
		undefined,
		undefined,
		(data) => pi.appendEntry(OM_EMBEDDINGS_INDEXED, data),
	);
	registerStatusCommand(pi, runtime, embeddings);
	registerViewCommand(pi, runtime);
	registerRecallTool(pi, (sessionId, docs, query) => embeddings.vectorScores(sessionId, docs, query));
	registerIndexCommand(pi, runtime, embeddings);
	// Compaction hides more transcript and workers record memory between runs; index what the
	// session added once idle. Compacted sessions without an index wait for /om:index.
	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		runtime.ensureConfig(ctx.cwd);
		void embeddings.scheduleIncrementalIndex(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch() as Entry[])?.then(() => {
			if (!embeddings.failure || embeddings.failureNotified) return;
			embeddings.failureNotified = true;
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: recall embeddings unavailable, using keyword search: ${embeddings.failure}`, "warning");
		});
	});
}
