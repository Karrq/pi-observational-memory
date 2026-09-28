import type { Observation, Reflection } from "../../session-ledger/index.js";

/**
 * Deterministic evidence attached to each active reflection before the
 * reflection dropper judges it.
 *
 * Reflections carry no timestamp of their own, so recency is derived from the
 * newest observation they cite. All recorded observations are used for that
 * lookup, including dropped ones, so a reflection whose evidence was pruned
 * long ago still reports when its evidence happened.
 */
export type ReflectionEvidence = {
	/** Raw timestamp of the newest supporting observation, or undefined when none resolves. */
	lastEvidenceTimestamp: string | undefined;
	/** Sort key for `lastEvidenceTimestamp`; unknown recency ranks newest so it is dropped last. */
	lastEvidenceRank: number;
	supportCount: number;
	activeSupportCount: number;
	droppedSupportCount: number;
	unknownSupportCount: number;
	/**
	 * Supporting observations that are already dropped from active memory and
	 * are cited by no other active reflection. Dropping this reflection would
	 * remove their durable meaning from active memory entirely, leaving only
	 * ledger history and `recall`.
	 */
	orphanCount: number;
};

export type ReflectionEvidenceInput = {
	/** All recorded observations by id, including dropped ones. */
	observationsById: ReadonlyMap<string, Observation>;
	droppedObservationIds: ReadonlySet<string>;
};

function timestampRank(timestamp: string | undefined): number {
	if (!timestamp) return Number.POSITIVE_INFINITY;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function supportCountsByObservationId(reflections: readonly Reflection[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const reflection of reflections) {
		for (const observationId of new Set(reflection.supportingObservationIds)) {
			counts.set(observationId, (counts.get(observationId) ?? 0) + 1);
		}
	}
	return counts;
}

export function reflectionEvidenceMap(
	reflections: readonly Reflection[],
	input: ReflectionEvidenceInput,
): Map<string, ReflectionEvidence> {
	const supportCounts = supportCountsByObservationId(reflections);
	const evidence = new Map<string, ReflectionEvidence>();

	for (const reflection of reflections) {
		const supportingIds = Array.from(new Set(reflection.supportingObservationIds));
		let lastEvidenceTimestamp: string | undefined;
		let lastEvidenceRank = Number.NEGATIVE_INFINITY;
		let activeSupportCount = 0;
		let droppedSupportCount = 0;
		let unknownSupportCount = 0;
		let orphanCount = 0;

		for (const observationId of supportingIds) {
			const observation = input.observationsById.get(observationId);
			if (!observation) {
				unknownSupportCount++;
				continue;
			}
			const rank = timestampRank(observation.timestamp);
			if (Number.isFinite(rank) && rank > lastEvidenceRank) {
				lastEvidenceRank = rank;
				lastEvidenceTimestamp = observation.timestamp;
			}
			if (input.droppedObservationIds.has(observationId)) {
				droppedSupportCount++;
				// Only this reflection still carries the dropped observation's meaning.
				if ((supportCounts.get(observationId) ?? 0) <= 1) orphanCount++;
				continue;
			}
			activeSupportCount++;
		}

		evidence.set(reflection.id, {
			lastEvidenceTimestamp,
			lastEvidenceRank: lastEvidenceTimestamp === undefined ? Number.POSITIVE_INFINITY : lastEvidenceRank,
			supportCount: supportingIds.length,
			activeSupportCount,
			droppedSupportCount,
			unknownSupportCount,
			orphanCount,
		});
	}

	return evidence;
}

export function evidenceForReflection(
	reflection: Reflection,
	evidenceById: ReadonlyMap<string, ReflectionEvidence>,
): ReflectionEvidence {
	return evidenceById.get(reflection.id) ?? {
		lastEvidenceTimestamp: undefined,
		lastEvidenceRank: Number.POSITIVE_INFINITY,
		supportCount: 0,
		activeSupportCount: 0,
		droppedSupportCount: 0,
		unknownSupportCount: 0,
		orphanCount: 0,
	};
}

export function reflectionToDropperLine(
	reflection: Reflection,
	evidence: ReflectionEvidence,
): string {
	const lastEvidence = evidence.lastEvidenceTimestamp ?? "unknown";
	return (
		`[${reflection.id}] [last evidence: ${lastEvidence}]`
		+ ` [support: ${evidence.activeSupportCount} active, ${evidence.droppedSupportCount} dropped]`
		+ ` [orphan risk: ${evidence.orphanCount}] ${reflection.content}`
	);
}

export type ReflectionEvidenceSummary = {
	reflectionCount: number;
	withOrphanRisk: number;
	orphanTotal: number;
	unknownRecency: number;
	totalSupportIds: number;
	droppedSupportIds: number;
};

export function summarizeReflectionEvidence(
	reflections: readonly Reflection[],
	evidenceById: ReadonlyMap<string, ReflectionEvidence>,
): ReflectionEvidenceSummary {
	const summary: ReflectionEvidenceSummary = {
		reflectionCount: reflections.length,
		withOrphanRisk: 0,
		orphanTotal: 0,
		unknownRecency: 0,
		totalSupportIds: 0,
		droppedSupportIds: 0,
	};
	for (const reflection of reflections) {
		const evidence = evidenceForReflection(reflection, evidenceById);
		if (evidence.orphanCount > 0) summary.withOrphanRisk++;
		summary.orphanTotal += evidence.orphanCount;
		if (evidence.lastEvidenceTimestamp === undefined) summary.unknownRecency++;
		summary.totalSupportIds += evidence.supportCount;
		summary.droppedSupportIds += evidence.droppedSupportCount;
	}
	return summary;
}
