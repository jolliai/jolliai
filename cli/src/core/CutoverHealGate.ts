/**
 * CutoverHealGate — the shared state machine that keeps a long-lived process's
 * cached storage honest across a cutover it did not witness.
 *
 * Two hosts need the identical scaffolding around an unwitnessed cutover: the
 * per-worktree MCP daemon ({@link ../core/ActiveStorageHeal.ts}) and the VS Code
 * extension host ({@link ../../../vscode/src/JolliMemoryBridge.ts}). Both must
 * probe the repo's cutover route lazily, coalesce the concurrent probes a burst
 * of tool calls would otherwise fire, latch off once the repo is seen cut over
 * (cutover is one-way), and back off between probes while the repo is still
 * uncutover so the common path stays near-free. Only the APPLY step differs — the
 * daemon swaps the process-global `setActiveStorage`, the bridge drops its cached
 * storage promises — and that difference is the `applyHeal` callback. Everything
 * else (the throttle window, the in-flight promise, the racing re-check) is this
 * class, so a change to the heal contract is made once instead of drifting across
 * two hand-rolled copies.
 *
 * The route CLASSIFIER ({@link routeMovesOffOrphanBranch}) is the genuinely
 * shared product rule and already lived in `cli/src`; this gate is the generic
 * async plumbing around it, parameterized so no host specifics leak in.
 */

import { type CutoverRoute, resolveCutoverRoute, routeMovesOffOrphanBranch } from "../dashboard/CutoverRouter.js";

/**
 * How long a repo that probed as still-orphan-backed (uncutover / blocked, or a
 * probe that failed) is trusted before the route is probed again. Bounds the
 * per-call cost of the pre-cutover common path at the cost of an at-most-one-window
 * read-staleness gap after an unwitnessed cutover — a write re-reads the fence at
 * the plumbing layer regardless, so the gap is reads only, never a data gap.
 */
export const ROUTE_PROBE_THROTTLE_MS = 5_000;

export interface CutoverHealGateOptions {
	/** The repo / worktree root this gate probes for. */
	cwd: string;
	/**
	 * Fast path AND racing re-check: `true` when the host's storage already reads
	 * the current source of truth, so no heal is needed. Consulted BEFORE probing
	 * (skip the whole probe) and again AFTER probing but before {@link applyHeal}
	 * (yield to a heal that landed while this one was probing).
	 */
	isHealed: () => boolean;
	/**
	 * Apply the heal for a route that has moved off the orphan branch. May throw:
	 * a transient failure (a momentary SQLite lock, a git probe error) must not
	 * fail the tool call that triggered the heal, so on a throw the gate backs off
	 * and a later {@link ensure} retries. Reached only when {@link isHealed} is
	 * still `false` after the route probe.
	 */
	applyHeal: (route: CutoverRoute) => void | Promise<void>;
	/** Host hook for logging a route-probe failure (the route is left as-is). */
	onProbeError?: (err: unknown) => void;
	/** Host hook for logging an {@link applyHeal} failure (the gate backs off). */
	onApplyError?: (err: unknown) => void;
	/** Throttle override; defaults to {@link ROUTE_PROBE_THROTTLE_MS}. */
	throttleMs?: number;
}

export class CutoverHealGate {
	private inFlight: Promise<void> | null = null;
	private nextProbeAt = 0;

	constructor(private readonly opts: CutoverHealGateOptions) {}

	/**
	 * Rebuilds the host's storage if the repo has cut over since it was cached.
	 * A no-op on the fast path (already reads the source of truth, or throttled).
	 * Never throws — see {@link CutoverHealGateOptions.applyHeal}.
	 */
	ensure(): Promise<void> {
		// Fast path: storage that already reads the system of record never regresses
		// (cutover is one-way), so skip the route lookup entirely.
		if (this.opts.isHealed()) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		// Throttle: a still-uncutover repo stays orphan-backed for a daemon's whole
		// life, so probing on every call is wasted work. Cutover is rare and one-way.
		if (Date.now() < this.nextProbeAt) return Promise.resolve();
		this.inFlight = this.run().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/**
	 * Forget the back-off so the very next {@link ensure} re-probes instead of
	 * trusting the window. Called when a write hit "orphan branch is frozen": that
	 * throw proves a cutover landed INSIDE the current window, so waiting it out
	 * would let a self-retrying caller strike the frozen branch twice.
	 */
	forgetBackOff(): void {
		this.nextProbeAt = 0;
	}

	private async run(): Promise<void> {
		const route = await resolveCutoverRoute(this.opts.cwd).catch((err) => {
			this.opts.onProbeError?.(err);
			return null;
		});
		// Only a committed cutover or a pending fence moves the source of truth off
		// the orphan branch. `uncutover` keeps it authoritative; `blocked` means the
		// DB is unreachable, where rebuilding would only turn a readable-but-stale
		// read into a hard throw — back off and leave the storage as-is.
		if (!routeMovesOffOrphanBranch(route)) {
			this.backOff();
			return;
		}
		// A racing heal may already have applied while we probed.
		if (this.opts.isHealed()) return;
		try {
			await this.opts.applyHeal(route as CutoverRoute);
		} catch (err) {
			this.opts.onApplyError?.(err);
			this.backOff();
		}
	}

	private backOff(): void {
		this.nextProbeAt = Date.now() + (this.opts.throttleMs ?? ROUTE_PROBE_THROTTLE_MS);
	}
}
