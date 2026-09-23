import { describe, expect, it } from "vitest";

import { reflectionPoolMetrics, reflectionTokenSum } from "../src/agents/reflection-dropper/pool.js";
import { reflection } from "./fixtures/session.js";

// "[<12-char id>] <content>" at ~4 chars per token.
function reflectionOfTokens(id: string, tokens: number) {
	const contentLength = tokens * 4 - "[000000000000] ".length;
	return reflection(id, ["aaaaaaaaaaaa"], { content: "x".repeat(contentLength) });
}

describe("reflection pool metrics", () => {
	it("counts the rendered line, not the stored content tokenCount", () => {
		// content "Reflection eeeeeeeeeeee" renders as 38 chars with the id prefix.
		const stored = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { tokenCount: 3 });

		expect(reflectionTokenSum([stored])).toBe(10);
	});

	it("reports an under-target pool as not ready", () => {
		const metrics = reflectionPoolMetrics([reflectionOfTokens("aaaaaaaaaaaa", 10)], 100);

		expect(metrics.reflectionTokens).toBe(10);
		expect(metrics.overTarget).toBe(false);
		expect(metrics.ready).toBe(false);
		expect(metrics.maxDropsAllowed).toBe(0);
		expect(metrics.tokensOverTarget).toBe(0);
		expect(metrics.fullness).toBeCloseTo(0.1);
	});

	it("sizes max drops from the token excess above target", () => {
		const reflections = Array.from({ length: 10 }, (_, index) =>
			reflectionOfTokens(`${index}`.padStart(12, "a"), 10),
		);

		expect(reflectionPoolMetrics(reflections, 100).maxDropsAllowed).toBe(0);
		expect(reflectionPoolMetrics(reflections, 90).maxDropsAllowed).toBe(1);
		expect(reflectionPoolMetrics(reflections, 50).maxDropsAllowed).toBe(5);
		expect(reflectionPoolMetrics(reflections, 0).maxDropsAllowed).toBe(10);
	});

	it("is ready only when over target with at least one allowed drop", () => {
		const metrics = reflectionPoolMetrics([reflectionOfTokens("aaaaaaaaaaaa", 20)], 10);

		expect(metrics.overTarget).toBe(true);
		expect(metrics.ready).toBe(true);
		expect(metrics.tokensOverTarget).toBe(10);
		expect(metrics.fullness).toBe(2);
		expect(metrics.activeReflectionCount).toBe(1);
	});

	it("stays inert on an empty pool and on an unusable target", () => {
		expect(reflectionPoolMetrics([], 10).ready).toBe(false);
		expect(reflectionPoolMetrics([reflectionOfTokens("aaaaaaaaaaaa", 20)], Number.NaN).ready).toBe(false);
		expect(reflectionPoolMetrics([reflectionOfTokens("aaaaaaaaaaaa", 20)], -1).ready).toBe(false);
	});
});
