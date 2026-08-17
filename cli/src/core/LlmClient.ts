/**
 * LLM Client -- Plugin-side routing layer
 *
 * Routes LLM calls based on available credentials:
 * 1. Direct mode: Anthropic API key present -> local SDK call
 * 2. Proxy mode: Jolli API key present -> POST to backend, receive text + tokens
 * 3. Neither -> throw error
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../Logger.js";
import type { LlmCredentialSource, LocalAgentToolId } from "../Types.js";
import { LOCAL_AGENT_TMP_PREFIX } from "./AgentReentry.js";
import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import { getBackend } from "./localagent/BackendRegistry.js";
import "./localagent/BuiltinBackends.js";
import { describeCandidate } from "./localagent/ExecutableResolver.js";
import { runInvocation as defaultRunInvocation } from "./localagent/LocalAgentRunner.js";
import {
	attributeUnsupportedFlag,
	loadUnsupportedFlagIds,
	recordUnsupportedFlagIds,
} from "./localagent/OptionalFlags.js";
import { resolveLocalAgentModel } from "./localagent/ToolMeta.js";
import {
	type LocalAgentBackend,
	LocalAgentModelRefusedError,
	type LocalAgentOutcome,
	LocalAgentSetupError,
	LocalAgentTransientError,
	type ResolvedExecutable,
} from "./localagent/Types.js";
import { fillTemplate, findUnfilledPlaceholders, TEMPLATES } from "./PromptTemplates.js";
import { resolveModelId } from "./Summarizer.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "./TraceContext.js";

// Re-export so existing imports of LlmCredentialSource from this module keep
// working — the source-of-truth definition lives in Types.ts because
// LlmCallMetadata references it (Types → LlmClient would cycle).
export type { LlmCredentialSource } from "../Types.js";

/** Module-level cache: reuse Anthropic client instances keyed by API key */
const clientCache = new Map<string, Anthropic>();

/** Returns a cached Anthropic client for the given API key. */
function getOrCreateClient(apiKey: string): Anthropic {
	let client = clientCache.get(apiKey);
	if (!client) {
		client = new Anthropic({ apiKey });
		clientCache.set(apiKey, client);
	}
	return client;
}

const log = createLogger("LlmClient");

/**
 * Flattens an Error's `cause` chain into a single line for logging.
 *
 * Node's undici fetch wraps transport-layer failures in a TypeError("fetch failed")
 * and stashes the actual reason (DNS, TLS, ECONNREFUSED, ETIMEDOUT, ECONNRESET, ...)
 * in `error.cause`, sometimes nested two levels deep. Logging only `error.message`
 * leaves operators with "fetch failed" and no way to diagnose. This helper extracts
 * Node syscall fields (code/errno/syscall/hostname/address/port) plus name/message,
 * and recurses when the cause itself has a cause.
 */
function formatCause(cause: unknown): string {
	if (cause == null) return "(none)";
	if (!(cause instanceof Error)) return String(cause);
	const fields: string[] = [];
	if (cause.name && cause.name !== "Error") fields.push(`name=${cause.name}`);
	if (cause.message) fields.push(`message=${cause.message}`);
	for (const key of ["code", "errno", "syscall", "hostname", "address", "port"] as const) {
		const value = (cause as unknown as Record<string, unknown>)[key];
		if (value !== undefined) fields.push(`${key}=${String(value)}`);
	}
	const inner = (cause as { cause?: unknown }).cause;
	if (inner !== undefined) fields.push(`cause=[${formatCause(inner)}]`);
	return fields.join(" ") || "(empty)";
}

/**
 * Backend route path for LLM proxy requests.
 * Must stay in sync with the route mounted in backend/src/router/LlmProxyRouter.ts.
 */
const LLM_PROXY_PATH = "/api/push/llm/complete";

/**
 * End-to-end timeout for proxy LLM calls (covers connect + headers + body).
 * The backend invokes Anthropic non-streaming inside this request, so 180s is
 * generous for a full LLM round-trip while bounding how long a stuck request
 * can hold the QueueWorker file lock. Historically moved in lockstep with
 * `DIRECT_FETCH_TIMEOUT_MS`, but that rationale no longer holds: the direct
 * path now streams by default and its non-streaming budget governs only
 * trivially-small calls, whereas this proxy budget governs ALL proxy calls
 * (which have no streaming escape). They happen to share 180s today but should
 * be evaluated independently. Exported so a regression test can pin the value.
 */
export const PROXY_FETCH_TIMEOUT_MS = 180_000;

/**
 * End-to-end timeout for direct Anthropic API calls. The SDK's `fetch` has
 * no default deadline, so a half-open TCP connection (firewall blackhole,
 * silently-dropped packets on a flaky network, suspended cloud-edge) would
 * hold the in-flight LLM call indefinitely — observed in production
 * holding a SyncEngine `ConflictResolver.resolveAll` for 2+ hours and
 * leaving the sidebar's "Sorting out conflicts…" label up the whole time.
 * 180 s matches the proxy path and is sized for the largest prompts the engine
 * sends — notably a regenerate of a large squash commit, which aggregates the
 * whole tree's transcripts + diff into one non-streaming request and was being
 * aborted mid-flight at the previous 120 s ceiling ("Request was aborted.").
 * The extra headroom still fails fast when the connection is genuinely wedged.
 * The QueueWorker refreshes its file lock every 60 s, so a call running this
 * long never loses the lock. Exported so a regression test can pin the value.
 */
export const DIRECT_FETCH_TIMEOUT_MS = 180_000;

/**
 * The direct path **streams by default**. A call takes the simple non-streaming
 * `messages.create` path only when it is "trivially small" — small on BOTH
 * axes: output cap ≤ {@link NONSTREAM_MAX_OUTPUT_TOKENS} AND prompt length ≤
 * {@link NONSTREAM_MAX_PROMPT_CHARS}. Everything else streams.
 *
 * Why default to streaming: a non-streaming request has no liveness signal, so
 * a single fixed wall-clock deadline ({@link DIRECT_FETCH_TIMEOUT_MS}) cannot
 * tell "healthy but slow" from "wedged socket" — it either kills legitimately
 * slow large calls or waits the full budget on a dead one. The streaming path's
 * inactivity watchdog ({@link STREAM_IDLE_TIMEOUT_MS}) governs by liveness
 * instead: a healthy-but-slow call (big prompt and/or big output) keeps the
 * `ping` events flowing and completes, while a wedged socket trips the watchdog
 * and fails fast. So any call that might run long belongs on the streaming path.
 *
 * Why BOTH axes: a small-output action can still carry a large input — most
 * notably `commit-message`, whose `max_tokens` is tiny (256) but whose staged
 * diff can be huge. Gating only on output would wrongly keep such a call on the
 * fixed-budget non-streaming path. `finalMessage()` returns the same
 * `Anthropic.Message` shape `messages.create` returns, so downstream code is
 * unchanged either way. Exported so a regression test can pin the values.
 */
export const NONSTREAM_MAX_OUTPUT_TOKENS = 512;
export const NONSTREAM_MAX_PROMPT_CHARS = 16_000;

/**
 * Inactivity budget for the streaming direct path. Streaming is selected for
 * responses that may legitimately exceed `DIRECT_FETCH_TIMEOUT_MS` (a 64K merge
 * response can take many minutes), so a fixed wall-clock cap would kill valid
 * large responses. Instead the stream is aborted only when NO stream event
 * arrives within this window. Anthropic emits `ping` events throughout
 * generation, so a healthy-but-slow stream keeps resetting the timer while a
 * wedged / half-open socket (firewall blackhole, suspended cloud-edge, a
 * silently-dropped `ANTHROPIC_BASE_URL` relay) produces nothing and trips it.
 * This restores the fail-fast guarantee the non-streaming path has — a hung
 * streaming call can no longer hold the QueueWorker lock (or a SyncEngine
 * conflict resolve) indefinitely, the regression introduced when the streaming
 * branch dropped its `AbortSignal`. Exported so a regression test can pin it.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Absolute wall-clock cap for the streaming direct path, on TOP of the idle
 * watchdog above. The idle watchdog alone cannot bound a stream that keeps
 * emitting `ping` events but never completes (a server-side stall, a relay that
 * trickles keep-alives, a pathological retry loop) — it would reset the idle
 * timer forever and hold the QueueWorker / SyncEngine lock indefinitely. This
 * hard cap fires regardless of activity. Sized well above the largest legitimate
 * response (a 64K merge regenerate runs a few minutes) so it never clips valid
 * work, while still failing in bounded time. The QueueWorker refreshes its lock
 * every 60s, so a call running this long never loses the lock. Exported so a
 * regression test can pin it.
 */
export const STREAM_MAX_WALL_CLOCK_MS = 15 * 60 * 1000;

// `x-jolli-client` header value lives in `./ClientHeader.ts` so both this
// module and `cli/src/sync/BackendClient.ts` share one source of truth.
// Build-time `__JOLLI_CLIENT_KIND__` + `__PKG_VERSION__` resolution happens
// there. Tests stub those globals via `vi.stubGlobal` + `vi.resetModules`,
// and `JOLLI_CLIENT_HEADER` re-evaluates on re-import accordingly.

/**
 * LLM provider credentials and model selection.
 *
 * Two modes:
 * - Direct: provide `apiKey` to call the Anthropic API locally.
 * - Proxy:  provide `jolliApiKey` to route through the Jolli backend.
 *           The base URL is derived from the API key metadata.
 */
interface LlmCredentials {
	/** Anthropic API key for direct mode (falls back to ANTHROPIC_API_KEY env var) */
	readonly apiKey?: string;
	/** Model alias or full ID (e.g. "haiku", "sonnet") */
	readonly model?: string;
	/** Jolli Space API key for proxy mode (sk-jol-...) */
	readonly jolliApiKey?: string;
	/**
	 * Explicit user preference from Settings UI / config.json. When set, takes
	 * priority over the credential-presence precedence so the UI's "Provider"
	 * dropdown is actually authoritative — without this, picking "Jolli" while
	 * also having ANTHROPIC_API_KEY in config would silently route to Anthropic
	 * (the "Settings says Jolli, doctor says Anthropic" bug).
	 *
	 * Optional — legacy configs without this field fall through to the
	 * credential-presence precedence below.
	 */
	readonly aiProvider?: "anthropic" | "jolli" | "local-agent";
	/** Which local agent tool to drive when aiProvider === "local-agent". */
	readonly localAgentTool?: LocalAgentToolId;
	/** Optional explicit path to the local agent binary, overriding PATH discovery. */
	readonly localAgentPath?: string;
	/** Which model to pin for the chosen tool; see `JolliMemoryConfig.localAgentModel`. */
	readonly localAgentModel?: string;
}

/**
 * Resolves which credential source `callLlm` would use for these credentials,
 * or `null` if none are available.
 *
 * Must stay aligned with the dispatch logic in `callLlm` — and it does, because
 * `callLlm` itself routes through this function.
 *
 * Resolution order:
 *   1. **Explicit `aiProvider` choice** (Settings UI / config.json). When set,
 *      only the matching credential is considered. If that credential is
 *      missing, returns `null` rather than silently falling back to the other
 *      provider — silent cross-provider fallback was the root cause of the
 *      "Settings says Jolli, doctor reports Anthropic" mismatch. `"local-agent"`
 *      is always honored the moment it's chosen: it drives the local agent
 *      tool's own login rather than a jollimemory-held credential, so there is
 *      no presence check to fail.
 *   2. **Legacy precedence** (apiKey > ANTHROPIC_API_KEY env > jolliApiKey),
 *      used when `aiProvider` is undefined so existing configs continue to
 *      work unchanged. `"local-agent"` is never selected by this fallback —
 *      only the explicit choice above can pick it.
 */
export function resolveLlmCredentialSource(
	credentials: Pick<LlmCredentials, "apiKey" | "jolliApiKey" | "aiProvider">,
): LlmCredentialSource | null {
	if (credentials.aiProvider === "local-agent") {
		// The local agent uses the tool's own login (subscription OAuth); no
		// jollimemory-held credential is required, so presence checks don't apply.
		return "local-agent";
	}
	if (credentials.aiProvider === "jolli") {
		return credentials.jolliApiKey ? "jolli-proxy" : null;
	}
	if (credentials.aiProvider === "anthropic") {
		if (credentials.apiKey) return "anthropic-config";
		if (process.env.ANTHROPIC_API_KEY) return "anthropic-env";
		return null;
	}
	if (credentials.apiKey) return "anthropic-config";
	if (process.env.ANTHROPIC_API_KEY) return "anthropic-env";
	if (credentials.jolliApiKey) return "jolli-proxy";
	return null;
}

/** The credential-carrying fields callLlm needs to select and drive a provider. */
type LlmCredentialFields = Pick<
	LlmCredentials,
	"apiKey" | "jolliApiKey" | "aiProvider" | "localAgentTool" | "localAgentPath" | "localAgentModel"
>;

/**
 * Extracts the credential-carrying subset of an `LlmConfig` for spreading into a
 * `callLlm({ ... })` options object. Every call site used to hand-copy
 * apiKey/jolliApiKey/aiProvider, which silently dropped the local-agent fields
 * (`localAgentTool` / `localAgentPath`) everywhere — a configured binary-path
 * override never reached the runner. Centralizing the field list here means a
 * new credential dimension is threaded to all call sites by editing one place.
 * Keep `model` out — call sites resolve it via `resolveModelId` themselves.
 */
export function llmCredentials(config: LlmCredentialFields): LlmCredentialFields {
	return {
		apiKey: config.apiKey,
		jolliApiKey: config.jolliApiKey,
		aiProvider: config.aiProvider,
		localAgentTool: config.localAgentTool,
		localAgentPath: config.localAgentPath,
		localAgentModel: config.localAgentModel,
	};
}

/**
 * Effective parallelism for an LLM fan-out under the active provider. The
 * API/proxy paths keep the caller's `baseLimit`, but each local-agent call
 * spawns a full CLI agent turn (a real `claude` process, multi-minute, ~9k
 * tokens of built-in system prompt each), so fanning out N-wide would launch N
 * concurrent processes and reliably trip the subscription's rate limit or bury
 * the machine. Serialize to 1 under local-agent — slower, but the only sane
 * shape for spawning real agent CLIs.
 */
export function llmFanoutLimit(baseLimit: number, config: Pick<LlmCredentials, "aiProvider">): number {
	return config.aiProvider === "local-agent" ? 1 : baseLimit;
}

/** Options for making an LLM call */
export interface LlmCallOptions extends LlmCredentials {
	/** Template key (e.g. "summarize", "commit-message") */
	readonly action: string;
	/** Params to fill {{placeholder}} tokens in the template */
	readonly params: Record<string, string>;
	/** Max output tokens (direct mode only, default 8192) */
	readonly maxTokens?: number;
	/**
	 * Force the direct path onto `messages.stream` regardless of size. Rarely
	 * needed now that the direct path streams by default for anything but a
	 * trivially-small call (see {@link NONSTREAM_MAX_OUTPUT_TOKENS}), but kept as
	 * an explicit override for callers that want to guarantee the streaming path
	 * even for a small call (e.g. the ingest route call). An explicit flag can't
	 * be silently undone by retuning the size thresholds. No effect in proxy mode.
	 */
	readonly forceStreaming?: boolean;
	/** Optional prompt revision to pin (proxy mode only) */
	readonly version?: number;
	/**
	 * Optional per-call wall-clock timeout in ms. When set, overrides the
	 * module-level fetch/stream hard caps (DIRECT_FETCH_TIMEOUT_MS /
	 * PROXY_FETCH_TIMEOUT_MS / STREAM_MAX_WALL_CLOCK_MS) for THIS call only.
	 * Lets latency-sensitive callers (e.g. the context-relevance ranker, which
	 * must fail-open fast without wedging the post-commit queue) impose a much
	 * shorter deadline than the default 180s. The streaming idle watchdog is
	 * unaffected — a short hard cap simply fires before it.
	 */
	readonly timeoutMs?: number;
	/**
	 * Test-only override for the local-agent child-process runner. Double
	 * underscore marks it as a test seam, not a user-facing option; never set
	 * from config. Ignored outside the `local-agent` path.
	 */
	readonly __localAgentRun?: typeof defaultRunInvocation;
	/**
	 * Test-only override for the machine-global dir holding the unsupported-flag
	 * store. Same test-seam convention as `__localAgentRun`; never set from config.
	 */
	readonly __localAgentGlobalDir?: string;
}

/** Result from an LLM call */
export interface LlmCallResult {
	/** Raw LLM text output */
	readonly text?: string;
	/** Actual model ID used (e.g. "claude-sonnet-4-6"); undefined in proxy mode */
	readonly model?: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/**
	 * Prompt-cache tokens for this call: cache_read + cache_creation input
	 * tokens. Anthropic counts these separately from `input_tokens` (which is
	 * the uncached prompt), so input + cached + output ≈ the billed total.
	 * Surfaced in the VS Code token-usage bar's "cached" segment.
	 */
	readonly cachedTokens: number;
	readonly apiLatencyMs: number;
	/** Stop reason from the API (e.g. "end_turn"); undefined in proxy mode */
	readonly stopReason?: string | null;
	/**
	 * Which credential source produced this result. Populated by `callLlm`
	 * from the same `resolveLlmCredentialSource` call that picked the path,
	 * so it's authoritative — callers shouldn't try to re-derive it.
	 * Persisted into `LlmCallMetadata.source` for traceability of past summaries.
	 */
	readonly source: LlmCredentialSource;
	/**
	 * For source === "local-agent": which tool produced this result. Threaded
	 * through into `LlmCallMetadata.localAgentTool` by callers that build the
	 * persisted metadata (`Summarizer.ts`, `PlanProgressEvaluator.ts`) so the
	 * footer can attribute the specific tool. Absent for every other source.
	 */
	readonly localAgentTool?: LocalAgentToolId;
}

/**
 * Routes an LLM call to either the Anthropic SDK (direct) or the Jolli backend (proxy).
 */
export async function callLlm(options: LlmCallOptions): Promise<LlmCallResult> {
	const source = resolveLlmCredentialSource(options);

	// Single dispatch-site log so every call leaves a "which provider was used"
	// trace, regardless of mode. Unifies what was previously asymmetric: only
	// proxy mode logged on success (`callProxy` line below), direct mode was
	// silent unless it errored. With this log, users can grep `debug.log`
	// after a commit to verify Settings UI's provider choice was honored
	// end-to-end. Skipped when source is null because the next switch branch
	// throws "No LLM provider available" — no provider was actually used.
	if (source) {
		log.info("LLM call: action=%s source=%s", options.action, source);
	}

	switch (source) {
		case "anthropic-config":
			// resolveLlmCredentialSource returned "anthropic-config" → options.apiKey is set
			return callDirect(options, options.apiKey as string, source);
		case "anthropic-env":
			// resolveLlmCredentialSource returned "anthropic-env" → env var is set
			return callDirect(options, process.env.ANTHROPIC_API_KEY as string, source);
		case "jolli-proxy": {
			const jolliApiKey = options.jolliApiKey as string;
			const baseUrl = parseJolliApiKey(jolliApiKey)?.u;
			if (!baseUrl) {
				throw new Error("Could not derive Jolli site URL from API key. Please regenerate your Jolli API Key.");
			}
			return callProxy(options, baseUrl, source);
		}
		case "local-agent":
			return callLocalAgent(options, source);
		default:
			throw new LlmCredentialError();
	}
}

/**
 * User-facing message for the "no provider could be resolved" failure. Kept
 * exported so callers that need to render the message inline (status panels,
 * onboarding hints) don't duplicate the string.
 */
export const NO_LLM_PROVIDER_MESSAGE =
	"No LLM provider available. Set an Anthropic API key (ANTHROPIC_API_KEY) or configure a Jolli Space API key (jolliApiKey).";

/**
 * Thrown by `callLlm` when no provider can be resolved from the supplied
 * credentials and `aiProvider` choice. Identified via `instanceof` so
 * recognition survives any future tweak to `NO_LLM_PROVIDER_MESSAGE` (i18n,
 * prefixing, wrapping with action context) without silently breaking the
 * QueueWorker's "skip retry / placeholder writes" guard.
 */
export class LlmCredentialError extends Error {
	constructor(message: string = NO_LLM_PROVIDER_MESSAGE) {
		super(message);
		this.name = "LlmCredentialError";
	}
}

/**
 * True when `err` is the "no LLM provider available" failure — i.e. a
 * credential-config error that won't recover on retry. Callers use this to
 * skip retry loops and placeholder writes that would otherwise hide the
 * "fix your Settings" signal from the user.
 */
export function isLlmCredentialError(err: unknown): err is LlmCredentialError {
	return err instanceof LlmCredentialError;
}

/** Direct mode: call Anthropic SDK locally */
/**
 * True for the Node ≥24 async-iterator teardown error the Anthropic SDK surfaces from
 * `stream.finalMessage()` when the HTTP connection closes right after the final SSE event.
 * Matched by `code` (ERR_STREAM_PREMATURE_CLOSE) or message text, on the error or its `cause`
 * (undici nests the transport reason there). Kept narrow so only this specific spurious close
 * is recovered — genuine transport failures still propagate.
 */
function isPrematureClose(err: unknown): boolean {
	const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
	if (e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.cause?.code === "ERR_STREAM_PREMATURE_CLOSE") return true;
	const text = `${String(e?.message ?? "")} ${String(e?.cause?.message ?? "")}`.toLowerCase();
	return text.includes("premature close");
}

interface FlagDegradationOpts {
	readonly prompt: string;
	readonly model: string;
	readonly systemPrompt: string;
	readonly timeoutMs?: number;
	readonly globalDir?: string;
	/**
	 * Out-param collecting the cwd of EVERY invocation built here, including the
	 * ones whose runs failed. `buildInvocation` mints a fresh temp dir per call
	 * (`createLocalAgentCwd`), so a degrading retry creates one per attempt and
	 * the caller's cleanup must see them all — returning only the last would leak
	 * a directory per dropped flag. An out-param rather than a return value
	 * because the caller needs the list on the throwing path too.
	 */
	readonly spawnedCwds: string[];
}

/**
 * Removes a temp cwd that WE created. Callers pass arbitrary cwds (tests inject
 * stubs with e.g. a bare "/tmp"), so the prefix check is what stops a blind
 * recursive delete of an unrelated directory. LOCAL_AGENT_TMP_PREFIX is the
 * single source of truth, shared with createLocalAgentCwd in AgentReentry.
 */
function removeLocalAgentCwd(cwd: string): void {
	if (!cwd.startsWith(tmpdir()) || !basename(cwd).startsWith(LOCAL_AGENT_TMP_PREFIX)) return;
	try {
		rmSync(cwd, { recursive: true, force: true });
	} catch (err) {
		log.warn("Failed to remove local-agent temp cwd %s: %s", cwd, (err as Error).message);
	}
}

/**
 * Runs the invocation, dropping the backend's optional flags one at a time if
 * the CLI turns out not to understand them, and remembering the outcome per
 * tool+version so later calls skip straight to the working shape.
 *
 * The point is that an older agent CLI does not IGNORE a flag it does not know —
 * it exits non-zero before running, so a single unrecognised optimization flag
 * would otherwise fail every summary on the machine, non-retryably, with no
 * probe able to catch it in advance (see `OptionalFlags.ts` for why).
 *
 * Three rules keep this from becoming a guessing game:
 *
 *   * Nothing is persisted until a degraded invocation SUCCEEDS. Attribution
 *     from stderr only chooses what to drop first — a wrong guess just costs one
 *     more attempt and is never written down. This is what lets opencode work at
 *     all: it names no flag, so its failures degrade wholesale.
 *   * A success is only written down for flags the CLI actually INDICTED, unless
 *     the backend declares `unnamedFlagFailures`. Success alone is a weaker
 *     signal than it looks: a setup error unrelated to argv (a crash, a bad
 *     TMPDIR) also degrades wholesale, and if that flake has passed by the time
 *     the stripped retry runs, the retry succeeds and would otherwise record
 *     every isolation flag as unsupported for that tool version — permanently,
 *     invisibly, and at ~48x the prompt cost. claude and codex both name the
 *     flag when argv really is the problem, so requiring attribution costs them
 *     nothing; opencode names nothing ever, which is exactly what its opt-out is
 *     for.
 *   * Only `LocalAgentSetupError` degrades. Auth and transient failures are not
 *     about argv, and retrying them stripped would be noise. (`claude` reports
 *     an expired login on STDOUT, so it arrives as an auth error from
 *     `parseResult`, not here.)
 *
 * Attempts are bounded by the flag count: each round drops at least one, so the
 * worst case is `optionalFlags.length + 1` spawns and only on a genuinely
 * ancient CLI. A backend with no optional flags runs exactly once.
 */
async function runWithFlagDegradation(
	backend: LocalAgentBackend,
	exe: ResolvedExecutable,
	run: typeof defaultRunInvocation,
	opts: FlagDegradationOpts,
): Promise<{ stdout: string; disabledFlagIds: ReadonlySet<string> }> {
	const flags = backend.optionalFlags ?? [];
	const known = await loadUnsupportedFlagIds(backend.id, exe.version, opts.globalDir);
	// Only the ids learned in THIS call get written back; `known` is already on
	// disk and re-recording it would rewrite the file after every single run.
	let disabled = new Set(known);
	// Subset of the above that the CLI's own failure text named. Everything else
	// was dropped blind, and is not durable evidence — see the third rule above.
	const indicted = new Set<string>();

	for (;;) {
		const invocation = backend.buildInvocation(exe, {
			prompt: opts.prompt,
			model: opts.model,
			systemPrompt: opts.systemPrompt,
			disabledFlagIds: disabled,
		});
		opts.spawnedCwds.push(invocation.cwd);
		try {
			const stdout = await run(invocation, { timeoutMs: opts.timeoutMs });
			const learned = new Set([...disabled].filter((id) => !known.has(id)));
			// Record the indicted ids only, unless this backend can never indict one.
			const durable = backend.unnamedFlagFailures
				? learned
				: new Set([...learned].filter((id) => indicted.has(id)));
			if (durable.size > 0) {
				log.warn(
					"Local agent %s@%s rejected %s; dropped and recorded — summaries keep working, without that isolation.",
					backend.id,
					exe.version,
					[...durable].join(", "),
				);
				await recordUnsupportedFlagIds(backend.id, exe.version, durable, opts.globalDir);
			}
			// A blind drop that worked is NOT written down for a CLI that names its
			// flags: the likeliest reading is a one-off setup failure that had nothing
			// to do with argv, and the next call retries at full isolation. Logged
			// because the alternative reading — a genuinely unrecognised flag that
			// somehow went unnamed — costs one wasted spawn on every subsequent call,
			// and this line is the only place that would ever show up.
			const blind = new Set([...learned].filter((id) => !durable.has(id)));
			if (blind.size > 0) {
				log.warn(
					"Local agent %s@%s succeeded after blindly dropping %s, but its failure named no flag — not recording; full isolation will be retried next call.",
					backend.id,
					exe.version,
					[...blind].join(", "),
				);
			}
			return { stdout, disabledFlagIds: disabled };
		} catch (err) {
			const remaining = flags.filter((f) => !disabled.has(f.id));
			if (!(err instanceof LocalAgentSetupError) || remaining.length === 0) throw err;
			// Narrow to the named flag when the CLI named one; otherwise drop every
			// remaining optional flag at once. The wholesale step is what covers a CLI
			// whose failure text identifies nothing, and it is why this loop always
			// terminates even with no attribution at all.
			const attribution = attributeUnsupportedFlag(err.message, remaining);
			const dropping = attribution ? [attribution.flag] : remaining;
			log.info(
				"Local agent %s failed with a setup error; retrying without %s (%s)",
				backend.id,
				dropping.map((f) => f.id).join(", "),
				// Which phrase indicted the flag, or that nothing did. Both halves are
				// worth having in debug.log: codex indicts one flag two different ways
				// (`--disable` vs `Unknown feature flag: plugins`) and they mean
				// different things, while "named nothing" is the signal that this is the
				// wholesale path — opencode's normal case, but on any other tool it means
				// the failure was probably never about argv at all.
				attribution ? `matched "${attribution.matched}"` : "failure named no flag; dropping all remaining",
			);
			if (attribution) indicted.add(attribution.flag.id);
			disabled = new Set([...disabled, ...dropping.map((f) => f.id)]);
		}
	}
}

/**
 * Local-agent mode: drive a locally-installed agent CLI (v1: Claude Code)
 * headless, using the tool's own subscription login. Mirrors callDirect's
 * template-fill + model-resolution preamble, then delegates spawning to the
 * selected backend. On failure it throws (LocalAgent*Error) — NEVER falls back
 * to another provider, so the user is never silently billed on their API key.
 */
async function callLocalAgent(options: LlmCallOptions, source: LlmCredentialSource): Promise<LlmCallResult> {
	const entry = TEMPLATES.get(options.action);
	if (!entry) {
		throw new Error(`Unknown LLM action: "${options.action}". Available: ${[...TEMPLATES.keys()].join(", ")}`);
	}
	const missing = findUnfilledPlaceholders(entry.template, options.params);
	if (missing.length > 0) {
		log.warn("Local-agent call has unfilled placeholders for action=%s: %s", options.action, missing.join(", "));
	}
	const prompt = fillTemplate(entry.template, options.params);
	const model = resolveModelId(options.model);
	// NOTE: options.maxTokens is intentionally NOT threaded here — the Claude
	// Code CLI has no per-call output-token cap flag, so the API path's
	// max_tokens budget (and the resulting `stopReason === "max_tokens"`
	// truncation signal) simply does not apply under the local-agent provider.

	const tool = options.localAgentTool ?? "claude-code";
	const backend = getBackend(tool);
	const exe = await backend.discoverExecutable(options.localAgentPath);
	// The model is pinned PER TOOL, not per action, and only for the tools that
	// declare one (claude-code today) — `resolveLocalAgentModel` returns "" for
	// every other tool, and an empty model tells the backend to emit no model flag
	// at all, so those four keep running whatever they are configured with.
	//
	// Why pin at all, when the spend lands on the user's own subscription: leaving
	// it unpinned does not mean "the user chose" — it means a background,
	// mechanical workload silently rides whatever model the developer picked for
	// INTERACTIVE work. Measured on one machine, every generation ran
	// `claude-opus-5[1m]`, the most expensive model at its most expensive context
	// tier: a 418-token routing decision cost $0.08, and one session consumed ~73%
	// of a five-hour window. The same work then costs different amounts on two
	// machines, for a reason that has nothing to do with this tool. `inherit` keeps
	// that behaviour available, as an explicit choice rather than the default.
	//
	// Why an alias (`sonnet`) rather than `resolveModelId`'s API model id: measured,
	// the CLI accepts both, but an alias tracks the latest of its family (so it does
	// not 404 when a dated model retires) and cannot select the `[1m]` SKU.
	//
	// Still NOT threaded here, deliberately: `jolli configure --set model=…` and
	// `PlanProgressEvaluator`'s `haiku` both name Anthropic API model ids, which are
	// a different namespace from a local CLI's aliases — `localAgentModel` is the
	// setting that reaches this provider.
	const localModel = resolveLocalAgentModel(tool, options.localAgentModel);
	const run = options.__localAgentRun ?? defaultRunInvocation;
	const startTime = Date.now();
	// Collected across every attempt so the `finally` below cleans up the temp
	// dirs of failed attempts too, not just the last one.
	const spawnedCwds: string[] = [];
	try {
		const runOnce = async (model: string) => {
			const { stdout, disabledFlagIds } = await runWithFlagDegradation(backend, exe, run, {
				prompt,
				model,
				systemPrompt: "You output only what the prompt asks for, with no preamble or commentary.",
				timeoutMs: options.timeoutMs,
				globalDir: options.__localAgentGlobalDir,
				spawnedCwds,
			});
			// The requested model is handed to the parser, not just to the spawn: a
			// tool's usage report can name several models (claude adds a small helper
			// turn of its own), and the one we ASKED for is the only non-heuristic way
			// to say which entry is the answering turn. See ClaudeCodeBackend.pickModel.
			return { outcome: backend.parseResult(stdout, model || undefined), disabledFlagIds };
		};

		// A model the tool REFUSES must not take the machine's summaries down with
		// it, and the flag-degradation loop cannot save us here — that loop only
		// sees failures `run()` rejects with, and a refused model is not one of
		// them. Measured: `--model bogus` exits 1 but WRITES the failure envelope to
		// stdout, and `LocalAgentRunner` deliberately resolves a nonzero exit that
		// produced stdout so the backend can classify it. So the throw happens in
		// `parseResult`, downstream of the loop, and the only place that can react
		// is here.
		//
		// The realistic trigger is not a corrupt config — `resolveLocalAgentModel`
		// clamps an unrecognised stored value — it is entitlement: the picker offers
		// Opus, and a subscription without Opus answers 404 for every single call.
		// One un-pinned retry turns "this machine can no longer generate anything"
		// into "this machine generates on the tool's own model", which is exactly
		// the pre-pinning behaviour and strictly better than nothing.
		//
		// Deliberately NOT persisted: unlike an unsupported flag, an entitlement can
		// be granted later, and the next call should ask for the pinned model again.
		// And deliberately only for `LocalAgentModelRefusedError` — see the narrowing
		// note at the catch for why the broader setup class is far too expensive.
		let attempt: { outcome: LocalAgentOutcome; disabledFlagIds: ReadonlySet<string> };
		let effectiveModel = localModel;
		try {
			attempt = await runOnce(localModel);
		} catch (err) {
			// Narrow on purpose. Retrying on ANY setup error would push a ~400 KB
			// prompt through the entire flag-degradation ladder a SECOND time — up
			// to 8 full spawns for one summary that was never going to succeed —
			// over failures (unparseable envelope, bad TMPDIR, a crash) that have
			// nothing to do with the model we pinned.
			if (!localModel || !(err instanceof LocalAgentModelRefusedError)) throw err;
			log.warn(
				'Local agent %s refused model "%s" (%s); retrying once on the tool\'s own model.',
				tool,
				localModel,
				err.message,
			);
			attempt = await runOnce("");
			effectiveModel = "";
		}
		const { outcome, disabledFlagIds } = attempt;

		// An empty completion is a FAILED run, not an answer. Every action's
		// template asks for structured output, so no caller has a use for "" — and
		// the ones that parse it produce a convincing empty artifact instead of an
		// error. That is how an exhausted codex workspace overwrote a good stored
		// summary: the backend reduced a failure envelope to text:"", the summarizer
		// read 0 topics from 0 chars, and regenerate persisted the result as if the
		// model had simply had nothing to say.
		//
		// Enforced at this seam rather than in each backend so all five tools are
		// covered at once, and so the next silent-failure envelope some CLI invents
		// cannot slip through a backend that has not learned to recognise it. The
		// backends stay responsible for naming a failure they CAN see (they have the
		// reason text); this only catches the ones that got past them.
		if (outcome.text.trim() === "") {
			throw new LocalAgentTransientError(
				`Local agent "${tool}" returned an empty completion for action=${options.action}. ` +
					`The tool exited without producing a response; see debug.log for its output.`,
			);
		}

		// Prefer the model the tool reported actually running over anything we
		// resolved. Claude Code names it (`modelUsage`); codex, cursor-agent,
		// opencode and kimi do not, so those fall back to the pinned value if there
		// is one and to the config alias otherwise — a guess, but the only value
		// available, and the same one every other provider records.
		const resultModel = outcome.model ?? (effectiveModel || model);

		// Verify rather than assume. Pinning a model is only worth anything if a
		// request that was NOT honoured is visible: a silently upgraded model is
		// exactly as expensive as never having asked, and `modelUsage` is the only
		// place the truth is written down. Skipped entirely when nothing was pinned
		// (`inherit`, or an unpinned tool) or when the tool reports no model — there
		// is no claim to check in either case.
		//
		// Containment, not equality: the request is a CLI alias ("sonnet") while the
		// envelope reports a full id ("claude-sonnet-5").
		// `effectiveModel`, not `localModel`: after an un-pinned retry the request
		// was withdrawn by US, and warning that "the tool did not run the requested
		// model" would blame it for our own decision. The retry already logged why.
		if (effectiveModel && outcome.model) {
			if (!outcome.model.toLowerCase().includes(effectiveModel.toLowerCase())) {
				log.warn(
					"Local-agent model mismatch: action=%s tool=%s requested=%s actual=%s — the tool did not run the requested model.",
					options.action,
					tool,
					effectiveModel,
					outcome.model,
				);
			} else if (/\[\d+[mk]\]/i.test(outcome.model)) {
				// Reported separately from a plain mismatch because the FAMILY matched
				// and only the tier did not: a long-context variant is a distinct SKU
				// priced above the base model, and an alias is never supposed to be able
				// to select one. If this ever fires, the assumption that aliases cannot
				// reach the `[1m]` tier has stopped holding.
				log.warn(
					"Local-agent ran a long-context variant: action=%s tool=%s requested=%s actual=%s — that tier is priced above the base model.",
					options.action,
					tool,
					effectiveModel,
					outcome.model,
				);
			}
		}

		// Surface the subscription cost the backend parsed. `LlmCallResult` has no
		// cost field (no provider carries one), so without this the value would be
		// dead — and local-agent spend is otherwise invisible, since it bills the
		// tool's own subscription rather than a jollimemory-metered key. `model` is
		// logged beside it because cost is only interpretable next to the tier that
		// produced it, and for an unpinned tool this line is the only place the
		// tool's own model choice becomes observable at all.
		log.info(
			"Local-agent completion: action=%s tool=%s model=%s cost=$%s in=%d out=%d cached=%d%s",
			options.action,
			tool,
			resultModel,
			outcome.costUsd.toFixed(4),
			outcome.inputTokens,
			outcome.outputTokens,
			outcome.cachedTokens,
			// Only present on a CLI too old for some isolation flag. Worth carrying
			// on the success line: the run worked, so nothing else would ever hint
			// that this machine is paying more prompt tokens than it needs to.
			disabledFlagIds.size > 0 ? ` degraded=${[...disabledFlagIds].join(",")}` : "",
		);

		return {
			text: outcome.text,
			model: resultModel,
			inputTokens: outcome.inputTokens,
			outputTokens: outcome.outputTokens,
			cachedTokens: outcome.cachedTokens,
			apiLatencyMs: Date.now() - startTime,
			stopReason: outcome.stopReason,
			source,
			localAgentTool: tool,
		};
	} catch (err) {
		// Symmetric with callDirect/callProxy, which both log rich failure detail:
		// local-agent was the ONLY provider that logged nothing when a CLI was found
		// but the invocation still failed. This covers a run() rejection (timeout /
		// spawn failure / nonzero exit with no stdout) AND a parseResult throw
		// (expired login, unparseable output). errorName carries the LocalAgent*Error
		// class so debug.log shows the classification (setup vs auth vs transient)
		// without decoding the message. Discovery failures throw earlier (before this
		// try) and are logged by resolveExecutable instead.
		const elapsedMs = Date.now() - startTime;
		const errorName = err instanceof Error ? err.name : "(non-error)";
		const message = err instanceof Error ? err.message : String(err);
		log.error(
			"Local-agent call failed: action=%s tool=%s exe=%s elapsedMs=%d errorName=%s error=%s",
			options.action,
			tool,
			describeCandidate(exe),
			elapsedMs,
			errorName,
			message,
		);
		throw err;
	} finally {
		// Every attempt, not just the successful one: a flag-degrading retry builds
		// a fresh invocation each round and each mints its own temp cwd.
		for (const cwd of spawnedCwds) removeLocalAgentCwd(cwd);
	}
}

async function callDirect(
	options: LlmCallOptions,
	apiKey: string,
	source: LlmCredentialSource,
): Promise<LlmCallResult> {
	const entry = TEMPLATES.get(options.action);
	if (!entry) {
		throw new Error(`Unknown LLM action: "${options.action}". Available: ${[...TEMPLATES.keys()].join(", ")}`);
	}
	const missing = findUnfilledPlaceholders(entry.template, options.params);
	if (missing.length > 0) {
		log.warn("Direct LLM call has unfilled placeholders for action=%s: %s", options.action, missing.join(", "));
	}
	const prompt = fillTemplate(entry.template, options.params);

	const model = resolveModelId(options.model);
	const maxTokens = options.maxTokens ?? 8192;

	const client = getOrCreateClient(apiKey);
	const startTime = Date.now();

	// Stream by default; only a "trivially small" call — small on BOTH the output
	// cap AND the prompt size — takes the simple non-streaming `messages.create`
	// path. See NONSTREAM_MAX_OUTPUT_TOKENS / NONSTREAM_MAX_PROMPT_CHARS for the
	// rationale (liveness watchdog beats a fixed wall-clock for anything that may
	// run long, and a tiny-output action like commit-message can still carry a
	// huge diff). `forceStreaming` still forces streaming. The SDK's non-streaming
	// "10-minute" refusal is moot: any call large enough to approach it streams.
	const isTrivialCall = maxTokens <= NONSTREAM_MAX_OUTPUT_TOKENS && prompt.length <= NONSTREAM_MAX_PROMPT_CHARS;
	const useStreaming = options.forceStreaming === true || !isTrivialCall;

	// Observability: a successful direct call otherwise logs nothing about which
	// path it took, so streaming-vs-non-streaming can't be confirmed from
	// debug.log without forcing a failure. Emit the decision + the inputs behind
	// it at info level (debug level is not persisted to debug.log).
	const streamReason =
		options.forceStreaming === true
			? "forceStreaming"
			: !useStreaming
				? "trivial(small output+prompt)"
				: maxTokens > NONSTREAM_MAX_OUTPUT_TOKENS && prompt.length > NONSTREAM_MAX_PROMPT_CHARS
					? "large output+prompt"
					: maxTokens > NONSTREAM_MAX_OUTPUT_TOKENS
						? "large output"
						: "large prompt";
	log.info(
		"Direct path: action=%s streaming=%s reason=%s maxTokens=%d promptChars=%d (non-stream needs maxTokens<=%d AND promptChars<=%d)",
		options.action,
		useStreaming,
		streamReason,
		maxTokens,
		prompt.length,
		NONSTREAM_MAX_OUTPUT_TOKENS,
		NONSTREAM_MAX_PROMPT_CHARS,
	);

	let response: Anthropic.Message;
	try {
		const body = {
			model,
			max_tokens: maxTokens,
			temperature: 0,
			messages: [{ role: "user" as const, content: prompt }],
		};
		if (useStreaming) {
			// A fixed `AbortSignal.timeout` would kill legitimate large responses
			// (streaming is selected *because* the call may exceed the non-streaming
			// budget, e.g. a 64K merge response). Guard with an INACTIVITY watchdog
			// instead: abort only when no stream event arrives within
			// STREAM_IDLE_TIMEOUT_MS. Anthropic emits `ping` events throughout
			// generation, so a healthy-but-slow stream keeps resetting the timer
			// while a wedged socket produces nothing and is aborted — restoring the
			// fail-fast guarantee without capping valid long responses.
			const stream = client.messages.stream(body);
			// Node 24's async-iterator teardown can make `finalMessage()` reject with
			// ERR_STREAM_PREMATURE_CLOSE *after* the full response was already received (the
			// `message_stop` event fired) — the socket close races the iterator's own end.
			// Capture the completed message from the `message` event (emitted on message_stop)
			// so a call that actually succeeded is recovered rather than failed. VS Code never
			// hit this because its extension host runs on Electron's Node 22; the IntelliJ
			// plugin shells out to the user's system Node (24+), which does.
			let receivedMessage: Anthropic.Message | undefined;
			stream.on("message", (m) => {
				receivedMessage = m;
			});
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const armIdleWatchdog = (): void => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => stream.abort(), STREAM_IDLE_TIMEOUT_MS);
				// Never let the watchdog keep a CLI process alive past its work.
				idleTimer.unref?.();
			};
			armIdleWatchdog();
			stream.on("streamEvent", armIdleWatchdog);
			// Absolute cap, NOT reset by stream events — bounds a stream that keeps
			// pinging but never completes, which the idle watchdog alone can't catch.
			const hardTimer = setTimeout(() => stream.abort(), options.timeoutMs ?? STREAM_MAX_WALL_CLOCK_MS);
			hardTimer.unref?.();
			try {
				response = await stream.finalMessage();
			} catch (streamErr) {
				// Only recover when the message genuinely completed (message_stop → `message`
				// event). A premature close with no received message is a real truncation and
				// must propagate so the caller retries.
				if (receivedMessage !== undefined && isPrematureClose(streamErr)) {
					log.warn(
						"stream.finalMessage() threw a premature-close after the response completed; recovering the received message (Node %s async-iterator teardown). action=%s",
						process.version,
						options.action,
					);
					response = receivedMessage;
				} else {
					throw streamErr;
				}
			} finally {
				clearTimeout(idleTimer);
				clearTimeout(hardTimer);
			}
		} else {
			// Hard cap on the in-flight HTTP request — see `DIRECT_FETCH_TIMEOUT_MS`.
			// AbortSignal.timeout fires once after the given delay; the SDK
			// surfaces it as an AbortError that the outer `catch` already
			// logs with `cause`, so a wedged socket fails fast instead of
			// holding the caller (e.g. `ConflictResolver.resolveAll`)
			// indefinitely.
			response = await client.messages.create(body, {
				signal: AbortSignal.timeout(options.timeoutMs ?? DIRECT_FETCH_TIMEOUT_MS),
			});
		}
	} catch (err) {
		// Surface the effective baseURL so users can tell whether a 3rd-party relay
		// (e.g. an ANTHROPIC_BASE_URL override) returned the error versus Anthropic itself.
		// Also surface error.cause: undici wraps transport-layer reasons (DNS, TLS,
		// ECONNREFUSED, ECONNRESET, ETIMEDOUT) inside `cause`, so logging only the
		// outer message leaves "fetch failed" with no diagnostic information.
		const baseUrl = client.baseURL;
		const message = err instanceof Error ? err.message : String(err);
		const cause = err instanceof Error ? formatCause((err as { cause?: unknown }).cause) : "(non-error)";
		// model / maxTokens / promptChars / elapsedMs turn a wall-clock-timeout
		// abort ("Request was aborted." with cause=(none)) into something
		// actionable: they show how large the prompt was and how long the call
		// ran before aborting, so "prompt too big for the 180s budget" is
		// distinguishable from a genuinely wedged connection without re-running.
		const elapsedMs = Date.now() - startTime;
		// errorName / httpStatus / requestId separate the failure modes that share
		// the "Request was aborted. cause=(none)" fingerprint. A wedged/slow call
		// killed by our AbortSignal surfaces as an abort with NO httpStatus and NO
		// requestId (the response never came). A server-side failure (rate limit
		// 429, overloaded 529, 5xx) carries an httpStatus, and any request that
		// actually reached Anthropic carries a requestId — so "the API rejected us"
		// is distinguishable from "the connection never produced a response".
		const errorName = err instanceof Error ? err.name : "(non-error)";
		const httpStatus = (err as { status?: number })?.status;
		// `||` (not `??`) so an empty-string id falls through to the camelCase
		// fallback and then to "(none)" rather than logging a blank field. The
		// current SDK sets `request_id` (snake_case) from the `request-id` header;
		// `requestID` is a defensive fallback for other/older error shapes.
		const requestId = (err as { request_id?: string })?.request_id || (err as { requestID?: string })?.requestID;
		log.error(
			"Direct LLM call failed: action=%s model=%s maxTokens=%d promptChars=%d elapsedMs=%d baseUrl=%s errorName=%s httpStatus=%s requestId=%s error=%s cause=%s",
			options.action,
			model,
			maxTokens,
			prompt.length,
			elapsedMs,
			baseUrl,
			errorName,
			httpStatus === undefined ? "(none)" : String(httpStatus),
			requestId || "(none)",
			message,
			cause,
		);
		throw new Error(`LLM direct request to ${baseUrl} failed: ${message}`);
	}

	const elapsed = Date.now() - startTime;

	const textBlock = response.content.find((block) => block.type === "text");
	if (!textBlock || textBlock.type !== "text") {
		throw new Error("No text content in API response");
	}

	return {
		text: textBlock.text.trim(),
		model: response.model,
		inputTokens: response.usage.input_tokens,
		outputTokens: response.usage.output_tokens,
		cachedTokens: (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
		apiLatencyMs: elapsed,
		stopReason: response.stop_reason,
		source,
	};
}

/** Proxy mode: POST structured request to Jolli backend */
async function callProxy(
	options: LlmCallOptions,
	baseUrl: string,
	source: LlmCredentialSource,
): Promise<LlmCallResult> {
	const { jolliApiKey } = options;
	/* v8 ignore start -- callProxy is only reached via callLlm which already guards jolliApiKey */
	if (!jolliApiKey) {
		throw new Error("Proxy mode requires jolliApiKey");
	}
	/* v8 ignore stop */

	const parsed = parseBaseUrl(baseUrl);
	const keyMeta = parseJolliApiKey(jolliApiKey);
	const orgSlug = keyMeta?.o;
	// Tenant slug from URL path (dev path-based) or API key metadata
	const tenantSlug = parsed.tenantSlug ?? keyMeta?.t;

	// Tenant is resolved via X-Jolli-Tenant header, not path — the path is always the same.
	const url = `${parsed.origin}${LLM_PROXY_PATH}`;

	// Jolli trace context: propagate the ambient trace id so the
	// backend can correlate this proxy call with the CLI operation that issued
	// it. Every outbound request is traceable — outside any trace scope we mint
	// a fresh standalone value rather than omit the header.
	const traceHeader = currentTraceHeader() ?? newTraceHeader();

	// Resolve the version to send to the proxy:
	// 1. Caller-supplied `options.version` wins (used for pinning to a specific
	//    revision in tests / debug scenarios).
	// 2. Otherwise auto-inject the version from the TEMPLATES entry. This is the
	//    normal path — every action has a known version baked into the CLI build.
	// 3. If neither is present (action unknown to TEMPLATES — should be unreachable
	//    given direct mode validates the same map), omit `version` so the backend
	//    falls back to its max-revision lookup.
	const templateEntry = TEMPLATES.get(options.action);
	const versionToSend = options.version ?? templateEntry?.version;

	const body = JSON.stringify({
		action: options.action,
		params: options.params as Record<string, unknown>,
		...(versionToSend !== undefined ? { version: versionToSend } : {}),
	});

	log.info("Proxy LLM call: action=%s url=%s", options.action, url);

	const startTime = Date.now();

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${jolliApiKey}`,
				"x-jolli-client": JOLLI_CLIENT_HEADER,
				...(tenantSlug ? { "x-tenant-slug": tenantSlug } : {}),
				...(orgSlug ? { "x-org-slug": orgSlug } : {}),
				[TRACE_HEADER_NAME]: traceHeader,
			},
			body,
			signal: AbortSignal.timeout(options.timeoutMs ?? PROXY_FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		// Transport-layer failure (DNS, TLS handshake, connect, reset, timeout).
		// undici wraps the real reason in `cause` — without surfacing it the log
		// is just "fetch failed" and the operator has no way to diagnose.
		// elapsedMs / bodyChars / errorName bring the proxy path to diagnostic
		// parity with the direct path: elapsedMs ≈ PROXY_FETCH_TIMEOUT_MS plus an
		// AbortError name marks a wall-clock-timeout abort (the backend stalled or
		// the connection wedged), versus a transport error that fails faster with
		// a populated cause; bodyChars is the proxy-side analog of promptChars.
		const elapsedMs = Date.now() - startTime;
		const message = err instanceof Error ? err.message : String(err);
		const cause = err instanceof Error ? formatCause((err as { cause?: unknown }).cause) : "(non-error)";
		const errorName = err instanceof Error ? err.name : "(non-error)";
		log.error(
			"Proxy LLM fetch failed: action=%s url=%s elapsedMs=%d bodyChars=%d errorName=%s error=%s cause=%s",
			options.action,
			url,
			elapsedMs,
			body.length,
			errorName,
			message,
			cause,
		);
		throw err;
	}
	const elapsed = Date.now() - startTime;

	if (!response.ok) {
		const errorBody = await response.text();
		log.error("Proxy LLM error: status=%d body=%s", response.status, errorBody.substring(0, 500));
		throw new Error(`LLM proxy request failed with status ${response.status}: ${errorBody.substring(0, 200)}`);
	}

	const result = (await response.json()) as Record<string, unknown>;

	log.info("Proxy LLM response: action=%s latency=%dms", options.action, elapsed);

	/* v8 ignore start -- defensive: proxy response always includes token counts, ?? 0 is a safety net */
	return {
		text: result.text as string | undefined,
		inputTokens: (result.inputTokens as number) ?? 0,
		outputTokens: (result.outputTokens as number) ?? 0,
		cachedTokens: (result.cachedTokens as number) ?? 0,
		apiLatencyMs: elapsed,
		source,
	};
	/* v8 ignore stop */
}
