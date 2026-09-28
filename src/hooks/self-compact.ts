import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";

export const SELF_COMPACT_TOOL_NAME = "compact_context";
export const SELF_COMPACT_RESUME_TYPE = "om.self-compact.resume";

const compactContextTool = (runtime: Runtime) => defineTool({
	name: SELF_COMPACT_TOOL_NAME,
	label: "Compact context",
	description:
		"Compact context into memory at a clean breakpoint; recent turns stay verbatim. Ends this turn.",
	parameters: Type.Object({
		resume: Type.Optional(Type.String({
			description: "Current task and next step, delivered to you after compaction. Omit when no work remains.",
		})),
	}),
	async execute(_toolCallId, params) {
		const scheduled = runtime.selfCompactPending === undefined;
		if (scheduled) runtime.selfCompactPending = params.resume?.trim() ? { resume: params.resume.trim() } : {};
		return {
			content: [{ type: "text", text: scheduled ? "Compaction scheduled." : "Compaction already scheduled." }],
			details: { scheduled },
			terminate: true,
		};
	},
});

function sendResume(pi: ExtensionAPI, resume: string | undefined, failure?: string): void {
	if (!resume) return;
	const content = failure
		? `Compaction failed: ${failure}. Continue without compacting from your note:\n\n${resume}`
		: `Continue from your note written before compaction:\n\n${resume}`;
	pi.sendMessage({ customType: SELF_COMPACT_RESUME_TYPE, content, display: true }, { triggerTurn: true });
}

export function registerSelfCompact(pi: ExtensionAPI, runtime: Runtime): void {
	let registered = false;

	pi.on("session_start", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.selfCompactPending = undefined;
		const enabled = runtime.config.selfCompact.enabled;
		const active = pi.getActiveTools();
		if (enabled && !registered) {
			pi.registerTool(compactContextTool(runtime));
			registered = true;
		} else if (enabled && !active.includes(SELF_COMPACT_TOOL_NAME)) {
			pi.setActiveTools([...active, SELF_COMPACT_TOOL_NAME]);
		} else if (!enabled && active.includes(SELF_COMPACT_TOOL_NAME)) {
			pi.setActiveTools(active.filter((name) => name !== SELF_COMPACT_TOOL_NAME));
		}
	});

	// Registered before the proactive trigger so an agent-requested compaction
	// claims compactInFlight first on the same agent_settled.
	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		const pending = runtime.selfCompactPending;
		if (!pending) return;
		runtime.selfCompactPending = undefined;
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (runtime.compactInFlight) {
			sendResume(pi, pending.resume, "another compaction is already running");
			return;
		}
		runtime.compactInFlight = true;
		setTimeout(() => {
			// Input that arrived since settling takes precedence over the handoff.
			if (!ctx.isIdle()) {
				runtime.compactInFlight = false;
				if (hasUI) ui?.notify("Observational memory: self-compaction skipped — agent became busy", "info");
				return;
			}
			try {
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						sendResume(pi, pending.resume);
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify(`Observational memory: self-compaction failed: ${error.message}`, "error");
						sendResume(pi, pending.resume, error.message);
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				sendResume(pi, pending.resume, error instanceof Error ? error.message : String(error));
			}
		}, 0);
	});
}
