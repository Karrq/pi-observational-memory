import { describe, expect, it } from "vitest";

import {
	normalizeDropReflectionIds,
	runReflectionDropper,
	selectReflectionDropCandidates,
} from "../src/agents/reflection-dropper/agent.js";
import { reflectionEvidenceMap } from "../src/agents/reflection-dropper/evidence.js";
import type { Observation, Reflection } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

function observationsById(observations: Observation[]): Map<string, Observation> {
	return new Map(observations.map((item) => [item.id, item]));
}

function evidenceFor(reflections: Reflection[], observations: Observation[], dropped: string[] = []) {
	return reflectionEvidenceMap(reflections, {
		observationsById: observationsById(observations),
		droppedObservationIds: new Set(dropped),
	});
}

describe("V3 reflection dropper agent", () => {
	const obsOld = observation("aaaaaaaaaaaa", { timestamp: "2026-01-02 09:00" }) as Observation;
	const obsNew = observation("bbbbbbbbbbbb", { timestamp: "2026-05-20 17:30" }) as Observation;
	// Rendered lines are 10 tokens each: "[<12 chars>] Reflection <12 chars>".
	const refOld = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]) as Reflection;
	const refNew = reflection("ffffffffffff", ["bbbbbbbbbbbb"]) as Reflection;
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [refOld, refNew],
		observations: [obsOld, obsNew],
		observationsById: observationsById([obsOld, obsNew]),
		droppedObservationIds: new Set<string>(),
		targetTokens: 10,
	};

	it("keeps the safety framing that separates durable facts from dated scope", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.messages[0]?.role === "system" ? context.messages[0].content : "";
		});

		await runReflectionDropper({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Default action is KEEP");
		expect(systemPrompt).toContain("When uncertain, keep");
		expect(systemPrompt).toContain("Durable versus dated");
		expect(systemPrompt).toContain("Age is not a reason to drop them");
		expect(systemPrompt).toContain("orphan risk");
		expect(systemPrompt).toContain("hard upper bound sized to move the pool toward target");
		expect(systemPrompt).toContain("It is not a target");
		expect(systemPrompt).toContain("Your only action is dropping");
		expect(systemPrompt).toContain("You cannot edit, merge, reword, or replace reflections");
	});

	it("shows pool pressure, evidence lines, and observations as orientation only", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runReflectionDropper({ ...baseArgs, agentLoop: loop });

		expect(userText).toContain("Reflection pool: ~20 tokens; target: ~10 tokens");
		expect(userText).toContain("fullness against target: ~200%");
		expect(userText).toContain("over target by ~10 tokens");
		expect(userText).toContain("Maximum drops allowed this run: 1 reflection");
		expect(userText).toContain("[eeeeeeeeeeee] [last evidence: 2026-01-02 09:00]");
		expect(userText).toContain("[orphan risk: 0]");
		expect(userText).toContain("orientation only; these are not drop candidates");
	});

	it("skips the model at or below target", async () => {
		let called = false;
		const loop = fakeAgentLoop(() => {
			called = true;
		});

		await expect(runReflectionDropper({ ...baseArgs, targetTokens: 20, agentLoop: loop })).resolves.toBeUndefined();
		expect(called).toBe(false);
	});

	it("normalizes proposed ids, filtering unknown ids and dedupes", () => {
		expect(normalizeDropReflectionIds(["ffffffffffff", "missing", "ffffffffffff", "eeeeeeeeeeee"], [refOld, refNew]))
			.toEqual(["ffffffffffff", "eeeeeeeeeeee"]);
		expect(normalizeDropReflectionIds(["missing"], [refOld, refNew])).toBeUndefined();
		expect(normalizeDropReflectionIds([], [refOld, refNew])).toBeUndefined();
	});

	it("ranks orphan-free candidates ahead of orphan-risk candidates", () => {
		const orphaning = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]) as Reflection;
		const safe = reflection("ffffffffffff", ["bbbbbbbbbbbb"]) as Reflection;
		const evidence = evidenceFor([orphaning, safe], [obsOld, obsNew], ["aaaaaaaaaaaa"]);

		// The orphaning reflection has older evidence, which would otherwise win.
		expect(selectReflectionDropCandidates(["eeeeeeeeeeee", "ffffffffffff"], [orphaning, safe], 1, evidence))
			.toEqual(["ffffffffffff"]);
	});

	it("prefers older evidence when orphan risk is equal", () => {
		const evidence = evidenceFor([refOld, refNew], [obsOld, obsNew]);

		expect(selectReflectionDropCandidates(["ffffffffffff", "eeeeeeeeeeee"], [refOld, refNew], 1, evidence))
			.toEqual(["eeeeeeeeeeee"]);
	});

	it("sorts unknown recency last, behind every dated reflection", () => {
		const unknown = reflection("999999999999", ["cccccccccccc"]) as Reflection;
		const evidence = evidenceFor([unknown, refNew], [obsNew]);

		expect(selectReflectionDropCandidates(["999999999999", "ffffffffffff"], [unknown, refNew], 1, evidence))
			.toEqual(["ffffffffffff"]);
	});

	it("caps accepted candidates at the pool-derived maximum", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["ffffffffffff", "missing", "eeeeeeeeeeee"] });
		});

		await expect(runReflectionDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["eeeeeeeeeeee"]);
	});

	it("dedupes ids across repeated tool calls", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["eeeeeeeeeeee"] });
			const second = await context.tools[0].execute("tool-2", { ids: ["eeeeeeeeeeee", "ffffffffffff"] });
			expect(second.details).toEqual({ added: 1, totalCandidates: 2, maxDropsAllowed: 2 });
		});

		await expect(runReflectionDropper({ ...baseArgs, targetTokens: 0, agentLoop: loop }))
			.resolves.toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
	});

	it("returns undefined when only unknown ids are proposed", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing"] });
		});

		await expect(runReflectionDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("returns undefined when the model drops nothing", async () => {
		const loop = fakeAgentLoop(() => {});

		await expect(runReflectionDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("returns undefined on an empty reflection pool without calling the model", async () => {
		let called = false;
		const loop = fakeAgentLoop(() => {
			called = true;
		});

		await expect(runReflectionDropper({ ...baseArgs, reflections: [], agentLoop: loop })).resolves.toBeUndefined();
		expect(called).toBe(false);
	});
	it("keeps the effort counterweight for a badly over-target pool", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.messages[0]?.role === "system" ? context.messages[0].content : "";
		});

		await runReflectionDropper({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Effort scales with pressure, the bar does not");
		expect(systemPrompt).toContain("work the whole list");
		expect(systemPrompt).toContain("Each individual drop still has to meet the bar above");
		expect(systemPrompt).toContain("a thorough pass that ends in few drops is a valid outcome");
		// The brake must survive alongside the accelerator.
		expect(systemPrompt).toContain("It is not a target");
		expect(systemPrompt).toContain("Do not try to fill it");
		expect(systemPrompt).toContain("Dropping nothing is the correct outcome");
	});
});
