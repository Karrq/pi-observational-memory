import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { SessionEmbeddings } from "./embeddings.js";
import { Runtime } from "./runtime.js";
import type { Entry } from "./session-ledger/index.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	const embeddings = new SessionEmbeddings(() => runtime.config.recallEmbeddings);
	registerRecallTool(pi, (sessionId, docs, query) => embeddings.vectorScores(sessionId, docs, query));
	// Compaction hides more transcript and workers record memory between runs; index whatever is new once idle.
	const index = (ctx: ExtensionContext) => {
		runtime.ensureConfig(ctx.cwd);
		void embeddings.scheduleIndex(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch() as Entry[])?.then(() => {
			if (!embeddings.failure || embeddings.failureNotified) return;
			embeddings.failureNotified = true;
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: recall embeddings unavailable, using keyword search: ${embeddings.failure}`, "warning");
		});
	};
	pi.on("session_start", (_event, ctx) => index(ctx));
	pi.on("agent_settled", (_event, ctx) => index(ctx));
}
