import { describe, expect, it, vi } from "vitest";

import { SYSTEM_ONE_DROPPER_DEFAULTS, normalizeSystemOneDropper } from "../src/config.js";
import { evaluateSystemOne, SystemOneError } from "../src/agents/dropper/system-one/client.js";
import { chunkObservations, runSystemOneDropper, scoreObservations } from "../src/agents/dropper/system-one/agent.js";
import {
	SIGNAL_KEYS,
	buildQuestions,
	buildState,
	collectSignals,
	dropProbability,
	parseQuestionKey,
	questionKey,
	rankCandidates,
} from "../src/agents/dropper/system-one/questions.js";
import { reflectionCoverageMap } from "../src/agents/dropper/coverage.js";
import { observation, reflection } from "./fixtures/session.js";

type Signals = { floor: number; redundant: number; superseded: number; lowSignal: number; safety: number };

const SAFE: Signals = { floor: 0.02, redundant: 0.95, superseded: 0.1, lowSignal: 0.1, safety: 1 };

function answersFor(signalsById: Record<string, Partial<Signals>>): Record<string, any> {
	const answers: Record<string, any> = {};
	for (const [id, signals] of Object.entries(signalsById)) {
		for (const key of SIGNAL_KEYS) {
			const value = signals[key];
			if (value === undefined) continue;
			answers[questionKey(id, key)] = key === "safety"
				? { type: "score", score: value * 2 }
				: { type: "noul", noul: value };
		}
	}
	return answers;
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

describe("system one dropper config", () => {
	it("ignores a non-object block so the LLM dropper stays in place", () => {
		expect(normalizeSystemOneDropper(undefined)).toBeUndefined();
		expect(normalizeSystemOneDropper("https://api.typesafe.ai")).toBeUndefined();
	});

	it("fills every field from defaults and strips a trailing slash from the endpoint", () => {
		expect(normalizeSystemOneDropper({ endpoint: "http://localhost:8080/" })).toEqual({
			...SYSTEM_ONE_DROPPER_DEFAULTS,
			endpoint: "http://localhost:8080",
		});
	});

	it("scores every observation without deciding", async () => {
		const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
		const fetchImpl = vi.fn(async () => jsonResponse({
			model: "m",
			answers: answersFor({ aaaaaaaaaaaa: SAFE }),
		}));

		const result = await scoreObservations({
			config: { ...SYSTEM_ONE_DROPPER_DEFAULTS, endpoint: "http://localhost:8080" },
			reflections: [],
			observations: [obsA],
			targetTokens: 1,
			fetchImpl: fetchImpl as any,
		});

		expect(result.signalsById.get("aaaaaaaaaaaa")?.redundant).toBe(SAFE.redundant);
		expect(result.requestCount).toBe(1);
	});

	it("keeps a configured endpoint when a threshold is malformed", () => {
		const config = normalizeSystemOneDropper({
			endpoint: "http://localhost:8080",
			vetoThreshold: 1.7,
			dropThreshold: "high",
		});

		expect(config?.endpoint).toBe("http://localhost:8080");
		expect(config?.vetoThreshold).toBe(SYSTEM_ONE_DROPPER_DEFAULTS.vetoThreshold);
		expect(config?.dropThreshold).toBe(SYSTEM_ONE_DROPPER_DEFAULTS.dropThreshold);
	});

	it("accepts the boundary probabilities", () => {
		expect(normalizeSystemOneDropper({ vetoThreshold: 0, dropThreshold: 1 })).toMatchObject({
			vetoThreshold: 0,
			dropThreshold: 1,
		});
	});

	it("defaults to shadow so a new endpoint scores without changing any drop", () => {
		expect(normalizeSystemOneDropper({ endpoint: "http://localhost:8080" })?.mode).toBe("shadow");
		expect(normalizeSystemOneDropper({ mode: "primary" })?.mode).toBe("primary");
		expect(normalizeSystemOneDropper({ mode: "off" })?.mode).toBe("off");
		expect(normalizeSystemOneDropper({ mode: "enabled" })?.mode).toBe("shadow");
	});
});

describe("system one client", () => {
	const baseArgs = {
		endpoint: "https://api.typesafe.ai",
		model: "jev-latest",
		state: { a: 1 },
		questions: { "aaaaaaaaaaaa:floor": { type: "noul" as const, instructions: "q" } },
		timeoutMs: 1_000,
		sleep: async () => {},
	};

	it("posts to /v1/systemone with the bearer token and the documented body shape", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ model: "jev-1.13.0", answers: {} }));

		await evaluateSystemOne({ ...baseArgs, apiKey: "secret", fetchImpl: fetchImpl as any });

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
		expect(JSON.parse(init.body as string)).toEqual({
			state: { a: 1 },
			model: "jev-latest",
			questions: baseArgs.questions,
		});
	});

	it("omits the authorization header when no key is configured", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ model: "local", answers: {} }));

		await evaluateSystemOne({ ...baseArgs, fetchImpl: fetchImpl as any });

		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).authorization).toBeUndefined();
	});

	it("retries 429 honoring retry-after and returns the eventual answers", async () => {
		const delays: number[] = [];
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ error: "slow down" }, { status: 429, headers: { "retry-after": "2" } }))
			.mockResolvedValueOnce(jsonResponse({ model: "jev-1.13.0", answers: { x: { type: "noul", noul: 0.5 } } }));

		const result = await evaluateSystemOne({
			...baseArgs,
			fetchImpl: fetchImpl as any,
			sleep: async (ms) => { delays.push(ms); },
		});

		expect(delays).toEqual([2000]);
		expect(result.answers).toEqual({ x: { type: "noul", noul: 0.5 } });
	});

	it("does not retry a validation error and surfaces the status", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ detail: "bad question" }, { status: 422 }));

		await expect(evaluateSystemOne({ ...baseArgs, fetchImpl: fetchImpl as any }))
			.rejects.toMatchObject({ name: "SystemOneError", status: 422 });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("rejects a response without an answers map", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ model: "jev-1.13.0" }));

		await expect(evaluateSystemOne({ ...baseArgs, fetchImpl: fetchImpl as any }))
			.rejects.toBeInstanceOf(SystemOneError);
	});
});

describe("system one questions", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("asks one question per signal and round-trips the key", () => {
		const questions = buildQuestions("aaaaaaaaaaaa");

		expect(Object.keys(questions)).toHaveLength(SIGNAL_KEYS.length);
		expect(parseQuestionKey(questionKey("aaaaaaaaaaaa", "floor")))
			.toEqual({ observationId: "aaaaaaaaaaaa", signal: "floor" });
		expect(parseQuestionKey("aaaaaaaaaaaa:unknown")).toBeUndefined();
	});

	it("carries the preservation floor and the coverage tier into the request", () => {
		const floor = buildQuestions("aaaaaaaaaaaa")[questionKey("aaaaaaaaaaaa", "floor")];
		expect(JSON.stringify(floor.instructions)).toContain("exact error messages");

		const state = buildState([obsA], [ref], reflectionCoverageMap([obsA], [ref]));
		expect(state.observations[0]).toMatchObject({ id: "aaaaaaaaaaaa", reflectionCoverage: "partial" });
		expect(state.reflections[0].id).toBe("eeeeeeeeeeee");
	});

	it("normalizes a score answer onto [0, 1] and drops observations with a missing signal", () => {
		const complete = collectSignals(answersFor({ aaaaaaaaaaaa: SAFE }));
		expect(complete.get("aaaaaaaaaaaa")?.safety).toBe(1);

		const { safety, ...withoutSafety } = SAFE;
		expect(collectSignals(answersFor({ aaaaaaaaaaaa: withoutSafety })).size).toBe(0);
	});

	it("multiplies drop evidence by the safety rubric so one signal cannot carry a drop", () => {
		expect(dropProbability({ ...SAFE, redundant: 1, safety: 0.2 })).toBeCloseTo(0.2);
		expect(dropProbability({ ...SAFE, redundant: 0.2, safety: 1 })).toBeCloseTo(0.2);
	});
});

describe("system one candidate ranking", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });

	it("vetoes on the preservation floor even when every drop signal is certain", () => {
		const signals = collectSignals(answersFor({
			aaaaaaaaaaaa: { floor: 0.2, redundant: 1, superseded: 1, lowSignal: 1, safety: 1 },
		}));

		const ranked = rankCandidates([obsA], signals, 0.15, 0.75);

		expect(ranked.candidates).toEqual([]);
		expect(ranked.vetoedCount).toBe(1);
	});

	it("ranks by drop probability and excludes anything below the threshold", () => {
		const signals = collectSignals(answersFor({
			aaaaaaaaaaaa: { ...SAFE, redundant: 0.8, safety: 1 },
			bbbbbbbbbbbb: { ...SAFE, redundant: 1, safety: 1 },
		}));

		const ranked = rankCandidates([obsA, obsB], signals, 0.15, 0.85);

		expect(ranked.candidates.map((candidate) => candidate.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(ranked.belowThresholdCount).toBe(1);
	});

	it("counts observations the endpoint never scored instead of dropping them", () => {
		const ranked = rankCandidates([obsA, obsB], collectSignals(answersFor({ aaaaaaaaaaaa: SAFE })), 0.15, 0.75);

		expect(ranked.missingSignalsCount).toBe(1);
		expect(ranked.candidates.map((candidate) => candidate.id)).toEqual(["aaaaaaaaaaaa"]);
	});
});

describe("runSystemOneDropper", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium", tokenCount: 40 });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low", tokenCount: 40 });
	const baseArgs = {
		config: { ...SYSTEM_ONE_DROPPER_DEFAULTS, endpoint: "http://localhost:8080" },
		reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		observations: [obsA, obsB],
		targetTokens: 20,
	};

	it("returns undefined without calling the endpoint when the pool is under target", async () => {
		const fetchImpl = vi.fn();

		await expect(runSystemOneDropper({
			...baseArgs,
			targetTokens: 1_000_000,
			fetchImpl: fetchImpl as any,
		})).resolves.toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("drops the highest-probability candidate within the pool budget", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({
			model: "jev-1.13.0",
			answers: answersFor({
				aaaaaaaaaaaa: { ...SAFE, redundant: 1, safety: 1 },
				bbbbbbbbbbbb: { ...SAFE, redundant: 0.1, superseded: 0.1, lowSignal: 0.1, safety: 0.1 },
			}),
			usage: { input_tokens: 500 },
		}));

		await expect(runSystemOneDropper({ ...baseArgs, fetchImpl: fetchImpl as any }))
			.resolves.toEqual(["aaaaaaaaaaaa"]);
	});

	it("returns undefined when every observation is vetoed by the preservation floor", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({
			model: "jev-1.13.0",
			answers: answersFor({
				aaaaaaaaaaaa: { ...SAFE, floor: 0.9 },
				bbbbbbbbbbbb: { ...SAFE, floor: 0.9 },
			}),
		}));

		await expect(runSystemOneDropper({ ...baseArgs, fetchImpl: fetchImpl as any }))
			.resolves.toBeUndefined();
	});

	it("fans questions across requests while sending the whole pool as state each time", async () => {
		const states: unknown[] = [];
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			states.push(body.state);
			return jsonResponse({ model: "jev-1.13.0", answers: answersFor({ aaaaaaaaaaaa: SAFE }) });
		});

		await runSystemOneDropper({
			...baseArgs,
			config: { ...baseArgs.config, maxQuestionsPerRequest: SIGNAL_KEYS.length },
			fetchImpl: fetchImpl as any,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect((states[0] as any).observations).toHaveLength(2);
		expect(states[0]).toEqual(states[1]);
	});

	it("packs as many observations per request as the question budget allows", () => {
		const observations = Array.from({ length: 7 }, (_, index) =>
			observation(`${index}`.padStart(12, "a"), { relevance: "low" }));

		expect(chunkObservations(observations, SIGNAL_KEYS.length * 3).map((chunk) => chunk.length)).toEqual([3, 3, 1]);
		expect(chunkObservations(observations, 1).map((chunk) => chunk.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
	});
});
