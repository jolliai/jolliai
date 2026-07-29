/**
 * PushControl — the per-repo outbound-push control (spec 306).
 *
 * The opt-out is stored **machine-globally, keyed by the repo's canonical
 * identity** (`getCanonicalRepoUrl`) in {@link PushControlStore}, NOT in the
 * repo's working-tree `profile.json`. This lets the machine-wide control view
 * (sourced from the Memory Bank, which knows repos by identity) and the per-repo
 * gate (which resolves its own canonical URL) share one key, and lets a repo
 * checked out in several worktrees share one decision.
 *
 * The CLI `push-control` command, the VS Code Settings toggle, and the IntelliJ
 * view (via the CLI bridge) all drive their toggle through this one module, so
 * there is a single implementation of "flip the flag", never a drifting second.
 */
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { createLogger } from "../Logger.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl, normalizeRemoteUrl } from "./GitRemoteUtils.js";
import { discoverRepos } from "./KBRepoDiscoverer.js";
import {
	isRepoPushDisabled,
	loadDisabledRepos,
	type SetRepoPushDisabledResult,
	setRepoPushDisabled,
} from "./PushControlStore.js";
import { readManualDisableFlag } from "./RepoProfile.js";
import { track } from "./Telemetry.js";

const log = createLogger("PushControl");

/** Where the toggle was driven from — becomes the telemetry `trigger` prop. */
export type PushControlTrigger = "cli" | "vscode" | "intellij";

/**
 * Thrown when an outbound operation is refused because this repo has opted out of
 * outbound push ({@link isOutboundPushAllowed} said no). Memory stays recorded
 * locally, so the call site should surface "re-enable to push" rather than a
 * failure.
 *
 * The `name` is the wire contract, not decoration: the ide-bridge error envelope
 * forwards `err.name` as `data.errorName` (see `copyPrimitiveErrorFields` in
 * IdeBridgeCommand.ts) and IDE hosts dispatch on that string to map the refusal
 * back to their own push-disabled type. A bare `Error` here degrades to the
 * host's generic-failure path, which is how an IntelliJ caller ended up unable to
 * tell a repo-wide opt-out from a real push failure. Mirrors vscode's
 * `PushDisabledError` in JolliPushService.ts and the Kotlin
 * `JolliShareService.PushDisabledError` — the three names must stay identical.
 */
export class PushDisabledError extends Error {
	constructor(
		message = "Outbound push is disabled for this repo. Re-enable it with `jolli push-control --enable` to push.",
	) {
		super(message);
		this.name = "PushDisabledError";
	}
}

/**
 * How long a resolved repo IDENTITY may be reused inside one process.
 *
 * Sized to collapse ONE burst of gate reads. A summary push calls
 * {@link isOutboundPushAllowed} 1 + N times (once up front, then once inside each
 * attachment's HTTP call), and each call otherwise spawns `git config --get
 * remote.origin.url`. At ~20-40 ms per spawn on Windows a 10-attachment push paid
 * ~11 spawns re-deriving one value that cannot change during it.
 *
 * **Only the identity is cached, deliberately.** Changing it means editing
 * `git config`, so a few seconds of staleness costs nothing.
 *
 * **This halves the burst, it does not remove it.** `readManualDisableFlag` below
 * resolves the main-worktree root through its own `git rev-parse --git-common-dir`
 * (see `RepoProfile.resolvePaths`) and is deliberately NOT memoized, so a
 * 10-attachment push still pays ~11 git spawns — one per gate read, not two. Don't
 * read this memo as having made the gate spawn-free. Closing the other half means
 * caching the WORKTREE ROOT inside `RepoProfile` (as stable as the remote URL)
 * while the flag FILE stays read live — which keeps the guarantee below intact,
 * since it is the flag's freshness that is load-bearing, not the path's. That is a
 * change to spec 145's module and is deliberately not made here.
 *
 * Neither state that says "don't push" is cached, and both are load-bearing:
 *   - `manuallyDisabled` (spec 145) is the highest-priority stop-ALL opt-out, and
 *     its writers are in OTHER processes — `jolli disable` in a terminal, the VS
 *     Code Disable command, the IntelliJ action. An in-process memo therefore
 *     CANNOT be invalidated airtight; any TTL is a window in which a repo the user
 *     just disabled keeps pushing. That is a privacy leak, not a latency
 *     trade-off, so the `git rev-parse` it costs is simply paid every time.
 *   - the push-control store, because spec 306 requires the opt-out be read LIVE
 *     so a mid-push toggle takes effect immediately (and it is a plain file read
 *     with no subprocess to save anyway).
 */
const GATE_IDENTITY_TTL_MS = 5_000;

interface CachedIdentity {
	readonly expiresAt: number;
	readonly identity: string;
}

/** Per-cwd memo of the canonical repo identity. See {@link GATE_IDENTITY_TTL_MS}. */
const identityCache = new Map<string, CachedIdentity>();

/**
 * Entry count past which a miss also drops expired entries.
 *
 * Without a sweep the memo only ever *replaces* an entry on re-access of the same
 * cwd — it never removes one — so a long-lived host that sees many distinct roots
 * over its lifetime (the MCP server, an extension host moved across folders and
 * worktrees) would grow it without bound. The cap is what triggers the O(n) walk,
 * so the common case (a handful of roots) stays O(1) per read.
 */
const IDENTITY_CACHE_SWEEP_AT = 64;

/** Test-only: drops the memo so a test can flip a repo's remote mid-run. */
export function __resetGateInputCache(): void {
	identityCache.clear();
}

/** Memoized `getCanonicalRepoUrl` — saves a `git config` spawn per gate read. */
async function cachedRepoIdentity(cwd: string): Promise<string> {
	const hit = identityCache.get(cwd);
	if (hit && hit.expiresAt > Date.now()) return hit.identity;
	const identity = await getCanonicalRepoUrl(cwd);
	// Re-read the clock: `getCanonicalRepoUrl` awaited a git spawn, so the value
	// taken before it is stale for both the sweep cutoff and the new expiry.
	const now = Date.now();
	// Sweep BEFORE inserting, so the entry written just below is never itself a
	// sweep candidate. Deleting during Map iteration is well-defined for entries
	// the iterator has already yielded.
	if (identityCache.size >= IDENTITY_CACHE_SWEEP_AT) {
		for (const [key, entry] of identityCache) {
			if (entry.expiresAt <= now) identityCache.delete(key);
		}
	}
	identityCache.set(cwd, { expiresAt: now + GATE_IDENTITY_TTL_MS, identity });
	return identity;
}

/** A display-path read of the opt-out, plus why the value may not be the user's choice. */
export interface PushDisabledState {
	/** True when outbound push is OFF — including the fail-closed unreadable case. */
	readonly disabled: boolean;
	/**
	 * Set ONLY when `disabled` is a fail-closed fallback rather than the user's
	 * recorded choice, i.e. the store could not be read. Carries the store's
	 * absolute path (see {@link isRepoPushDisabled}) so the surface can explain an
	 * otherwise inexplicable "OFF" — without it every repo on the machine reports
	 * OFF with no way to learn that one file is corrupt.
	 */
	readonly error?: string;
}

/**
 * Reads the outbound-push opt-out for the repo containing `cwd`, keeping the
 * *reason* when the read fails. Fails CLOSED — reports "disabled" — when the
 * push-control store can't be read (corrupt/EACCES), matching
 * {@link isOutboundPushAllowed}, so an unreadable store never reads as "push on".
 *
 * This is the ONLY read of the opt-out meant for a surface that reports it. There
 * is deliberately no boolean-only shorthand: one used to exist, and the single
 * caller that picked it (the IntelliJ Settings toggle, via the `push-control-get`
 * bridge) thereby reported a fail-closed read as the user's own per-repo choice —
 * the exact confusion the `error` half exists to prevent. Gates read
 * {@link isOutboundPushAllowed} instead, which composes in `manuallyDisabled` and
 * is not a reporting path at all.
 */
export async function readPushDisabledState(cwd: string): Promise<PushDisabledState> {
	try {
		// Identity memoized, store read LIVE — see `gateInputCache`.
		return { disabled: await isRepoPushDisabled(await cachedRepoIdentity(cwd)) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn(
			"readPushDisabledState: could not read push-control state — reporting disabled (fail-closed): %s",
			message,
		);
		return { disabled: true, error: message };
	}
}

/**
 * The single "may this repo push memory outbound?" predicate every outbound path
 * reads (both CLI drains, the manual/MCP push, the VS Code HTTP client, the
 * IntelliJ push sites). False when the repo is fully disabled OR push-disabled.
 * `manuallyDisabled` goes through {@link readManualDisableFlag} (migration-aware)
 * so a repo disabled only via the legacy per-worktree marker is still blocked.
 *
 * **Fails CLOSED.** A *missing* store means "nothing disabled" (allowed), but any
 * error reading the opt-out state — a corrupt/unreadable push-control store, or a
 * failed identity/manual-flag read — returns `false` (block) rather than silently
 * allowing a push from a repo the user may have opted out. A silent fail-open
 * here would let the automatic drains leak memory the moment the store went bad.
 */
export async function isOutboundPushAllowed(cwd: string): Promise<boolean> {
	try {
		// `manuallyDisabled` is read LIVE every time, never memoized: it is the
		// stop-ALL opt-out and its writers live in other processes, so a cached `false`
		// would keep pushing from a repo the user just disabled. See
		// `GATE_IDENTITY_TTL_MS` for why only the identity is cached.
		if (await readManualDisableFlag(cwd)) return false;
		return !(await isRepoPushDisabled(await cachedRepoIdentity(cwd)));
	} catch (error) {
		log.warn(
			"isOutboundPushAllowed: could not read push-control state — failing closed (blocking outbound push): %s",
			error,
		);
		return false;
	}
}

/**
 * Writes the outbound-push opt-out for the repo containing `cwd` (keyed by its
 * canonical identity), then — when ENABLING — triggers the compensation drain so
 * retained memory syncs.
 *
 * Delegates the write, the log, and the telemetry to
 * {@link setRepoPushDisabledByIdentity} so there is exactly one implementation of
 * "flip the flag": this function only adds the two things that need a working
 * tree — resolving the identity from `cwd`, and the re-enable drain.
 */
export async function applyPushDisabled(
	cwd: string,
	disabled: boolean,
	trigger: PushControlTrigger,
): Promise<SetRepoPushDisabledResult> {
	const identity = await getCanonicalRepoUrl(cwd);
	const result = await setRepoPushDisabledByIdentity(identity, disabled, trigger);
	if (!disabled) triggerReenableDrain(cwd);
	return result;
}

/**
 * Re-enable catch-up: drains entries recorded while push was disabled, via the
 * same detached worker activation/sign-in use. Best-effort, non-blocking, and a
 * no-op when there is no backlog.
 *
 * Exported so a surface that already knows the repo's identity (the VS Code
 * machine-wide list, whose rows carry an identity rather than a path) can write
 * by identity — the key the user actually clicked — and still get the drain,
 * without going through {@link applyPushDisabled} and having the target repo
 * re-derived from a working-tree path as a second source of truth.
 */
export function triggerReenableDrain(cwd: string): void {
	triggerPendingPushRetry(cwd, "reenable");
}

/**
 * Toggles the opt-out for a repo identified by its canonical URL (not a cwd) —
 * used by the machine-wide control view, whose rows come from the Memory Bank
 * and carry an identity, not a working-tree path, and by
 * {@link applyPushDisabled} once it has resolved its own identity. Re-enable
 * catch-up cannot run here (no working tree to drain); for a foreign repo it
 * happens on that repo's next activation or `git push`.
 *
 * Emits the `push_disabled` / `push_enabled` telemetry event tagged with
 * `trigger`. Propagates the store's {@link SetRepoPushDisabledResult} —
 * `recoveredFromCorrupt` MUST reach the user (see the store's docstring).
 */
export async function setRepoPushDisabledByIdentity(
	repoIdentity: string,
	disabled: boolean,
	trigger: PushControlTrigger,
): Promise<SetRepoPushDisabledResult> {
	const result = await setRepoPushDisabled(repoIdentity, disabled, { trigger });
	log.info("push %s for id=%s (trigger=%s)", disabled ? "disabled" : "enabled", repoIdentity, trigger);
	if (result.recoveredFromCorrupt) {
		log.warn(
			"push enable for id=%s rebuilt an unreadable store from empty — other repos' opt-outs were dropped",
			repoIdentity,
		);
	}
	track(disabled ? "push_disabled" : "push_enabled", { trigger });
	return result;
}

/** One repo row for the machine-wide control view. */
export interface PushControlRepo {
	/** Canonical repo URL — the store key and the toggle target. */
	readonly repoIdentity: string;
	readonly repoName: string;
	/** Whether outbound push is currently OFF for this repo. */
	readonly pushDisabled: boolean;
	/** True for the repo the caller is currently in (surfaced first / highlighted). */
	readonly isCurrentRepo: boolean;
}

/**
 * Lists every repo the Memory Bank knows about (each carries a `remoteUrl` in
 * its `<kbRoot>/.jolli/config.json`) plus the caller's current repo, annotated
 * with each one's live push-disabled state from the machine-global store. The
 * identity is the same canonical URL the gate keys on, so a toggle here and the
 * gate there always agree.
 *
 * Local-only repos (no git remote) are **omitted**: their canonical identity is
 * a `file://<worktree>` path the Memory Bank does not record, so they cannot be
 * keyed here — they are still controllable in-repo via `jolli push-control` /
 * the VS Code current-repo toggle. Rows are sorted current-first, then by name.
 */
export async function listPushControlRepos(opts: {
	readonly localFolder?: string;
	readonly currentCwd?: string;
}): Promise<PushControlRepo[]> {
	const disabled = await loadDisabledRepos();
	let currentIdentity: string | null = null;
	if (opts.currentCwd) {
		try {
			currentIdentity = await getCanonicalRepoUrl(opts.currentCwd);
		} catch {
			currentIdentity = null;
		}
	}

	const byIdentity = new Map<string, PushControlRepo>();
	for (const repo of discoverRepos(null, null, opts.localFolder)) {
		if (!repo.remoteUrl) continue; // local-only — cannot key by identity
		const repoIdentity = normalizeRemoteUrl(repo.remoteUrl, repo.kbRoot);
		byIdentity.set(repoIdentity, {
			repoIdentity,
			repoName: repo.repoName,
			pushDisabled: disabled.has(repoIdentity),
			isCurrentRepo: repoIdentity === currentIdentity,
		});
	}

	// Always include the current repo, even if it isn't mirrored into the Memory
	// Bank yet, so the user can toggle the repo they're in immediately.
	if (currentIdentity && !byIdentity.has(currentIdentity)) {
		byIdentity.set(currentIdentity, {
			repoIdentity: currentIdentity,
			repoName: deriveRepoNameFromUrl(currentIdentity),
			pushDisabled: disabled.has(currentIdentity),
			isCurrentRepo: true,
		});
	}

	return [...byIdentity.values()].sort((a, b) => {
		if (a.isCurrentRepo !== b.isCurrentRepo) return a.isCurrentRepo ? -1 : 1;
		// Pin the locale so the display order is stable across machines/runtimes
		// (a bare localeCompare uses the ambient ICU locale, which can differ).
		return a.repoName.localeCompare(b.repoName, "en", { sensitivity: "base" });
	});
}
