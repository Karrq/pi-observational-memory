import { describe, expect, it } from "vitest";

import {
	reflectionEvidenceMap,
	reflectionToDropperLine,
	summarizeReflectionEvidence,
} from "../src/agents/reflection-dropper/evidence.js";
import type { Observation, Reflection } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

function byId(observations: Observation[]): Map<string, Observation> {
	return new Map(observations.map((item) => [item.id, item]));
}

describe("reflection evidence", () => {
	const old = observation("aaaaaaaaaaaa", { timestamp: "2026-01-02 09:00" }) as Observation;
	const recent = observation("bbbbbbbbbbbb", { timestamp: "2026-05-20 17:30" }) as Observation;

	it("derives recency from the newest supporting observation", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) as Reflection;
		const evidence = reflectionEvidenceMap([ref], {
			observationsById: byId([old, recent]),
			droppedObservationIds: new Set(),
		});

		expect(evidence.get("eeeeeeeeeeee")?.lastEvidenceTimestamp).toBe("2026-05-20 17:30");
		expect(evidence.get("eeeeeeeeeeee")?.activeSupportCount).toBe(2);
		expect(evidence.get("eeeeeeeeeeee")?.droppedSupportCount).toBe(0);
	});

	it("derives recency from dropped observations too, so pruned evidence still dates the reflection", () => {
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"]) as Reflection;
		const evidence = reflectionEvidenceMap([ref], {
			observationsById: byId([old, recent]),
			droppedObservationIds: new Set(["bbbbbbbbbbbb"]),
		});

		expect(evidence.get("eeeeeeeeeeee")?.lastEvidenceTimestamp).toBe("2026-05-20 17:30");
		expect(evidence.get("eeeeeeeeeeee")?.droppedSupportCount).toBe(1);
		expect(evidence.get("eeeeeeeeeeee")?.activeSupportCount).toBe(0);
	});

	it("ranks unknown recency as newest so it is never preferred for dropping", () => {
		const ref = reflection("eeeeeeeeeeee", ["cccccccccccc"]) as Reflection;
		const evidence = reflectionEvidenceMap([ref], {
			observationsById: byId([old]),
			droppedObservationIds: new Set(),
		});

		expect(evidence.get("eeeeeeeeeeee")?.lastEvidenceTimestamp).toBeUndefined();
		expect(evidence.get("eeeeeeeeeeee")?.lastEvidenceRank).toBe(Number.POSITIVE_INFINITY);
		expect(evidence.get("eeeeeeeeeeee")?.unknownSupportCount).toBe(1);
	});

	it("counts a dropped observation as an orphan only when no other reflection carries it", () => {
		const soleCarrier = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]) as Reflection;
		const shared = reflection("ffffffffffff", ["bbbbbbbbbbbb"]) as Reflection;
		const alsoShared = reflection("999999999999", ["bbbbbbbbbbbb"]) as Reflection;
		const evidence = reflectionEvidenceMap([soleCarrier, shared, alsoShared], {
			observationsById: byId([old, recent]),
			droppedObservationIds: new Set(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]),
		});

		expect(evidence.get("eeeeeeeeeeee")?.orphanCount).toBe(1);
		expect(evidence.get("ffffffffffff")?.orphanCount).toBe(0);
		expect(evidence.get("999999999999")?.orphanCount).toBe(0);
	});

	it("does not treat still-active supporting observations as orphan risk", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]) as Reflection;
		const evidence = reflectionEvidenceMap([ref], {
			observationsById: byId([old]),
			droppedObservationIds: new Set(),
		});

		expect(evidence.get("eeeeeeeeeeee")?.orphanCount).toBe(0);
	});

	it("renders evidence into the dropper line", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], { content: "User ships on Fridays" }) as Reflection;
		const evidence = reflectionEvidenceMap([ref], {
			observationsById: byId([old, recent]),
			droppedObservationIds: new Set(["aaaaaaaaaaaa"]),
		});

		expect(reflectionToDropperLine(ref, evidence.get("eeeeeeeeeeee")!)).toBe(
			"[eeeeeeeeeeee] [last evidence: 2026-05-20 17:30] [support: 1 active, 1 dropped] [orphan risk: 1] User ships on Fridays",
		);
	});

	it("summarizes evidence for the debug log", () => {
		const orphaning = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]) as Reflection;
		const safe = reflection("ffffffffffff", ["bbbbbbbbbbbb"]) as Reflection;
		const evidence = reflectionEvidenceMap([orphaning, safe], {
			observationsById: byId([old, recent]),
			droppedObservationIds: new Set(["aaaaaaaaaaaa"]),
		});

		expect(summarizeReflectionEvidence([orphaning, safe], evidence)).toEqual({
			reflectionCount: 2,
			withOrphanRisk: 1,
			orphanTotal: 1,
			unknownRecency: 0,
			totalSupportIds: 2,
			droppedSupportIds: 1,
		});
	});
});
