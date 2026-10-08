#!/usr/bin/env node
// Re-score "unscored" drop-score rows against a now-working endpoint, one dropper
// run at a time.
//
// Usage: npx tsx scripts/backfill-drop-scores.mjs \
//   <sessionJsonlPath> <dropScoresNdjsonPath> <endpoint> <model>
//
// A run's pool comes from the score log itself: `recordDropScores` writes one row
// per observation the dropper saw, so a group's observation ids are exactly that
// pool, and the session file supplies the text. No ledger replay or drop-event
// matching is involved, which removes the alignment failures that hit sessions
// where a drop event had no matching score group.

import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { scoreObservations } from "../src/agents/dropper/system-one/agent.js";

const [sessionPath, scoresPath, endpoint, model] = process.argv.slice(2);
if (!sessionPath || !scoresPath || !endpoint || !model) {
	console.error("usage: backfill-drop-scores.mjs <session.jsonl> <scores.ndjson> <endpoint> <model>");
	process.exit(1);
}

const VETO_THRESHOLD = 0.15;
const DROP_THRESHOLD = 0.75;
const MAX_QUESTIONS_PER_REQUEST = 250;
// Stop after this many scoring runs, so a batch can be bounded to a time budget.
// Resumable: a later invocation skips the runs already scored. 0 or unset = no cap.
const MAX_SCORING_RUNS = Number(process.env.OM_BACKFILL_MAX_RUNS ?? 0) || Number.POSITIVE_INFINITY;
// Undici's fetch caps header wait at 300s, which a queued server can exceed. Talk
// HTTP directly so a request can outlast a busy server queue. Override with env.
const REQUEST_TIMEOUT_MS = Number(process.env.OM_BACKFILL_TIMEOUT_MS ?? 3_600_000);

/** POST one System One request, waiting as long as REQUEST_TIMEOUT_MS for headers. */
function postSystemOne(url, body) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const data = JSON.stringify(body);
		const request = httpRequest(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						reject(new Error(`System One request to ${url} failed with ${response.statusCode} ${text.slice(0, 400)}`));
						return;
					}
					try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
				});
			},
		);
		request.setTimeout(REQUEST_TIMEOUT_MS, () =>
			request.destroy(new Error(`System One request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
		request.on("error", reject);
		request.end(data);
	});
}

/**
 * The script runs outside pi, so it cannot use ctx.modelRegistry. It speaks the
 * same classifier contract directly, mapping pi's `bool` questions to the wire's
 * `noul` and back.
 */
function httpRegistry(url, model) {
	const endpoint = `${url.replace(/\/+$/, "")}/v1/systemone`;
	const classifierModel = { provider: "local-jev", id: model };
	return {
		getModelsOfType: (type, provider) => (type === "classifier" && provider === "local-jev" ? [classifierModel] : []),
		findOfType: (type, provider, id) =>
			type === "classifier" && provider === "local-jev" && id === model ? classifierModel : undefined,
		classify: async (_model, context) => {
			const questions = Object.fromEntries(
				Object.entries(context.questions).map(([id, question]) =>
					[id, question.type === "bool" ? { ...question, type: "noul" } : question]),
			);
			const payload = await postSystemOne(endpoint, { state: context.state, model, questions });
			const answers = {};
			for (const [id, answer] of Object.entries(payload.answers ?? {})) {
				answers[id] = answer.type === "noul" ? { type: "bool", probability: answer.noul } : answer;
			}
			return { answers, stopReason: "stop", usage: { input: payload.usage?.input_tokens, output: payload.usage?.output_tokens } };
		},
	};
}

function dropProbability(signals) {
	return Math.max(signals.redundant, signals.superseded, signals.lowSignal) * signals.safety;
}

/**
 * Everything the session ever recorded: observation text by id, reflection text by
 * id, and the times reflections were added or dropped, so the reflection set of a
 * past run can be reconstructed.
 */
function loadMemory(sessionPath) {
	const observations = new Map();
	const reflections = new Map();
	const reflectionEvents = []; // { ts, add? , drop? }, timestamp-ordered

	for (const line of readFileSync(sessionPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const data = entry.data ?? {};
		if (entry.type === "custom" && entry.customType === "om.observations.recorded") {
			for (const observation of data.observations ?? []) observations.set(observation.id, observation);
		} else if (entry.type === "custom" && entry.customType === "om.reflections.recorded") {
			for (const reflection of data.reflections ?? []) {
				reflections.set(reflection.id, reflection);
				reflectionEvents.push({ ts: entry.timestamp, add: reflection.id });
			}
		} else if (entry.type === "custom" && entry.customType === "om.reflections.dropped") {
			for (const id of data.reflectionIds ?? []) reflectionEvents.push({ ts: entry.timestamp, drop: id });
		} else if (entry.type === "compaction" && entry.details?.type === "om.folded" && entry.details?.version === 1) {
			// Fallback text for anything a truncated branch no longer carries directly.
			for (const observation of entry.details.observations ?? []) if (!observations.has(observation.id)) observations.set(observation.id, observation);
			for (const reflection of entry.details.reflections ?? []) if (!reflections.has(reflection.id)) reflections.set(reflection.id, reflection);
		}
	}

	reflectionEvents.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return { observations, reflections, reflectionEvents };
}

/** Reflections active at ts: recorded at or before ts, minus those dropped at or before. */
function reflectionsAt(memory, ts) {
	const active = new Set();
	for (const event of memory.reflectionEvents) {
		if (event.ts > ts) break;
		if (event.add) active.add(event.add);
		else if (event.drop) active.delete(event.drop);
	}
	return [...active].map((id) => memory.reflections.get(id)).filter(Boolean);
}

function groupByTs(rows) {
	const order = [];
	const byTs = new Map();
	for (const row of rows) {
		if (!byTs.has(row.ts)) {
			byTs.set(row.ts, []);
			order.push(row.ts);
		}
		byTs.get(row.ts).push(row);
	}
	return order.map((ts) => ({ ts, rows: byTs.get(ts) }));
}

const memory = loadMemory(sessionPath);
const rawLines = readFileSync(scoresPath, "utf-8").split("\n").filter((l) => l.trim());
const rows = rawLines.map((l) => JSON.parse(l));
const runGroups = groupByTs(rows);

const updatedByKey = new Map(); // `${ts}:${observationId}` -> patch fields
let scoringRuns = 0;

for (let i = 0; i < runGroups.length; i++) {
	const group = runGroups[i];
	const unscored = group.rows.filter((r) => r.systemOneDecision === "unscored");
	if (unscored.length === 0) {
		console.error(`run ${i} (${group.ts}): nothing to backfill`);
		continue;
	}
	if (scoringRuns >= MAX_SCORING_RUNS) {
		const remaining = runGroups.slice(i).filter((g) => g.rows.some((r) => r.systemOneDecision === "unscored")).length;
		console.error(`run ${i} (${group.ts}): reached OM_BACKFILL_MAX_RUNS=${MAX_SCORING_RUNS}, stopping (${remaining} scoring run(s) left)`);
		break;
	}

	const missingIds = group.rows.filter((r) => !memory.observations.has(r.observationId)).map((r) => r.observationId);
	if (missingIds.length > 0) {
		console.error(`run ${i} (${group.ts}): ${missingIds.length} observation(s) have no recorded content, skipping`);
		continue;
	}

	scoringRuns++;
	const pool = group.rows.map((r) => memory.observations.get(r.observationId));
	const reflections = reflectionsAt(memory, group.ts);
	console.error(`run ${i} (${group.ts}): scoring ${unscored.length} of ${pool.length} observation(s), ${reflections.length} reflection(s) against ${endpoint} ...`);
	const t0 = Date.now();
	const { signalsById } = await scoreObservations({
		config: {
			mode: "primary",
			provider: "local-jev",
			model,
			vetoThreshold: VETO_THRESHOLD,
			dropThreshold: DROP_THRESHOLD,
			maxQuestionsPerRequest: MAX_QUESTIONS_PER_REQUEST,
			requestTimeoutMs: REQUEST_TIMEOUT_MS,
		},
		registry: httpRegistry(endpoint, model),
		reflections,
		observations: pool,
		targetTokens: 0,
	});
	console.error(`run ${i}: scored in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${signalsById.size} usable signal sets`);

	for (const row of unscored) {
		const signals = signalsById.get(row.observationId);
		if (!signals) continue;
		const probability = dropProbability(signals);
		const systemOneDecision =
			signals.floor >= VETO_THRESHOLD ? "vetoed" : probability >= DROP_THRESHOLD ? "drop" : "keep";
		updatedByKey.set(`${row.ts}:${row.observationId}`, { signals, dropProbability: probability, systemOneDecision });
	}
}

// Re-read at write time rather than rewriting the start-of-run snapshot: a live
// session can append to this same log while we score, and rewriting the whole
// file from the old copy would clobber those rows. Patches are keyed by
// `ts:observationId`, which a later run never reuses, so only rows from our
// snapshot are touched and anything appended since is preserved verbatim.
const currentLines = readFileSync(scoresPath, "utf-8").split("\n").filter((line) => line.trim());
let patchedCount = 0;
const mergedLines = currentLines.map((line) => {
	let row;
	try {
		row = JSON.parse(line);
	} catch {
		return line;
	}
	const patch = updatedByKey.get(`${row.ts}:${row.observationId}`);
	if (!patch) return line;
	patchedCount++;
	return JSON.stringify({ ...row, ...patch });
});

writeFileSync(scoresPath, mergedLines.join("\n") + "\n", "utf-8");
console.error(`wrote ${mergedLines.length} rows (${patchedCount} backfilled) to ${scoresPath}`);
