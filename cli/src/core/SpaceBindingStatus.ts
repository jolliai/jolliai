/**
 * Repo→Space binding resolution — shared by `jolli status`'s `Jolli Space:` row
 * (`StatusCommand.ts`) and the VS Code Settings panel's per-repo Space column
 * (`PushControlSpaces.ts`). One implementation so the two surfaces can never
 * disagree about a repo's bound-ness.
 */
import { createLogger } from "../Logger.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
	SPACE_PROBE_TIMEOUT_MS,
} from "./JolliMemoryPushClient.js";
import {
	clearSpaceBindingCache,
	loadSpaceBindingCache,
	saveSpaceBindingCache,
	tenantOriginForKey,
} from "./SpaceBindingCache.js";

const log = createLogger("SpaceBindingStatus");

/**
 * Repo→Space binding state behind `jolli status`'s `Jolli Space:` row and the
 * VS Code Settings panel's per-repo Space column.
 *
 * Cache-first since the SpaceBindingCache landed: a fresh healthy entry in
 * `<projectDir>/.jolli/jollimemory/space-binding.json` renders with zero
 * network I/O (`--refresh` forces a live re-check for `jolli status`). On a
 * cache miss the state is resolved by ONE best-effort `POST
 * /api/jolli-memory/front-door` round-trip — the same single call the guided
 * front door makes, reused deliberately so every caller can never disagree
 * about bound-ness — and the answer maintains the cache: a healthy bound
 * writes it, an unbound / no-spaces / degraded answer clears it, and
 * network/auth failures leave it untouched. No request at all is made without
 * a `jolliApiKey` (`no_key`) or in `--json` mode (the VS Code extension polls
 * that path; it must stay offline-safe and fast — it neither reads nor writes
 * the cache).
 *
 * Server-side caveat inherited from the endpoint: when the repo is unbound and
 * exactly one Space is bindable, the server auto-binds during the call — on
 * such tenants status reports the resulting `bound` state rather than
 * `unbound`. There is no read-only variant of the endpoint today (the backend's
 * `GET /api/jolli-memory/bindings` is marked unused/slated for removal, returns
 * no Space name, and masks a forbidden binding as 404 — so it cannot replace
 * the front-door call here).
 *
 * Server semantics pinned down against the backend's `JolliMemoryRouter`:
 * `no_spaces` is caller-relative — the bindable pool is filtered by the key
 * creator's Space visibility plus per-Space `articles.edit`, so a tenant full
 * of Spaces the caller cannot access still answers `no_spaces`. A binding
 * whose target Space was deleted is reported through the unbound path (the
 * stale row is preserved server-side), and a bound Space the caller lacks
 * `spaces.view` on comes back `bound` with null name/id.
 */
export type SpaceBindingStatus =
	| {
			readonly kind: "bound";
			readonly spaceName: string | null;
			readonly canPush: boolean | null;
			/** True when the server attached a bindable pool — i.e. `jolli` can actually offer a rebind. */
			readonly canRebind: boolean;
	  }
	| { readonly kind: "unbound"; readonly spaceCount: number }
	/** `restricted` true: Spaces exist but this repo isn't allowlisted on any (admin-action-required); false: genuinely none available. */
	| { readonly kind: "no_spaces"; readonly restricted: boolean }
	| { readonly kind: "no_key" }
	| { readonly kind: "auth_rejected" }
	| { readonly kind: "outdated" }
	| { readonly kind: "unreachable" };

/**
 * {@link probeFrontDoor}'s result: the public {@link SpaceBindingStatus} plus
 * the server's raw `jmSpaceId` when bound (`null` otherwise) — needed only by
 * {@link fetchSpaceBindingStatus} to maintain the local cache (whose dedup
 * keys off the numeric id, not the display name) and deliberately NOT part of
 * `SpaceBindingStatus` itself, which every other caller consumes.
 */
interface FrontDoorProbe {
	readonly status: SpaceBindingStatus;
	readonly jmSpaceId: number | null;
}

/**
 * Per-call knobs shared by {@link fetchSpaceBindingStatus} and
 * {@link fetchSpaceBindingStatusForUrl}.
 */
export interface SpaceBindingProbeOptions {
	/**
	 * Diverts the failure line these functions would otherwise `warn`
	 * themselves. Present for ONE caller shape: a fan-out over every repo on
	 * the machine (`PushControlSpaces.resolveSpaceBindingsForRepos`), where the
	 * per-call `warn` is O(repos) per settings-panel open — an offline machine
	 * with forty repos wrote forty identical lines every time the panel was
	 * opened, and a log line that fires that often stops being read. The
	 * failure must still be diagnosable (see the `warn`-not-`debug` reasoning
	 * below), so this hands it to the fan-out to aggregate into ONE line rather
	 * than dropping it. A caller that omits this keeps the per-call `warn`,
	 * which is the right shape for the single-repo paths (`jolli status`, the
	 * IntelliJ dialog's `space-binding-get`).
	 */
	readonly onFailure?: (message: string) => void;
}

/** Reports a probe failure to the caller's sink, or `warn`s it when there is none. */
function reportProbeFailure(error: unknown, opts: SpaceBindingProbeOptions | undefined): void {
	const message = `space binding probe failed: ${error instanceof Error ? error.message : String(error)}`;
	if (opts?.onFailure) {
		opts.onFailure(message);
		return;
	}
	// warn, not debug: this is what a "Not checked" cell traces back to, and
	// debug-level output is dropped at the default log level — a probe that
	// silently degrades to "unreachable" needs to leave a line in debug.log,
	// or diagnosing a false "Not checked" has nothing to go on.
	log.warn(message);
}

/**
 * Live front-door round-trip for an already-known `repoUrl`/`repoName` — no
 * cache, no `cwd`. Shared by {@link fetchSpaceBindingStatus} (which resolves
 * `repoUrl` from a `cwd` and layers the local cache on top) and
 * {@link fetchSpaceBindingStatusForUrl} (which has no `cwd` to anchor a cache
 * to at all). Never throws — every failure maps to a `SpaceBindingStatus`.
 */
async function probeFrontDoor(
	repoUrl: string,
	repoName: string,
	jolliApiKey: string,
	opts?: SpaceBindingProbeOptions,
): Promise<FrontDoorProbe> {
	try {
		const client = new JolliMemoryPushClient({
			apiKeyProvider: async () => jolliApiKey,
			timeoutMs: SPACE_PROBE_TIMEOUT_MS,
		});
		const result = await client.frontDoor({ repoUrl, repoName });
		if (result.status === "bound") {
			return {
				status: {
					kind: "bound",
					spaceName: result.binding.spaceName,
					canPush: result.binding.canPush,
					canRebind: result.spaces.length > 0,
				},
				jmSpaceId: result.binding.jmSpaceId,
			};
		}
		// An `unbound` whose list came back empty is contract drift (the server
		// answers `no_spaces` when nothing is bindable) — fold it into
		// `no_spaces`, mirroring SpaceSyncStep, so the row can never point at a
		// bind with zero options.
		if (result.status === "unbound" && result.spaces.length > 0) {
			return { status: { kind: "unbound", spaceCount: result.spaces.length }, jmSpaceId: null };
		}
		// `restricted` only exists on the real `no_spaces` variant; a folded-in
		// empty `unbound` (contract drift) is never allowlist-restricted.
		return {
			status: { kind: "no_spaces", restricted: result.status === "no_spaces" ? result.restricted : false },
			jmSpaceId: null,
		};
	} catch (error) {
		if (error instanceof ClientOutdatedError) {
			return { status: { kind: "outdated" }, jmSpaceId: null };
		}
		if (error instanceof NotAuthenticatedError) {
			return { status: { kind: "auth_rejected" }, jmSpaceId: null };
		}
		reportProbeFailure(error, opts);
		return { status: { kind: "unreachable" }, jmSpaceId: null };
	}
}

/**
 * Resolves the repo's Space-binding state for the status display. See {@link SpaceBindingStatus}.
 *
 * On a cache miss, a repo the server finds unbound with exactly one bindable
 * Space is auto-bound as a side effect of the underlying `frontDoor` call —
 * accepted, not suppressed, regardless of whether the caller is actively
 * working in this repo.
 */
export async function fetchSpaceBindingStatus(
	cwd: string,
	jolliApiKey: string | undefined,
	refresh = false,
	opts?: SpaceBindingProbeOptions,
): Promise<SpaceBindingStatus> {
	if (!jolliApiKey) {
		return { kind: "no_key" };
	}
	// The WHOLE body is one try/catch, not just getCanonicalRepoUrl — matching
	// this function's pre-JOLLI-2152 contract. probeFrontDoor never throws, but
	// the cache read/write calls (loadSpaceBindingCache, saveSpaceBindingCache,
	// clearSpaceBindingCache) are not documented not to, and StatusCommand's
	// call site has no catch of its own: an unprotected throw here would crash
	// `jolli status` instead of degrading it to "unreachable".
	try {
		const repoUrl = await getCanonicalRepoUrl(cwd);
		const origin = tenantOriginForKey(jolliApiKey);
		// Cache-first: a fresh healthy binding renders with zero network I/O.
		// canRebind false is safe — the rebind hint only matters on degraded
		// bindings, which are never cached.
		if (!refresh && origin) {
			const cached = await loadSpaceBindingCache(cwd, { repoUrl, origin });
			if (cached) {
				return { kind: "bound", spaceName: cached.spaceName, canPush: cached.canPush, canRebind: false };
			}
		}
		const probe = await probeFrontDoor(repoUrl, deriveRepoNameFromUrl(repoUrl), jolliApiKey, opts);
		const { status } = probe;
		if (status.kind === "bound") {
			const healthy = status.canPush !== false && status.spaceName !== null;
			if (healthy && origin) {
				await saveSpaceBindingCache(cwd, {
					repoUrl,
					origin,
					jmSpaceId: probe.jmSpaceId,
					spaceName: status.spaceName as string,
					canPush: status.canPush === true ? true : null,
				});
			} else {
				// Degraded bindings must never be served from cache.
				await clearSpaceBindingCache(cwd);
			}
		} else if (status.kind === "unbound" || status.kind === "no_spaces") {
			// The server says unbound/no_spaces — drop any stale bound cache.
			await clearSpaceBindingCache(cwd);
		}
		// outdated/auth_rejected/unreachable: leave the cache untouched (a transient
		// failure must not be read as "this binding is now gone").
		return status;
	} catch (error) {
		reportProbeFailure(error, opts);
		return { kind: "unreachable" };
	}
}

/**
 * Probes a repo's Space binding directly by its already-known canonical URL —
 * for a row {@link PushControlSpaces.resolveSpaceBindingsForRepos} has no live
 * local checkout to anchor a {@link fetchSpaceBindingStatus} `cwd` call to
 * (its Memory Bank folder's `.jolli/config.json` still has a `remoteUrl`, but
 * nothing on this machine currently checks it out). `repoUrl` here is the SAME
 * canonical form `getCanonicalRepoUrl` would have produced from a real `cwd` —
 * both funnel through {@link normalizeRemoteUrl}, so a row's own
 * `PushControlRepo.repoIdentity` (computed by `listPushControlRepos` from that
 * same stored `remoteUrl`) is a safe, already-resolved substitute. No local
 * cache is read or written (there is no worktree to anchor a
 * `space-binding.json` to) — every call here is a live round-trip. A repo the
 * server finds unbound with exactly one bindable Space is auto-bound as a
 * side effect, same as {@link fetchSpaceBindingStatus}. Never throws.
 */
export async function fetchSpaceBindingStatusForUrl(
	repoUrl: string,
	repoName: string,
	jolliApiKey: string | undefined,
	opts?: SpaceBindingProbeOptions,
): Promise<SpaceBindingStatus> {
	if (!jolliApiKey) {
		return { kind: "no_key" };
	}
	return (await probeFrontDoor(repoUrl, repoName, jolliApiKey, opts)).status;
}

/**
 * Compact `{state, label, title?, degraded?}` view of {@link SpaceBindingStatus}
 * for the VS Code Settings panel's per-repo Space column (JOLLI-2152) — a
 * shorter counterpart to `StatusCommand.ts`'s `describeSpaceBinding`, which
 * renders full CLI sentences. `state` drives the column's styling; `title` is
 * the tooltip explaining an otherwise-terse label. `degraded` marks a `bound`
 * row whose binding is unhealthy (no access, or read-only) so the column can
 * give it a distinct, non-alarming warning treatment without overloading
 * `state` — a degraded row is still bound, not unbound or unknown.
 *
 * `unknown` is reserved for states this feature genuinely cannot resolve: not
 * signed in, an outdated client, sign-in rejected, or the live probe itself
 * failing (offline, timeout, a malformed server reply). A row with no local
 * checkout is NOT one of these — `PushControlSpaces.ts`'s fan-out still probes
 * it live via {@link fetchSpaceBindingStatusForUrl}, using the row's own
 * already-known canonical URL, so it resolves to a real `bound`/`unbound`
 * answer like any other row. `unknown` must never be confused with `unbound`,
 * which is a real, confirmed "no Space" answer from the server.
 *
 * A bound Space's name is always quoted in `label` (`"Acme Core"`), never the
 * bare name: the surfaces that render this column (VS Code, the dashboard,
 * IntelliJ) have no static column header, so an unquoted name that happens to
 * read like a product label — a Space literally named "Jolli Memory" is a
 * real, unremarkable case — would look like UI chrome rather than a value the
 * user can change. Same reasoning `StatusCommand.ts`'s `describeSpaceBinding`
 * already applies to its `Space "…"` phrasing; do not drop the quoting here.
 */
export interface SpaceBindingColumnDisplay {
	readonly state: "bound" | "unbound" | "unknown";
	readonly label: string;
	readonly title?: string;
	readonly degraded?: true;
}

export function describeSpaceBindingColumn(state: SpaceBindingStatus): SpaceBindingColumnDisplay {
	switch (state.kind) {
		case "bound": {
			if (!state.spaceName) {
				return {
					state: "bound",
					degraded: true,
					label: "Bound (no access)",
					title: "You don't have access to view this Space — memories won't sync until access is restored.",
				};
			}
			if (state.canPush === false) {
				return {
					state: "bound",
					degraded: true,
					label: `"${state.spaceName}"`,
					title: `Read-only — memories won't sync to "${state.spaceName}" until access is restored.`,
				};
			}
			return {
				state: "bound",
				// Quoted, not the bare name: a Space can be named anything — including
				// something that reads like a product name (e.g. a Space literally
				// called "Jolli Memory") — and this column has no static header
				// telling the user "this cell is a Space name". Same reason
				// StatusCommand.ts's describeSpaceBinding quotes it as `Space "…"`.
				label: `"${state.spaceName}"`,
				title: `This repo's memories push into the Jolli Space "${state.spaceName}".`,
			};
		}
		case "unbound":
			return {
				state: "unbound",
				label: "Not bound",
				title: `${state.spaceCount} Space${state.spaceCount === 1 ? "" : "s"} available — bind from the Binding Chooser.`,
			};
		case "no_spaces":
			return {
				state: "unbound",
				label: "Not bound",
				title: state.restricted
					? "This repo isn't registered in any Space (ask an administrator to add it)."
					: "No Spaces available to you.",
			};
		case "no_key":
			return { state: "unknown", label: "Not checked", title: "Not signed in to Jolli." };
		case "auth_rejected":
			return { state: "unknown", label: "Not checked", title: "Sign-in was rejected — sign in again." };
		case "outdated":
			return { state: "unknown", label: "Not checked", title: "Update the extension to check this." };
		case "unreachable":
			return {
				state: "unknown",
				label: "Not checked",
				title: "Couldn't check this repo's Space binding (offline, or the server didn't respond).",
			};
	}
}
