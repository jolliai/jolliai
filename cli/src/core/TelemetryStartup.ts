/**
 * TelemetryStartup — the one-call bootstrap that resolves everything
 * `Telemetry.initTelemetry` needs and primes the module context (JOLLI-1785
 * Phase 2). Called once on the CLI startup path (`Api.ts main`) and mirrored
 * by the VS Code activate path. Kept out of `main()` so the resolution logic
 * is unit-testable in isolation and never drags the hot startup path's
 * coverage.
 *
 * Resolution:
 *   - config: the machine-global config (`loadConfig`).
 *   - installId: minted once per machine (`getOrCreateInstallId`). Minting is
 *     a local random UUID — inert until a flush, which the consent gate blocks
 *     when the user opted out — so it is safe to always mint.
 *   - origin → env: the client's already-resolved jolli origin. A signed-in
 *     key's embedded tenant URL wins; else the saved `jolliUrl`; else
 *     `getJolliUrl()`. `Telemetry.resolveTelemetryEnv` maps it to local/dev/
 *     preview/prod.
 *
 * Fires `app_installed` exactly once — on the run that mints the installId.
 * The deps are injectable for tests; production uses the real implementations.
 */
import { getJolliUrl as defaultGetJolliUrl } from "../auth/AuthConfig.js";
import type { JolliMemoryConfig } from "../Types.js";
import { parseJolliApiKey } from "./JolliApiUtils.js";
import {
	getOrCreateInstallId as defaultGetOrCreateInstallId,
	loadConfig as defaultLoadConfig,
	saveConfig as defaultSaveConfig,
} from "./SessionTracker.js";
import { initTelemetry, track } from "./Telemetry.js";
import { detectAgentFromEnv } from "./TelemetryAgent.js";
import { clearTelemetryBuffer } from "./TelemetryBuffer.js";
import { isTelemetryEnabled, shouldShowTelemetryNotice } from "./TelemetryConsent.js";
import { flushTelemetry } from "./TelemetryFlusher.js";

export interface BootstrapTelemetryOptions {
	/** Project dir whose buffer receives events. */
	readonly cwd: string;
	/** Current AI/editor session id, when known. */
	readonly sessionId?: string;
	/**
	 * The AI host this process is working in, for a caller that knows it
	 * STRUCTURALLY — a plugin bootstrap only ever runs inside its own host, which
	 * is a stronger claim than any marker. Beats {@link inferAgentFromEnv} when
	 * both are given. An unrecognised value leaves the dimension absent rather
	 * than defaulted — see `TelemetryAgent`.
	 */
	readonly agent?: string;
	/**
	 * Whether this process may infer its host from the env markers
	 * (`TelemetryAgent.detectAgentFromEnv`). **Defaults to false — opt in.**
	 *
	 * The markers are only trustworthy under one condition: *this process is the
	 * one the AI host just launched*. Env vars are inherited by every descendant
	 * and never expire, so the condition holds for a short-lived CLI invocation or
	 * a git hook, and fails for anything long-lived that has outlived the shell
	 * that started it — a GUI extension host, the `ide-bridge` server. Cold-start
	 * VS Code with `code .` from inside a Claude session and its extension host
	 * carries `CLAUDECODE` for days, so every button click in that window would
	 * report `agent: "claude"` while the user is clicking, not prompting.
	 *
	 * Off by default because the two mistakes are not symmetric, which is the same
	 * asymmetry the whole dimension rests on: forgetting to opt a short-lived path
	 * IN costs one channel's data, and data can be backfilled from the day someone
	 * notices. Forgetting to opt a long-lived host OUT produces confident wrong
	 * values that no later fix can separate from the true ones.
	 *
	 * Note it must be ON for anything that re-bootstraps mid-process — a second
	 * bootstrap REPLACES the context, so leaving it off would clear an agent an
	 * earlier bootstrap had correctly inferred.
	 */
	readonly inferAgentFromEnv?: boolean;
	/** Host-platform opt-out (VS Code passes `!vscode.env.isTelemetryEnabled`). */
	readonly platformDisabled?: boolean;
	/** Env for the `DO_NOT_TRACK` check. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Test seams. */
	readonly deps?: BootstrapDeps;
}

export interface BootstrapDeps {
	readonly loadConfig?: () => Promise<JolliMemoryConfig>;
	readonly getOrCreateInstallId?: () => Promise<{ readonly installId: string; readonly created: boolean }>;
	readonly getJolliUrl?: () => string;
}

/** Resolve the jolli origin telemetry should report `env` from. */
export function resolveTelemetryOrigin(config: JolliMemoryConfig, getJolliUrl: () => string): string | undefined {
	if (config.jolliApiKey) {
		const meta = parseJolliApiKey(config.jolliApiKey);
		if (meta) return meta.u;
	}
	if (config.jolliUrl) return config.jolliUrl;
	try {
		return getJolliUrl();
	} catch {
		// JOLLI_URL off-allowlist / unset with no default — env stays "unknown".
		return undefined;
	}
}

/** Resolve config + installId + origin and initialize telemetry. Never throws. */
export async function bootstrapTelemetry(opts: BootstrapTelemetryOptions): Promise<void> {
	const loadConfig = opts.deps?.loadConfig ?? defaultLoadConfig;
	const getOrCreateInstallId = opts.deps?.getOrCreateInstallId ?? defaultGetOrCreateInstallId;
	const getJolliUrl = opts.deps?.getJolliUrl ?? defaultGetJolliUrl;
	try {
		const config = await loadConfig();
		const { installId, created } = await getOrCreateInstallId();
		const origin = resolveTelemetryOrigin(config, getJolliUrl);
		initTelemetry({
			cwd: opts.cwd,
			installId,
			sessionId: opts.sessionId,
			agent: opts.agent ?? (opts.inferAgentFromEnv ? detectAgentFromEnv(opts.env) : undefined),
			origin,
			config,
			platformDisabled: opts.platformDisabled,
			env: opts.env,
		});
		if (created) track("app_installed");
	} catch {
		// Telemetry bootstrap must never block CLI/extension startup.
	}
}

/** The one-time CLI disclosure, printed to stderr (so it never pollutes stdout / piped output). */
export const CLI_TELEMETRY_NOTICE =
	"\nℹ Jolli Memory collects anonymous, content-free usage telemetry to improve the product —\n" +
	"  never your code, file paths, or memory content. Turn it off any time:\n" +
	"    jolli telemetry off      (or set DO_NOT_TRACK=1)\n" +
	"  See exactly what would be sent: jolli telemetry inspect · https://www.jolli.ai/telemetry\n\n";

export interface CliNoticeDeps {
	readonly loadConfig?: () => Promise<JolliMemoryConfig>;
	readonly saveConfig?: (update: Partial<JolliMemoryConfig>) => Promise<void>;
	readonly env?: NodeJS.ProcessEnv;
	readonly write?: (s: string) => void;
}

/**
 * Print the first-run telemetry disclosure to stderr exactly once per machine
 * (CLI surface), then record it as shown. No-op when telemetry is off
 * (DO_NOT_TRACK / config) or the notice was already shown. Never throws.
 * Returns whether it printed (for tests).
 */
export async function maybeShowCliTelemetryNotice(deps?: CliNoticeDeps): Promise<boolean> {
	const loadConfig = deps?.loadConfig ?? defaultLoadConfig;
	const saveConfig = deps?.saveConfig ?? defaultSaveConfig;
	const write = deps?.write ?? ((s: string) => process.stderr.write(s));
	try {
		const config = await loadConfig();
		if (!shouldShowTelemetryNotice({ config, env: deps?.env })) return false;
		write(CLI_TELEMETRY_NOTICE);
		await saveConfig({ telemetryNoticeShown: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * The standard budget for a flush that is blocking something user-visible:
 * used as BOTH the per-POST `timeoutMs` and the whole-flush `deadlineMs`.
 * Consumers: the CLI's command-exit flush (holds the shell prompt), the two
 * plugin SessionStart bootstraps and `enable --repo-hooks-only` (hold the
 * host's session start). One name so the number cannot be tuned at one site
 * and silently not the others.
 */
export const BOUNDED_FLUSH_BUDGET_MS = 2_000;

export interface FlushNowDeps {
	readonly loadConfig?: () => Promise<JolliMemoryConfig>;
	readonly getJolliUrl?: () => string;
	readonly fetchImpl?: typeof fetch;
	/** Host-platform opt-out (VS Code passes `!vscode.env.isTelemetryEnabled`). */
	readonly platformDisabled?: boolean;
	/** Env for the `DO_NOT_TRACK` check. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Per-POST timeout override, forwarded to `flushTelemetry`. Latency-sensitive
	 * callers (the CLI command-exit flush, JOLLI-1955) pass a short cap so a slow
	 * network can't stall the process; omit to use the flusher's default (10s).
	 */
	readonly timeoutMs?: number;
	/**
	 * Total flush budget, forwarded to `flushTelemetry`. `timeoutMs` bounds each
	 * POST; a full buffer still flushes as several sequential POSTs, so a caller
	 * that is blocking something user-visible (the plugin SessionStart
	 * bootstraps) passes this to bound the whole call. See `FlushOptions`.
	 */
	readonly deadlineMs?: number;
}

/**
 * Resolve origin + key from config and flush the buffer once. Never throws.
 * The reusable flush entry point for the QueueWorker drain / process exit
 * (and the VS Code tick), independent of the in-process Telemetry context so
 * it works in a freshly-spawned worker that never called `initTelemetry`.
 *
 * Consent is **re-gated here**, not just at `track()` time: a user who runs
 * `jolli telemetry off` (or sets `DO_NOT_TRACK`) after events were already
 * buffered must not have those events uploaded. When opted out, the buffer is
 * dropped instead of sent — honoring the `telemetry off` promise.
 */
export async function flushTelemetryNow(cwd: string, deps?: FlushNowDeps): Promise<void> {
	const loadConfig = deps?.loadConfig ?? defaultLoadConfig;
	const getJolliUrl = deps?.getJolliUrl ?? defaultGetJolliUrl;
	try {
		const config = await loadConfig();
		if (!isTelemetryEnabled({ config, env: deps?.env, platformDisabled: deps?.platformDisabled })) {
			await clearTelemetryBuffer(cwd);
			return;
		}
		const origin = resolveTelemetryOrigin(config, getJolliUrl);
		await flushTelemetry({
			cwd,
			origin,
			jolliApiKey: config.jolliApiKey,
			fetchImpl: deps?.fetchImpl,
			timeoutMs: deps?.timeoutMs,
			deadlineMs: deps?.deadlineMs,
		});
	} catch {
		// Flush is best-effort — never propagate into the worker / exit path.
	}
}
