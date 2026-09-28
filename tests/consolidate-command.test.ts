import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runReflectionDropper: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/reflection-dropper/agent.js", () => ({ runReflectionDropper: mockAgents.runReflectionDropper }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { registerConsolidateCommand, summarizeConsolidation } from "../src/commands/consolidate.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runReflectionDropper.mockReset();
	mockAgents.runDropper.mockReset();
	mockAgents.runObserver.mockResolvedValue(undefined);
	mockAgents.runReflector.mockResolvedValue(undefined);
	mockAgents.runReflectionDropper.mockResolvedValue(undefined);
	mockAgents.runDropper.mockResolvedValue(undefined);
});

function setup(args: {
	entries: TestEntry[];
	passive?: boolean;
	hasUI?: boolean;
	consolidationInFlight?: boolean;
	consolidationPhase?: string;
	reflectionsPoolTargetTokens?: number;
	observationsPoolTargetTokens?: number;
	onWork?: () => void;
}) {
	let entries = [...args.entries];
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:consolidate");
			handler = command.handler;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return id;
		}),
	};
	const runtime = {
		config: {
			showWorkerNotifications: true,
			passive: args.passive ?? false,
			debugLog: false,
			observeAfterTokens: 1_000_000,
			reflectAfterTokens: 1_000_000,
			observationsPoolMaxTokens: 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? 5,
			reflectionsPoolTargetTokens: args.reflectionsPoolTargetTokens ?? 5,
			agentMaxTurns: 9,
		},
		configLoaded: true,
		consolidationInFlight: args.consolidationInFlight ?? false,
		consolidationPhase: args.consolidationPhase,
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastReflectionDropperError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", thinking: "minimal" })),
		launchConsolidationTask: vi.fn(async (_ctx: unknown, work: () => Promise<void>) => {
			runtime.consolidationInFlight = true;
			try {
				args.onWork?.();
				await work();
			} finally {
				runtime.consolidationInFlight = false;
			}
		}),
		recordConsolidationStageError: vi.fn((_ctx, phase: string, error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (phase === "observer") runtime.lastObserverError = message;
			if (phase === "reflector") runtime.lastReflectorError = message;
			if (phase === "reflection-dropper") runtime.lastReflectionDropperError = message;
			if (phase === "dropper") runtime.lastDropperError = message;
			return message;
		}),
	};
	registerConsolidateCommand(pi as any, runtime as any);
	if (!handler) throw new Error("consolidate handler not registered");
	const notify = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		cwd: "/tmp/project",
		hasUI: args.hasUI ?? true,
		ui: { notify, setStatus },
		model: { provider: "session", contextWindow: 200_000 },
		modelRegistry: {},
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session-1.jsonl",
		},
	};
	return {
		pi,
		runtime,
		notify,
		setStatus,
		run: () => handler!("", ctx as any),
		getEntries: () => entries,
		messages: () => notify.mock.calls.map((call) => call[0] as string),
		statusTexts: () => setStatus.mock.calls.map((call) => call[1] as string | undefined),
	};
}

describe("/om:consolidate", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("runs the observer below its token threshold", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, pi } = setup({ entries });

		await run();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" });
	});

	it("runs the reflector below its token threshold", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { run, pi } = setup({ entries, reflectionsPoolTargetTokens: 1_000 });

		await run();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});

	it("prunes an over-target reflection pool even when the reflector records nothing", async () => {
		mockAgents.runReflectionDropper.mockResolvedValueOnce(["eeeeeeeeeeee"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { run, pi } = setup({ entries, reflectionsPoolTargetTokens: 5 });

		await run();

		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_DROPPED, { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-1" });
	});

	it("prunes observations against existing reflections without same-run reflector output", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { run, pi } = setup({ entries, observationsPoolTargetTokens: 5, reflectionsPoolTargetTokens: 1_000 });

		await run();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [refA] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" });
	});

	it("still runs in passive mode", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, pi } = setup({ entries, passive: true });

		await run();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalled();
	});

	it("refuses to start while a consolidation is already in flight", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, messages } = setup({ entries, consolidationInFlight: true, consolidationPhase: "reflector" });

		await run();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
		expect(messages()).toContain("Observational memory: consolidation already running (reflector); skipping manual run");
	});

	it("reports what the run changed", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, messages } = setup({ entries, reflectionsPoolTargetTokens: 1_000 });

		await run();

		expect(messages()[0]).toBe("Observational memory: consolidation started");
		expect(messages().at(-1)).toBe(
			"Observational memory: consolidation complete — 1 observation recorded, 1 reflection recorded",
		);
	});

	it("reports an unchanged ledger plainly", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, messages } = setup({ entries });

		await run();

		expect(messages().at(-1)).toBe("Observational memory: consolidation complete — no memory changes");
	});

	it("surfaces stage failures in the completion message", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("observer exploded"));
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, messages } = setup({ entries });

		await run();

		expect(messages().at(-1)).toBe(
			"Observational memory: consolidation complete — no memory changes; observer failed: observer exploded",
		);
	});

	it("summarizes counts from ledger deltas", () => {
		const before = { observations: 4, reflections: 2, droppedObservations: 1, droppedReflections: 0 };
		const after = { observations: 6, reflections: 3, droppedObservations: 4, droppedReflections: 2 };

		expect(summarizeConsolidation(before, after, [])).toBe(
			"Observational memory: consolidation complete — 2 observations recorded, 1 reflection recorded, 2 reflections dropped, 3 observations dropped",
		);
		expect(summarizeConsolidation(before, before, ["dropper failed: boom"])).toBe(
			"Observational memory: consolidation complete — no memory changes; dropper failed: boom",
		);
	});
	it("blocks until the run finishes before reporting", async () => {
		let resolveObserver: ((value: unknown) => void) | undefined;
		mockAgents.runObserver.mockImplementationOnce(() => new Promise((resolve) => {
			resolveObserver = resolve;
		}));
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, messages } = setup({ entries });

		const pending = run();
		await new Promise((resolve) => setImmediate(resolve));

		// Still mid-run: started, but no completion report yet.
		expect(messages()[0]).toBe("Observational memory: consolidation started");
		expect(messages().some((message) => message.includes("consolidation complete"))).toBe(false);

		resolveObserver?.([obsA]);
		await pending;

		expect(messages().at(-1)).toBe("Observational memory: consolidation complete — 1 observation recorded");
	});

	it("shows an animated footer status while running and clears it afterwards", async () => {
		vi.useFakeTimers();
		try {
			let resolveObserver: ((value: unknown) => void) | undefined;
			mockAgents.runObserver.mockImplementationOnce(() => new Promise((resolve) => {
				resolveObserver = resolve;
			}));
			const entries = [textCustomMessage("raw-1", "aaaa")];
			const { run, setStatus, statusTexts } = setup({ entries });

			const pending = run();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(360);

			const frames = statusTexts().filter((text): text is string => typeof text === "string");
			expect(frames.length).toBeGreaterThan(1);
			expect(frames[0]).toContain("consolidating memory");
			expect(frames.at(-1)).toContain("(observer)");
			// The spinner actually animates rather than repainting one frame.
			expect(new Set(frames.map((text) => text.slice(0, 1))).size).toBeGreaterThan(1);
			expect(setStatus.mock.calls.every((call) => call[0] === "om:consolidate")).toBe(true);

			resolveObserver?.(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await pending;

			expect(statusTexts().at(-1)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the footer status when a stage throws", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("observer exploded"));
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, statusTexts } = setup({ entries });

		await run();

		expect(statusTexts().at(-1)).toBeUndefined();
	});

	it("skips the footer status without UI but still runs and reports", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, setStatus, messages } = setup({ entries, hasUI: false });

		await run();

		expect(setStatus).not.toHaveBeenCalled();
		expect(messages().at(-1)).toBe("Observational memory: consolidation complete — 1 observation recorded");
	});
});
