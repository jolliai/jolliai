/**
 * The shared onboarding-funnel tail of the two plugin SessionStart bootstraps
 * (`PluginBootstrapHook` for Claude, `CodexPluginBootstrapHook` for Codex).
 * Both hooks used to carry this sequence verbatim — three calls plus the same
 * eight-line comment — and duplicated must-stay-in-sync blocks are exactly the
 * failure mode this repo's lockstep rules exist to prevent.
 *
 * What the sequence does, and why the order is load-bearing:
 *   1. `bootstrapTelemetry` primes the in-process telemetry context — a
 *      one-shot hook process otherwise has none, so `track()` would be a no-op.
 *   2. `maybeEmitOnboardingProgress` records the funnel snapshot (dedup-gated,
 *      buffered on disk — no network).
 *   3. `flushTelemetryNow` sends the buffer, since a one-shot hook gets no
 *      later flush tick. It is STARTED here but deliberately NOT awaited: the
 *      caller holds the returned promise and awaits it right before returning,
 *      so the network wait overlaps the briefing build instead of delaying it.
 *      Both the per-POST timeout and the total deadline are capped at 2 s — the
 *      hook blocks the host's session start, and an uncapped flush of a full
 *      buffer is several sequential POSTs, not one.
 *
 * The config is read ONCE and injected into both telemetry calls through their
 * `deps` seams — each would otherwise do its own uncached `readFile` +
 * `JSON.parse` of the same file (and could theoretically observe different
 * contents).
 *
 * Never throws, and `flushed` never rejects: telemetry must not cost the user
 * the briefing, let alone fail the hook (a stray error line on stdout is
 * exactly what Codex's SessionStart schema rejects).
 */

import { maybeEmitOnboardingProgress } from "../core/OnboardingFunnel.js";
import { loadConfig } from "../core/SessionTracker.js";
import { bootstrapTelemetry, flushTelemetryNow } from "../core/TelemetryStartup.js";

/** Per-POST timeout AND total budget for the bootstrap's blocking flush. */
export const PLUGIN_FUNNEL_FLUSH_BUDGET_MS = 2_000;

export interface PluginFunnelSnapshot {
	/**
	 * Resolves when the bounded flush completes; never rejects. The hook must
	 * await this before returning — after the briefing work, so the two overlap.
	 */
	readonly flushed: Promise<void>;
}

/**
 * Emit the onboarding-funnel snapshot for a plugin SessionStart bootstrap and
 * start the bounded telemetry flush. Call after repo-hook reconciliation (the
 * snapshot must observe the just-installed state), on the success AND failure
 * paths — a setup that installs but never reaches a working state is precisely
 * the drop-off the funnel exists to observe.
 */
export async function capturePluginOnboardingSnapshot(
	worktreeRoot: string,
	sessionId?: string,
): Promise<PluginFunnelSnapshot> {
	try {
		const config = await loadConfig();
		const loadOnce = async (): Promise<typeof config> => config;
		await bootstrapTelemetry({ cwd: worktreeRoot, sessionId, deps: { loadConfig: loadOnce } });
		await maybeEmitOnboardingProgress({ cwd: worktreeRoot, config });
		const flushed = flushTelemetryNow(worktreeRoot, {
			loadConfig: loadOnce,
			timeoutMs: PLUGIN_FUNNEL_FLUSH_BUDGET_MS,
			deadlineMs: PLUGIN_FUNNEL_FLUSH_BUDGET_MS,
		});
		return { flushed };
	} catch {
		// A config read failure costs the snapshot, never the briefing. (The
		// three calls above each guard themselves; this guards the read.)
		return { flushed: Promise.resolve() };
	}
}
