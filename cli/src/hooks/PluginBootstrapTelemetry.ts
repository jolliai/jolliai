/**
 * The shared onboarding-funnel snapshot for the plugin install surfaces: both
 * SessionStart bootstraps (`PluginBootstrapHook` for Claude,
 * `CodexPluginBootstrapHook` for Codex) and `enable --repo-hooks-only` (the
 * `/jolli:init` path). The hooks used to carry this sequence verbatim — three
 * calls plus the same eight-line comment — and duplicated must-stay-in-sync
 * blocks are exactly the failure mode this repo's lockstep rules exist to
 * prevent.
 *
 * The call is SYNCHRONOUS-START, FULLY DEFERRED: it kicks off the whole chain
 * and returns a handle immediately, so a caller with other work (the hooks'
 * briefing build) overlaps every part of it — the config read, the telemetry
 * bootstrap, the funnel probes (git subprocesses + fs reads, paid on every
 * session start since dedup needs the state first), and the bounded network
 * flush. Await `done` before returning/exiting; a caller with nothing to
 * overlap just awaits immediately.
 *
 * What the chain does, in an order that is load-bearing:
 *   1. `loadConfig` — read ONCE and injected into both telemetry calls through
 *      their `deps` seams; each would otherwise do its own uncached read of
 *      the same file. NOTE for hook callers: start the chain only AFTER
 *      `ensurePluginDefaultProvider` has seeded the capture route, or a fresh
 *      install's first snapshot misreports `capture_method: "none"` for a
 *      state the same hook run repairs milliseconds later.
 *   2. `bootstrapTelemetry` primes the in-process telemetry context — a
 *      one-shot hook process otherwise has none, so `track()` would no-op. In
 *      the `enable` process this re-points the context at the requested cwd,
 *      which is what keeps the buffer, the flush, and the dedup ledger on the
 *      SAME directory even under an explicit `--cwd`.
 *   3. `maybeEmitOnboardingProgress` records the snapshot (dedup-gated,
 *      buffered on disk — no network).
 *   4. `flushTelemetryNow` sends the buffer — a one-shot process gets no later
 *      flush tick, and `enable --repo-hooks-only` disarmed the exit flush.
 *      Both the per-POST timeout and the whole-flush deadline are
 *      `BOUNDED_FLUSH_BUDGET_MS`: these callers block a session start or a
 *      shell prompt, and an uncapped flush of a full buffer is several
 *      sequential POSTs, not one.
 *
 * `done` NEVER rejects: telemetry must not cost the user the briefing, let
 * alone fail the hook (a stray error line on stdout is exactly what Codex's
 * SessionStart schema rejects).
 */

import { maybeEmitOnboardingProgress } from "../core/OnboardingFunnel.js";
import { loadConfig } from "../core/SessionTracker.js";
import { BOUNDED_FLUSH_BUDGET_MS, bootstrapTelemetry, flushTelemetryNow } from "../core/TelemetryStartup.js";

export interface PluginFunnelSnapshot {
	/**
	 * Resolves when the whole chain (config read → bootstrap → emit → bounded
	 * flush) completes; never rejects. The caller must await this before
	 * returning — inside a `finally`, so no future early return or throw can
	 * orphan an in-flight POST.
	 */
	readonly done: Promise<void>;
}

/**
 * Start the onboarding-funnel snapshot chain for a plugin install surface and
 * return immediately. Call after repo-hook reconciliation (the snapshot must
 * observe the just-installed state) and — on the hooks' success path — after
 * `ensurePluginDefaultProvider` (see the module doc). Fire on the success AND
 * failure paths: a setup that installs but never reaches a working state is
 * precisely the drop-off the funnel exists to observe.
 */
export function capturePluginOnboardingSnapshot(worktreeRoot: string, sessionId?: string): PluginFunnelSnapshot {
	const done = (async (): Promise<void> => {
		try {
			const config = await loadConfig();
			const loadOnce = async (): Promise<typeof config> => config;
			await bootstrapTelemetry({ cwd: worktreeRoot, sessionId, deps: { loadConfig: loadOnce } });
			await maybeEmitOnboardingProgress({ cwd: worktreeRoot, config });
			await flushTelemetryNow(worktreeRoot, {
				loadConfig: loadOnce,
				timeoutMs: BOUNDED_FLUSH_BUDGET_MS,
				deadlineMs: BOUNDED_FLUSH_BUDGET_MS,
			});
		} catch {
			// A config read failure costs the snapshot, never the briefing. (The
			// three calls above each guard themselves; this guards the read.)
		}
	})();
	return { done };
}
