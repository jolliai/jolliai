/**
 * Per-repo Jolli Space resolution for the VS Code Settings panel's push-control
 * list (JOLLI-2152). {@link PushControl.listPushControlRepos} is deliberately
 * fast and fully offline — this module is where the network-bound "which
 * Space does each row push into" resolution lives instead, so it never risks
 * getting mixed into that fast path.
 */

import {
	existingWorktrees,
	hasLiveWorktree,
	isRepoDisabled,
	type RegisteredRepo,
	readRepoRegistry,
} from "../dashboard/RepoRegistry.js";
import { createLogger } from "../Logger.js";
import { mapWithConcurrency } from "../util/Concurrency.js";
import type { PushControlRepo } from "./PushControl.js";
import { readManualDisableFlagSync } from "./RepoProfile.js";
import {
	fetchSpaceBindingStatus,
	fetchSpaceBindingStatusForUrl,
	type SpaceBindingStatus,
} from "./SpaceBindingStatus.js";

const log = createLogger("PushControlSpaces");

/**
 * Fan-out width for the Space-binding probes, deliberately its OWN constant
 * rather than {@link mapWithConcurrency}'s shared `defaultConcurrency()`
 * default (8). That default is sized for the process-wide local-disk I/O
 * budget it doubles as (`Concurrency.ts`'s own docstring: "this shapes the
 * fan-out; it does NOT gate I/O" — a network call never acquires that budget,
 * so reusing its width just means "8 network requests in flight," not
 * anything actually tuned for one). Measured against `jolli-local.me`: 8
 * concurrent `frontDoor` probes made rows that resolve in ~300-1000ms alone
 * queue behind each other and occasionally miss `SPACE_PROBE_TIMEOUT_MS`
 * (5s) — a genuinely bound repo reading back "Not checked" under load, not a
 * logic bug. A smaller width trades a slightly longer worst-case settle time
 * for not saturating what is often a lightweight local/dev tenant.
 */
const SPACE_PROBE_CONCURRENCY = 3;

export interface ResolveSpaceBindingsOptions {
	/** cwd for the row whose `isCurrentRepo` is true — the caller's own workspace root. */
	readonly currentCwd?: string;
	/** Override for `~/.jolli/jollimemory/dashboard-repos.json`'s directory — test seam. */
	readonly configDir?: string;
	/**
	 * Fired as soon as EACH row settles, in whatever order the fan-out
	 * completes them (not input order) — lets a caller with a push channel
	 * (VS Code's `postMessage`) show a fast row's real result immediately
	 * instead of waiting for the whole map, so one slow/failing repo can't
	 * hold every other row on "Checking…". The returned `Map` still carries
	 * every entry regardless; this is purely an earlier, incremental view of
	 * the same data for callers that can use it.
	 */
	readonly onResolved?: (repoIdentity: string, status: SpaceBindingStatus) => void;
}

/**
 * Resolves each row's Jolli Space binding for the VS Code Settings panel's
 * per-repo Space column. Every row gets a live single-repo front-door probe
 * ({@link fetchSpaceBindingStatus}, called with `refresh: true`) — deliberately
 * NOT cache-first, unlike `jolli status`'s bare invocation. A settings panel is
 * a surface people leave open and glance back at, not a one-shot command, and
 * it has no way to trigger the self-healing paths the cache's long TTL relies
 * on (a rejected push, or an explicit `jolli status --refresh`) — it never
 * pushes. Serving a week-old cached "bound" answer here would silently hide an
 * out-of-band unbind (an admin rebinding the repo elsewhere, or on another
 * machine) for as long as `SPACE_BINDING_TTL_MS`. Every row that is probed at
 * all — current or not, see the `manuallyDisabled` gate below — gets the same
 * real `frontDoor` probe; a row the server finds unbound with exactly one
 * bindable Space is auto-bound as a side effect of merely being displayed, same
 * as any other caller of `fetchSpaceBindingStatus` /
 * `fetchSpaceBindingStatusForUrl` — accepted, not suppressed. A live probe
 * still WRITES the cache on a healthy result (see
 * {@link fetchSpaceBindingStatus}), so opening this panel also warms `jolli
 * status`'s own cache rather than only ever bypassing it. Fanned out with the
 * shared bounded-concurrency helper; entirely off any first-paint path: the
 * caller runs this after posting the (fast, offline) push-control list and
 * posts the result as a separate message once it settles.
 *
 * Gated on `jolliApiKey`: returns an EMPTY map immediately, before touching the
 * repo registry or probing a single repo, when no key is configured — a
 * signed-out machine has no binding to report for anyone, and the "signed
 * out" UX (silence vs. a hint) is a presentation decision left to the caller.
 *
 * Also gated PER ROW on the two switches the user controls — the per-repo
 * outbound-push toggle (`PushControlRepo.pushDisabled`) and `manuallyDisabled`
 * (`jolli disable`). A row either one is set on is neither probed nor
 * cache-written and gets no map entry at all; see {@link SkipReason} for why
 * each one counts. A probe here is not read-only, which is the whole point: it
 * makes a `frontDoor` call the server AUTO-BINDS through on a single-Space
 * tenant, and it writes `space-binding.json` into the repo — both purely as a
 * side effect of someone opening a settings panel.
 *
 * A LOCAL CHECKOUT is preferred but not required. The current repo uses
 * `opts.currentCwd` directly; every other row is cross-referenced by
 * repoIdentity against the machine-wide RepoRegistry
 * (~/.jolli/jollimemory/dashboard-repos.json), and when hasLiveWorktree
 * confirms a checkout still exists on disk, its newest live path that is not
 * itself switched off (existingWorktrees, see {@link resolveRowTarget}) is used
 * with {@link fetchSpaceBindingStatus} exactly like the current row — this is
 * what lets the local cache warm and lets `refresh` mean something. A row with
 * no known or no-longer-live checkout
 * still gets a REAL answer: {@link fetchSpaceBindingStatusForUrl} probes the
 * server directly using the row's own `repoIdentity` (the canonical URL
 * `listPushControlRepos` already resolved from the Memory Bank's
 * `.jolli/config.json`, the exact same normalized form `getCanonicalRepoUrl`
 * would have produced from a real cwd — see that function's own docstring),
 * with no local cache to read or write (nothing to anchor `space-binding.json`
 * to). Only a genuine failure — not signed in, an outdated client, sign-in rejected, or
 * the live call itself failing — still resolves to `{kind:"unreachable"}`
 * ("Not checked"); a repo Jolli merely doesn't have a live checkout for on
 * THIS machine now gets its real bound/unbound answer instead of a permanent
 * "can't tell you" dead end.
 */
export async function resolveSpaceBindingsForRepos(
	repos: ReadonlyArray<PushControlRepo>,
	jolliApiKey: string | undefined,
	opts: ResolveSpaceBindingsOptions = {},
): Promise<ReadonlyMap<string, SpaceBindingStatus>> {
	if (!jolliApiKey || repos.length === 0) {
		return new Map();
	}
	const { repos: registered } = await readRepoRegistry(opts.configDir); // never throws
	const registryByIdentity = new Map<string, RegisteredRepo>(registered.map((r) => [r.repoIdentity, r]));

	// One aggregated failure line per fan-out instead of one per repo — see
	// SpaceBindingProbeOptions.onFailure. Collected across the whole pass and
	// emitted below, so the count is the pass's own denominator.
	const failures: string[] = [];
	const probeOpts = { onFailure: (message: string) => failures.push(message) };
	const skipped: Record<SkipReason, number> = { "push-disabled": 0, "manually-disabled": 0 };

	const entries = await mapWithConcurrency(
		repos,
		async (repo): Promise<readonly [string, SpaceBindingStatus] | undefined> => {
			const target = resolveRowTarget(repo, registryByIdentity.get(repo.repoIdentity), opts.currentCwd);
			if (target.kind === "skipped") {
				skipped[target.reason]++;
				return undefined;
			}
			// Both calls are documented to never throw; this catch is cheap insurance
			// at the fan-out boundary, not reliance on a contract this file doesn't own.
			const status = await (target.kind === "cwd"
				? fetchSpaceBindingStatus(target.cwd, jolliApiKey, true, probeOpts)
				: fetchSpaceBindingStatusForUrl(repo.repoIdentity, repo.repoName, jolliApiKey, probeOpts)
			).catch((): SpaceBindingStatus => ({ kind: "unreachable" }));
			opts.onResolved?.(repo.repoIdentity, status);
			return [repo.repoIdentity, status];
		},
		SPACE_PROBE_CONCURRENCY,
	);
	if (failures.length > 0) {
		// One line, naming the count and the FIRST message: the messages are
		// overwhelmingly the same transport failure repeated (one offline
		// machine, N repos), so the first is representative and the count is
		// what says how much of the panel degraded.
		log.warn(`space binding probes failed for ${failures.length} of ${repos.length} repo(s): ${failures[0]}`);
	}
	if (skipped["push-disabled"] > 0) {
		log.debug(`skipped ${skipped["push-disabled"]} repo(s) with outbound push switched off`);
	}
	if (skipped["manually-disabled"] > 0) {
		log.debug(`skipped ${skipped["manually-disabled"]} repo(s) with Jolli manually disabled`);
	}
	return new Map(entries.filter((entry): entry is readonly [string, SpaceBindingStatus] => entry !== undefined));
}

/**
 * Why a row was left unprobed. Both reasons are a switch the USER threw, and
 * both matter because a probe here is not read-only: {@link fetchSpaceBindingStatus}
 * makes a `frontDoor` call on that repo's behalf — which the server contract
 * AUTO-BINDS an unbound repo through, the instant exactly one Space is bindable
 * — and writes `space-binding.json` into the repo's `.jolli/jollimemory/`.
 *
 * - `push-disabled`: the per-repo outbound-push toggle is off. That toggle is
 *   consumed only by the push paths (`PrePushHook`, `isOutboundPushAllowed`), so
 *   it never used to reach this fan-out — a user who unchecked every row still
 *   had each one probed, and single-Space tenants had them bound, purely because
 *   a settings panel was open. A repo that does not push has no meaningful push
 *   DESTINATION either, so the column has nothing worth changing server state to
 *   show. The accepted cost: unchecking push also stops showing which Space that
 *   row was bound to.
 * - `manually-disabled`: `jolli disable` (or the VS Code / ide-bridge
 *   equivalents). That switch stops EVERYTHING for a repo, and neither the
 *   network call nor the cache write is exempt.
 *
 * A skipped row is left OUT of the returned map entirely rather than given a
 * status of its own — every surface already renders a row with no entry as a
 * plain "Not checked" (the settled-but-missing fallback), which is the honest
 * answer: nothing was checked. A dedicated `SpaceBindingStatus` kind was the
 * alternative and was not worth it — the union is shared with `StatusCommand`'s
 * own exhaustive `describeSpaceBinding` switch, so a new kind would have to grow
 * CLI status wording for states `jolli status` cannot reach.
 */
type SkipReason = "push-disabled" | "manually-disabled";

/** Where a row's probe should be aimed — or that it must not be probed at all. */
type RowTarget =
	/** Probe through a live local checkout — reads and warms `space-binding.json`. */
	| { readonly kind: "cwd"; readonly cwd: string }
	/** No local checkout on this machine — probe the server by canonical URL, no cache. */
	| { readonly kind: "url" }
	/** A user switch says leave this repo alone — do not probe, do not write. */
	| { readonly kind: "skipped"; readonly reason: SkipReason };

function resolveRowTarget(
	repo: PushControlRepo,
	registered: RegisteredRepo | undefined,
	currentCwd: string | undefined,
): RowTarget {
	// First, and before any file read: this one is a plain field already on the
	// row, so it costs nothing and short-circuits the profile reads below.
	if (repo.pushDisabled) return { kind: "skipped", reason: "push-disabled" };
	if (repo.isCurrentRepo && currentCwd) {
		// The current row is gated on ITS OWN checkout, not on the identity-wide
		// `isRepoDisabled` answer below: `currentCwd` is the checkout the calling
		// surface belongs to, so if Jolli is switched off there, that surface must
		// not act — the same call and the same reasoning as `executeDashboard`'s
		// gate on `registerRepo`. Sync reader on purpose: a question asked on the
		// way to painting a panel must not migrate and persist a profile decision.
		return readManualDisableFlagSync(currentCwd)
			? { kind: "skipped", reason: "manually-disabled" }
			: { kind: "cwd", cwd: currentCwd };
	}
	if (!registered || !hasLiveWorktree(registered)) return { kind: "url" };
	// The shared predicate, not a hand-rolled read of `worktreeRoot`: a registry
	// row is one repo IDENTITY while `profile.json` is per CLONE, so the question
	// is whether EVERY checkout is switched off.
	if (isRepoDisabled(registered)) return { kind: "skipped", reason: "manually-disabled" };
	const live = existingWorktrees(registered);
	// Prefer a checkout that is not itself switched off. isRepoDisabled just
	// proved one exists, so the `?? live[0]` is only for the case where those two
	// disagree — never silently probe (and write a cache file) into a clone the
	// user switched off while a sibling clone is on.
	return { kind: "cwd", cwd: live.find((wt) => !readManualDisableFlagSync(wt)) ?? live[0] };
}
