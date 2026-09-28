import { maxDropCountForPool, observationPoolFullness } from "../dropper/pool.js";
import { reflectionLineTokenCount } from "../../tokens.js";
import type { Reflection } from "../../session-ledger/index.js";

export type ReflectionPoolMetrics = {
	reflectionTokens: number;
	targetTokens: number;
	tokensOverTarget: number;
	fullness: number;
	activeReflectionCount: number;
	maxDropsAllowed: number;
	overTarget: boolean;
	ready: boolean;
};

export function reflectionTokenSum(reflections: readonly Reflection[]): number {
	// Count the full rendered line (id + content), not bare content: the pool
	// budget caps how much reflection text is re-rendered into every future
	// compacted context, and each line carries its id prefix.
	return reflections.reduce((sum, reflection) => sum + reflectionLineTokenCount(reflection), 0);
}

export function reflectionPoolMetrics(
	reflections: readonly Reflection[],
	targetTokens: number,
): ReflectionPoolMetrics {
	const reflectionTokens = reflectionTokenSum(reflections);
	const fullness = observationPoolFullness(reflectionTokens, targetTokens);
	const activeReflectionCount = reflections.length;
	const tokensOverTarget = Math.max(0, reflectionTokens - targetTokens);
	const maxDropsAllowed = maxDropCountForPool(reflections, reflectionTokens, targetTokens);
	const overTarget = Number.isFinite(targetTokens) && targetTokens >= 0 && reflectionTokens > targetTokens;
	return {
		reflectionTokens,
		targetTokens,
		tokensOverTarget,
		fullness,
		activeReflectionCount,
		maxDropsAllowed,
		overTarget,
		ready: overTarget && maxDropsAllowed > 0,
	};
}
