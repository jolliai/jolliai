/** A resolved, capability-verified local agent executable. */
export interface ResolvedExecutable {
	readonly file: string;
	readonly version: string;
}

/**
 * One completion request, already template-filled and model-resolved.
 *
 * Note there is no output-token cap here: the Claude Code CLI exposes no
 * per-call max-output-tokens flag (only `--max-budget-usd` / `--max-turns`), so
 * an API-style `maxTokens` could not be honored and is deliberately absent.
 * The wall-clock budget is enforced by the runner ({@link LocalAgentRunner}),
 * not carried on the request.
 */
export interface LocalAgentRequest {
	readonly prompt: string;
	readonly model: string;
	readonly systemPrompt: string;
}

/** Normalized result of one local-agent completion. */
export interface LocalAgentOutcome {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedTokens: number;
	readonly costUsd: number;
	readonly stopReason: string | null;
}

/** A fully-specified child-process invocation. */
export interface Invocation {
	readonly file: string;
	readonly args: readonly string[];
	readonly stdin: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
}

export interface LocalAgentBackend {
	readonly id: string;
	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable>;
	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation;
	parseResult(stdout: string): LocalAgentOutcome;
}

/* v8 ignore start */
/** Binary missing / too old / tool not installed — won't recover on retry. */
export class LocalAgentSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentSetupError";
	}
}

/** Not signed in to the tool's subscription — user must log in. */
export class LocalAgentAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentAuthError";
	}
}

/** Timeout / rate-limit / overloaded — safe to retry later. */
export class LocalAgentTransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentTransientError";
	}
}
/* v8 ignore stop */
