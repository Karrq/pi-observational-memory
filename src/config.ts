import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/**
 * The two ways a token threshold can be expressed.
 *
 * - `"calibrated"` (default): use the static token value directly.
 *   Backwards-compatible with all existing V3 configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * value)`. This auto-scales the trigger to the
 *   active model's context window, so a 1M context model is not preempted at
 *   the same absolute threshold as a 128K model.
 *
 *   Some models advertise a large context window but lose attention at long
 *   range; users can lower the ratio to fire earlier on such models without
 *   giving up the window on models that stay sharp.
 *
 *   When the active model's `contextWindow` is unavailable (undefined, 0, or
 *   negative), ratio mode falls back to the corresponding default token value
 *   so the trigger still fires safely.
 *
 * The union is deliberately discriminated on `type` so adding a new strategy
 * is a compile-time exhaustive check at every `switch` over it.
 */
export type TokenThresholdType = "calibrated" | "ratio";

export type TokenThreshold =
	| { type: "calibrated"; value: number }
	| { type: "ratio"; value: number };

/** Legacy flat settings keys, still parsed for backwards compatibility. */
export interface LegacyCompactThresholdSettings {
	compactAfterTokensMode?: TokenThresholdType;
	compactAfterTokensRatio?: number;
}

/**
 * Lets the agent compact its own context through the `compact_context` tool.
 * `warnAt` thresholds resolve against the active model's context window and
 * are compared with Pi's live context usage, not source-entry estimates.
 */
export interface SelfCompactConfig {
	enabled: boolean;
	warnAt: (number | TokenThreshold)[];
}

export interface Config {
	observeAfterTokens: number | TokenThreshold;
	reflectAfterTokens: number | TokenThreshold;
	/**
	 * Maximum estimated source tokens serialized into a single observer chunk.
	 * Unset (default) derives the cap from the resolved memory model's context
	 * window; see {@link resolveObserverChunkMaxTokens}.
	 */
	observerChunkMaxTokens?: number;
	compactAfterTokens: number | TokenThreshold;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	agentMaxTurns: number;
	/**
	 * Maximum output tokens requested for background memory-agent loops
	 * (observer/reflector/dropper). Always clamped to the model's own
	 * `maxTokens` when available. Lower it for local servers with a modest
	 * context window, where concurrent sub-agent requests share KV with the
	 * main session and the default 32K response budget can overflow the slot.
	 */
	agentMaxTokens: number;
	model?: ConfiguredModel;
	/**
	 * Optional model the memory workers fall back to.
	 *
	 * Tried in two places:
	 * - Resolution: when the primary memory model (this `model` when set,
	 *   otherwise the session model) cannot be resolved — absent from Pi's
	 *   registry, or carrying no usable credentials.
	 * - Runtime: when a worker stage (observer/reflector/dropper) fails its
	 *   model call, that one stage is retried once with this model.
	 *
	 * Once the fallback resolves, it is reused for the rest of the consolidation
	 * pass so later stages do not re-pay a known-broken primary. A configured
	 * fallback that also fails leaves the existing skip/fail-safe behavior intact.
	 */
	fallbackModel?: ConfiguredModel;
	showWorkerNotifications: boolean;
	selfCompact: SelfCompactConfig;
	passive: boolean;
	debugLog: boolean;
}

/**
 * Numeric fallbacks used when a `"ratio"` threshold cannot be resolved against
 * a model context window. Also the source of the plain-number defaults.
 */
const THRESHOLD_FALLBACKS = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
} as const;

export const DEFAULTS: Config = {
	observeAfterTokens: THRESHOLD_FALLBACKS.observeAfterTokens,
	reflectAfterTokens: THRESHOLD_FALLBACKS.reflectAfterTokens,
	compactAfterTokens: THRESHOLD_FALLBACKS.compactAfterTokens,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	agentMaxTurns: 16,
	agentMaxTokens: 32_000,
	showWorkerNotifications: true,
	selfCompact: { enabled: false, warnAt: [] },
	passive: false,
	debugLog: false,
};

export const TOKEN_THRESHOLD_TYPE_VALUES: readonly TokenThresholdType[] = ["calibrated", "ratio"] as const;

function isTokenThresholdType(value: unknown): value is TokenThresholdType {
	return typeof value === "string" && (TOKEN_THRESHOLD_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve a threshold spec against the active model's context window.
 *
 * Plain numbers pass through unchanged. In `"calibrated"` form the value is
 * used directly; in `"ratio"` form it is `floor(contextWindow * value)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number, and
 * `fallback` otherwise. Exhaustive over the {@link TokenThreshold} union:
 * adding a variant fails to compile here until handled.
 */
export function resolveTokenThreshold(
	spec: number | TokenThreshold,
	contextWindow: number | undefined,
	fallback: number,
): number {
	if (typeof spec === "number") return spec;
	switch (spec.type) {
		case "calibrated":
			return spec.value;
		case "ratio":
			if (typeof contextWindow === "number" && contextWindow > 0) {
				return Math.max(1, Math.floor(contextWindow * spec.value));
			}
			return fallback;
	}
}

function resolveConfigThreshold(
	spec: number | TokenThreshold,
	contextWindow: number | undefined,
	defaultFallback: number,
): number {
	const fallback = typeof spec === "number" ? spec : defaultFallback;
	return resolveTokenThreshold(spec, contextWindow, fallback);
}

/** Effective observation-run threshold for the given config and model window. */
export function resolveObserveAfterTokens(config: Config, contextWindow: number | undefined): number {
	return resolveConfigThreshold(config.observeAfterTokens, contextWindow, THRESHOLD_FALLBACKS.observeAfterTokens);
}

/** Effective reflection-run threshold for the given config and model window. */
export function resolveReflectAfterTokens(config: Config, contextWindow: number | undefined): number {
	return resolveConfigThreshold(config.reflectAfterTokens, contextWindow, THRESHOLD_FALLBACKS.reflectAfterTokens);
}

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and active model context window.
 *
 * See {@link resolveTokenThreshold}; falls back to the default
 * `compactAfterTokens` when a ratio cannot be resolved against a window.
 */
export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	return resolveConfigThreshold(config.compactAfterTokens, contextWindow, THRESHOLD_FALLBACKS.compactAfterTokens);
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimated at ~4 chars/token, which can undercount
 * real tokens by up to ~4x on non-ASCII content, so 0.2 keeps even the worst
 * case at ~80% of the window with room left for the system prompt, prior
 * memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the
 * cap is `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved
 * memory model, falling back to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when
 * the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g.
 * after repeated observer failures, or when the extension is enabled mid-way
 * into a long session) makes every observer call fail, so coverage never
 * advances and the session can never recover. With the cap, oversized backlogs
 * are drained oldest-first across successive runs.
 */
export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}


/**
 * A valid ratio is a finite number strictly between 0 and 1.
 * 0 would never trigger; >= 1 would compact at/after the full window with no
 * room left for the response.
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

/**
 * Parse a threshold setting: a plain positive-integer token count, or an
 * object form where `value` must be a positive integer in `"calibrated"`
 * form and a finite ratio in (0, 1) in `"ratio"` form. Anything else yields
 * undefined so callers can reject or ignore the setting.
 */
export function parseTokenThreshold(value: unknown): number | TokenThreshold | undefined {
	const plain = positiveIntegerOrUndefined(value);
	if (plain !== undefined) return plain;
	if (!isRecord(value)) return undefined;
	if (!isTokenThresholdType(value.type)) return undefined;
	if (value.type === "ratio") {
		const ratio = validRatioOrUndefined(value.value);
		return ratio !== undefined ? { type: "ratio", value: ratio } : undefined;
	}
	const tokens = positiveIntegerOrUndefined(value.value);
	return tokens !== undefined ? { type: "calibrated", value: tokens } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

/** Malformed `warnAt` entries are dropped individually; a non-object block is ignored. */
export function normalizeSelfCompact(value: unknown): SelfCompactConfig | undefined {
	if (!isRecord(value)) return undefined;
	const warnAt = Array.isArray(value.warnAt)
		? value.warnAt.map(parseTokenThreshold).filter((threshold) => threshold !== undefined)
		: [];
	return { enabled: value.enabled === true, warnAt };
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observerChunkMaxTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"agentMaxTurns",
		"agentMaxTokens",
	] as const;
	const thresholdKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"compactAfterTokens",
	] as const;
	const selfCompact = normalizeSelfCompact(value.selfCompact);
	if (selfCompact) normalized.selfCompact = selfCompact;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	for (const key of thresholdKeys) {
		const normalizedValue = parseTokenThreshold(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// Legacy flat keys (`compactAfterTokensMode` + `compactAfterTokensRatio`)
	// map onto the object form. In legacy semantics the ratio applied whenever
	// the mode said so, even alongside a plain-number `compactAfterTokens`
	// (which served only as the no-window fallback), so only a new-form object
	// takes precedence over it.
	const legacyRatio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (
		value.compactAfterTokensMode === "ratio"
		&& legacyRatio !== undefined
		&& !isRecord(value.compactAfterTokens)
	) {
		normalized.compactAfterTokens = { type: "ratio", value: legacyRatio };
	}
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	const fallbackModel = normalizeModel(value.fallbackModel);
	if (fallbackModel) normalized.fallbackModel = fallbackModel;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath);
	const projectConfig = readNamespacedConfig(projectPath);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const target = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

	return {
		...merged,
		observationsPoolTargetTokens: target,
	};
}
