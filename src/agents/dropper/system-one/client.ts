/**
 * Minimal client for the System One evaluation API (`POST /v1/systemone`),
 * as served by TypeSafe's Jev and by compatible self-hosted endpoints.
 *
 * Only the question types the dropper sends are modelled.
 */

export type SystemOneInstructions = string | Record<string, unknown> | unknown[];

export type SystemOneNoulQuestion = {
	type: "noul";
	instructions: SystemOneInstructions;
	criteria?: { true?: SystemOneInstructions; false?: SystemOneInstructions };
};

export type SystemOneScoreQuestion = {
	type: "score";
	instructions: SystemOneInstructions;
	/** Ordered level descriptions, lowest first. */
	criteria: string[];
};

export type SystemOneQuestion = SystemOneNoulQuestion | SystemOneScoreQuestion;

export type SystemOneNoulAnswer = { type: "noul"; noul: number };

export type SystemOneScoreAnswer = {
	type: "score";
	score: number;
	legend?: Record<string, string>;
	probabilities?: Record<string, number>;
	confidence?: number;
};

export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneScoreAnswer;

export type SystemOneUsage = { input_tokens?: number; output_tokens?: number };

export type SystemOneResponse = {
	model: string;
	answers: Record<string, SystemOneAnswer>;
	usage?: SystemOneUsage;
};

export type FetchImpl = typeof fetch;

export class SystemOneError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = "SystemOneError";
	}
}

export interface EvaluateSystemOneArgs {
	endpoint: string;
	model: string;
	apiKey?: string;
	state: unknown;
	questions: Record<string, SystemOneQuestion>;
	timeoutMs: number;
	signal?: AbortSignal;
	fetchImpl?: FetchImpl;
	/** Attempts after a retryable status. Retries sleep, so tests override this. */
	maxAttempts?: number;
	sleep?: (ms: number) => Promise<void>;
}

/** 429 and 529 are the documented back-off statuses; 5xx covers transient gateway failures. */
function isRetryable(status: number): boolean {
	return status === 429 || status === 529 || (status >= 500 && status < 600);
}

function retryDelayMs(response: Response, attempt: number): number {
	const header = response.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		const date = Date.parse(header);
		if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	}
	return 500 * 2 ** attempt;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAnswerRecord(value: unknown): value is Record<string, SystemOneAnswer> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function evaluateSystemOne(args: EvaluateSystemOneArgs): Promise<SystemOneResponse> {
	const { endpoint, model, apiKey, state, questions, timeoutMs, signal } = args;
	const doFetch = args.fetchImpl ?? fetch;
	const sleep = args.sleep ?? defaultSleep;
	const maxAttempts = args.maxAttempts ?? 3;
	const url = `${endpoint.replace(/\/+$/, "")}/v1/systemone`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const body = JSON.stringify({ state, model, questions });

	let lastError: SystemOneError | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const timeout = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await doFetch(url, { method: "POST", headers, body, signal: requestSignal });
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = new SystemOneError(`System One request to ${url} failed: ${String(error)}`);
			if (attempt === maxAttempts - 1) break;
			await sleep(500 * 2 ** attempt);
			continue;
		}

		if (response.ok) {
			const payload = await response.json() as Partial<SystemOneResponse>;
			if (!isAnswerRecord(payload?.answers)) {
				throw new SystemOneError(`System One response from ${url} has no answers map`);
			}
			return { model: payload.model ?? model, answers: payload.answers, usage: payload.usage };
		}

		const detail = await response.text().catch(() => "");
		lastError = new SystemOneError(
			`System One request to ${url} failed with ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
			response.status,
		);
		if (!isRetryable(response.status) || attempt === maxAttempts - 1) break;
		await sleep(retryDelayMs(response, attempt));
	}
	throw lastError ?? new SystemOneError(`System One request to ${url} failed`);
}
