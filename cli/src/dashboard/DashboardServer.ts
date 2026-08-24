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
 * both directions).
 *
 * That write used to stand down unless the file was already at this build's
 * schema version, because the server was a DETACHED process a launcher would
 * reuse after probing `/health` — the one long-lived process whose build could
 * lag behind the CLI that spawned it. `jolli dashboard` now serves in its own
 * command process, so server build ≡ CLI build and that gate is gone. The
 * read-only open per render stays, for two reasons that never depended on the
 * daemon: WAL's one-writer/N-readers split, and the SQLite-enforced guarantee
 * that a browser-reachable process cannot write through a render path.
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
 *   4. `Sec-Fetch-Site` names the initiator, which layers 1+2 cannot: they do
 *      not stop a hostile tab from ISSUING a GET (a `no-cors` request carries
 *      no `Origin` to reject and a loopback `Host` to accept), only from
 *      reading the reply. It is one half of `trusted` on `/api/model`, which
 *      is what keeps the settings view's masked keys behind our own page.
 *      An absent header is trusted as `curl` — a local process on the user's
 *      own machine.
 *
 *      No GET on this server spends money any more. It used to: the Stats
 *      payload fired a display-time LLM call to compress the Decisions card's
 *      text, which is why this layer also carried an `allowModelSpend` gate.
 *      The card now shows a stored topic title and the call is retired
 *      (JOLLI-2209), so that gate is gone. Anything reintroducing a paid path
 *      on a GET needs it back — cross-site reachability here is unchanged.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { clearAuthCredentials, getJolliUrl } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { getProjectRootDir, readLocalGitIdentity } from "../core/GitOps.js";
import { escapeForInlineScript } from "../core/InlineScript.js";
import { isLocalAgentUsable } from "../core/localagent/DetectAgents.js";
import { listPushControlRepos, setRepoPushDisabledByIdentity, triggerReenableDrain } from "../core/PushControl.js";
import { NEUTRAL_SOURCE_COLOR, SOURCE_META } from "../core/references/SourceLabels.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import { trackAs } from "../core/Telemetry.js";
import { isTelemetryEventName, type TelemetryEventName } from "../core/TelemetryEvents.js";
import { TRANSCRIPT_SOURCE_LABELS } from "../core/TranscriptSourceLabel.js";
import { getAggregateWikiFreshness } from "../core/WikiFreshness.js";
import { resolveAssetsDir as resolveGraphAssetsDir } from "../graph/GraphExport.js";
import { install } from "../install/Installer.js";
import { createLogger, errMsg } from "../Logger.js";
import type { LocalAgentToolId } from "../Types.js";
import {
	ensureDashboardDbExists,
	getDashboardDbPath,
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
	TOOL_ROWS_LIMIT,
	type ToolUsageList,
} from "./DashboardModel.js";
import {
	buildDashboardModel,
	buildMcpServerDetail,
	buildSkillDetail,
	buildToolUsagePage,
	clearWorktreeExistenceCache,
	JOURNEYS_DEFAULT_RANGE,
	MAX_CUSTOM_DAYS,
	type QueryOptions,
	resolveWindow,
	STANDUP_MAX_OFFSET,
} from "./DashboardQuery.js";
import { projectRepoRegistryState } from "./DbBackfill.js";
import { buildGraphViewerDocument } from "./GraphViewerDocument.js";
import { buildJourneyDetail, buildJourneys } from "./JourneysQuery.js";
import {
	buildGraphModel,
	buildKnowledgeModel,
	readGraphJson,
	readWikiBody,
	resolveKbRepo,
	resolveKbRoot,
	WIKI_FILE_PATTERN,
} from "./KnowledgeQuery.js";
import { machineTimeZone } from "./LocalDays.js";
import {
	buildMemoriesPage,
	readContextDoc,
	readConversationEntries,
	readMemoryTranscriptRepairState,
} from "./MemoriesQuery.js";
import { backupRepoRegistry, classifyRegistryEntry, forgetRepo, type RegistryEntryVerdict } from "./RepoForget.js";
import { probeRepo } from "./RepoProbe.js";
import { existingWorktrees, readRepoRegistry, recordedRepoPaths, registerRepo } from "./RepoRegistry.js";
import {
	applySettings,
	checkLocalFolder,
	countMissingForCwd,
	parseSettingsApplyInput,
	SettingsValidationError,
	setSyncSessions,
} from "./SettingsMutations.js";
import { buildSettingsPageModel, clearLaunchRepoStateCache } from "./SettingsPageQuery.js";

const log = createLogger("DashboardServer");

const HERE = dirname(fileURLToPath(import.meta.url));

/** Preferred ports: both verified free of mainstream registered services. */
export const DASHBOARD_PORTS = [1818, 18118] as const;

/**
 * Names this service in the `/health` body, so the next `jolli dashboard` can
 * tell one of ours from anything else answering on the port.
 *
 * Load-bearing rather than cosmetic: the launch path SIGTERMs the pid it reads
 * out of that body, and the shape it would otherwise match on — `{ok: true, pid:
 * number}` — is one of the most common health payloads there is. Requiring the
 * marker is what keeps an unrelated local service from being identified as a
 * dashboard and killed, which matters most under an explicit `--port`, where the
 * user aims the probe at a port a dev server is far more likely to hold.
 *
 * Consumed by `identifyDashboardHealth` in `commands/DashboardCommand.ts`. Both
 * halves must agree on this string, which is why it lives here and is imported
 * there rather than being spelled twice.
 */
export const DASHBOARD_HEALTH_SERVICE = "jolli-dashboard";

// ── Asset assembly ──────────────────────────────────────────────────────────

/**
 * Every script `assembleDashboardHtml` inlines, in load order (shared helpers
 * first, page modules, then `main.js` boots). Exported because three gates
 * depend on the list being one thing: `resolveDashboardAssetsDir` probes for
 * each file, the plugin publish scripts assert each is staged
 * (`PluginDashboardAssets.test.ts`), and `assets/index.html`'s
 * `<!-- scripts:start/end -->` block must declare exactly these, in this order
 * (`DashboardServer.test.ts`).
 *
 * That last gate exists because the template's `<script src>` tags are the one
 * copy of this list that CANNOT fail loudly: the assembler replaces the whole
 * block, so those tags never load anything — a file declared there and omitted
 * here is simply absent from the page, and the first symptom is a TypeError in
 * the browser when `main.js` calls into it. `journeys.js` shipped that way.
 */
export const DASHBOARD_SCRIPT_FILES = [
	"format.js",
	"charts.js",
	"shell.js",
	"stats.js",
	// Needs format/charts/shell above it for `JD.stackedBars`, `JD.seriesColor` and the
	// fetch helpers; nothing in stats.js. Ordered here rather than earlier only to keep
	// the list reading in nav order.
	"skills.js",
	// Same dependencies as skills.js and no dependency ON it: the two pages share their
	// CSS grammar, not their code.
	"mcps.js",
	"standup.js",
	"memories.js",
	"journeys.js",
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
 * the mutation-only credential `JD.post` attaches to every POST it makes
 * (see the module header for why GET stays token-free). Optional so the
 * many existing tests that call this with two arguments are unaffected.
 *
 * `window.__JOLLI_SOURCE_LABELS__` carries `TRANSCRIPT_SOURCE_LABELS` verbatim,
 * so `JD.sourceLabel` names an agent without the page holding a copy of that
 * map. The icons beside those labels DO live in `shell.js` and cannot come from
 * here — they are markup, not a constant — but the names are one `JSON.stringify`
 * away, and a label map that drifts is the cheap half of the same bug. Always
 * inlined (unlike the token): it is a fixed, non-secret table, and a page that
 * skipped it would silently print raw transcript tags.
 *
 * `window.__JOLLI_SOURCE_META__` does the same for REFERENCE sources, and here
 * the whole badge is a constant — letter and brand colour both — so nothing is
 * left behind in the page the way the agent marks are. The neutral fallback
 * rides along in the same object rather than being re-typed client-side, which
 * is what the constant's own docstring asks of every consumer. Without this the
 * page had only the row's KIND to key on, so a Linear ticket, a Jira issue and a
 * Sentry issue all rendered as one identical amber `R` while the editor showed
 * three distinct badges for the same memory.
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
		`<script>window.__JOLLI_SOURCE_LABELS__ = ${escapeForInlineScript(JSON.stringify(TRANSCRIPT_SOURCE_LABELS))};</script>\n` +
		`<script>window.__JOLLI_SOURCE_META__ = ${escapeForInlineScript(
			JSON.stringify({ meta: SOURCE_META, neutral: NEUTRAL_SOURCE_COLOR }),
		)};</script>\n` +
		`<script>window.__JOLLI_DASHBOARD__ = ${escapeForInlineScript(modelJson)};</script>\n` +
		DASHBOARD_SCRIPT_FILES.map((f) => `<script>\n${read("js", f)}\n</script>`).join("\n");
	const marker = /<!-- scripts:start -->[\s\S]*?<!-- scripts:end -->/;
	if (!marker.test(html)) throw new Error("dashboard template missing scripts block");
	return html.replace(marker, () => scripts);
}

// ── Framed viewer documents (Knowledge / Graph iframes) ─────────────────────

/**
 * Minimal readable styling for the framed viewer documents — `/wiki-viewer`,
 * `/context-viewer`, and the plain message document. Each renders in a sandboxed
 * iframe with its own (opaque) origin, so it inherits none of the dashboard
 * theme — hence a self-contained neutral stylesheet.
 *
 * "Inherits none of the theme" is also why it honours an explicit
 * `<html data-theme>`, not just `prefers-color-scheme`. The dashboard's own
 * palette keys on both (`main.css`: `:root[data-theme="dark"]` beside the media
 * query), so a reader who forced light or dark would otherwise get a frame in
 * the opposite scheme. The wiki and graph frames fill a whole pane and mostly
 * got away with that; `/context-viewer` sits INSIDE a themed modal, where a
 * white page in a dark dialog is impossible to miss. The `:where(:not(…))` guard
 * is the same idiom `main.css` uses, so an explicit `light` still wins on a
 * dark-preferring OS. A document that passes no theme keeps the old
 * media-query-only behaviour exactly.
 */
const FRAMED_VIEWER_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px 40px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1d21; background: #fff; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) body { color: #d6dae0; background: #16181c; } }
:root[data-theme="dark"] body { color: #d6dae0; background: #16181c; }
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
 * `</script>` and the U+2028 / U+2029 line separators neutralised.
 */
/**
 * Runs after `marked` renders `#md`. The wiki's links are all repo-relative
 * (`../<branch>/…`) and dead inside this framed viewer, so:
 *
 *   - **Source-commit** links — `../<branch>/<slug>-<hash8>.md` (NO `summary--`
 *     prefix: the visible file `FolderStorage` writes is `<slug>-<hash8>.md`, and
 *     the link's visible label is that 8-char hash) — get their `href` REWRITTEN
 *     to the real target `/memories?hash=…&detailRepo=<token>` (so the browser
 *     status bar previews where a click goes) but still `preventDefault` +
 *     `postMessage` the hash up to the Knowledge page, which performs the actual
 *     navigation. This frame is sandboxed (opaque origin) — a bare `<a>` click
 *     would navigate the FRAME, not the top page — so the anchor cannot be left to
 *     do the jump. `detailRepo` is the repo's SCOPE TOKEN (see `detailRepoToken`:
 *     the dashboard repoIdentity from the remote URL when one exists, else the
 *     display name — NOT the frame's own `?kb=`, a Memory Bank DIRECTORY name that
 *     `resolveScope` cannot scope by), injected by `buildWikiViewerHtml` as
 *     `window.__JOLLI_WIKI_DETAIL_REPO__`. The parent navigates to the SAME
 *     `detailRepo` — both values come from `discoverRepos` for the same `dirName`,
 *     so they normally match exactly (the injected one is read at request time, the
 *     parent's from the page's model, so a mid-session folder rename could
 *     momentarily diverge them — a status-bar-preview cosmetic, not a wrong jump).
 *     Classified as a relative `.md` whose trailing `-<hex>.md` (or link text) is a
 *     commit hash; the hash is read from that trailing group, falling back to text.
 *   - **Related-branch** links — `../<folder>/` — plus the index page's bare
 *     `topic--<slug>.md` links and any other leftover relative link keep their
 *     text but drop the anchor (local dashboard has no branch page, and every
 *     other relative target is a 404 here).
 *   - Absolute / external links are left untouched.
 *
 * Self-contained, no user data — inlined verbatim (unlike `bodyMd`).
 */
export const WIKI_LINK_REWRITE_SCRIPT =
	'(function(){var md=document.getElementById("md");if(!md)return;' +
	// The owning repo's scope token (repoIdentity, or display name when it has no
	// remote), injected by buildWikiViewerHtml — for /memories?detailRepo=. A Memory
	// Bank dir name would not resolve.
	'var repo=window.__JOLLI_WIKI_DETAIL_REPO__||"";' +
	'Array.prototype.forEach.call(md.querySelectorAll("a[href]"),function(a){' +
	'var href=a.getAttribute("href")||"";' +
	"var rel=/^\\.{1,2}\\//.test(href);" +
	"var m=href.match(/-([0-9a-f]{7,40})\\.md$/i);" +
	'var hash=m?m[1]:(a.textContent||"").trim();' +
	// Source-commit link: a relative .md whose trailing -<hex>.md (or visible label)
	// is a commit hash. There is NO "summary--" prefix — the file is <slug>-<hash8>.md.
	"if(rel&&/\\.md$/i.test(href)&&/^[0-9a-f]{7,40}$/i.test(hash)){" +
	// Show the real destination in the status bar; the click still goes through the
	// parent, since a sandboxed <a> would only navigate the frame. The parent
	// navigates to this SAME detailRepo=<token>.
	'a.setAttribute("href","/memories?hash="+encodeURIComponent(hash)+(repo?"&detailRepo="+encodeURIComponent(repo):""));' +
	'a.addEventListener("click",function(e){e.preventDefault();' +
	'window.parent.postMessage({type:"jolli-wiki-nav",hash:hash},"*");});' +
	"return;}" +
	// Branch dir (../x/), the index page's bare topic--<slug>.md, or any other
	// relative dead link → keep the text, drop the anchor.
	'if(rel||/^[^/:]+\\.md$/i.test(href)){var s=document.createElement("span");' +
	"s.textContent=a.textContent;if(a.parentNode)a.parentNode.replaceChild(s,a);}" +
	"});})();";

function buildWikiViewerHtml(graphAssetsDir: string, bodyMd: string, detailRepo: string): string {
	const marked = readFileSync(join(graphAssetsDir, "vendor", "marked.min.js"), "utf8");
	const safe = escapeForInlineScript(JSON.stringify(bodyMd));
	// The scope token the rewrite script writes into each source-commit link's
	// `detailRepo`. Escaped like `bodyMd` (not developer-controlled — a repo URL).
	const safeRepo = escapeForInlineScript(JSON.stringify(detailRepo));
	return (
		`<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
		`<meta name="viewport" content="width=device-width, initial-scale=1" />` +
		`<style>${FRAMED_VIEWER_CSS}</style></head><body><article id="md" class="md"></article>` +
		`<script>\n${marked}\n</script>` +
		`<script>window.__JOLLI_WIKI_DETAIL_REPO__ = ${safeRepo};</script>` +
		`<script>document.getElementById("md").innerHTML = window.marked.parse(${safe});</script>` +
		`<script>${WIKI_LINK_REWRITE_SCRIPT}</script>` +
		`</body></html>`
	);
}

/** A friendly framed message (no scripts) for a viewer that has nothing to show. */
function viewerMessageHtml(message: string): string {
	// `message` is one of a few fixed strings, never user input — safe to inline.
	return (
		`<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
		`<style>${FRAMED_VIEWER_CSS}</style></head><body><p class="viewer-msg">${message}</p></body></html>`
	);
}

/**
 * The vendored `marked` bundle, read from the DASHBOARD assets with the graph
 * assets as the fallback — deliberately in that order, and it is the whole
 * reason `/context-viewer` is not simply a copy of `/wiki-viewer`.
 *
 * Only the CLI's own dist ships `graph-assets/`. `vscode/dist` and all three
 * plugin bundles stage `dashboard-assets/` alone (their build scripts copy that
 * one tree), so `resolveGraphAssetsDir()` THROWS on every non-CLI surface —
 * which is why `/wiki-viewer` and `/graph-viewer` already answer 500 there. The
 * Context dialog, by contrast, works on those surfaces today because it was pure
 * client-side markup; routing its body through a graph-asset-dependent viewer
 * would have converted a working dialog into a 500 on four surfaces out of five.
 * So the CLI build copies this one file into `dist/dashboard-assets/vendor/`,
 * which the existing copy step then carries downstream for free.
 *
 * The graph fallback is what covers a run from SOURCE (`npm run cli --
 * dashboard`): `cli/src/dashboard/assets/` has no `vendor/`, the file is only
 * placed there by the build, and the source tree's graph vendor copy is the
 * original.
 *
 * Returns undefined rather than throwing when neither exists. This file is
 * needed by ONE route, so a missing copy must degrade to that route showing a
 * message — not to `resolveDashboardAssetsDir` refusing the whole dashboard at
 * the door, which is why it is deliberately NOT in that probe's list (adding it
 * there would also fail every source run, since the source tree never has it).
 */
function resolveMarkedJs(dashboardAssetsDir: string): string | undefined {
	const dashboardCopy = join(dashboardAssetsDir, "vendor", "marked.min.js");
	if (existsSync(dashboardCopy)) return readFileSync(dashboardCopy, "utf8");
	try {
		const graphCopy = join(resolveGraphAssetsDir(), "vendor", "marked.min.js");
		if (existsSync(graphCopy)) return readFileSync(graphCopy, "utf8");
	} catch (err) {
		// resolveGraphAssetsDir throws when the viz tree is absent — the normal
		// case on every non-CLI surface, not an error worth more than a debug line.
		log.debug("no graph assets for the markdown renderer: %s", errMsg(err));
	}
	return undefined;
}

/**
 * Runs after `marked` renders `#md` in `/context-viewer`. The wiki script's
 * mirror image, because the link populations are opposite: a context document
 * (a plan, a note, an archived Linear/Sentry reference) carries ABSOLUTE
 * upstream URLs, where the wiki's are all repo-relative.
 *
 * A sandboxed frame has no `allow-popups` and cannot navigate the top page, so a
 * plain anchor click does NOTHING here — silently, and worse than the raw
 * markdown it replaced, where at least the URL was visible as text. So an
 * http(s) anchor keeps its visible href (status-bar preview) but hands the click
 * to the parent, which re-checks the scheme before opening it. Relative links
 * lose their anchor: there is no repo-relative target inside this frame.
 *
 * Self-contained, no user data — inlined verbatim (unlike the document body).
 */
export const CONTEXT_LINK_SCRIPT =
	'(function(){var md=document.getElementById("md");if(!md)return;' +
	'Array.prototype.forEach.call(md.querySelectorAll("a[href]"),function(a){' +
	'var href=a.getAttribute("href")||"";' +
	// Mirrors JD.safeHrefAttr's probe: strip the bytes the URL parser ignores
	// before reading a scheme, so `java\nscript:` cannot slip through as "relative".
	'var probe=href.replace(/[\\t\\n\\r]/g,"").replace(/^[\\u0000-\\u0020]+/,"").toLowerCase();' +
	"if(/^https?:/.test(probe)){" +
	'a.addEventListener("click",function(e){e.preventDefault();' +
	'window.parent.postMessage({type:"jolli-context-nav",href:href},"*");});' +
	"return;}" +
	// Anything else (relative, mailto-less, or an unreadable scheme) is dead in
	// this frame — keep the text, drop the anchor.
	'var s=document.createElement("span");s.textContent=a.textContent;' +
	"if(a.parentNode)a.parentNode.replaceChild(s,a);" +
	"});})();";

/**
 * A self-contained `/context-viewer` document: the vendored `marked` inlined,
 * plus one script that renders the context body into `#md`. Served ONLY into a
 * `sandbox="allow-scripts"` iframe (no `allow-same-origin`) — that opaque origin
 * is what isolates the rendered HTML from the token-bearing parent page, which
 * is the reason this content was rendered as literal `<pre>` text before rather
 * than being injected into the dashboard's own DOM.
 *
 * `theme` stamps `<html data-theme>` so the frame matches the dialog around it;
 * see {@link FRAMED_VIEWER_CSS}. Already validated to `light`/`dark` by the
 * route, and interpolated as a bare attribute value, so it must stay a closed
 * set rather than becoming a passthrough.
 */
function buildContextViewerHtml(markedJs: string, bodyMd: string, theme: "light" | "dark" | undefined): string {
	const safe = escapeForInlineScript(JSON.stringify(bodyMd));
	const themeAttr = theme ? ` data-theme="${theme}"` : "";
	return (
		`<!doctype html><html lang="en"${themeAttr}><head><meta charset="utf-8" />` +
		`<meta name="viewport" content="width=device-width, initial-scale=1" />` +
		`<style>${FRAMED_VIEWER_CSS}</style></head><body><article id="md" class="md"></article>` +
		`<script>\n${markedJs}\n</script>` +
		`<script>document.getElementById("md").innerHTML = window.marked.parse(${safe});</script>` +
		`<script>${CONTEXT_LINK_SCRIPT}</script>` +
		`</body></html>`
	);
}

// ── Request handling ────────────────────────────────────────────────────────

/**
 * Everything one page render is asked for — `QueryOptions` minus the clock,
 * which only tests inject. A single object rather than positional parameters
 * because the query layer keeps gaining optional axes, and each new one would
 * otherwise be a positional argument every caller has to thread through.
 */
export type ModelRequest = Omit<QueryOptions, "timeZone" | "nowMs">;

/** Builds the model for one request. Injectable so tests skip the real DB. */
export type ModelBuilder = (request: ModelRequest) => Promise<DashboardModel>;

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
	// The command creates the file before it binds, so this only
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
	// Not view-gated, unlike the three above: the repo picker is part of the shell,
	// so `missing` is computed on every view. One small JSON read per request, and
	// `readRepoRegistry` is the fail-open reader — an unreadable registry yields an
	// empty map, which is exactly the "fall back to `worktree_root`" case
	// `isMissingWorktree` already handles.
	const registryRoots = new Map<string, ReadonlyArray<string>>(
		(await readRepoRegistry(configDir)).repos.map((repo) => [repo.repoIdentity, recordedRepoPaths(repo)]),
	);
	// Optional sidebar rows. Not view-gated either, and for the same reason the
	// registry read above is not: the sidebar is shell furniture rendered on EVERY
	// view, so a flag read only on the settings view would leave the nav guessing
	// everywhere else. One small JSON read per request, on the same order as the
	// registry's; `loadConfigFromDir` is fail-open (an unreadable config reads as
	// an empty one), which lands on the default-hidden state rather than throwing.
	const menuConfig = await loadConfigFromDir(configDir ?? getGlobalConfigDir());
	const menus = {
		knowledge: menuConfig.dashboardKnowledgeMenuEnabled === true,
		graph: menuConfig.dashboardGraphMenuEnabled === true,
	};
	return withReadonlyDashboardDb(
		async (db) => {
			// A rebase/reset/squash that rewrites history away leaves the old commits'
			// rows in `commits` and `memories` forever. Reachability used to be asked
			// of git here (a `rev-list --branches` per repo, on every load), and is now
			// a materialised `memories.reachable` / `commits.reachable` column the feeds
			// filter in SQL — maintained asynchronously by the backfill sweep and the
			// daemon reconcile task (see MEMORY_REACHABLE_DDL / COMMIT_REACHABLE_DDL).
			// So no view pays git on the read path.
			//
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
			// Which of spec §9's three sentences the memory detail's EMPTY
			// conversations list prints. Async — it reads the machine-global Claude
			// owners ledger and stats the transcripts it names — so it is computed
			// here and threaded through `QueryOptions`, exactly like the reachability
			// sets above. Without this the page would fall through to the plainest
			// wording forever, with nothing failing to say so.
			//
			// Only the memories view, and only when a memory is actually selected: a
			// tree render with no `?hash=` has no detail pane to word.
			const transcriptRepairState =
				request.view === "memories" && request.hash
					? await readMemoryTranscriptRepairState(db, request.scope, request.hash, request.detailRepoIdentity)
					: undefined;
			// Every view is now served straight from the database. The stats view
			// used to get one more step here — a display-time LLM call compressing
			// the Decisions card's text — which is what made this builder async and
			// gave a GET a way to spend money. The card shows a stored topic title
			// now, so the call is retired (JOLLI-2209).
			return buildDashboardModel(db, {
				...request,
				registryRoots,
				menus,
				...(settingsModel ? { settingsModel } : {}),
				...(knowledgeModel ? { knowledgeModel } : {}),
				...(graphModel ? { graphModel } : {}),
				...(authorIdentity ? { authorIdentity } : {}),
				...(transcriptRepairState ? { transcriptRepairState } : {}),
			});
		},
		{ dbPath },
	);
}

export interface DashboardServerOptions {
	/** 0 lets the OS pick (tests); the command passes a preferred port. */
	readonly port: number;
	readonly buildModel?: ModelBuilder;
	readonly assetsDir?: string;
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
 * Whether the request was initiated by a page we did not serve.
 *
 * `Sec-Fetch-Site` is sent by every current browser and by nothing else, so it
 * names the initiator: `cross-site`/`same-site` is someone else's page,
 * whatever it is loading us as. Paired with the token on `/api/model` (see
 * `trusted`) because neither covers that route alone — the token is missing
 * from an old browser that sends no Fetch-Metadata, and the header is missing
 * from `curl`.
 *
 * An absent header therefore means "not a browser" and is trusted: that is
 * `curl` on the user's own machine, which can read this database directly by a
 * hundred easier routes than this one.
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
 * The one sign-in error text that is safe to return to the client: a developer
 * authored constant, carrying no internal detail. A CAUGHT error's own message
 * can leak implementation specifics (CWE-209), so `handleSignIn` returns this or
 * a generic fallback — never `errMsg(err)` — while still logging the real error
 * server-side. Shared with the `withTimeout` call so the two cannot drift.
 */
const SIGNIN_TIMEOUT_MESSAGE = "sign-in timed out — please try again";

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

/**
 * The page's repo scope, from zero or more `repo=` params.
 *
 * REPEATED params, never one comma-joined value: a repo identity is a remote URL
 * for anything with a remote, so any delimiter we picked would be a character an
 * identity may legitimately contain — and splitting on it would silently answer
 * for two repos that do not exist instead of the one that does.
 *
 * A single `?repo=x` therefore keeps parsing exactly as it always did, which is
 * what makes every existing bookmark and the Repositories row button survive the
 * move to a multi-select picker. Blank values are dropped so a `?repo=` the
 * browser emitted with nothing behind it reads as "all repos" rather than as an
 * identity no repo can match.
 */
function parseScope(url: URL): DashboardScope {
	const repos = url.searchParams.getAll("repo").filter((value) => value.length > 0);
	return repos.length > 0 ? { kind: "repo", repoIdentities: repos } : { kind: "all" };
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
 * `offset=N` — the standup board's whole-week paging step. A non-negative
 * integer, else absent (buildStandup then defaults to the window ending today).
 * Validated here rather than forwarded verbatim like `from`/`to` because it
 * reaches `addLocalDays`, which loops one local day at a time: a non-integer
 * throws there, and an unbounded magnitude (this param is deep-linkable) would
 * spin the single-threaded server for minutes. A too-large value is CLAMPED to
 * the furthest page rather than dropped, so a stale deep link lands on the oldest
 * window instead of silently snapping to today; `buildStandup` re-clamps for any
 * caller that does not pass through here.
 */
function parseStandupOffset(url: URL): number | undefined {
	const raw = url.searchParams.get("offset");
	if (raw === null) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) return undefined;
	return Math.min(n, STANDUP_MAX_OFFSET);
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
	const standupOffset = parseStandupOffset(url);
	return {
		...(dimension ? { dimension } : {}),
		...(range ? { range } : {}),
		...(customFrom ? { customFrom } : {}),
		...(customTo ? { customTo } : {}),
		...(hash ? { hash } : {}),
		...(detailRepo ? { detailRepoIdentity: detailRepo } : {}),
		...(standupOffset !== undefined ? { standupOffset } : {}),
	};
}

/**
 * The page model's clock, carried by follow-up reads so a preset window cannot
 * cross a local-day boundary between the model response and a detail/page fetch.
 *
 * `null` means the caller supplied an invalid value; `undefined` means it supplied
 * none, preserving the current-clock fallback for direct API calls. An empty value
 * (`nowMs=` with nothing after it) is deliberately `null`, not `undefined`: it is a
 * malformed param, and `Number("")` is `0`, so falling back to a silent epoch-0
 * clock would be worse than a 400. Leave enough valid-Date headroom for the widest
 * dashboard window and its end boundary. A safe integer can still lie beyond
 * JavaScript's Date range, where resolving a window would otherwise throw and turn a
 * malformed local URL into a 500.
 */
function parseNowMs(url: URL): number | null | undefined {
	const raw = url.searchParams.get("nowMs");
	if (raw === null) return undefined;
	const nowMs = Number(raw);
	const validThroughWindowEnd = Number.isFinite(new Date(nowMs + 367 * 86_400_000).getTime());
	return raw.trim() !== "" && nowMs >= 0 && Number.isSafeInteger(nowMs) && validThroughWindowEnd ? nowMs : null;
}

/**
 * Parses the `fromMs`/`toMs` echo-back pair the two journeys routes share —
 * the SAME window the feed resolved, sent back by the client rather than left
 * for the route to re-derive (see the `/api/journey` handler's comment for why
 * a second resolve is the bug). Returns `undefined` when the pair is unusable
 * and the caller should fall back to a fresh `resolveWindow`.
 *
 * `Number` plus `Number.isSafeInteger` rejects a trailing-garbage suffix that
 * `parseInt` would accept, and `from < to` rejects a reversed or degenerate
 * pair that parsed fine but describes no real window. Both or neither: one
 * bound alone is a window nobody computed.
 *
 * The span is clamped to the same scan ceiling the range picker's custom
 * window gets ({@link MAX_CUSTOM_DAYS}): a hostile or stale request cannot ask
 * the read path to walk wider than the preset/custom limit allows. Only the
 * WIDTH is clamped, never the position — a bounded window in the past (the
 * page's own presets, a bookmarked custom range) is echoed back exactly, which
 * is the contract a caller's trace request depends on.
 */
function parseExplicitWindowMs(url: URL): { readonly startMs: number; readonly endMs: number } | undefined {
	const rawFromMs = url.searchParams.get("fromMs");
	const rawToMs = url.searchParams.get("toMs");
	const fromMs = rawFromMs === null ? Number.NaN : Number(rawFromMs);
	const toMs = rawToMs === null ? Number.NaN : Number(rawToMs);
	if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs) return undefined;
	const maxSpanMs = MAX_CUSTOM_DAYS * 86_400_000;
	const startMs = toMs - fromMs > maxSpanMs ? toMs - maxSpanMs : fromMs;
	return { startMs, endMs: toMs };
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
 * range control and the repo picker able to disagree about where a view lives.
 *
 * `/decisions` is retired — its view token, model payload and page are gone
 * (folded into Memories' per-topic Decisions callout) — so it is absent here
 * and handled as its own 302 in `handle()` instead. `/repositories` is retired
 * too and gets no such redirect: it had no content to fold anywhere, so it 404s.
 *
 * NOTHING IS GATED. A `GATED_PATHS` set used to redirect the three paths above to
 * `/repositories` while no repo was enabled, with Repositories as the row that
 * opened the gate. With that page gone the gate has nowhere to send anyone — a
 * redirect to a 404, or a loop back to the same path — so the zero-repo case is
 * a state the stats view renders (the enable instruction that page used to
 * carry) rather than a place to be sent.
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
	"/dashboard": "stats",
	"/dashboard/standup": "standup",
	"/skills": "skills",
	"/mcps": "mcps",
	"/dashboard/journeys": "journeys",
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
	"skills",
	"mcps",
	"memories",
	"journeys",
	"knowledge",
	"graph",
	"settings",
]);

/**
 * Valid `?list=` tokens for `/api/tool-usage`.
 *
 * An unrecognized one is a 400, NOT a fallback to the first list. Every other
 * enum on this router degrades to a default because the answer is still a page
 * the reader can read — here the answer would be a page of the WRONG list,
 * appended by the client to the one it asked about.
 */
const TOOL_USAGE_LISTS: ReadonlyArray<ToolUsageList> = ["skill", "server", "tool"];

/**
 * Widest `?limit=` this route will serve — 25 pages of {@link TOOL_ROWS_LIMIT}.
 *
 * The limit used to be ours alone, because the only caller was a "Show more"
 * click and one click means one page. Two callers need the other shape now. The
 * 30 s poll, to decide whether a list the reader has already expanded still
 * looks the same, has to re-read exactly as many rows as are on screen, which is
 * a number only the client knows (see `carryForwardToolLists` in
 * `assets/js/stats.js`). And the Skills PAGE asks for the whole list outright —
 * it has no button, so it reads to the end on arrival (`assets/js/skills.js`).
 *
 * Clamped rather than rejected, so a caller asking past the cap still gets a
 * readable page, and each of the three degrades safely in its own way. A Show
 * more click cannot reach the cap in under 25 clicks on one list. A poll holding
 * more rows than the cap receives fewer than it asked for, reads that as "the
 * card changed", and collapses back to the first page — the pre-existing
 * behaviour — rather than trusting rows it could not verify. The Skills page
 * reaches the cap on its FIRST request for any corpus past 200 skills, which is
 * the case it is built for: the short answer advances its offset and it comes
 * back for the remainder, so the clamp costs it a round trip rather than rows.
 *
 * A cap at all because this is an unauthenticated-shaped GET on a local server:
 * without one, `?limit=1e9` turns a card's paging endpoint into an unbounded
 * whole-table read, and the SQL behind it groups and folds per-agent shares for
 * every row it returns.
 */
const TOOL_USAGE_MAX_LIMIT = TOOL_ROWS_LIMIT * 25;

/**
 * Creates (but does not start) the server. Exported separately from
 * {@link startDashboardServer} so tests can drive it on port 0 with an
 * injected model builder and no real database.
 */
export function createDashboardServer(options: DashboardServerOptions): Server {
	const now = options.now ?? Date.now;
	const configDir = options.configDir;
	const serverCwd = options.serverCwd ?? process.cwd();
	const token = options.token ?? randomBytes(32).toString("hex");
	let assetsDir: string | undefined;
	/** Lazily-resolved knowledge-graph viz assets (`<dist>/graph-assets/`) — reused by both iframe routes. */
	let graphAssetsDir: string | undefined;
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
	// Same one-at-a-time guard as `generateMissingInFlight`, for the folder-wide
	// wiki rebuild. The rebuild (`compileAllRepos`) runs IN this long-lived server
	// process (fire-and-forget), so a plain process-scoped boolean observes its
	// start and end — the freshness endpoint reports it as `inFlight` and the page
	// polls it to completion. (The old per-repo detached-worker rebuild needed the
	// real lock/queue state; a folder sweep in-process does not.)
	let wikiRebuildInFlight = false;
	// A per-server-process identity handed to the browser with every freshness
	// response. The page stores a banner "dismiss" in localStorage keyed by this
	// value, so restarting the dashboard (a new process → a new nonce) makes a
	// dismissed banner reappear — the web analog of "restart the server to see it
	// again". It only needs to differ across restarts, so process start time is
	// enough; it is captured once here (server-creation) and never changes.
	const wikiBannerNonce = String(Date.now());
	const buildModel =
		options.buildModel ??
		((request: ModelRequest) =>
			defaultModelBuilder(request, configDir, options.dbPath, identityCache, now, serverCwd));

	const server = createServer(async (req, res) => {
		try {
			await handle(req, res);
		} catch (err) {
			log.error("request failed: %s", errMsg(err));
			if (!res.headersSent) sendText(res, 500, "Internal error");
			else res.end();
		}
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		/* v8 ignore start -- a server IncomingMessage always carries a url; the `?? "/"` only satisfies the `string | undefined` type (client responses lack one) and is unreachable here. */
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
		/* v8 ignore stop */

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
		// frame was enough to POST /api/settings/apply with the page's own mutation
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
		// Identifies this listener to the next `jolli dashboard`, which reclaims the
		// port by killing whatever holds it — but only once this answers, because
		// signalling an unidentified process on 1818 would kill some unrelated local
		// service. The pid it returns is live BY CONSTRUCTION (it just answered on
		// the port being taken), which is what makes this safe where the state file
		// it replaces was not: a recorded pid could have been recycled.
		//
		// `service` is what makes "unidentified" a real test rather than a hopeful
		// one: `{ok: true, pid: number}` on its own is a payload plenty of unrelated
		// services emit. See DASHBOARD_HEALTH_SERVICE.
		//
		// `platform` and `host` say WHICH pid namespace that process id belongs to,
		// and they are what stops the reclaim signalling a stranger. Answering on
		// loopback does not put a process within reach: a dashboard inside WSL or a
		// container answers a host CLI perfectly well, and the id it reports is real
		// THERE. The host resolving it locally either finds nothing (harmless) or
		// finds an unrelated process and SIGTERMs it — a wrong kill that also leaves
		// the port held, so nothing downstream can tell it happened. `process.kill`
		// takes any integer; only these two fields let the caller decline.
		//
		// Ungated, like every other read here, and it exposes nothing beyond a
		// process id, a hostname, and the fact that a dashboard is running.
		if (url.pathname === "/health") {
			sendJson(res, 200, {
				ok: true,
				pid: process.pid,
				service: DASHBOARD_HEALTH_SERVICE,
				platform: process.platform,
				host: hostname(),
			});
			return;
		}

		if (url.pathname === "/") {
			// Unconditional now. This used to build a whole `repositories` model
			// just to choose between two destinations — the LANDING page depended
			// on whether anything was enabled yet, so the redirect had to know.
			// With Repositories gone there is one destination, and the "nothing
			// enabled" case is a state the Dashboard renders rather than a place
			// to be sent. That deletes a full model build from the base URL.
			res.writeHead(302, { Location: "/dashboard" });
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
			// — so no token here, and nothing this builds costs anything.
			const model = await buildModel({
				view: pageView,
				scope: parseScope(url),
				...parseWindow(url),
			});
			assetsDir ??= options.assetsDir ?? resolveDashboardAssetsDir();
			const html = assembleDashboardHtml(assetsDir, JSON.stringify(model), token);
			res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
			res.end(html);
			return;
		}

		// The Memories page's Context viewer: one archived plan / note / reference
		// body rendered by the vendored `marked` into a SANDBOXED self-contained
		// document, shown inside the Context dialog's iframe. Same isolation model
		// as `/wiki-viewer` and the same reason — the parent page carries the
		// mutation token, and these documents were written by an agent.
		//
		// It reads `readContextDoc`, exactly as `/api/context` does; that JSON route
		// stays as the machine-readable form of the same read.
		if (url.pathname === "/context-viewer") {
			const repo = url.searchParams.get("repo") ?? "";
			const kindParam = url.searchParams.get("kind") ?? "";
			const key = url.searchParams.get("key") ?? "";
			const themeParam = url.searchParams.get("theme");
			const kind = CONTEXT_DOC_KINDS.find((k) => k === kindParam);
			if (!repo || !key || !kind) {
				sendText(res, 400, `repo, kind (${CONTEXT_DOC_KINDS.join("|")}) and key are required`);
				return;
			}
			// A closed set, never a passthrough: it is interpolated as a bare
			// attribute value in `buildContextViewerHtml`. An absent or unrecognised
			// value means "no explicit theme", which leaves the media query in charge.
			const theme = themeParam === "light" || themeParam === "dark" ? themeParam : undefined;
			// Caught here rather than left to the outer handler, which answers a
			// failed request with plain text. Every other exit from this route is a
			// framed document, because what receives it is an iframe inside the
			// Context dialog: an unstyled "500 internal error" renders there as a bare
			// line of text in the middle of the page, in a frame the reader cannot
			// scroll away from, saying nothing about what to do.
			let doc: Awaited<ReturnType<typeof readContextDoc>>;
			try {
				doc = await withReadonlyDashboardDb((db) => readContextDoc(db, repo, kind, key), {
					...(options.dbPath ? { dbPath: options.dbPath } : {}),
				});
			} catch (err) {
				// Same rule as `/api/context`: log the detail, tell the reader only
				// that the read failed. 500 and not 404 — "could not be found" would
				// send them looking for a document that is still there.
				log.warn("context viewer read failed: %s", errMsg(err));
				sendViewerHtml(res, 500, viewerMessageHtml("This document could not be read — try again."));
				return;
			}
			if (!doc) {
				sendViewerHtml(res, 404, viewerMessageHtml("This document could not be found."));
				return;
			}
			assetsDir ??= options.assetsDir ?? resolveDashboardAssetsDir();
			const markedJs = resolveMarkedJs(assetsDir);
			if (markedJs === undefined) {
				// A 200 with guidance, not a 500: the document was found and the rest of
				// the dashboard is fine — only this renderer is missing from the install.
				sendViewerHtml(
					res,
					200,
					viewerMessageHtml(
						"The markdown renderer is missing from this install — reinstall to view documents.",
					),
				);
				return;
			}
			sendViewerHtml(res, 200, buildContextViewerHtml(markedJs, doc.bodyMd, theme));
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
			const repo = await resolveKbRepo(configDir, kb);
			const body = repo ? readWikiBody(repo.kbRoot, file) : undefined;
			if (!repo || body === undefined) {
				sendViewerHtml(res, 404, viewerMessageHtml("This wiki page could not be found."));
				return;
			}
			// A partially-shipped viz asset tree would throw here; the outer request
			// catch turns that into a 500 (never a crash), same as any page route.
			graphAssetsDir ??= resolveGraphAssetsDir();
			// The rewritten source-commit links carry `repo.detailRepo` (the dashboard
			// repoIdentity when a remote exists, else the display name — NOT the `kb`
			// dir name) so the memory jump scopes to the owning repo even when two
			// repos share a display name. See the script's docstring and `resolveKbRepo`.
			sendViewerHtml(res, 200, buildWikiViewerHtml(graphAssetsDir, body, repo.detailRepo));
			return;
		}

		// The Graph page's on-demand wiki body: RAW markdown for ONE topic, fetched
		// when the user opens a full wiki page in the graph. The graph iframe is a
		// `sandbox="allow-scripts"` opaque-origin frame and cannot fetch same-origin
		// itself, so the parent `/graph` page relays the request here (see the
		// `jolli-graph-wiki-request` handler in `graph.js`). Public GET like the
		// other viewer routes; the viz renders the markdown client-side. The body is
		// NOT inlined into graph.json (schema v5) — this is what replaces it.
		if (url.pathname === "/graph-wiki") {
			const kb = url.searchParams.get("kb");
			const slug = url.searchParams.get("slug");
			if (!kb || !slug) {
				sendText(res, 400, "kb and slug are required");
				return;
			}
			// Slug is the lowercase-hyphen `stableSlug`; the strict shape also blocks
			// path traversal before the filename is built (readWikiBody re-checks).
			if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
				sendText(res, 400, "invalid slug");
				return;
			}
			const repo = await resolveKbRepo(configDir, kb);
			const body = repo ? readWikiBody(repo.kbRoot, `topic--${slug}.md`) : undefined;
			if (body === undefined) {
				sendText(res, 404, "wiki page not found");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" });
			res.end(body);
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
			// Otherwise the route stays open as layer 3 promises: every other view
			// here is a free public read, and `trusted` decides nothing beyond the
			// settings gate above. (It used to also gate the Decisions gist's LLM
			// call — the one paid path a GET had, now retired.)
			sendJson(
				res,
				200,
				await buildModel({
					view,
					scope: parseScope(url),
					...parseWindow(url),
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
				// Reachability is a materialised `memories.reachable` column now
				// (see MEMORY_REACHABLE_DDL), filtered in SQL by `buildMemoriesPage`,
				// so this page pays no per-request `git rev-list`.
				const page = await withReadonlyDashboardDb((db) => buildMemoriesPage(db, scope, cursor), {
					...(options.dbPath ? { dbPath: options.dbPath } : {}),
				});
				sendJson(res, 200, page);
			} catch (err) {
				log.warn("memories page read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that page of memories" });
			}
			return;
		}

		// One page of a Skills / MCPs list — behind those cards' "Show more" button on
		// the Stats page, and read straight through to the end by the Skills page, which
		// has no button. Same shape as `/api/memories` above and for the same reason: the
		// model is inlined into the page HTML, so only the first page can ride there. A
		// read like every other GET here — no token.
		//
		// The window params ride along (`range`/`from`/`to`) because the rows are
		// an aggregate OVER a window: paging with a different one than the card was
		// rendered under would append rows counted from a different set. The client
		// sends them from the same `JD.query` builder every other fetch uses.
		//
		// `limit` IS a parameter, and used to deliberately not be — the page size was
		// the height the card is laid out for, so it was ours to pick. The 30 s poll
		// added the other caller: re-reading an already-expanded list to compare it
		// against what is on screen needs a width only the client knows. The reason
		// it was refused survives as the CLAMP rather than as the absence of the
		// parameter — see TOOL_USAGE_MAX_LIMIT for why clamped and not rejected.
		if (url.pathname === "/api/tool-usage") {
			const requested = url.searchParams.get("list") ?? "";
			const list = TOOL_USAGE_LISTS.find((known) => known === requested);
			if (!list) {
				sendJson(res, 400, { error: `list must be one of ${TOOL_USAGE_LISTS.join("|")}` });
				return;
			}
			// A non-numeric offset is the caller's bug, not a position to guess at:
			// treating it as 0 would answer a "Show more" click with the page the
			// client already holds, which its dedupe drops — a button that visibly
			// does nothing. (A negative or fractional NUMBER is floored instead; see
			// `buildToolUsagePage`.)
			const rawOffset = url.searchParams.get("offset") ?? "0";
			const offset = Number(rawOffset);
			if (!Number.isFinite(offset)) {
				sendJson(res, 400, { error: "offset must be a number" });
				return;
			}
			// Absent means "one page", the shape a Show more click asks for. A
			// non-numeric one is a 400 for the same reason `offset` is: the caller
			// asked a question this route cannot answer, and silently answering a
			// different one is what makes a client-side bug invisible. In range it is
			// clamped, never rejected — see TOOL_USAGE_MAX_LIMIT.
			const rawLimit = url.searchParams.get("limit");
			let limit: number | undefined;
			if (rawLimit !== null) {
				const parsed = Number(rawLimit);
				if (!Number.isFinite(parsed)) {
					sendJson(res, 400, { error: "limit must be a number" });
					return;
				}
				limit = Math.min(Math.max(1, Math.trunc(parsed)), TOOL_USAGE_MAX_LIMIT);
			}
			const pageNowMs = parseNowMs(url);
			if (pageNowMs === null) {
				sendJson(res, 400, { error: "nowMs must be an epoch-millisecond integer" });
				return;
			}
			// Spelled out rather than spread from `parseWindow`: that helper also
			// carries the series axis and the Memories view's `hash`/`detailRepo`,
			// none of which this route has any business receiving.
			const requestedWindow = parseWindow(url);
			try {
				const page = await withReadonlyDashboardDb(
					(db) =>
						buildToolUsagePage(db, {
							scope: parseScope(url),
							list,
							offset,
							...(limit !== undefined ? { limit } : {}),
							...(requestedWindow.range ? { range: requestedWindow.range } : {}),
							...(requestedWindow.customFrom ? { customFrom: requestedWindow.customFrom } : {}),
							...(requestedWindow.customTo ? { customTo: requestedWindow.customTo } : {}),
							...(pageNowMs !== undefined ? { nowMs: pageNowMs } : {}),
						}),
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				sendJson(res, 200, page);
			} catch (err) {
				log.warn("tool usage page read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that page of tool usage" });
			}
			return;
		}

		// One skill's breakdown, for the Skills card's detail view. A fetch rather
		// than a slice of the page model: that model carries ONE PAGE of skills and
		// none of the per-agent / per-session / per-commit detail, so a skill past
		// row 8 would have nothing to open.
		if (url.pathname === "/api/skill-detail") {
			// Trimmed, because the name rides in a query string and a stray space is a
			// name that matches nothing — indistinguishable, to the reader, from a skill
			// with no recorded calls. Empty after trimming is the caller's bug.
			const name = (url.searchParams.get("name") ?? "").trim();
			if (name === "") {
				sendJson(res, 400, { error: "name is required" });
				return;
			}
			const detailNowMs = parseNowMs(url);
			if (detailNowMs === null) {
				sendJson(res, 400, { error: "nowMs must be an epoch-millisecond integer" });
				return;
			}
			const requestedWindow = parseWindow(url);
			try {
				const detail = await withReadonlyDashboardDb(
					(db) =>
						buildSkillDetail(db, {
							scope: parseScope(url),
							name,
							...(requestedWindow.range ? { range: requestedWindow.range } : {}),
							...(requestedWindow.customFrom ? { customFrom: requestedWindow.customFrom } : {}),
							...(requestedWindow.customTo ? { customTo: requestedWindow.customTo } : {}),
							...(detailNowMs !== undefined ? { nowMs: detailNowMs } : {}),
						}),
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				// 404 for "no call of that skill in this window" — a real answer, and one
				// the client must not paint as an empty detail view. A skill that ran but
				// attributed no tokens comes back 200 with `usage` absent instead.
				if (!detail) {
					sendJson(res, 404, { error: "no recorded calls for that skill in this window" });
					return;
				}
				sendJson(res, 200, detail);
			} catch (err) {
				log.warn("skill detail read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that skill's detail" });
			}
			return;
		}

		// One MCP server's breakdown, for the MCPs page's reading pane — the
		// server-side twin of `/api/skill-detail` above, and a fetch for the same
		// reason: the page model carries ONE PAGE of servers and none of the per-tool
		// or per-session detail.
		if (url.pathname === "/api/mcp-detail") {
			// Trimmed for the reason the skill name is: the value rides in a query
			// string, and a stray space is a server that matches nothing —
			// indistinguishable, to the reader, from a server with no recorded calls.
			const server = (url.searchParams.get("server") ?? "").trim();
			if (server === "") {
				sendJson(res, 400, { error: "server is required" });
				return;
			}
			const detailNowMs = parseNowMs(url);
			if (detailNowMs === null) {
				sendJson(res, 400, { error: "nowMs must be an epoch-millisecond integer" });
				return;
			}
			const requestedWindow = parseWindow(url);
			try {
				const detail = await withReadonlyDashboardDb(
					(db) =>
						buildMcpServerDetail(db, {
							scope: parseScope(url),
							server,
							...(requestedWindow.range ? { range: requestedWindow.range } : {}),
							...(requestedWindow.customFrom ? { customFrom: requestedWindow.customFrom } : {}),
							...(requestedWindow.customTo ? { customTo: requestedWindow.customTo } : {}),
							...(detailNowMs !== undefined ? { nowMs: detailNowMs } : {}),
						}),
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				// 404 for "no call to that server in this window" — a real answer, and
				// the one a missing server has. This page never claims to list
				// CONFIGURED servers, so there is no "registered but silent" state for
				// this route to distinguish.
				if (!detail) {
					sendJson(res, 404, { error: "no recorded calls for that MCP server in this window" });
					return;
				}
				sendJson(res, 200, detail);
			} catch (err) {
				log.warn("mcp detail read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that MCP server's detail" });
			}
			return;
		}

		// One journey's full record, for the trace modal. Deliberately NOT folded
		// into the page model: the feed caps each row's decisions at 8 and carries
		// no per-commit rows, and shipping every journey's full trace would
		// multiply the page's size for content the reader usually never opens.
		// A read like every other GET here — no token.
		if (url.pathname === "/api/journey") {
			// `id` alone identifies a journey. Every `JourneyKey.key` is namespaced
			// by repo identity (a ticket key carries `T\x00<repoIdentity>\x00<ticket>`,
			// a branch key `B\x00<repoIdentity>\x00<branch>`, a lone commit
			// `C\x00<repoIdentity>\x00<hash>`), so a lookup by id under an "all
			// repos" scope cannot collide across repos the way `/api/memories`'
			// bare commit hash can. `repo=` is still accepted below (via
			// `parseScope`) as an optional scope narrowing, mirroring every other
			// page — it is simply not REQUIRED for correctness.
			const id = url.searchParams.get("id") ?? "";
			if (!id) {
				sendJson(res, 400, { error: "id is required" });
				return;
			}
			const scope = parseScope(url);
			const win = parseWindow(url);
			// The feed already resolved a window when it rendered these journeys —
			// `fromMs`/`toMs` are that SAME window, echoed back by the client rather
			// than left for this route to re-derive. Two independent `resolveWindow`
			// calls (one when the feed rendered, one here) can straddle a
			// local-midnight boundary and disagree about what "30d" means, so a
			// journey the feed just rendered could otherwise 404 from this route —
			// the id is only meaningful within the window that grouped it. Both or
			// neither: one bound alone is a window nobody computed, so a
			// half-supplied pair falls back to a fresh resolve rather than mixing
			// one echoed bound with one freshly-derived one. Parse and clamp live in
			// `parseExplicitWindowMs` — the SAME helper `/api/journeys` uses, so the
			// two routes can never disagree about what a pair means.
			const explicitWindow = parseExplicitWindowMs(url);
			try {
				const detail = await withReadonlyDashboardDb(
					async (db) => {
						const resolved =
							explicitWindow ??
							// Match the Coaching page's own default: with no explicit
							// bounds AND no `?range=`, the feed opens on
							// `JOURNEYS_DEFAULT_RANGE` (week), not the global month, so a
							// window-dependent journey id stays resolvable.
							resolveWindow(
								win.range ?? JOURNEYS_DEFAULT_RANGE,
								win.customFrom,
								win.customTo,
								Date.now(),
								machineTimeZone(),
							);
						return buildJourneyDetail(db, scope, resolved, id);
					},
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				if (!detail) {
					sendJson(res, 404, { error: "not found" });
					return;
				}
				sendJson(res, 200, detail);
			} catch (err) {
				// Same rule as the other read routes: log the detail, tell the
				// client only that the read failed.
				log.warn("journey detail read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that journey" });
			}
			return;
		}

		// The whole journey feed, fetched when the feed modal opens.
		//
		// Deliberately NOT cursor-paged, unlike `/api/memories`. Two of the feed's
		// client functions are defined over the COMPLETE set and would silently
		// degrade against a page: `JD.journeyFilters` derives which filter chips
		// exist from the journeys present, and `JD.shouldGroupByDay` decides on the
		// header count across the whole set against `DAY_HEADER_CAP`. Paging would
		// make both answer from whatever happened to have loaded, with no error
		// anywhere. The payload is only paid when the modal opens, which is the
		// win this route exists for; paging can be added later behind the same URL
		// once those two functions take an explicit total.
		if (url.pathname === "/api/journeys") {
			const scope = parseScope(url);
			const win = parseWindow(url);
			// Explicit bounds arrive as `fromMs`/`toMs`, NOT as `from`/`to` —
			// `parseWindow` already claims the latter pair for the range picker's
			// `customFrom`/`customTo`, where they are date strings. Sending epoch
			// milliseconds under those names is silently misread. Same parse and
			// same clamp as `/api/journey` above — `parseExplicitWindowMs` is the
			// ONE definition of what a pair means, so the feed and its trace can
			// never resolve different windows for the same bounds.
			const explicitWindow = parseExplicitWindowMs(url);
			try {
				const model = await withReadonlyDashboardDb(
					async (db) => {
						const resolved =
							explicitWindow ??
							// Match the Coaching page's own default: with no explicit
							// bounds AND no `?range=`, the feed opens on
							// `JOURNEYS_DEFAULT_RANGE` (week), not the global month, so a
							// window-dependent journey id stays resolvable.
							resolveWindow(
								win.range ?? JOURNEYS_DEFAULT_RANGE,
								win.customFrom,
								win.customTo,
								Date.now(),
								machineTimeZone(),
							);
						// The feed renders the `flagged` chip (turn-abort friction)
						// and the `test-first` chip, and the Patterns page filters
						// the feed to its own test-first count — so the feed must
						// carry the same `tested` signal that count was measured
						// with, or clicking the pattern opens an empty list. Both
						// signals ride the one per-journey transcript walk this
						// surface pays; the roster's page load does not.
						return buildJourneys(db, scope, resolved.startMs, resolved.endMs, {
							withFriction: true,
							withTests: true,
						});
					},
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				sendJson(res, 200, model);
			} catch (err) {
				// Same rule as the other read routes: log the detail, tell the
				// client something generic.
				log.warn("journeys read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read journeys" });
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

		// One archived conversation's turns, for the Memories page's Conversation
		// viewer. Deliberately NOT folded into the memory detail payload, for the
		// same reason as `/api/context`: a memory can link several conversations of
		// thousands of turns each, and the reader opens at most one.
		//
		// JSON, not a framed viewer — unlike a context document, a transcript turn
		// is rendered as TEXT (the editor's ConversationDetailsPanel does the same),
		// so there is no agent-authored HTML here to isolate. A read like every
		// other GET here — no token.
		if (url.pathname === "/api/conversation") {
			const repo = url.searchParams.get("repo") ?? "";
			const hash = url.searchParams.get("hash") ?? "";
			const source = url.searchParams.get("source") ?? "";
			const session = url.searchParams.get("session") ?? "";
			if (!repo || !hash || !source || !session) {
				sendJson(res, 400, { error: "repo, hash, source and session are required" });
				return;
			}
			try {
				const doc = await withReadonlyDashboardDb(
					(db) => readConversationEntries(db, repo, hash, source, session),
					{ ...(options.dbPath ? { dbPath: options.dbPath } : {}) },
				);
				if (!doc) {
					sendJson(res, 404, { error: "not found" });
					return;
				}
				sendJson(res, 200, doc);
			} catch (err) {
				// Same rule as the other read routes: log the detail, tell the client
				// only that the read failed.
				log.warn("conversation read failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not read that conversation" });
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

		// Folder-wide wiki/graph freshness, aggregated across EVERY Memory Bank repo
		// (matches the whole-folder rebuild below). Slow (scans source refs per
		// repo), so it is its own endpoint off first paint (like missing-summaries).
		// `inFlight` reflects the in-process rebuild flag. `available:false` when no
		// `localFolder` (Memory Bank) is configured.
		if (url.pathname === "/api/wiki/freshness") {
			try {
				const config = await loadConfigFromDir(configDir ?? getGlobalConfigDir());
				if (!config.localFolder) {
					sendJson(res, 200, { available: false });
					return;
				}
				const freshness = await getAggregateWikiFreshness(config.localFolder, config);
				sendJson(res, 200, {
					available: true,
					inFlight: wikiRebuildInFlight,
					nonce: wikiBannerNonce,
					...freshness,
				});
			} catch (err) {
				log.warn("wiki freshness failed: %s", errMsg(err));
				sendJson(res, 500, { error: "could not compute wiki freshness" });
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
		if (url.pathname === "/api/repos/forget") {
			await handleForget(res, b);
			return;
		}
		// `/api/repos/disable` and `/api/repos/resume` were the Repositories page's
		// per-row Pause / Resume. Both went with that page. Pausing a repository
		// is still a thing — `jolli disable` writes `disabled_at` and every query
		// here still honours it — it just has no dashboard control any more.
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
		if (url.pathname === "/api/settings/set-sync-sessions") {
			await handleSetSyncSessions(res, b);
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
		if (url.pathname === "/api/wiki/rebuild") {
			await handleWikiRebuild(res);
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
	 * Settings → Sync to Jolli: the machine-wide session-statistics switch. Applies
	 * immediately, like `set-push` above and unlike the batched `apply` — the two
	 * were the same tab's identical-looking switches with different rules.
	 */
	async function handleSetSyncSessions(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		if (typeof body.enabled !== "boolean") {
			sendJson(res, 400, { error: "enabled (boolean) is required" });
			return;
		}
		try {
			const result = await setSyncSessions(body.enabled, configDir ?? getGlobalConfigDir());
			sendJson(res, 200, { ok: true, syncSessions: result.syncSessions });
		} catch (err) {
			log.warn("set-sync-sessions failed: %s", errMsg(err));
			sendJson(res, 500, { error: "could not change the session-statistics setting" });
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
			await withTimeout(browserLogin(getJolliUrl()), SIGNIN_TIMEOUT_MS, SIGNIN_TIMEOUT_MESSAGE);
			sendJson(res, 200, { ok: true });
		} catch (err) {
			// Log the real error server-side, but return only a CONSTANT to the
			// client: a caught error's message can carry internal detail (CWE-209),
			// so nothing derived from `err` reaches the response. The timeout text is
			// a safe developer-authored constant worth preserving; anything else is a
			// generic message and the detail stays in the log above.
			log.warn("sign-in failed: %s", errMsg(err));
			const clientError =
				errMsg(err) === SIGNIN_TIMEOUT_MESSAGE
					? SIGNIN_TIMEOUT_MESSAGE
					: "Sign-in failed — see the server log for details.";
			sendJson(res, 400, { error: clientError });
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
		// second tab drops the page-side busy flag) would otherwise start a second
		// pass over the same commits. This flag is PROCESS-scoped and cannot see a
		// concurrent `jolli backfill`, so it is not what stops double billing:
		// `runBackfill` re-checks each commit for a summary immediately before the
		// model call (`hasSummaryNow`). This guard just keeps one server from racing
		// itself, and answers 409 so the page can say so.
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

	/**
	 * Knowledge/Graph page: rebuild the WHOLE Memory Bank folder's wiki/graph on
	 * demand — the same folder-wide sweep as `jolli compile` / VS Code's "Build
	 * Knowledge Wiki" (`compileAllRepos`). Runs IN this long-lived server process,
	 * fire-and-forget: returns 202 immediately while the sweep proceeds, and the
	 * page polls `/api/wiki/freshness` (whose `inFlight` reflects the flag below)
	 * to completion. 409 when one is already running so the page shows one
	 * "Rebuilding…", not two.
	 *
	 * In-process (not a detached worker) is what lets a plain server-local boolean
	 * observe start and end — `compileAllRepos` uses folder-only storage per repo
	 * (no git worktree), so it needs no per-repo queue/worker.
	 */
	async function handleWikiRebuild(res: ServerResponse): Promise<void> {
		const config = await loadConfigFromDir(configDir ?? getGlobalConfigDir());
		if (!config.localFolder) {
			sendJson(res, 400, { error: "no Memory Bank folder is configured" });
			return;
		}
		// Gate on a usable LLM provider up front — the same check VS Code's
		// "Build Knowledge Wiki" does. Without it, `compileAllRepos` would fail every
		// batch silently (its per-repo errors are caught, not thrown), the flag would
		// flip back, and the banner would return to the identical "behind" state with
		// no signal to the user beyond a server log line. Surfacing it as an error the
		// page renders (shell.js's non-409 catch → callout + Retry) keeps parity.
		const { resolveLlmCredentialSource } = await import("../core/LlmClient.js");
		if (resolveLlmCredentialSource(config) === null) {
			sendJson(res, 400, {
				error: "Building the knowledge wiki needs an AI provider — open Settings to sign in, add a key, or select the Local Agent, then try again.",
			});
			return;
		}
		if (wikiRebuildInFlight) {
			sendJson(res, 409, { error: "a wiki rebuild is already running — wait for it to finish" });
			return;
		}
		wikiRebuildInFlight = true;
		const localFolder = config.localFolder;
		// Fire-and-forget: the sweep is multi-minute and LLM-bearing, so it must not
		// block this handler. The flag is cleared in the tail regardless of outcome.
		void (async () => {
			try {
				const { compileAllRepos } = await import("../core/MultiRepoCompile.js");
				await compileAllRepos(localFolder, config);
			} catch (err) {
				log.warn("wiki rebuild (compile all repos) failed: %s", errMsg(err));
			} finally {
				wikiRebuildInFlight = false;
			}
		})();
		sendJson(res, 202, { ok: true });
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
		// This process just learned that a directory exists, and the render path's
		// existence memo (`DashboardQuery.worktreeExists`) may hold the opposite
		// answer for up to its whole window: a `repos` row pointing here that was
		// probed while the checkout was absent — cloned back, or created and enabled
		// from this page — leaves the memo saying `false`, so the reload right after
		// this 200 renders the repo the user just enabled with a forget ✕ on it.
		// Nothing else invalidates the memo; it is real-time-generational by design.
		clearWorktreeExistenceCache();
		const warning = await projectRegistryEntry(repo.repoIdentity);
		sendJson(res, 200, { ok: true, repoIdentity: repo.repoIdentity, ...(warning ? { warning } : {}) });
	}

	/**
	 * Removes a repository from this machine's dashboard — registry entry, rows and
	 * unprojected events. The counterpart to `handleEnable`, and the only user-facing
	 * way to reach an entry whose directory is gone (every `cwd`-addressed path has
	 * to run inside the repo, so none of them can name one).
	 *
	 * Refuses a repository that still exists on disk, and the check is deliberately
	 * not "did the page offer the control": the control is rendered from a payload
	 * that can be minutes old, a repo can be recreated or a drive remounted in
	 * between, and this deletes memories irreversibly. `409` rather than `400` — the
	 * request was well-formed, the state is what says no.
	 *
	 * The liveness question goes to whichever source can answer it — the registry
	 * when there is an entry, the projection otherwise — because either can be the
	 * only one. A registered entry knows every clone's path, which `worktree_root`
	 * alone does not, so it outranks the projection; and a row projected from an
	 * event before its repo registered has no entry at all, where judging it by "not
	 * registered" would make it unconditionally forgettable.
	 *
	 * Deliberately either/or rather than an `||` of both: consulting the projection
	 * for a registered entry could only change the answer if `worktree_root` were
	 * FRESHER than the registry, and projection runs registry → database, so it can
	 * only be staler.
	 *
	 * **"Not on disk" is TWO states, and the second one needs the user to say so.**
	 * `existsSync` cannot tell a deleted folder from one whose VOLUME is absent, and
	 * `RepoForget.classifyRegistryEntry` draws that line: an unplugged external drive
	 * or an unmounted share is `unavailable` — a repo that may well come back — and
	 * `doctor` will not remove it even under `--fix --forget-dead-repos`. This route
	 * used to ask `hasLiveWorktree` alone, so it answered `false` for exactly that
	 * case and ONE confirm deleted twelve child tables' worth of a repository that
	 * was merely unplugged. The gap is platform-weighted rather than academic: on
	 * POSIX an unmounted mountpoint usually survives as an empty directory and reads
	 * as `dead`, while a Windows drive letter or UNC host simply goes. Memories
	 * re-import from the repo when it returns; its sessions and recall receipts have
	 * no second copy anywhere.
	 *
	 * So `unavailable` is refused UNLESS the request carries
	 * `acknowledgeUnavailableVolume`, which the page sets only after a second
	 * confirmation naming the volume. An outright refusal was the first shape and is
	 * wrong in the other direction: the user is the one who knows whether that drive
	 * is coming back, and a control that cannot be reached leaves them no way to
	 * remove a repository they are certain about. Accepting it unconditionally is
	 * equally wrong — the ✕ is drawn from a payload minutes old, so without the flag
	 * a stale click, a re-POST or a scripted request is indistinguishable from an
	 * informed one. The flag is not security (nothing stops a caller sending it); it
	 * is the record that a human was shown the volume-specific sentence, which is the
	 * only thing that separates the two.
	 *
	 * `doctor` stays stricter on purpose: a batch sweep has no row to point at and no
	 * dialog to show, so there is nothing there for such an acknowledgement to mean.
	 */
	async function handleForget(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
		const repoIdentity = typeof body.repoIdentity === "string" ? body.repoIdentity.trim() : "";
		if (!repoIdentity) {
			sendJson(res, 400, { error: "repoIdentity is required" });
			return;
		}
		const entry = (await readRepoRegistry(configDir)).repos.find((r) => r.repoIdentity === repoIdentity);
		// `classifyRegistryEntry` answers `live` on exactly `hasLiveWorktree`, so the
		// pre-existing verdict is unchanged and only `unavailable` is new. `disposable`
		// stays forgettable — that class is fixture garbage the launch path prunes
		// unattended anyway.
		const verdict = entry ? classifyRegistryEntry(entry) : await classifyProjectedRoot(repoIdentity);
		if (verdict === "live") {
			sendJson(res, 409, {
				error: "that repository still exists on disk — pause it with `jolli disable` instead of forgetting it",
			});
			return;
		}
		if (verdict === "unavailable" && body.acknowledgeUnavailableVolume !== true) {
			sendJson(res, 409, {
				error:
					"that repository is on a drive or share this machine cannot reach — reconnect it, or confirm that " +
					"you want its memories deleted anyway",
				// Named so the page can tell this refusal from the live-checkout one and
				// re-ask instead of just reporting failure. A client that does not know
				// the field simply shows the message, which is still true.
				volumeUnavailable: true,
			});
			return;
		}
		// Backup FIRST, and for the same reason `applyRepoRegistryFix` takes one: every
		// step below is irreversible, and a copy taken after the first removal is a copy
		// of the damage. It protects the REGISTRATION, not the memories — that file holds
		// none of them — so it is not what makes this removal safe; the two 409s above
		// are. Doctor needs `--forget-dead-repos` on top because `--fix` is a bundle a
		// user runs to release a lock or reinstall hooks, where forgetting a repo is not
		// what they asked for; a click on one row's ✕ names its target and says so, which
		// is the consent that flag exists to obtain. See `applyRepoRegistryFix`.
		//
		// A backup that could not be written fails the request rather than proceeding:
		// same rule, and its own message, since nothing has been attempted yet and
		// "could not forget" would name the wrong step.
		try {
			const saved = backupRepoRegistry(now(), configDir);
			if (saved) log.info("backed up the repo registry to %s before forgetting %s", saved, repoIdentity);
		} catch (err) {
			log.warn("could not back up the repo registry before forgetting %s: %s", repoIdentity, errMsg(err));
			sendJson(res, 500, { error: `could not back up the repo registry first: ${errMsg(err)}` });
			return;
		}
		try {
			const result = await forgetRepo(repoIdentity, {
				configDir,
				...(options.dbPath ? { dbPath: options.dbPath } : {}),
			});
			if (result.error !== undefined) {
				sendJson(res, 500, { error: `could not forget that repository: ${result.error}` });
				return;
			}
			// "Nothing was there" is reported rather than dressed up as a removal: a
			// page acting on a stale payload otherwise gets a cheerful 200 for an
			// entry another window already removed, and reloads to the same list.
			const removedSomething =
				result.removedFromRegistry ||
				result.repoRowDeleted ||
				result.childRowsDeleted > 0 ||
				result.pendingEventsDeleted > 0;
			if (!removedSomething) {
				sendJson(res, 404, { error: "no repository with that identity is on this machine any more" });
				return;
			}
			sendJson(res, 200, {
				ok: true,
				repoIdentity,
				removedFromRegistry: result.removedFromRegistry,
				repoRowDeleted: result.repoRowDeleted,
				childRowsDeleted: result.childRowsDeleted,
			});
		} catch (err) {
			log.warn("forget failed for %s: %s", repoIdentity, errMsg(err));
			sendJson(res, 500, { error: `could not forget that repository: ${errMsg(err)}` });
		}
	}

	/**
	 * The same verdict for an identity the registry does not list, read off its
	 * projected `worktree_root`.
	 *
	 * Delegates to `classifyRegistryEntry` on a SYNTHETIC single-path entry rather
	 * than re-deciding here. An unregistered row on an unplugged drive is the
	 * identical hazard through the identical button, so the two halves must not be
	 * able to disagree — and the synthesis is exact: this row carries one recorded
	 * path and no `worktrees` list, which is precisely what `recordedRepoPaths` falls
	 * back to. The fields the classifier reads are the three set here.
	 */
	async function classifyProjectedRoot(repoIdentity: string): Promise<RegistryEntryVerdict> {
		// No database means no projected row, which is a real answer rather than a
		// failed read — and it must not take the fail-safe branch below, or an
		// unregistered identity could never be forgotten on a fresh machine.
		if (!existsSync(options.dbPath ?? getDashboardDbPath())) return "dead";
		try {
			const root = await withReadonlyDashboardDb(
				(db) =>
					(
						db.prepare("SELECT worktree_root FROM repos WHERE repo_identity = ?").get(repoIdentity) as
							| { worktree_root: string }
							| undefined
					)?.worktree_root,
				options.dbPath ? { dbPath: options.dbPath } : {},
			);
			// The placeholder `ensureRepoRow` writes stores the identity in this
			// column, which names no directory — see `isMissingWorktree`. Asked first,
			// so the volume walk inside the classifier is never handed an identity
			// string to treat as a path.
			if (root === undefined || root === repoIdentity) return "dead";
			return classifyRegistryEntry({ repoIdentity, repoName: repoIdentity, worktreeRoot: root, enabledAt: "" });
		} catch (err) {
			// Fail SAFE, not open: a read we could not do is not evidence that the
			// checkout is gone, and the cost of being wrong here is deleted memories.
			log.warn("could not read the projected root for %s: %s", repoIdentity, errMsg(err));
			return "live";
		}
	}

	/**
	 * Projects a registry mutation into the `repos` table — the step `jolli enable`
	 * gets for free from the backfill it runs and a long-lived server does not.
	 *
	 * The reachability reads filter on `repos.disabled_at IS NULL`, and this server
	 * never re-backfills, so an unprojected write stays invisible until the next
	 * `jolli dashboard`: a repo added from this page has no row, so it is missing
	 * everywhere, while a paused one keeps counting in every KPI (the repo picker
	 * now lists it, marked paused, rather than dropping it).
	 *
	 * Re-reads the registry rather than taking the caller's entry: `registerRepo` is
	 * the writer, and what has to be projected is the row it LANDED. The paused half
	 * is not read from the registry at all — `projectRepoRegistryState` asks each
	 * clone's own `profile.json`, the machine's one disable switch.
	 *
	 * The ONE write this process makes to the database, and it is now an ordinary
	 * one. It used to stand down unless the file was already at this build's schema
	 * version, because a writable open MIGRATES and the detached server was the one
	 * long-lived process whose build could lag behind the CLI that spawned it. The
	 * server runs in the command process now, so it carries that command's own
	 * build and `executeDashboard` has already migrated the file before binding.
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
		// Every checkout: hooks live in each clone's own `.git/hooks`, while the
		// registry row this resolves from is keyed by repo IDENTITY and therefore
		// speaks for every clone of it.
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
	});

	return server;
}

export interface StartedDashboardServer {
	readonly server: Server;
	readonly port: number;
	/**
	 * True when the preferred port was taken and a later candidate won. The
	 * command prints a line for it: with no state file and no reuse probe, an
	 * unexplained port change is the only symptom of an older `jolli dashboard`
	 * (or anything else) already holding 1818.
	 */
	readonly fellBack: boolean;
}

/**
 * Starts the server on the first available preferred port, falling back to an
 * OS-assigned one.
 *
 * No state file is written. `jolli dashboard` serves in its own process and
 * lives until Ctrl+C, so there is nothing for another process to discover and
 * nothing to leave behind on a hard kill.
 */
export async function startDashboardServer(
	options: Omit<DashboardServerOptions, "port"> & { readonly port?: number; readonly configDir?: string },
): Promise<StartedDashboardServer> {
	const candidates = options.port !== undefined ? [options.port] : [...DASHBOARD_PORTS, 0];
	let lastError: Error | null = null;
	for (const [index, candidate] of candidates.entries()) {
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
			log.info("dashboard listening on 127.0.0.1:%d", port);
			return { server, port, fellBack: index > 0 };
		} catch (err) {
			server.close();
			/* v8 ignore start -- the bind promise only ever rejects with the 'error' event's Error (or a thrown Error), so the `String(err)` arm is unreachable defensive typing. */
			lastError = err instanceof Error ? err : new Error(String(err));
			/* v8 ignore stop */
			// EADDRINUSE on a preferred port → try the next candidate.
		}
	}
	/* v8 ignore next 2 -- candidates always ends with port 0, which cannot collide */
	throw lastError ?? new Error("could not bind the dashboard server");
}
