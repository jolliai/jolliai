/**
 * DashboardServer — the localhost HTTP service behind `jolli dashboard`.
 *
 * Serves the app's HTML pages and JSON endpoints (`/api/*`) from the
 * dashboard database. GET requests never write: producers write the DB
 * directly through `StatsWriter`, so this process opens the database
 * read-only for every render and whether it is running has no effect on data
 * capture. A handful of POST routes (Repositories' enable/disable/resume,
 * Settings' hook reinstall) DO cause writes — mostly outside the database, via
 * the same `install`/`registerRepo`/`uninstall` functions the CLI commands use.
 *
 * ONE of them also writes the database: `projectRegistryEntry`, two rows, so an
 * enable/pause/resume made here is visible to the very next request instead of
 * waiting for the next `jolli dashboard` (every read surface filters on
 * `repos.disabled_at IS NULL`, so an unprojected registry write is invisible in
 * both directions). It is guarded to preserve the rule that matters — this
 * process NEVER migrates the schema; see the function.
 *
 * That rule is load-bearing enough to have been broken once: the daily
 * backup snapshot used to fire from `startDashboardServer`, and
 * `opportunisticSnapshot` opens a WRITABLE handle — which runs schema
 * migrations. This is the one long-lived process whose build can lag (a
 * launcher reuses a recorded server after probing `/health`, which reports no
 * version), so it is the last one that should be able to migrate the schema.
 * Both halves of the no-daemon backup schedule now live in processes that
 * already write: `executeDashboard` and the post-commit `QueueWorker`.
 *
 * DbBackfill is deliberately NOT part of that write surface: the import sweep
 * that fills the database from summaries already written is `jolli dashboard`'s
 * own startup step, run in the command process, never from a request here.
 * Generating the memories themselves (a real per-commit model call) stays a CLI
 * action (`jolli backfill`) too — with ONE deliberate browser-reachable
 * exception, Settings → Generate Missing Summaries
 * (`/api/settings/generate-missing`), added for parity with the VS Code panel.
 * That is the one place a request here spends model budget on a backfill, so it
 * is serialised by `generateMissingInFlight`: a refresh or a second tab drops
 * the page-side busy flag, and without the guard a re-click would start a second
 * backfill over the same commits and pay for every summary twice.
 *
 * ## Security model
 *
 * Three layers, all browser-facing:
 *
 *   1. Loopback-only binding plus a Host allowlist — only `127.0.0.1[:port]` /
 *      `localhost[:port]` Hosts are served. The allowlist is what defeats DNS
 *      rebinding, where the packet reaches 127.0.0.1 but the Host is the
 *      attacker's domain.
 *   2. No CORS — no `Access-Control-Allow-Origin` is ever emitted, and any
 *      request carrying a cross-origin `Origin` is rejected outright, so a
 *      hostile page cannot read the responses even if it can issue requests.
 *   3. A per-server random token, checked ONLY on mutating routes (every
 *      POST) and on the three GETs that expose more than a public read: the
 *      two that feed a mutation or probe the filesystem (`/api/repo-probe`,
 *      `/api/settings/check-folder`) and the one that carries key-derived
 *      material (`/api/model?view=settings` — masked keys, sign-in state, the
 *      Memory Bank folder path). Every other GET page and `/api/model` view
 *      stays exactly as open as before — `http://localhost:<port>/dashboard`
 *      still just works by hand, which was the original product call and is
 *      unaffected by this. The token is minted at server start, held only in
 *      process memory, and inlined into the page as
 *      `window.__JOLLI_DASHBOARD_TOKEN__` (never in a URL, to keep it out of
 *      referrers/history/logs). This is what makes the write surface safe
 *      despite layers 1+2 alone not being enough for it: a hostile page in
 *      the same browser cannot read our HTML to steal the token (no CORS,
 *      `hasForeignOrigin` already rejects it), and another local user cannot
 *      read this process's memory over loopback the way they could read a
 *      file. GET-only readers (session counts, tokens, cost, commit subjects,
 *      mined insights) still need no credential — nothing there is a secret.
 *      The lone exception is the settings view, whose masked keys, sign-in
 *      state and folder path are gated by the same token above; every other
 *      model this serves is still free of key-derived material.
 *   4. `Sec-Fetch-Site` gates the one thing a GET can do that is NOT free:
 *      building the Stats payload can fire a DecisionGist LLM call. Layers
 *      1+2 do not stop a hostile tab from ISSUING a GET (a `no-cors` request
 *      carries no `Origin` to reject and a loopback `Host` to accept) — they
 *      only stop it reading the reply, which is enough when the reply is the
 *      only thing at stake and not enough when producing it spends money. So
 *      a cross-site request still gets its answer, minus the parts that cost
 *      anything; see {@link ModelRequest.allowModelSpend}. This layer is what
 *      covers the PAGE routes, which deliberately demand no token, and it
 *      degrades to the token check on a client that sends no Fetch-Metadata.
 *      An absent header is trusted as `curl` — a local process spending the
 *      local user's own budget, which needs no help from us to do that.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { clearAuthCredentials, getJolliUrl } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { getProjectRootDir, listReachableCommits, readLocalGitIdentity } from "../core/GitOps.js";
import { escapeForInlineScript } from "../core/InlineScript.js";
import { isLocalAgentUsable } from "../core/localagent/DetectAgents.js";
import { listPushControlRepos, setRepoPushDisabledByIdentity, triggerReenableDrain } from "../core/PushControl.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import { trackAs } from "../core/Telemetry.js";
import { isTelemetryEventName, type TelemetryEventName } from "../core/TelemetryEvents.js";
import { resolveAssetsDir as resolveGraphAssetsDir } from "../graph/GraphExport.js";
import { install, uninstall } from "../install/Installer.js";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { LocalAgentToolId } from "../Types.js";
import {
	DASHBOARD_SCHEMA_VERSION,
	ensureDashboardDbExists,
	readSchemaVersion,
	withDashboardDb,
	withReadonlyDashboardDb,
} from "./DashboardDb.js";
import {
	CONTEXT_DOC_KINDS,
	type DashboardModel,
	type DashboardRange,
	type DashboardScope,
	type DashboardView,
	type SeriesDimension,
} from "./DashboardModel.js";
import { buildDashboardModel, type QueryOptions } from "./DashboardQuery.js";
import { projectRepoRegistryState } from "./DbBackfill.js";
import { getDecisionGist } from "./DecisionGist.js";
import { buildGraphViewerDocument } from "./GraphViewerDocument.js";
import {
	buildGraphModel,
	buildKnowledgeModel,
	readGraphJson,
	readWikiBody,
	resolveKbRoot,
	WIKI_FILE_PATTERN,
} from "./KnowledgeQuery.js";
import { buildMemoriesPage, type ReachableCommits, readContextDoc } from "./MemoriesQuery.js";
import { probeRepo } from "./RepoProbe.js";
import { deregisterRepo, existingWorktrees, readRepoRegistry, registerRepo } from "./RepoRegistry.js";
import { buildRepositoriesModel } from "./RepositoriesQuery.js";
import {
	applySettings,
	checkLocalFolder,
	countMissingForCwd,
	parseSettingsApplyInput,
	SettingsValidationError,
} from "./SettingsMutations.js";
import { buildSettingsPageModel, clearLaunchRepoStateCache } from "./SettingsPageQuery.js";

const log = createLogger("DashboardServer");

const HERE = dirname(fileURLToPath(import.meta.url));

/** Preferred ports: both verified free of mainstream registered services. */
export const DASHBOARD_PORTS = [1818, 18118] as const;

/** Shut down after this long with no requests. Restarting is cheap and lossless. */
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** State the launcher needs to find (or verify) a running server. */
export interface DashboardServerState {
	readonly pid: number;
	readonly port: number;
	readonly startedAt: string;
	readonly schemaVersion: number;
}

/** Path of `dashboard.json` — pid/port, so the launcher can find a live server. */
export function getDashboardStatePath(configDir: string = getGlobalConfigDir()): string {
	return join(configDir, "dashboard.json");
}

export async function readDashboardState(configDir?: string): Promise<DashboardServerState | null> {
	try {
		const raw = JSON.parse(await readFile(getDashboardStatePath(configDir), "utf-8")) as DashboardServerState;
		return typeof raw?.port === "number" ? raw : null;
	} catch (err) {
		if (!isEnoent(err)) log.warn("dashboard.json unreadable: %s", errMsg(err));
		return null;
	}
}

export async function writeDashboardState(state: DashboardServerState, configDir?: string): Promise<void> {
	const path = getDashboardStatePath(configDir);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Removes `dashboard.json`.
 *
 * `expectedPid` makes the removal **conditional**: clear the record only while
 * it still describes that pid. A shutting-down server must never delete a
 * successor's record — should two servers ever be alive at once, the first to
 * exit would orphan the second, leaving a healthy server that no launcher can
 * find and every later `jolli dashboard` spawning yet another one. Callers
 * cleaning up after a server they merely *read about* (`--stop`, the launcher's
 * replace path) pass the pid they read, for the same reason.
 *
 * Read-then-unlink is not atomic, so a record rewritten inside that window can
 * still be removed. That is a far smaller race than the unconditional delete,
 * and the recovery is the same one that already covers a crashed server: the
 * next launcher finds no record and spawns.
 */
export async function clearDashboardState(configDir?: string, expectedPid?: number): Promise<void> {
	if (expectedPid !== undefined) {
		const current = await readDashboardState(configDir);
		if (current && current.pid !== expectedPid) {
			log.info("dashboard.json now records pid %d — leaving it for that server", current.pid);
			return;
		}
	}
	try {
		await unlink(getDashboardStatePath(configDir));
	} catch (err) {
		if (!isEnoent(err)) log.warn("could not remove dashboard.json: %s", errMsg(err));
	}
}

// ── Asset assembly ──────────────────────────────────────────────────────────

/**
 * App scripts, in load order (shared helpers first, page modules, then boot).
 *
 * This list is duplicated in three other places that must move together:
 * `assets/index.html`'s `<!-- scripts:start/end -->` block, the test fixture
 * in `DashboardServer.test.ts` (`writeTestAssets`), and the loader in
 * `FeedCardAsset.test.ts`. A file added here and missed in one of those three
 * only fails at runtime (a 404'd `<script src>` in the shipped page) or in
 * that one test file, never at compile time.
 */
/**
 * Every script `assembleDashboardHtml` inlines, in load order. Exported because
 * two gates depend on the list being one thing: `resolveDashboardAssetsDir`
 * probes for each file, and the plugin publish scripts assert each is staged.
 */
export const DASHBOARD_SCRIPT_FILES = [
	"format.js",
	"charts.js",
	"shell.js",
	"stats.js",
	"standup.js",
	"repositories.js",
	"memories.js",
	"knowledge.js",
	"graph.js",
	"settings.js",
	"main.js",
] as const;

/**
 * Locates the shipped dashboard assets: `<dist>/dashboard-assets/` in a build,
 * `./assets/` beside this module when running from source. Same convention as
 * the knowledge-graph viz.
 */
export function resolveDashboardAssetsDir(baseDir: string = HERE): string {
	for (const candidate of ["dashboard-assets", "assets", join("dashboard", "assets")]) {
		const dir = join(baseDir, candidate);
		// The probe checks EVERY file `assembleDashboardHtml` reads, not just
		// index.html. A partially-shipped asset tree (a marketplace-repo .gitignore
		// matching `js/` or `*.css`) otherwise resolved happily here and threw
		// ENOENT from inside the render — a 500 per page load instead of one clear
		// "reinstall" message at the door.
		if (!existsSync(join(dir, "index.html"))) continue;
		if (!existsSync(join(dir, "styles", "main.css"))) continue;
		if (DASHBOARD_SCRIPT_FILES.some((f) => !existsSync(join(dir, "js", f)))) continue;
		return dir;
	}
	throw new Error("Dashboard assets not found — reinstall @jolli.ai/cli (the dashboard needs its bundled assets).");
}

/**
 * Assembles one self-contained page: template + inlined CSS + the model behind
 * `window.__JOLLI_DASHBOARD__` + inlined app scripts. No external fetches, so
 * the strict no-CORS policy costs the page nothing.
 *
 * `token` (when given) is inlined as `window.__JOLLI_DASHBOARD_TOKEN__` —
 * the mutation-only credential `repositories.js` attaches to its own POSTs
 * (see the module header for why GET stays token-free). Optional so the
 * many existing tests that call this with two arguments are unaffected.
 */
export function assembleDashboardHtml(assetsDir: string, modelJson: string, token?: string): string {
	const read = (...p: string[]) => readFileSync(join(assetsDir, ...p), "utf8");
	let html = read("index.html");
	const cssMarker = '<link rel="stylesheet" href="styles/main.css" />';
	if (!html.includes(cssMarker)) throw new Error("dashboard template missing stylesheet marker");
	html = html.replace(cssMarker, () => `<style>\n${read("styles", "main.css")}\n</style>`);
	const tokenScript = token
		? `<script>window.__JOLLI_DASHBOARD_TOKEN__ = ${escapeForInlineScript(JSON.stringify(token))};</script>\n`
		: "";
	const scripts =
		tokenScript +
		`<script>window.__JOLLI_DASHBOARD__ = ${escapeForInlineScript(modelJson)};</script>\n` +
		DASHBOARD_SCRIPT_FILES.map((f) => `<script>\n${read("js", f)}\n</script>`).join("\n");
	const marker = /<!-- scripts:start -->[\s\S]*?<!-- scripts:end -->/;
	if (!marker.test(html)) throw new Error("dashboard template missing scripts block");
	return html.replace(marker, () => scripts);
}

// ── Framed viewer documents (Knowledge / Graph iframes) ─────────────────────

/**
 * Minimal readable styling for the `/wiki-viewer` document. It renders in a
 * sandboxed iframe with its own (opaque) origin, so it inherits none of the
 * dashboard theme — hence a self-contained neutral stylesheet.
 */
const WIKI_VIEWER_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px 40px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1d21; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #d6dae0; background: #16181c; } }
/* Fill the reading pane's width (left-aligned) — a narrow centred column left
   large blank margins in the wide detail pane. Cap only on very wide viewports. */
.md { max-width: 1200px; margin: 0; }
.md h1, .md h2, .md h3 { line-height: 1.25; margin: 1.4em 0 .5em; }
.md h1 { font-size: 1.6em; } .md h2 { font-size: 1.3em; } .md h3 { font-size: 1.1em; }
.md a { color: #2563eb; } @media (prefers-color-scheme: dark) { .md a { color: #6ea8ff; } }
.md pre { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: #f3f4f6; }
@media (prefers-color-scheme: dark) { .md pre { background: #23262b; } }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
.md table { border-collapse: collapse; } .md th, .md td { border: 1px solid #d0d5dd; padding: 6px 10px; }
.md img { max-width: 100%; }
.viewer-msg { max-width: 640px; margin: 48px auto; color: #6b7280; text-align: center; }
`;

/**
 * A self-contained `/wiki-viewer` document: the vendored `marked` engine inlined,
 * plus one script that renders `bodyMd` into `#md`. Served ONLY into a
 * `sandbox="allow-scripts"` iframe (no `allow-same-origin`), which is what
 * actually isolates any HTML the wiki markdown produces from the token-bearing
 * parent page — the CSP `frame-ancestors 'self'` only controls who may embed it.
 * `bodyMd` is inlined as `escapeForInlineScript(JSON.stringify(bodyMd))`: it must
 * become a JS string literal first (marked.parse takes a string), then have
 * `</script>` / ` ` neutralised.
 */
function buildWikiViewerHtml(graphAssetsDir: string, bodyMd: string): string {
	const marked = readFileSync(join(graphAssetsDir, "vendor", "marked.min.js"), "utf8");
	const safe = escapeForInlineScript(JSON.stringify(bodyMd));
	return (
		`<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
		`<meta name="viewport" content="width=device-width, initial-scale=1" />` +
		`<style>${WIKI_VIEWER_CSS}</style></head><body><article id="md" class="md"></article>` +
		`<script>\n${marked}\n</script>` +
		`<script>document.getElementById("md").innerHTML = window.marked.parse(${safe});</script>` +
		`</body></html>`
	);
}

/** A friendly framed message (no scripts) for a viewer that has nothing to show. */
function viewerMessageHtml(message: string): string {
	// `message` is one of a few fixed strings, never user input — safe to inline.
	return (
		`<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
		`<style>${WIKI_VIEWER_CSS}</style></head><body><p class="viewer-msg">${message}</p></body></html>`
	);
}

// ── Request handling ────────────────────────────────────────────────────────

/**
 * Everything one page render is asked for — `QueryOptions` minus the clock,
 * which only tests inject. A single object rather than positional parameters
 * because the query layer keeps gaining optional axes, and each new one would
 * otherwise be a positional argument every caller has to thread through.
 */
export type ModelRequest = Omit<QueryOptions, "timeZone" | "nowMs"> & {
	/**
	 * Whether this request may spend model budget (today: the Decisions gist).
	 * Set for a page render, and for an `/api/model` call that presented the
	 * token — i.e. one our own page made. A token-free `/api/model` still gets
	 * the full payload, minus the parts that cost money.
	 *
	 * The gate exists because `/api/model` is reachable cross-site in a way the
	 * page routes are not: a `no-cors` GET carries no `Origin` (so layer 2 never
	 * fires) and `Host: 127.0.0.1:<port>` passes layer 1, so a background tab
	 * could loop `?view=stats` with varied window params — each miss on
	 * DecisionGist's 256-entry cache being a real LLM call the user never sees.
	 * The `/` redirect below already avoids this one view for the same reason;
	 * this closes the route that redirect cannot cover.
	 */
	readonly allowModelSpend?: boolean;
	/**
	 * Set when the caller reads only the parts of the model every view carries —
	 * today just `repos.length`, for the `/` redirect — and must not pay for the
	 * per-repo `git rev-list --branches` fan-out {@link REACHABILITY_VIEWS} would
	 * otherwise trigger.
	 *
	 * The redirect builds the `repositories` model to stay clear of the stats
	 * view's LLM call, and that became the expensive choice the moment
	 * `repositories` joined the reachability set: one git subprocess per enabled
	 * repo plus every root memory hash materialized in JS, to decide a 302 whose
	 * destination then does the same work again. `isReachable` fails open, so the
	 * counts this skips revert to their raw values — which the redirect discards.
	 */
	readonly skipReachability?: boolean;
};

/** Builds the model for one request. Injectable so tests skip the real DB. */
export type ModelBuilder = (request: ModelRequest) => Promise<DashboardModel>;

/**
 * Views whose payload counts or renders per-MEMORY rows, and therefore pay for
 * one `git rev-list --branches` per repo. Deliberately not `standup`: its
 * commit lists — like the stats heatmap and KPI row — report activity, and a
 * commit that has since been squashed away still happened. Only the
 * memory-facing rows are filtered, because a rewritten commit's `memories` row
 * is a DUPLICATE of the surviving one, not a record of separate work.
 *
 * `repositories` is here for its per-repo memory badge alone: that number must
 * answer the same question the Memories tree does, or the two pages contradict
 * each other for any repo whose history was rewritten away.
 */
const REACHABILITY_VIEWS: ReadonlySet<DashboardView> = new Set<DashboardView>(["stats", "memories", "repositories"]);

/**
 * How long one worktree's git identity is trusted. Minutes, not hours: the value
 * only changes when the user reconfigures git, and a stale identity shows the
 * wrong person's commits as their own.
 */
const IDENTITY_CACHE_TTL_MS = 5 * 60_000;

/**
 * Per-worktree git identity, remembered for the life of ONE server (created in
 * `createDashboardServer`, never module-global). Process-scoped state is what a
 * cache of a machine-local git config should be, and it also keeps a test's
 * observations of the git calls from depending on what an earlier test cached.
 */
type IdentityCache = Map<string, { identity: { email: string | null; name: string | null }; atMs: number }>;

/**
 * Every `user.email` / `user.name` this machine commits under, unioned across
 * the registered repos — the standup board's "mine only" filter.
 *
 * Per repo rather than once globally because `git config user.email` is
 * routinely overridden inside a worktree (a work identity in one checkout, a
 * personal one in another), and a global-only read would filter the overridden
 * repo's own commits away. Unioning is the right shape for the same reason it is
 * safe: the alternative — per-repo identities applied only to that repo's rows —
 * costs a correlated filter to separate identities that belong to one person
 * anyway.
 *
 * Concurrent, two `git config` reads per repo, and only for the standup view —
 * and each worktree's answer is then cached for {@link IDENTITY_CACHE_TTL_MS}.
 * The page re-polls `/api/model` every 30 s for as long as it is open, so an
 * uncached read means two subprocesses per repo forever, to re-learn a value
 * that changes when the user edits `.git/config` by hand. The TTL, rather than a
 * permanent memo, is what lets such an edit take effect without a restart.
 *
 * An unreadable or unconfigured repo contributes nothing rather than failing the
 * request: `authorFilter` then fails open on an empty identity. Those are cached
 * too — a repo with no `user.email` would otherwise pay the subprocesses on
 * every poll precisely because it has nothing to remember.
 */
async function readLocalAuthorIdentity(
	repos: ReadonlyArray<{ worktree_root: string }>,
	cache: IdentityCache,
	now: () => number,
): Promise<{ emails: string[]; names: string[] }> {
	const nowMs = now();
	const identities = await Promise.all(
		// An empty `worktree_root` is a placeholder row (see readReachableCommitsByRepo):
		// `cwd: ''` silently runs in the PARENT process's directory, which would read
		// whichever repo the server happens to be launched from.
		repos.map(async (repo) => {
			if (!repo.worktree_root) return null;
			const hit = cache.get(repo.worktree_root);
			if (hit && nowMs - hit.atMs < IDENTITY_CACHE_TTL_MS) return hit.identity;
			const identity = await readLocalGitIdentity(repo.worktree_root);
			cache.set(repo.worktree_root, { identity, atMs: nowMs });
			return identity;
		}),
	);
	const emails = new Set<string>();
	const names = new Set<string>();
	for (const identity of identities) {
		if (identity?.email) emails.add(identity.email);
		if (identity?.name) names.add(identity.name);
	}
	return { emails: [...emails], names: [...names] };
}

/**
 * One `git rev-list --branches` per enabled repo, mapped to {@link ReachableCommits}.
 * Run concurrently — each is a single git subprocess, and repos are typically
 * few (this machine's own dashboard, not a fleet). A repo whose git call fails
 * gets `null` rather than being dropped from the map: `isReachable` treats
 * both the same (fail open), but recording it distinguishes "checked, has no
 * filter" from "never checked" in a debugger, which a dropped entry would not.
 */
async function readReachableCommitsByRepo(
	repos: ReadonlyArray<{ repo_identity: string; worktree_root: string }>,
): Promise<ReachableCommits> {
	const entries = await Promise.all(
		repos.map(async (r): Promise<readonly [string, ReadonlySet<string> | null]> => {
			// A `repos` row can legitimately carry an EMPTY worktree_root: a hook
			// that writes before the registry has been projected gets a placeholder
			// row from `ensureRepoRow`, which fills the NOT NULL column with `''`.
			// Node's execFile treats `cwd: ''` as absent and silently runs in the
			// PARENT process's directory — measured — so the git call would answer
			// with some other repo's commits and filter every one of this repo's
			// memories away. No path, no filter.
			if (!r.worktree_root) return [r.repo_identity, null];
			const hashes = await listReachableCommits(r.worktree_root);
			return [r.repo_identity, hashes ? new Set(hashes) : null];
		}),
	);
	return new Map(entries);
}

/**
 * Builds only data for routes that are part of the released dashboard surface.
 */
async function defaultModelBuilder(
	request: ModelRequest,
	configDir: string | undefined,
	dbPath: string | undefined,
	identityCache: IdentityCache,
	now: () => number,
	launchCwd: string,
): Promise<DashboardModel> {
	// The launcher creates the file before this process starts, so this only
	// covers the case where it disappears under a running server (a wiped
	// `~/.jolli/jollimemory`, a `doctor` mid-restore). Recreating an empty
	// schema beats the alternative: a read-only open raises SQLITE_CANTOPEN,
	// which the request handler turns into a plain-text 500 — a page with no
	// scripts on it, so nothing polls `/api/model` and the browser never comes
	// back on its own. An empty database renders the normal "no data yet" page.
	await ensureDashboardDbExists(dbPath ? { dbPath } : {});
	// Settings is built off config + a cheap folder-state peek, not the DB. Built
	// here (before the read-only DB open) and threaded through `QueryOptions`. The
	// launch cwd — `process.cwd()`, set to the git root by `DashboardCommand` when
	// it spawned this process — drives only the Memory Bank state line; a reused
	// long-lived server reflects the repo it was FIRST launched in, which is why
	// that repo's name travels to the user alongside it as `repoLabel`.
	const settingsModel = request.view === "settings" ? await buildSettingsPageModel(configDir, launchCwd) : undefined;
	// Knowledge/Graph read the Memory Bank folder (not the DB), like Settings above.
	const knowledgeModel = request.view === "knowledge" ? await buildKnowledgeModel(configDir) : undefined;
	const graphModel = request.view === "graph" ? await buildGraphModel(configDir) : undefined;
	return withReadonlyDashboardDb(
		async (db) => {
			// A rebase/reset/squash that rewrites history away leaves the old
			// commits' rows in `commits` and `memories` forever, since nothing
			// else notices they dropped off every branch — see `ReachableCommits`.
			// Every view that renders per-commit rows pays for the check: the
			// memories tree, the stats page's Memory Activity feed and captured
			// counts, and the Repositories page's per-repo memory badge.
			//
			// Computed BEFORE the repositories model, which consumes it. Skipped
			// for a caller that never looks at the filtered rows — see
			// `ModelRequest.skipReachability`.
			const reachableCommits =
				REACHABILITY_VIEWS.has(request.view) && !request.skipReachability
					? await readReachableCommitsByRepo(
							db
								.prepare("SELECT repo_identity, worktree_root FROM repos WHERE disabled_at IS NULL")
								.all() as ReadonlyArray<{ repo_identity: string; worktree_root: string }>,
						)
					: undefined;
			const repositories =
				request.view === "repositories"
					? await buildRepositoriesModel(db, configDir, reachableCommits)
					: undefined;
			// Standup is a FIRST-PERSON report, unlike every other view: its columns
			// feed a Copy-as-standup draft the user posts as their own work, so a
			// shared branch's teammate commits are a false claim rather than noise.
			const authorIdentity =
				request.view === "standup"
					? await readLocalAuthorIdentity(
							db
								.prepare("SELECT worktree_root FROM repos WHERE disabled_at IS NULL")
								.all() as ReadonlyArray<{ worktree_root: string }>,
							identityCache,
							now,
						)
					: undefined;
			const built = buildDashboardModel(db, {
				...request,
				...(repositories ? { repositoriesModel: repositories } : {}),
				...(settingsModel ? { settingsModel } : {}),
				...(knowledgeModel ? { knowledgeModel } : {}),
				...(graphModel ? { graphModel } : {}),
				...(reachableCommits ? { reachableCommits } : {}),
				...(authorIdentity ? { authorIdentity } : {}),
			});
			return attachDecisionGist(built, request, configDir);
		},
		{ dbPath },
	);
}

/**
 * Stats view only: compresses the Decisions card's "Latest" text into one
 * sentence for display. Runs after `buildDashboardModel` (rather than as a
 * pre-fetch alongside envFacts/hooks/repositories above) because the text to
 * compress isn't known until that call returns the `latest` decision. Fails
 * open — a missing API key, LLM error, or timeout just leaves `latest.text`
 * as-is; see DecisionGist.ts.
 *
 * This is the ONLY place a browser-reachable route can spend model budget, so
 * it is also where `allowModelSpend` is enforced; skipping it degrades the card
 * to its un-compressed text, which is what a gist failure already does.
 */
async function attachDecisionGist(
	model: DashboardModel,
	request: ModelRequest,
	configDir: string | undefined,
): Promise<DashboardModel> {
	if (!request.allowModelSpend) return model;
	const stats = request.view === "stats" ? model.stats : undefined;
	const decisions = stats?.decisions;
	const latest = decisions?.latest;
	if (!stats || !decisions || !latest) return model;

	const config = await loadConfigFromDir(configDir ?? getGlobalConfigDir());
	const gist = await getDecisionGist(latest.commitHash, latest.text, config);
	if (!gist) return model;

	return { ...model, stats: { ...stats, decisions: { ...decisions, latest: { ...latest, gist } } } };
}

export interface DashboardServerOptions {
	/** 0 lets the OS pick (tests); the launcher passes a preferred port. */
	readonly port: number;
	readonly buildModel?: ModelBuilder;
	readonly assetsDir?: string;
	readonly idleTimeoutMs?: number;
	/** Called when the idle timeout fires, after the server closes. */
	readonly onIdleShutdown?: () => void;
	readonly now?: () => number;
	/** Database override for the start-time snapshot trigger (tests). */
	readonly dbPath?: string;
	/** Where the repo registry lives. Defaults to the machine-global config dir. */
	readonly configDir?: string;
	/** Mutation token override (tests). Defaults to a fresh random one per server. */
	readonly token?: string;
	/**
	 * The repo the server was launched in — `process.cwd()` in production (set to
	 * the git root by `DashboardCommand`). Drives the Settings page's per-repo
	 * displays and its repo-scoped actions (generate-missing, migrate, sync-now,
	 * the push list's "this repo" marker). Injectable so tests point it at a
	 * temp repo instead of the real one.
	 */
	readonly serverCwd?: string;
}

/** Host header allowlist — exact host, optional matching port. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
	if (!hostHeader) return false;
	const allowed = new Set(["127.0.0.1", "localhost", `127.0.0.1:${port}`, `localhost:${port}`]);
	return allowed.has(hostHeader.toLowerCase());
}

/**
 * True when the request's Origin (if any) is NOT this server — reject it.
 *
 * Strict on the port, unlike {@link isAllowedHost}. That predicate accepts the
 * port-less `127.0.0.1` / `localhost` because a request's `Host` header may
 * legitimately omit a default port; an `Origin`, though, is an origin — and
 * `http://localhost` (port 80) is a DIFFERENT origin from this server's. Reusing
 * the Host predicate here silently admitted every other-port localhost page,
 * contradicting the module header's "any cross-origin Origin is rejected
 * outright". Not a breach on its own (mutations still need the unreadable token
 * and a preflight that 405s, and reads carry no CORS headers), but it is the
 * layer that is supposed to hold without them.
 */
export function hasForeignOrigin(originHeader: string | undefined, port: number): boolean {
	if (!originHeader) return false;
	try {
		const origin = new URL(originHeader);
		if (origin.protocol !== "http:") return true;
		const host = origin.hostname.toLowerCase();
		if (host !== "127.0.0.1" && host !== "localhost") return true;
		return origin.port !== String(port);
	} catch {
		return true;
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, { "Content-Type": "text/plain" });
	res.end(text);
}

/**
 * Sends a framed viewer document (`/wiki-viewer`, `/graph-viewer`).
 *
 * Two isolation layers, both load-bearing:
 *   - The `sandbox allow-scripts` CSP directive forces this document into an
 *     OPAQUE origin whatever loads it — the framing iframe OR a top-level
 *     navigation. That is what actually stops any HTML the wiki/graph markdown
 *     produces from reaching this same-origin server's `__JOLLI_DASHBOARD_TOKEN__`
 *     and forging a mutation. The front end's `sandbox="allow-scripts"` iframe
 *     attribute does the same for the frame case, but a document loaded top-level
 *     (a hostile page's `window.open('…/wiki-viewer?…')`) has no such attribute —
 *     so the header is the backend-enforced backstop the attribute cannot be.
 *     `allow-scripts` (no `allow-same-origin`) keeps `marked` running while the
 *     opaque origin denies token access; the viz uses no `localStorage`/`cookie`.
 *   - `frame-ancestors 'self'` (overriding the global `'none'`) lets the dashboard
 *     frame it; it is evaluated on the response URL's origin, not the sandboxed
 *     one, so same-origin framing still works. `X-Frame-Options: SAMEORIGIN`
 *     covers pre-CSP clients (it has no sandbox equivalent, hence the CSP above).
 *
 * `no-store` keeps it in step with the dashboard's private-data caching policy.
 */
function sendViewerHtml(res: ServerResponse, status: number, html: string): void {
	res.setHeader("Content-Security-Policy", "sandbox allow-scripts; frame-ancestors 'self'");
	res.setHeader("X-Frame-Options", "SAMEORIGIN");
	res.writeHead(status, { "Content-Type": "text/html", "Cache-Control": "no-store" });
	res.end(html);
}

/** Header carrying the mutation token — never a query param (URLs end up in logs/history/referrers). */
const TOKEN_HEADER = "x-jolli-dashboard-token";

/**
 * Surface stamped on telemetry forwarded from the local web view. Distinct from
 * the hosting process's own `cli` surface (see `trackAs`) and from the future
 * hosted `web` frontend. Must be in the backend's `SURFACES` allowlist or the
 * event is dropped at ingest.
 */
const WEB_LOCAL_SURFACE = "web-local";

/**
 * The only events the beacon may stamp `web-local`. The endpoint is reachable by
 * any same-origin script — and, lacking an Origin header, by any local process —
 * so gating on {@link isTelemetryEventName} alone would let a caller forge an
 * unrelated registered event (e.g. `search_performed`) under this surface.
 * Restricting to the four dashboard-UI events matches the documented contract:
 * this endpoint forwards local-web-view interactions, nothing else.
 */
const WEB_LOCAL_EVENTS: ReadonlySet<TelemetryEventName> = new Set([
	"dashboard_opened",
	"dashboard_view_switched",
	"range_changed",
	"chart_split_changed",
]);

/**
 * Constant-time token check. A length mismatch is checked first (bailing out
 * before `timingSafeEqual`, which throws on unequal-length buffers) — that
 * branch leaks only the token's length, which is fixed and public (every
 * token this server ever mints is the same 64 hex chars).
 */
function hasValidToken(req: IncomingMessage, token: string): boolean {
	const header = req.headers[TOKEN_HEADER];
	if (typeof header !== "string") return false;
	// Compare the BUFFERS' lengths, not the strings'. Node decodes header bytes as
	// latin1, so one non-ASCII byte is one JS char but two UTF-8 bytes — a crafted
	// header of the right character count reached `timingSafeEqual` with mismatched
	// buffers, which throws, turning a 403 into a 500.
	const given = Buffer.from(header, "utf-8");
	const expected = Buffer.from(token, "utf-8");
	if (given.length !== expected.length) return false;
	return timingSafeEqual(given, expected);
}

/**
 * Whether a request may build a payload that costs money — see
 * {@link ModelRequest.allowModelSpend}. Two independent signals, because
 * neither covers the whole surface on its own:
 *
 *   - `Sec-Fetch-Site` (sent by every current browser, and by nothing else)
 *     names the initiator. `cross-site`/`same-site` is a page we did not
 *     serve, whatever it is loading us as — and it is the ONLY signal that
 *     covers the PAGE routes, which an `<img src="…/stats">` reaches just as
 *     easily as `/api/model` and where no token can be demanded without
 *     breaking "open the URL by hand".
 *   - The token covers `/api/model` for a client that sends no Fetch-Metadata
 *     at all (an old browser), where the header's absence is indistinguishable
 *     from `curl`.
 *
 * An absent header therefore means "not a browser" and is trusted: that is
 * `curl` on the user's own machine, which can spend the user's own budget by
 * a hundred easier routes than this one.
 */
function isCrossSiteRequest(req: IncomingMessage): boolean {
	const site = req.headers["sec-fetch-site"];
	return typeof site === "string" && site !== "same-origin" && site !== "none";
}

/** Caps a POST body — this is a local settings form, never a file upload. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

/** Reads and JSON-parses a request body, capped at {@link MAX_BODY_BYTES}. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new BodyTooLargeError("request body too large");
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf-8");
	return raw ? JSON.parse(raw) : {};
}

/** How long a Settings sign-in may wait for the browser callback before failing. */
const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Rejects with `message` if `promise` has not settled within `ms`. Used to cap
 * `browserLogin`, which resolves only on the OAuth callback and otherwise waits
 * forever — a request must not hang on a login the user abandoned.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

/**
 * The `/api/telemetry` beacon. Forwards ONE content-free, already-bucketed event
 * from the local web view into the shared telemetry buffer, stamped `web-local`.
 *
 * Fire-and-forget by contract: any bad input — an unreadable/oversized body, a
 * non-object payload, or an unregistered event name — is dropped and answered
 * 204, so a browser beacon is never taught to retry. Property scrubbing and the
 * opt-out/uninitialized no-op both live in `trackAs`, so this handler only has
 * to validate the event NAME (the one thing the registry gates on).
 */
async function handleTelemetry(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = await readJsonBody(req);
		if (typeof body === "object" && body !== null) {
			const b = body as Record<string, unknown>;
			const event = typeof b.event === "string" ? b.event : "";
			const properties =
				typeof b.properties === "object" && b.properties !== null
					? (b.properties as Record<string, unknown>)
					: {};
			if (isTelemetryEventName(event) && WEB_LOCAL_EVENTS.has(event))
				trackAs(WEB_LOCAL_SURFACE, event, properties);
		}
	} catch {
		// Unreadable / oversized body, or a socket error — drop silently. The
		// payload is content-free and a beacon must never learn to retry.
	}
	res.writeHead(204).end();
}

function parseScope(url: URL): DashboardScope {
	const repo = url.searchParams.get("repo");
	return repo ? { kind: "repo", repoIdentity: repo } : { kind: "all" };
}

/** Series-axis request param; anything unrecognized falls back to the default. */
function parseDimension(url: URL): SeriesDimension | undefined {
	const raw = url.searchParams.get("dimension");
	// Kept in step with SeriesDimension — a value missing here silently degrades
	// to the default axis, which reads as "the chip does nothing".
	const allowed: ReadonlyArray<SeriesDimension> = ["model", "agent", "project", "branch", "ticket", "category"];
	return allowed.find((value) => value === raw);
}

/** Time-range request param; anything unrecognized falls back to the default. */
function parseRange(url: URL): DashboardRange | undefined {
	const raw = url.searchParams.get("range");
	return raw === "today" || raw === "week" || raw === "2w" || raw === "month" || raw === "3m" || raw === "custom"
		? raw
		: undefined;
}

/**
 * The query params that select a window and an axis.
 *
 * `from`/`to` are forwarded verbatim: validating them here as well as in
 * `resolveWindow` would be two places to keep in step, and there is no
 * injection surface to guard — they never reach SQL, and what the model echoes
 * back as `rangeFrom`/`rangeTo` is re-derived from the resolved instants, never
 * from the raw input.
 */
function parseWindow(url: URL): Omit<ModelRequest, "view" | "scope"> {
	const dimension = parseDimension(url);
	const range = parseRange(url);
	const customFrom = url.searchParams.get("from") ?? undefined;
	const customTo = url.searchParams.get("to") ?? undefined;
	// Memories view: which memory's detail to build. Forwarded verbatim, same
	// as from/to above — it only ever reaches SQL as a bound parameter, and an
	// unresolvable hash just means no memory matched (buildMemoryDetail
	// returns undefined), never a query to sanitize here.
	const hash = url.searchParams.get("hash") ?? undefined;
	// Which repo owns that hash — NOT a page scope. It is a separate param from
	// `repo=` precisely because `repo=` narrows every page, and opening one
	// memory used to collapse the whole tree to its repository. Same forwarding
	// rules as `hash`: it reaches SQL only through `resolveScope`'s bound
	// parameters, and an unresolvable value means the detail falls back to the
	// page scope rather than erroring.
	const detailRepo = url.searchParams.get("detailRepo") ?? undefined;
	return {
		...(dimension ? { dimension } : {}),
		...(range ? { range } : {}),
		...(customFrom ? { customFrom } : {}),
		...(customTo ? { customTo } : {}),
		...(hash ? { hash } : {}),
		...(detailRepo ? { detailRepoIdentity: detailRepo } : {}),
	};
}

/**
 * Path → view.
 *
 * `/dashboard` and `/dashboard/standup` are the current nav's two Dashboard
 * children; they map to the view tokens `stats`/`standup`, which keep their
 * historical names so `DashboardQuery`'s switch and its test suite need no
 * change. Each view has exactly ONE path: the legacy `/stats` and `/standup`
 * aliases were removed, so a bookmark on either now 404s. That was a
 * deliberate call — two URLs for one page is what made `shell.js`'s nav, the
 * range control and the repo filter able to disagree about where a view lives.
 *
 * `/decisions` is retired — its view token, model payload and page are gone
 * (folded into Memories' per-topic Decisions callout) — so it is absent here
 * and handled as its own 302 in `handle()` instead.
 *
 * `settings` has NO page path — it is a MODAL opened over any page from the nav
 * (`shell.js` → `JD.openSettings`), which fetches its model via
 * `/api/model?view=settings`. So `settings` is in `VIEW_TOKENS` (for that fetch)
 * but deliberately absent here; a direct visit to `/settings` 404s.
 *
 * `/knowledge` and `/graph` ARE routed (Memory Bank `_wiki` browser + per-repo
 * knowledge graph). Each also has a companion iframe route — `/wiki-viewer` and
 * `/graph-viewer` — that serves a sandboxed self-contained document (see below);
 * those are NOT view paths and are handled directly in `handle()`.
 */
const VIEW_PATHS: Readonly<Record<string, DashboardView>> = {
	"/repositories": "repositories",
	"/dashboard": "stats",
	"/dashboard/standup": "standup",
	"/memories": "memories",
	"/knowledge": "knowledge",
	"/graph": "graph",
};

/**
 * Valid `?view=` tokens for `/api/model`.
 *
 * Its own list, NOT `VIEW_PATHS` keyed by `/${token}`: that trick only worked
 * while every view's path was its token, and it silently broke the API the
 * moment `stats` moved to `/dashboard` — `?view=standup` stopped resolving and
 * fell back to Stats. The API speaks view tokens; the router speaks paths.
 */
const VIEW_TOKENS: ReadonlySet<string> = new Set<DashboardView>([
	"stats",
	"standup",
	"repositories",
	"memories",
	"knowledge",
	"graph",
	"settings",
]);

/**
 * New destinations that redirect to Repositories when nothing is enabled yet
 * — mirrors the mockup's nav gating ("nothing for any of them to read" before
 * a repo is set up). `/repositories` is deliberately absent — it is the row
 * that opens the gate, so it must stay reachable with zero repos.
 */
const GATED_PATHS = new Set(["/dashboard", "/dashboard/standup", "/memories"]);

/**
 * Creates (but does not start) the server. Exported separately from
 * {@link startDashboardServer} so tests can drive it on port 0 with an
 * injected model builder and no real database.
 */
export function createDashboardServer(options: DashboardServerOptions): Server {
	const now = options.now ?? Date.now;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const configDir = options.configDir;
	const serverCwd = options.serverCwd ?? process.cwd();
	const token = options.token ?? randomBytes(32).toString("hex");
	let assetsDir: string | undefined;
	/** Lazily-resolved knowledge-graph viz assets (`<dist>/graph-assets/`) — reused by both iframe routes. */
	let graphAssetsDir: string | undefined;
	let lastRequestMs = now();
	/** The idle poll, armed on `listening` and cleared on `close`. See `armIdlePoll`. */
	let idlePoll: ReturnType<typeof setInterval> | undefined;
	let boundPort = options.port;
	/** Lives as long as this server; see {@link IdentityCache}. */
	const identityCache: IdentityCache = new Map();
	// Serialises the one browser-reachable LLM-spending action (Settings →
	// Generate Missing Summaries). Its only progress signal is page-side
	// `state.busy`, which a refresh or a second tab drops — so without this a
	// re-click would run a SECOND backfill over the same commits concurrently,
	// paying for every summary twice. Process-scoped: it guards this server, not
	// a separate CLI `jolli backfill` (those still serialise on the orphan lock).
	let generateMissingInFlight = false;
	const buildModel =
		options.buildModel ??
		((request: ModelRequest) =>
			defaultModelBuilder(request, configDir, options.dbPath, identityCache, now, serverCwd));

	const server = createServer(async (req, res) => {
		lastRequestMs = now();
		try {
			await handle(req, res);
		} catch (err) {
			log.error("request failed: %s", errMsg(err));
			if (!res.headersSent) sendText(res, 500, "Internal error");
			else res.end();
		}
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);

		// Layer 1+2: Host allowlist and origin policy apply to every route.
		if (!isAllowedHost(req.headers.host, boundPort)) {
			sendText(res, 403, "Forbidden");
			return;
		}
		if (hasForeignOrigin(req.headers.origin, boundPort)) {
			sendText(res, 403, "Forbidden");
			return;
		}

		// Layer 2b: no framing, ever. The Origin check above cannot see a
		// clickjack: a cross-site page that FRAMES this server issues same-origin
		// requests from inside the frame, Origin and all, and the port is one of two
		// hard-coded candidates so it is guessable. One tricked click on an overlaid
		// frame was enough to POST /api/repos/disable with the page's own mutation
		// token. `frame-ancestors` is the modern rule; X-Frame-Options covers the
		// clients that predate it. Set on EVERY response, not just the HTML — an
		// api response rendered in a frame is equally usable as a probe.
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");

		// The telemetry beacon is deliberately handled BEFORE `handlePost`'s
		// mutation-token gate. The token is inlined only into the write-surface
		// pages (Repositories/Settings), so a token-gated beacon would silently
		// drop every event fired from the stats/memories pages. It is safe to
		// leave ungated: the host-allowlist + Origin + `frame-ancestors` checks
		// above already reject cross-site callers, and the payload is content-free
		// and non-mutating. `handleTelemetry` never rejects a beacon (always 204).
		if (req.method === "POST" && url.pathname === "/api/telemetry") {
			await handleTelemetry(req, res);
			return;
		}
		if (req.method === "POST") {
			await handlePost(req, res, url);
			return;
		}
		if (req.method !== "GET") {
			sendText(res, 405, "Method not allowed");
			return;
		}

		// The GETs that exist only to feed a mutation — token-gated on the same
		// terms as the POSTs (see the module header's layer 3).
		if (url.pathname === "/api/repo-probe") {
			if (!hasValidToken(req, token)) {
				sendText(res, 403, "Forbidden");
				return;
			}
			const path = url.searchParams.get("path");
			if (!path) {
				sendJson(res, 400, { error: "path is required" });
				return;
			}
			sendJson(res, 200, await probeRepo(path, configDir));
			return;
		}
		// Settings → Memory Bank: advisory existence/writability check for the typed
		// Folder Path (blur feedback). Never mutates — creation is a deliberate act
		// the user does themselves; this only reports a verdict.
		if (url.pathname === "/api/settings/check-folder") {
			if (!hasValidToken(req, token)) {
				sendText(res, 403, "Forbidden");
				return;
			}
			sendJson(res, 200, { status: await checkLocalFolder(url.searchParams.get("path") ?? "") });
			return;
		}
		if (url.pathname === "/health") {
			sendJson(res, 200, {
				ok: true,
				pid: process.pid,
				port: boundPort,
				schemaVersion: DASHBOARD_SCHEMA_VERSION,
			});
			return;
		}

		if (url.pathname === "/") {
			// Repositories is the landing page until something is enabled; once it
			// is, land on the Dashboard. Built as `repositories`, NOT `stats`:
			// `repos` is on every model, while the stats view additionally runs
			// the whole stats query set and can fire a DecisionGist LLM call — so
			// merely opening the base URL by hand used to spend model budget on a
			// redirect. Same gate as the destination pages below, one model each.
			// `skipReachability` because only `repos.length` is read here: the
			// per-repo git fan-out the `repositories` view otherwise pays for would
			// buy a memory badge this response throws away, and the page it
			// redirects to computes it again anyway.
			const model = await buildModel({
				view: "repositories",
				scope: parseScope(url),
				...parseWindow(url),
				skipReachability: true,
			});
			res.writeHead(302, { Location: model.repos.length === 0 ? "/repositories" : "/dashboard" });
			res.end();
			return;
		}

		// The retired Decisions page — its content moved into Memories, so the
		// redirect lands somewhere meaningful and is kept indefinitely.
		if (url.pathname === "/decisions") {
			res.writeHead(302, { Location: "/memories" });
			res.end();
			return;
		}

		const pageView = VIEW_PATHS[url.pathname];
		if (pageView) {
			// A page render is a top-level navigation the user can see, and it is
			// what the product call ("opening the URL by hand just works") is about
			// — so no token here. A cross-site `<img src="…/stats">` reaches this
			// route too, though, and only Fetch-Metadata can tell the two apart.
			const model = await buildModel({
				view: pageView,
				scope: parseScope(url),
				...parseWindow(url),
				allowModelSpend: !isCrossSiteRequest(req),
			});
			if (GATED_PATHS.has(url.pathname) && model.repos.length === 0) {
				res.writeHead(302, { Location: "/repositories" });
				res.end();
				return;
			}
			assetsDir ??= options.assetsDir ?? resolveDashboardAssetsDir();
			const html = assembleDashboardHtml(assetsDir, JSON.stringify(model), token);
			res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
			res.end(html);
			return;
		}

		// The Knowledge page's per-file iframe: one wiki markdown rendered by the
		// vendored `marked` into a SANDBOXED self-contained document. A public GET
		// like the pages (no token); the `sandbox="allow-scripts"` attribute on the
		// iframe (front end) is what isolates it — see `buildWikiViewerHtml`.
		if (url.pathname === "/wiki-viewer") {
			const kb = url.searchParams.get("kb");
			const file = url.searchParams.get("file");
			if (!kb || !file) {
				sendText(res, 400, "kb and file are required");
				return;
			}
			if (!WIKI_FILE_PATTERN.test(file)) {
				// Path-traversal guard: only `_index.md` / `topic--<slug>.md` are servable.
				sendText(res, 400, "invalid wiki file");
				return;
			}
			const kbRoot = await resolveKbRoot(configDir, kb);
			const body = kbRoot ? readWikiBody(kbRoot, file) : undefined;
			if (body === undefined) {
				sendViewerHtml(res, 404, viewerMessageHtml("This wiki page could not be found."));
				return;
			}
			// A partially-shipped viz asset tree would throw here; the outer request
			// catch turns that into a 500 (never a crash), same as any page route.
			graphAssetsDir ??= resolveGraphAssetsDir();
			sendViewerHtml(res, 200, buildWikiViewerHtml(graphAssetsDir, body));
			return;
		}

		// The Graph page's iframe: the repo's knowledge graph inlined into the
		// self-contained viz (reusing `GraphExport.buildStandaloneHtml`), served
		// into a `sandbox="allow-scripts"` iframe. Same public-GET + isolation model.
		if (url.pathname === "/graph-viewer") {
			const kb = url.searchParams.get("kb");
			if (!kb) {
				sendText(res, 400, "kb is required");
				return;
			}
			const kbRoot = await resolveKbRoot(configDir, kb);
			if (!kbRoot) {
				sendViewerHtml(res, 404, viewerMessageHtml("This repository could not be found."));
				return;
			}
			const graphJson = readGraphJson(kbRoot);
			if (graphJson === undefined) {
				// A friendly 200 so the iframe shows guidance rather than a browser error.
				sendViewerHtml(
					res,
					200,
					viewerMessageHtml('No knowledge graph yet — run "jolli compile" in this repo.'),
				);
				return;
			}
			graphAssetsDir ??= resolveGraphAssetsDir();
			// The Graph page is just this iframe: build the viz with an in-header repo
			// switcher (self-navigating) and, for light, the injected `--vscode-*`
			// palette the viz needs (dark-only otherwise). See GraphViewerDocument.
			const graphRepos = (await buildGraphModel(configDir)).repos.filter((r) => r.graphAvailable);
			sendViewerHtml(
				res,
				200,
				buildGraphViewerDocument(graphAssetsDir, graphJson, {
					kb,
					repos: graphRepos,
					light: url.searchParams.get("theme") === "light",
				}),
			);
			return;
		}

		// The staleness poll behind the graph view's refresh. Its own route rather
		// than a flag on /api/model precisely so it can never accidentally return
		// the payload it exists to avoid sending.
		if (url.pathname === "/api/model") {
			const requested = url.searchParams.get("view") ?? "";
			const view: DashboardView = VIEW_TOKENS.has(requested) ? (requested as DashboardView) : "stats";
			const trusted = hasValidToken(req, token) && !isCrossSiteRequest(req);
			// The settings view is the one payload here that carries key-derived
			// material (masked API keys, sign-in state, the Memory Bank folder path),
			// so unlike every other view it is NOT a free public read: serve it only
			// to our own token-bearing, same-site page (JD.getJson always sends the
			// token). A token-free or cross-site caller gets 403 rather than the
			// masked keys — see the module header's layer 3.
			if (view === "settings" && !trusted) {
				sendText(res, 403, "Forbidden");
				return;
			}
			// Otherwise the route stays open as layer 3 promises; the token only
			// decides whether the answer may cost money — see `ModelRequest.allowModelSpend`.
			sendJson(
				res,
				200,
				await buildModel({
					view,
					scope: parseScope(url),
					...parseWindow(url),
					allowModelSpend: trusted,
				}),
			);
			return;
		}

		// One page of the Memories tree, behind that page's "Load more" button.
		// Same reasoning as `/api/context` below — the model is inlined into the
		// page HTML, so only the first page can ride there, and the rest is
		// fetched when the reader asks for it. A read like every other GET here:
		// no token, and a cursor naming a memory that no longer exists restarts
		// from the top rather than erroring.
		if (url.pathname === "/api/memories") {
			// Both halves or neither: a hash without the repo it belongs to cannot
			// identify a row in an all-repos scope, and silently paging from the top
			// would look like a working "Load more" that repeats the first page.
			const afterRepo = url.searchParams.get("afterRepo");
			const afterHash = url.searchParams.get("afterHash");
			if (!afterRepo !== !afterHash) {
				sendJson(res, 400, { error: "afterRepo and afterHash must be given together" });
				return;
			}
			const cursor = afterRepo && afterHash ? { repoIdentity: afterRepo, commitHash: afterHash } : undefined;
			const scope = parseScope(url);
			try {
				// Recomputed per page rather than cached with the page's first
				// render: reachability is what decides which rows exist at all, so
				// a stale set would page over memories a rebase already removed.
				const page = await withReadonlyDashboardDb(
					async (db) => {
						const reachable = await readReachableCommitsByRepo(
							db
								.prepare("SELECT repo_identity, worktree_root FROM repos WHERE disabled_at IS NULL")
								.all() as ReadonlyArray<{ repo_identity: string; worktree_root: string }>,
						);
						return buildMemoriesPage(db, scope, cursor, reachable);
					},
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				sendJson(res, 200, page);
			} catch (err) {
				log.warn("memories page read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that page of memories" });
			}
			return;
		}

		// One plan/note body, for the Memories page's Context dialog. Deliberately
		// NOT folded into the memory detail payload: a memory can carry many
		// documents and each is a full markdown file, so shipping them all with
		// every detail render would multiply the page's size for content the user
		// usually never opens. A read like every other GET here — no token.
		if (url.pathname === "/api/context") {
			const repo = url.searchParams.get("repo") ?? "";
			const kindParam = url.searchParams.get("kind") ?? "";
			const key = url.searchParams.get("key") ?? "";
			const kind = CONTEXT_DOC_KINDS.find((k) => k === kindParam);
			if (!repo || !key || !kind) {
				sendJson(res, 400, { error: `repo, kind (${CONTEXT_DOC_KINDS.join("|")}) and key are required` });
				return;
			}
			try {
				const doc = await withReadonlyDashboardDb((db) => readContextDoc(db, repo, kind, key), {
					...(options.dbPath ? { dbPath: options.dbPath } : {}),
				});
				if (!doc) {
					sendJson(res, 404, { error: "not found" });
					return;
				}
				sendJson(res, 200, doc);
			} catch (err) {
				// Same rule as the other read routes: log the detail, tell the client
				// only that the read failed.
				log.warn("context read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that document" });
			}
			return;
		}

		// Settings → Sync to Jolli: the machine-wide per-repo push list. A read like
		// every other GET here (no token). `currentCwd` only marks the launch repo's
		// row and is not what determines the list contents.
		if (url.pathname === "/api/settings/push-repos") {
			try {
				const config = await loadConfigFromDir(configDir ?? getGlobalConfigDir());
				const repos = await listPushControlRepos({
					...(config.localFolder ? { localFolder: config.localFolder } : {}),
					currentCwd: serverCwd,
				});
				sendJson(res, 200, { repos });
			} catch (err) {
				log.warn("push-repos read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not list repositories" });
			}
			return;
		}

		// Settings → Memory Bank: the slow missing-summaries count, on its own
		// endpoint so it never blocks the page's first paint. `null` (not a project)
		// becomes a 200 with `{ missing: null }` so the page cleanly renders no line.
		if (url.pathname === "/api/settings/missing-summaries") {
			try {
				const count = await countMissingForCwd(serverCwd);
				sendJson(res, 200, count ?? { missing: null });
			} catch (err) {
				log.warn("missing-summaries count failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not count missing summaries" });
			}
			return;
		}

		sendText(res, 404, "Not found");
	}

	/**
	 * Every mutating route. Token-checked up front — a wrong or missing token
	 * 403s before any POST body is even read, and before any of `install`/
	 * `registerRepo`/`uninstall` touch the filesystem.
	 */
	async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (!hasValidToken(req, token)) {
			sendText(res, 403, "Forbidden");
			return;
		}
		let body: unknown;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			// Same rule as /api/browse: echo only our own message. A JSON parse or
			// socket error quotes body bytes and internal detail.
			if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: err.message });
			else {
				log.warn("request body unreadable: %s", errMsg(err));
				sendJson(res, 400, { error: "invalid JSON body" });
			}
			return;
		}
		if (typeof body !== "object" || body === null) {
			sendJson(res, 400, { error: "expected a JSON object body" });
			return;
		}
		const b = body as Record<string, unknown>;

		if (url.pathname === "/api/repos/enable") {
			await handleEnable(res, b);
			return;
		}
		if (url.pathname === "/api/repos/disable") {
			await handleDisable(res, b);
			return;
		}
		if (url.pathname === "/api/repos/resume") {
			await handleResume(res, b);
			return;
		}
		if (url.pathname === "/api/hooks/reinstall") {
			await handleHooksReinstall(res, b);
			return;
		}
		if (url.pathname === "/api/settings/apply") {
			await handleSettingsApply(res, b);
			return;
		}
		if (url.pathname === "/api/settings/set-push") {
			await handleSetPush(res, b);
			return;
		}
		if (url.pathname === "/api/settings/signin") {
			await handleSignIn(res);
			return;
		}
		if (url.pathname === "/api/settings/signout") {
			await handleSignOut(res);
			return;
		}
		if (url.pathname === "/api/settings/generate-missing") {
			await handleGenerateMissing(res);
			return;
		}
		if (url.pathname === "/api/settings/probe-local-agent") {
			await handleProbeLocalAgent(res, b);
			return;
		}
		if (url.pathname === "/api/settings/migrate") {
			await handleMigrate(res);
			return;
		}
		if (url.pathname === "/api/settings/sync-now") {
			await handleSyncNow(res);
			return;
		}
		sendText(res, 404, "Not found");
	}

	/** Settings → Apply Changes: persist config + reconcile hook/global-instructions side effects. */
	async function handleSettingsApply(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		let input: ReturnType<typeof parseSettingsApplyInput>;
		try {
			input = parseSettingsApplyInput(body);
		} catch (err) {
			if (err instanceof SettingsValidationError) {
				sendJson(res, 400, { error: err.message });
				return;
			}
			throw err;
		}
		try {
			const result = await applySettings(input, configDir ?? getGlobalConfigDir());
			sendJson(res, 200, { ok: true, hookFailures: result.hookFailures });
		} catch (err) {
			if (err instanceof SettingsValidationError) {
				sendJson(res, 400, { error: err.message });
				return;
			}
			log.warn("settings apply failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not save settings" });
		}
	}

	/** Settings → Sync to Jolli: toggle one repo's outbound push. Applies immediately. */
	async function handleSetPush(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const repoIdentity = typeof body.repoIdentity === "string" ? body.repoIdentity : undefined;
		if (!repoIdentity) {
			sendJson(res, 400, { error: "repoIdentity is required" });
			return;
		}
		if (typeof body.disabled !== "boolean") {
			sendJson(res, 400, { error: "disabled (boolean) is required" });
			return;
		}
		try {
			const result = await setRepoPushDisabledByIdentity(repoIdentity, body.disabled, "cli");
			// Re-enabling the repo we're in kicks off its retained-backlog drain now.
			if (!body.disabled && body.isCurrentRepo === true) triggerReenableDrain(serverCwd);
			sendJson(res, 200, {
				ok: true,
				disabled: result.disabled,
				// The store had to be rebuilt from empty — other repos' opt-outs were
				// dropped. The page MUST surface this (see PushControlStore docstring).
				...(result.recoveredFromCorrupt ? { recoveredFromCorrupt: true } : {}),
			});
		} catch (err) {
			log.warn("set-push failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not change push setting" });
		}
	}

	/**
	 * Settings → Sign In. Reuses `browserLogin` verbatim — the same loopback-callback
	 * OAuth flow `jolli auth login` runs — so there is no new callback route and no
	 * backend dependency. It opens its own browser tab and resolves when the callback
	 * lands; capped so a never-completed login does not hang the request forever.
	 */
	/* v8 ignore start -- opens a real browser and blocks on the OAuth callback; the
	   underlying browserLogin is covered by cli/src/auth/Login.test.ts. */
	async function handleSignIn(res: ServerResponse): Promise<void> {
		try {
			await withTimeout(browserLogin(getJolliUrl()), SIGNIN_TIMEOUT_MS, "sign-in timed out — please try again");
			sendJson(res, 200, { ok: true });
		} catch (err) {
			log.warn("sign-in failed: %s", errMsg(err));
			sendJson(res, 400, { error: errMsg(err) });
		}
	}
	/* v8 ignore stop */

	/* v8 ignore start -- mutates the machine-global auth config; clearAuthCredentials
	   is covered by cli/src/auth/AuthConfig.test.ts. */
	/** Settings → Sign Out. Same as `jolli auth logout` (clears authToken + jolliApiKey). */
	async function handleSignOut(res: ServerResponse): Promise<void> {
		try {
			await clearAuthCredentials();
			sendJson(res, 200, { ok: true });
		} catch (err) {
			log.warn("sign-out failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not sign out" });
		}
	}
	/* v8 ignore stop */

	/** Settings → Generate Missing Summaries: backfill the launch repo's un-summarized commits. */
	async function handleGenerateMissing(res: ServerResponse): Promise<void> {
		let repoRoot: string;
		try {
			repoRoot = await getProjectRootDir(serverCwd);
		} catch {
			sendJson(res, 400, { error: "the dashboard was not started inside a git repository" });
			return;
		}
		// One backfill at a time per server — a second concurrent run (a refresh or a
		// second tab drops the page-side busy flag) would re-summarize the same
		// commits and pay for every summary twice. See `generateMissingInFlight`.
		/* v8 ignore start -- concurrency guard: a second in-flight backfill is not
		   deterministically reproducible in a unit test (the empty-repo backfill the
		   endpoint test uses returns before a second request could observe the flag).
		   Exercised in production by a refresh / second-tab re-click. */
		if (generateMissingInFlight) {
			sendJson(res, 409, { error: "a summary generation is already running — wait for it to finish" });
			return;
		}
		/* v8 ignore stop */
		generateMissingInFlight = true;
		try {
			const { runBackfill, recentCommitHashes } = await import("../backfill/BackfillEngine.js");
			const hashes = await recentCommitHashes(repoRoot);
			const report = await runBackfill({ cwd: repoRoot, hashes });
			sendJson(res, 200, { ok: true, generated: report.generated, errors: report.errors, total: report.total });
		} catch (err) {
			log.warn("generate-missing failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not generate summaries" });
		} finally {
			generateMissingInFlight = false;
		}
	}

	/** Settings → AI Summary: probe whether a local-agent CLI is usable (spawns `--version`). */
	async function handleProbeLocalAgent(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const tool = typeof body.tool === "string" ? (body.tool as LocalAgentToolId) : undefined;
		if (!tool) {
			sendJson(res, 400, { error: "tool is required" });
			return;
		}
		try {
			const usable = await isLocalAgentUsable(tool);
			sendJson(res, 200, { ok: true, usable });
		} catch (err) {
			log.warn("probe-local-agent failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not probe the local agent" });
		}
	}

	/** Settings → Memory Bank → Migrate: re-migrate the launch repo into a fresh folder. */
	async function handleMigrate(res: ServerResponse): Promise<void> {
		try {
			const { rebuildMemoryBank } = await import("../core/MemoryBankRebuild.js");
			const result = await rebuildMemoryBank(serverCwd);
			// A successful OR partial migrate archived the old folder and re-migrated
			// into the freed base slot WITHOUT changing `localFolder`, so the memoised
			// launch-repo state (keyed on (launchCwd, localFolder)) is now stale. Drop
			// it unconditionally — cache invalidation is the host's job by
			// MemoryBankRebuild's contract, and it is harmless on the "no memories"
			// early-out (which changed nothing).
			clearLaunchRepoStateCache();
			// On failure the client's JD.post reads `error`, so surface the reason
			// there (not just `message`) or it renders as "request failed (400)".
			if (result.ok) sendJson(res, 200, result);
			else sendJson(res, 400, { error: result.message, ...result });
		} catch (err) {
			log.warn("migrate failed: %s", errMsg(err));
			sendJson(res, 500, { ok: false, message: "could not migrate the Memory Bank" });
		}
	}

	/* v8 ignore start -- performs a real network sync to Personal Space via the
	   shared runSync (covered by cli/src/commands/SyncCommand.test.ts); not safe to
	   drive against the real account in a unit test. */
	/** Settings → Memory Bank → Sync Now: one manual push of the Memory Bank to Personal Space. */
	async function handleSyncNow(res: ServerResponse): Promise<void> {
		try {
			const { runSync } = await import("../commands/SyncCommand.js");
			const code = await runSync({ cwd: serverCwd });
			if (code === 0) sendJson(res, 200, { ok: true });
			else sendJson(res, 400, { error: "sync did not complete — check that you are signed in to Jolli" });
		} catch (err) {
			log.warn("sync-now failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not sync the Memory Bank" });
		}
	}
	/* v8 ignore stop */

	async function handleEnable(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const path = typeof body.path === "string" ? body.path : undefined;
		if (!path) {
			sendJson(res, 400, { error: "path is required" });
			return;
		}
		let worktreeRoot: string;
		try {
			worktreeRoot = await getProjectRootDir(path);
		} catch {
			sendJson(res, 400, { error: "path is not a git repository" });
			return;
		}
		// clearManualDisableOnSuccess: enabling from this page is the same decision
		// as `jolli enable`, so it has to clear a prior `userDisabled` opt-out —
		// otherwise a repo the user once paused installs its hooks, registers, and
		// reports success while every commit still skips capture.
		const installResult = await install(worktreeRoot, { source: "cli", clearManualDisableOnSuccess: true });
		if (!installResult.success) {
			sendJson(res, 500, { error: installResult.message });
			return;
		}
		const repo = await registerRepo({ cwd: worktreeRoot, configDir });
		const warning = await projectRegistryEntry(repo.repoIdentity);
		sendJson(res, 200, { ok: true, repoIdentity: repo.repoIdentity, ...(warning ? { warning } : {}) });
	}

	/**
	 * Projects a registry mutation into the `repos` table — the step `jolli enable`
	 * gets for free from the backfill it runs and a long-lived server does not.
	 *
	 * Every read surface filters on `repos.disabled_at IS NULL`, and this server
	 * never re-backfills (its only timer is the idle-shutdown poll), so an
	 * unprojected write stays invisible until the next `jolli dashboard`: a repo
	 * added from this page has no row, so every gated route 302s and the button
	 * appears to do nothing, while a paused one keeps counting in every KPI.
	 *
	 * Re-reads the registry rather than taking the caller's entry: `registerRepo` /
	 * `deregisterRepo` are the writers, and what has to be projected is the state
	 * they LANDED (registerRepo clears `disabledAt`, deregisterRepo stamps it).
	 *
	 * The ONE write this process makes to the database, and it stays inside the
	 * "never migrates" rule at the top of this file: a writable open runs pending
	 * migrations, and this is the one long-lived process whose build can lag behind
	 * the CLI that spawned it. So the schema version is read read-only first and the
	 * projection is skipped unless the file is already at this build's version —
	 * an older schema means the caller is the wrong process to upgrade it, and the
	 * `jolli dashboard` that migrates will project on the way through.
	 *
	 * Returns a warning string instead of throwing. The install/uninstall it
	 * follows has already succeeded, so answering 500 would report a rollback that
	 * did not happen; the caller passes this through so the page can say the row
	 * may need a restart to appear.
	 */
	async function projectRegistryEntry(repoIdentity: string): Promise<string | undefined> {
		const staleList = "the repository list may be out of date until the next `jolli dashboard` run";
		try {
			const registry = await readRepoRegistry(configDir);
			const entry = registry.repos.find((r) => r.repoIdentity === repoIdentity);
			if (!entry) return undefined;
			const dbOpts = options.dbPath ? { dbPath: options.dbPath } : {};
			const found = await withReadonlyDashboardDb(readSchemaVersion, dbOpts);
			if (found !== DASHBOARD_SCHEMA_VERSION) {
				log.info(
					"skipping registry projection: database schema v%d != this build's v%d",
					found,
					DASHBOARD_SCHEMA_VERSION,
				);
				return staleList;
			}
			await withDashboardDb((db) => projectRepoRegistryState(db, entry), dbOpts);
			return undefined;
		} catch (err) {
			log.warn("could not project registry state for %s: %s", repoIdentity, errMsg(err));
			return staleList;
		}
	}

	async function resolveRegisteredRepo(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<{ repoIdentity: string; worktreeRoot: string; roots: ReadonlyArray<string> } | undefined> {
		const repoIdentity = typeof body.repoIdentity === "string" ? body.repoIdentity : undefined;
		if (!repoIdentity) {
			sendJson(res, 400, { error: "repoIdentity is required" });
			return undefined;
		}
		const registry = await readRepoRegistry(configDir);
		const entry = registry.repos.find((r) => r.repoIdentity === repoIdentity);
		if (!entry) {
			sendJson(res, 404, { error: "no repository with that identity is registered" });
			return undefined;
		}
		// EVERY surviving checkout, not just `worktreeRoot`. A registry entry is
		// keyed by repo IDENTITY, so a second clone of the same remote shares this
		// row and the page's one "paused" badge speaks for both — while hooks and
		// the `userDisabled` flag are per-clone (`RepoProfile` anchors the profile
		// to a clone's git-common-dir). Acting on the recorded root alone left the
		// other clone capturing every commit under a badge that said paused.
		return { repoIdentity, worktreeRoot: entry.worktreeRoot, roots: existingWorktrees(entry) };
	}

	async function handleDisable(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const target = await resolveRegisteredRepo(res, body);
		if (!target) return;
		for (const root of target.roots) {
			const result = await uninstall(root, { preserveMenu: true, persistManualDisable: true });
			if (!result.success) {
				sendJson(res, 500, { error: result.message });
				return;
			}
		}
		await deregisterRepo({ cwd: target.worktreeRoot, configDir });
		const warning = await projectRegistryEntry(target.repoIdentity);
		sendJson(res, 200, { ok: true, ...(warning ? { warning } : {}) });
	}

	async function handleResume(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const target = await resolveRegisteredRepo(res, body);
		if (!target) return;
		// clearManualDisableOnSuccess is what makes resume actually resume: pausing
		// from this page goes through `uninstall(persistManualDisable: true)`, which
		// writes `userDisabled: true`, and that flag alone stops capture even with
		// every hook back in place. Reinstalling without clearing it returns ok and
		// changes nothing observable.
		//
		// Per checkout, mirroring the pause: the flag it clears is per-clone, so a
		// resume that visited only one root would leave the other one flagged and
		// silent.
		for (const root of target.roots) {
			const result = await install(root, { source: "cli", clearManualDisableOnSuccess: true });
			if (!result.success) {
				sendJson(res, 500, { error: result.message });
				return;
			}
		}
		// registerRepo clears disabledAt on an existing entry — the same
		// "re-registering is re-enabling" behaviour `jolli enable` relies on.
		await registerRepo({ cwd: target.worktreeRoot, configDir });
		const warning = await projectRegistryEntry(target.repoIdentity);
		sendJson(res, 200, { ok: true, ...(warning ? { warning } : {}) });
	}

	async function handleHooksReinstall(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const target = await resolveRegisteredRepo(res, body);
		if (!target) return;
		// Deliberately WITHOUT clearManualDisableOnSuccess, unlike enable/resume:
		// this repairs hooks on a repo the user has not asked to un-pause, so it
		// must leave their opt-out exactly as it found it. That flag is the ONLY
		// difference from enable — in particular NOT `repoHooksOnly`, which reads
		// like "just the hooks, please" and is in fact the plugin-bootstrap mode:
		// it is host-parameterized by the source tag, `pluginBootstrapHost` maps an
		// unmapped tag (`"cli"`, ours) to `"claude"`, and the Claude branch runs
		// `removeClaudeLegacySkills` — so this button deleted the repo's
		// `.claude/skills/jolli-*`, which skill-revision gating then stops
		// `jolli enable` from restoring.
		//
		// Every checkout, like pause/resume: hooks live in each clone's own
		// `.git/hooks`, and this row's button speaks for the whole identity.
		for (const root of target.roots) {
			const result = await install(root, { source: "cli" });
			if (!result.success) {
				sendJson(res, 500, { error: result.message });
				return;
			}
		}
		sendJson(res, 200, { ok: true });
	}

	server.on("listening", () => {
		const addr = server.address();
		/* v8 ignore next -- address() is always AddressInfo once listening */
		boundPort = typeof addr === "object" && addr ? addr.port : boundPort;
		// The idle clock starts when we begin SERVING, not when the object was
		// constructed — `startDashboardServer` builds one server per candidate
		// port and the losers can sit around for a while before the winner binds.
		lastRequestMs = now();
		armIdlePoll();
	});

	// Idle shutdown: poll rather than re-arm a timer per request — requests are
	// bursty and the poll is cheap. unref'd so it never keeps the process alive
	// by itself.
	//
	// Armed from the `listening` handler, NOT here. `startDashboardServer` walks
	// the candidate ports by constructing a server per port and discarding the
	// ones that hit EADDRINUSE; a timer armed at construction outlives that
	// discard (nothing clears it, and `close()` on a server that never listened
	// still invokes its callback), so the loser's frozen `lastRequestMs` would
	// fire the shutdown hours later and take down the HEALTHY server sharing the
	// process — `unref` does not help, because the live server keeps the loop
	// alive. Arming on `listening` means a server that never bound never arms.
	function armIdlePoll(): void {
		if (idleTimeoutMs <= 0 || idlePoll) return;
		idlePoll = setInterval(() => {
			if (now() - lastRequestMs >= idleTimeoutMs) {
				log.info("idle for %d ms — shutting down", idleTimeoutMs);
				disarmIdlePoll();
				server.closeAllConnections();
				server.close(() => options.onIdleShutdown?.());
			}
		}, 60_000);
		idlePoll.unref();
	}

	function disarmIdlePoll(): void {
		if (!idlePoll) return;
		clearInterval(idlePoll);
		idlePoll = undefined;
	}

	// A server closed by any route (idle, signal, a failed bind after listening)
	// must not leave the poll behind.
	server.on("close", disarmIdlePoll);

	return server;
}

export interface StartedDashboardServer {
	readonly server: Server;
	readonly port: number;
}

/**
 * Starts the server on the first available preferred port, falling back to an
 * OS-assigned one, and persists `dashboard.json` so launchers can find it.
 */
export async function startDashboardServer(
	options: Omit<DashboardServerOptions, "port"> & { readonly port?: number; readonly configDir?: string },
): Promise<StartedDashboardServer> {
	const candidates = options.port !== undefined ? [options.port] : [...DASHBOARD_PORTS, 0];
	let lastError: Error | null = null;
	for (const candidate of candidates) {
		const server = createDashboardServer({ ...options, port: candidate });
		try {
			const port = await new Promise<number>((resolve, reject) => {
				// Bind-phase listener only. Leaving it attached would swallow every
				// LATER error: rejecting a settled promise is a no-op, yet the
				// listener's presence stops Node from throwing, so the error would
				// vanish entirely. Hand off to a logging listener once listening.
				const onBindError = (err: Error): void => reject(err);
				server.once("error", onBindError);
				server.listen(candidate, "127.0.0.1", () => {
					server.off("error", onBindError);
					server.on("error", (err) => log.warn("dashboard server error: %s", err.message));
					const addr = server.address();
					/* v8 ignore next -- address() is always AddressInfo once listening */
					resolve(typeof addr === "object" && addr ? addr.port : candidate);
				});
			});
			await writeDashboardState(
				{
					pid: process.pid,
					port,
					startedAt: new Date((options.now ?? Date.now)()).toISOString(),
					schemaVersion: DASHBOARD_SCHEMA_VERSION,
				},
				options.configDir,
			);
			log.info("dashboard listening on 127.0.0.1:%d", port);
			// No snapshot trigger here — the backup schedule's "dashboard start"
			// half lives in `executeDashboard` (the command process). This process
			// must stay read-only: `opportunisticSnapshot` opens a WRITABLE handle,
			// which runs schema migrations, and this is the one long-lived process
			// whose build can lag (a launcher only probes the recorded pid's
			// `/health`, never its version). See the module header's first claim.
			return { server, port };
		} catch (err) {
			// `close()` is what releases the loser's idle poll (createDashboardServer
			// disarms on the 'close' event). A discarded server that kept its poll
			// would later shut down the winner, which shares this process.
			server.close();
			lastError = err instanceof Error ? err : new Error(String(err));
			// EADDRINUSE on a preferred port → try the next candidate.
		}
	}
	/* v8 ignore next 2 -- candidates always ends with port 0, which cannot collide */
	throw lastError ?? new Error("could not bind the dashboard server");
}
