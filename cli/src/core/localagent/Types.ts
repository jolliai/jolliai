import type { OptionalFlag } from "./OptionalFlags.js";

/** A resolved, capability-verified local agent executable. */
export interface ResolvedExecutable {
	readonly file: string;
	readonly version: string;
	/**
	 * Launcher arguments that MUST precede the tool's own arguments. Empty for a
	 * self-contained binary; populated when the tool is really a script that needs
	 * an interpreter — e.g. Windows `cursor-agent` resolves to the bundled
	 * `node.exe` with `launchArgs: ["--use-system-ca", "…\\index.js"]`. Backends
	 * spread this ahead of their own flags in `buildInvocation`.
	 */
	readonly launchArgs?: readonly string[];
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
	/**
	 * Ids from the backend's {@link LocalAgentBackend.optionalFlags} that this
	 * invocation must OMIT, because the installed CLI does not understand them.
	 *
	 * Passed in rather than read from disk by the backend so `buildInvocation`
	 * stays a synchronous pure function: `LlmClient` loads the store once per
	 * call and owns the degrade-and-retry loop. Undefined (the common path) means
	 * "pass every optional flag".
	 */
	readonly disabledFlagIds?: ReadonlySet<string>;
}

/** Normalized result of one local-agent completion. */
export interface LocalAgentOutcome {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedTokens: number;
	readonly costUsd: number;
	readonly stopReason: string | null;
	/**
	 * The model the tool ACTUALLY ran, when its response envelope reports one.
	 * Optional because only Claude Code does today (`modelUsage`); codex, cursor,
	 * opencode and kimi emit no model field, so their outcomes leave this unset.
	 *
	 * Load-bearing for metadata honesty: a pinned model is a REQUEST, not a receipt,
	 * and the four unpinned tools are sent no model at all — so without this the
	 * stored `model` would be a jollimemory-side value the run may never have used.
	 * `LlmClient` prefers this when present and falls back to the pinned value, or
	 * to the config alias, when absent.
	 */
	readonly model?: string;
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
	/**
	 * Flags this backend passes as an optimization, which an older CLI may not
	 * recognise — and would then exit non-zero over, before running anything.
	 * `LlmClient` drops them one at a time on such a failure and remembers the
	 * result per tool+version. Omit (or leave empty) when every flag the backend
	 * passes is load-bearing. See `OptionalFlags.ts`.
	 */
	readonly optionalFlags?: readonly OptionalFlag[];
	/**
	 * True when this CLI does not NAME the offending flag on an argument-parsing
	 * failure, so "dropped everything and it worked" is the only evidence its
	 * flags will ever produce. opencode is the one such tool today: it prints its
	 * whole yargs help and identifies nothing.
	 *
	 * Load-bearing for what gets PERSISTED, not for what gets retried — every
	 * backend degrades wholesale when attribution finds nothing, because that is
	 * the only way to make progress. But for a CLI that normally names the flag
	 * (claude/commander, codex/clap), an UNattributed setup error is evidence the
	 * failure was never about argv at all: a transient crash whose blind retry
	 * then happens to succeed would otherwise write all three isolation flags off
	 * permanently for that version, silently costing ~48x the prompt tokens with
	 * nothing but a debug.log line to show for it. So those backends persist only
	 * flags the CLI actually indicted; this flag opts out of that requirement.
	 */
	readonly unnamedFlagFailures?: boolean;
	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable>;
	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation;
	/**
	 * `requestedModel` is the value this invocation actually put in its model flag,
	 * or undefined when it emitted none. It exists because a usage report can name
	 * more than one model — claude adds a small helper turn of its own — and the
	 * model we ASKED for is the only non-heuristic way to say which entry answered.
	 *
	 * Optional, and most backends ignore it: a method may declare fewer parameters
	 * than the interface, so the four tools that report no model at all keep their
	 * one-parameter signature unchanged.
	 */
	parseResult(stdout: string, requestedModel?: string): LocalAgentOutcome;
	/**
	 * Cheap presence check — is this tool on disk? No capability probe, no
	 * subprocess. Used by onboarding surfaces that must decide what to OFFER
	 * before the user has committed to a tool; anything that must know the tool
	 * actually RUNS calls `discoverExecutable` instead.
	 */
	isPresent(overridePath?: string): boolean;
}

/* v8 ignore start */
/** Binary missing / too old / tool not installed — won't recover on retry. */
export class LocalAgentSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentSetupError";
	}
}

/**
 * The tool ran, but REFUSED the model it was told to use — an entitlement the
 * subscription lacks, or an alias the CLI has retired.
 *
 * A subclass of the setup error rather than a sibling, so every existing
 * `instanceof LocalAgentSetupError` classification keeps working. It exists so
 * `LlmClient` can retry ONCE without the pin for this case ALONE: retrying on
 * any setup error would re-run a ~400 KB prompt through the whole flag
 * degradation ladder a second time (up to 8 full spawns for one doomed summary)
 * for failures — an unparseable envelope, a bad TMPDIR — that have nothing to do
 * with the model.
 *
 * Declared AFTER its parent on purpose: `extends` is evaluated eagerly and class
 * bindings are not hoisted, so putting it first is a module-evaluation TDZ error,
 * not a lint nit.
 */
export class LocalAgentModelRefusedError extends LocalAgentSetupError {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentModelRefusedError";
	}
}

/** Not signed in to the tool's subscription — user must log in. */
export class LocalAgentAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentAuthError";
	}
}

/**
 * Timeout / rate-limit / overloaded — a transient condition, as opposed to a
 * setup/auth fault. This labels the failure for the diagnostic message; it does
 * NOT today drive a distinct retry-later path — the QueueWorker treats every
 * LLM failure uniformly (one immediate retry, then a "llm-failed" placeholder
 * the user re-triggers via Regenerate).
 */
export class LocalAgentTransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalAgentTransientError";
	}
}
/* v8 ignore stop */
