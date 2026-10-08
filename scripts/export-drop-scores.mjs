#!/usr/bin/env node
// Export drop-score rows joined with observation text, straight from session
// files, without opening each session in pi.
//
//   npx tsx scripts/export-drop-scores.mjs [options] [sessionIdOrPath ...]
//
// Options:
//   --out <path>           output JSONL for observation drop scores (default om-drop-scores.jsonl)
//   --reflections          also write reflection drop scores (default om-reflection-drop-scores.jsonl)
//   --reflections-out <p>  path for the reflection export
//   --agent-dir <dir>      override ~/.pi/agent (or set PI_AGENT_DIR)
//   --sessions-dir <dir>   override <agent-dir>/sessions
//   --quiet                print only the final summary
//
// With no positional arguments it exports every session that has a drop-score log.
// Positional arguments are session ids or session .jsonl / drop-score .ndjson paths.
//
// Difference from /om:export-drops: the command joins against `fullProjection`,
// which drops observations the dropper removed and therefore loses most rows it
// is meant to label. This joins against every observation ever recorded on the
// branch (recorded entries plus folded compaction details), so a row whose
// observation was dropped still exports its text.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	isMemoryDetails,
} from "../src/session-ledger/types.js";

const DROP_SCORES_DIR = "observational-memory/drop-scores";
const REFLECTION_DROP_SCORES_DIR = "observational-memory/reflection-drop-scores";

function parseArgs(argv) {
	const opts = {
		out: "om-drop-scores.jsonl",
		reflections: false,
		reflectionsOut: "om-reflection-drop-scores.jsonl",
		quiet: false,
		agentDir: process.env.PI_AGENT_DIR ? resolve(process.env.PI_AGENT_DIR.replace(/^~/, homedir())) : join(homedir(), ".pi", "agent"),
		sessionsDir: undefined,
		inputs: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") opts.out = argv[++i];
		else if (arg === "--reflections") opts.reflections = true;
		else if (arg === "--reflections-out") { opts.reflectionsOut = argv[++i]; opts.reflections = true; }
		else if (arg === "--agent-dir") opts.agentDir = argv[++i];
		else if (arg === "--sessions-dir") opts.sessionsDir = argv[++i];
		else if (arg === "--quiet") opts.quiet = true;
		else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
		else if (arg.startsWith("-")) { console.error(`Unknown option: ${arg}`); process.exit(2); }
		else opts.inputs.push(arg);
	}
	opts.sessionsDir = opts.sessionsDir ?? join(opts.agentDir, "sessions");
	return opts;
}

function printHelp() {
	console.log(`Usage: npx tsx scripts/export-drop-scores.mjs [options] [sessionIdOrPath ...]

  --out <path>           observation export (default om-drop-scores.jsonl)
  --reflections          also export reflection drop scores
  --reflections-out <p>  reflection export path
  --agent-dir <dir>      override ~/.pi/agent (env PI_AGENT_DIR)
  --sessions-dir <dir>   override <agent-dir>/sessions
  --quiet                only the final summary`);
}

function readJsonl(path) {
	const rows = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// A truncated final line from an interrupted write is expected; skip it.
		}
	}
	return rows;
}

/** Walk the sessions tree once and index each session file by the id in its name. */
function indexSessionFiles(sessionsDir) {
	const byId = new Map();
	const stack = [sessionsDir];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const stem = entry.name.slice(0, -".jsonl".length);
				const id = stem.slice(stem.lastIndexOf("_") + 1);
				if (id) byId.set(id, full);
			}
		}
	}
	return byId;
}

function sessionIdOf(entries) {
	const header = entries.find((entry) => entry?.type === "session");
	return header?.id;
}

/**
 * Every observation and reflection the branch ever recorded, keyed by id.
 * Recorded entries are the source of truth; folded compaction details are a
 * fallback for anything a truncated branch no longer carries directly.
 */
function collectMemory(entries) {
	const observations = new Map();
	const reflections = new Map();
	for (const entry of entries) {
		if (isObservationsRecordedEntry(entry)) for (const observation of entry.data.observations) observations.set(observation.id, observation);
		else if (isReflectionsRecordedEntry(entry)) for (const reflection of entry.data.reflections) reflections.set(reflection.id, reflection);
		else if (entry?.type === "compaction" && isMemoryDetails(entry.details)) {
			for (const observation of entry.details.observations) if (!observations.has(observation.id)) observations.set(observation.id, observation);
			for (const reflection of entry.details.reflections) if (!reflections.has(reflection.id)) reflections.set(reflection.id, reflection);
		}
	}
	return { observations, reflections };
}

function buildObservationRows(rows, observations, reflections) {
	const supporting = new Map();
	for (const reflection of reflections.values()) {
		for (const id of reflection.supportingObservationIds) {
			const list = supporting.get(id) ?? [];
			list.push(reflection.content);
			supporting.set(id, list);
		}
	}
	const exported = [];
	let missing = 0;
	for (const row of rows) {
		const observation = observations.get(row.observationId);
		if (!observation) { missing++; continue; }
		exported.push({
			...row,
			content: observation.content,
			timestamp: observation.timestamp,
			supportingReflections: supporting.get(row.observationId) ?? [],
			label: "",
		});
	}
	return { exported, missing };
}

function buildReflectionRows(rows, reflections) {
	const exported = [];
	let missing = 0;
	for (const row of rows) {
		const reflection = reflections.get(row.reflectionId);
		if (!reflection) { missing++; continue; }
		exported.push({ ...row, content: reflection.content, label: "" });
	}
	return { exported, missing };
}

function writeJsonl(path, rows) {
	const target = resolve(path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf-8");
	return target;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const sessionFiles = indexSessionFiles(opts.sessionsDir);

	// Resolve the requested sessions: explicit ids/paths, else every session with a log.
	const remembered = existsSync(join(opts.agentDir, DROP_SCORES_DIR))
		? readdirSync(join(opts.agentDir, DROP_SCORES_DIR)).filter((name) => name.endsWith(".ndjson")).map((name) => name.slice(0, -".ndjson".length))
		: [];
	const requested = opts.inputs.length
		? opts.inputs.map((input) => {
			const stem = basename(input).replace(/\.(jsonl|ndjson)$/, "");
			return stem.includes("_") ? stem.slice(stem.lastIndexOf("_") + 1) : stem;
		})
		: remembered;

	const unique = [...new Set(requested)];
	if (unique.length === 0) {
		console.error(`No drop-score logs under ${join(opts.agentDir, DROP_SCORES_DIR)}`);
		process.exit(1);
	}

	const observationRows = [];
	const reflectionRows = [];
	const missingSessions = [];
	const stats = [];
	let totalObsMissing = 0;
	let totalRefMissing = 0;

	for (const sessionId of unique) {
		const sessionFile = sessionFiles.get(sessionId);
		if (!sessionFile) { missingSessions.push(sessionId); continue; }
		const entries = readJsonl(sessionFile);
		if (sessionIdOf(entries) !== sessionId) { missingSessions.push(sessionId); continue; }
		const { observations, reflections } = collectMemory(entries);

		const obsScoresPath = join(opts.agentDir, DROP_SCORES_DIR, `${sessionId}.ndjson`);
		const obsScores = existsSync(obsScoresPath) ? readJsonl(obsScoresPath) : [];
		const { exported, missing } = buildObservationRows(obsScores, observations, reflections);
		observationRows.push(...exported);
		totalObsMissing += missing;

		let refMissing = 0;
		if (opts.reflections) {
			const refScoresPath = join(opts.agentDir, REFLECTION_DROP_SCORES_DIR, `${sessionId}.ndjson`);
			const refScores = existsSync(refScoresPath) ? readJsonl(refScoresPath) : [];
			const built = buildReflectionRows(refScores, reflections);
			reflectionRows.push(...built.exported);
			refMissing = built.missing;
			totalRefMissing += refMissing;
		}

		const scored = exported.filter((row) => row.signals !== undefined);
		const labelled = exported.filter((row) => row.llmDecision !== undefined);
		const agreed = labelled.filter((row) => row.llmDecision === (row.systemOneDecision === "drop" ? "drop" : "keep"));
		stats.push({ sessionId, rows: exported.length, missing, scored: scored.length, labelled: labelled.length, agreed: agreed.length });
		if (!opts.quiet) {
			console.log(`${String(exported.length).padStart(6)} rows  ${String(scored.length).padStart(5)} scored  ${String(missing).padStart(5)} missing  ${sessionId}`);
		}
	}

	const outPath = writeJsonl(opts.out, observationRows);
	const scored = observationRows.filter((row) => row.signals !== undefined);
	const labelled = observationRows.filter((row) => row.llmDecision !== undefined);
	const agreed = labelled.filter((row) => row.llmDecision === (row.systemOneDecision === "drop" ? "drop" : "keep"));

	console.log("");
	console.log(`Exported ${observationRows.length} row${observationRows.length === 1 ? "" : "s"} from ${stats.length} session${stats.length === 1 ? "" : "s"} (${scored.length} scored by the endpoint).`);
	if (labelled.length > 0) {
		console.log(`Endpoint agreed with the LLM dropper on ${agreed.length} of ${labelled.length} labelled rows (${Math.round((agreed.length / labelled.length) * 100)}%).`);
	} else {
		console.log("No LLM dropper verdicts recorded. Run in shadow mode to collect distillation labels.");
	}
	if (totalObsMissing > 0) console.log(`${totalObsMissing} observation row${totalObsMissing === 1 ? "" : "s"} had no recorded observation and were skipped.`);
	console.log(`Written to ${outPath}.`);

	if (opts.reflections) {
		const refPath = writeJsonl(opts.reflectionsOut, reflectionRows);
		console.log(`Exported ${reflectionRows.length} reflection row${reflectionRows.length === 1 ? "" : "s"}.`);
		if (totalRefMissing > 0) console.log(`${totalRefMissing} reflection row${totalRefMissing === 1 ? "" : "s"} had no recorded reflection and were skipped.`);
		console.log(`Written to ${refPath}.`);
	}

	if (missingSessions.length > 0) {
		console.log(`No session file found for: ${missingSessions.join(", ")}`);
	}
}

main();
