import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The write-surface POST handlers call these directly (no injectable seam,
// same as the CLI commands they mirror) — mocked so the server-layer tests
// below never touch a real git repo, hook file, or spawned process.
vi.mock("../core/GitOps.js", () => ({
	getProjectRootDir: vi.fn(async (cwd: string) => cwd),
	// The Memories view asks git which commits are still reachable. Mocked so
	// that read stays a pure-unit test — the real one shells out to `rev-list`.
	listReachableCommits: vi.fn(async () => ["reachable-hash"]),
	// The Standup view asks git who the local user is, to filter the board to
	// their own commits. Mocked for the same reason: no `git config` subprocess.
	readLocalGitIdentity: vi.fn(async () => ({ email: "me@example.com", name: "Me" })),
}));
vi.mock("../install/Installer.js", () => ({
	install: vi.fn().mockResolvedValue({ success: true, warnings: [] }),
	uninstall: vi.fn().mockResolvedValue({ success: true, warnings: [] }),
}));
// Partial: only the three registry WRITERS/readers are stubbed. Pure helpers the
// routes also reach (`existingWorktrees`, which fans a mutation out over every
// surviving checkout) stay real, so adding one does not 500 every write test.
// Partial for the same reason as the registry below: the forget route's own
// liveness checks stay real, only the removal is stubbed.
// `classifyRegistryEntry` keeps the REAL implementation (`vi.fn(impl)`), so every
// test that does not override it behaves exactly as the unmocked module would. It
// is wrapped only because its `unavailable` verdict is unreachable on this CI: the
// volume walk needs a path with no existing ancestor, and on POSIX every absolute
// path bottoms out at a live `/` — which is why `volumeReachable` carries an
// `exists` seam that `classifyRegistryEntry`'s callers here cannot reach.
vi.mock("./RepoForget.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RepoForget.js")>();
	return { ...actual, forgetRepo: vi.fn(), classifyRegistryEntry: vi.fn(actual.classifyRegistryEntry) };
});
vi.mock("./RepoRegistry.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./RepoRegistry.js")>()),
	registerRepo: vi.fn().mockResolvedValue({
		repoIdentity: "r1",
		repoName: "acme-api",
		worktreeRoot: "/tmp/acme-api",
		enabledAt: "2026-01-01T00:00:00.000Z",
	}),
	readRepoRegistry: vi.fn().mockResolvedValue({ version: 1, repos: [] }),
}));
// unlink is wrapped (not replaced) so every other state-file test keeps its
// real filesystem behavior — only the non-ENOENT-unlink-error test below ever
// overrides it, and only for its own call.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, unlink: vi.fn(actual.unlink) };
});
// wiki endpoints reach these directly (same no-injectable-seam pattern
// as the other write handlers) — mocked so the server-layer tests stay hermetic.
// Freshness is folder-wide aggregate; rebuild is the whole-folder compile sweep.
vi.mock("../core/WikiFreshness.js", () => ({ getAggregateWikiFreshness: vi.fn() }));
// Reads the machine-global Claude owners ledger, so a real call would answer
// differently on every developer's machine. Its own cases are in
// TranscriptRepair.test.ts.
vi.mock("../core/TranscriptRepair.js", () => ({
	transcriptRepairState: vi.fn().mockResolvedValue("repairable"),
}));
vi.mock("../core/MultiRepoCompile.js", () => ({
	compileAllRepos: vi.fn(async () => ({ repos: [], totalIngested: 0, failed: 0 })),
}));
// Partial mock so the rebuild endpoint's up-front provider gate is controllable;
// default = a usable provider so the happy-path rebuild tests proceed.
vi.mock("../core/LlmClient.js", async (orig) => ({
	...(await orig<typeof import("../core/LlmClient.js")>()),
	resolveLlmCredentialSource: vi.fn(() => "local-agent"),
}));
// The Settings write/read handlers call these directly. Partial so the real
// SettingsValidationError class survives (the handlers `instanceof`-check it), and
// the pure helpers stay real for anyone else; only the effectful entry points are
// stubbed so the endpoint tests never touch config, git or the network.
vi.mock("./SettingsMutations.js", async (orig) => {
	const actual = await orig<typeof import("./SettingsMutations.js")>();
	return {
		...actual,
		applySettings: vi.fn(),
		setSyncSessions: vi.fn(),
		countMissingForCwd: vi.fn(),
		checkLocalFolder: vi.fn(),
		parseSettingsApplyInput: vi.fn(),
	};
});
// The push-control read/write endpoints. Mocked so no PushControlStore touches disk.
vi.mock("../core/PushControl.js", () => ({
	listPushControlRepos: vi.fn(async () => []),
	setRepoPushDisabledByIdentity: vi.fn(async () => ({ disabled: true })),
	triggerReenableDrain: vi.fn(),
}));
// JOLLI-2152: the per-repo Space column's fan-out. Mocked so a space-bindings
// read never fans out real front-door probes; describeSpaceBindingColumn
// (SpaceBindingStatus.js) is left real so the response shape is end-to-end.
vi.mock("../core/PushControlSpaces.js", () => ({
	resolveSpaceBindingsForRepos: vi.fn(async () => new Map()),
}));
// Sign In opens a real browser and blocks on the OAuth callback — mocked to resolve.
vi.mock("../auth/Login.js", () => ({ browserLogin: vi.fn(async () => {}) }));
// Sign Out clears the machine-global auth config — mocked so a test never wipes it.
// Partial: getJolliUrl (read by the sign-in handler) stays real.
vi.mock("../auth/AuthConfig.js", async (orig) => ({
	...(await orig<typeof import("../auth/AuthConfig.js")>()),
	clearAuthCredentials: vi.fn(async () => {}),
}));
// The AI-summary probe spawns a `--version` subprocess — mocked.
vi.mock("../core/localagent/DetectAgents.js", async (orig) => ({
	...(await orig<typeof import("../core/localagent/DetectAgents.js")>()),
	isLocalAgentUsable: vi.fn(async () => true),
}));
// Dynamically imported by the generate-missing / migrate / sync-now handlers. Mocked
// so those routes never spend model budget, re-migrate a real folder, or hit the network.
vi.mock("../backfill/BackfillEngine.js", () => ({
	runBackfill: vi.fn(async () => ({ generated: 0, errors: 0, total: 0 })),
	recentCommitHashes: vi.fn(async () => []),
}));
vi.mock("../core/MemoryBankRebuild.js", () => ({
	rebuildMemoryBank: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../commands/SyncCommand.js", () => ({ runSync: vi.fn(async () => 0) }));
// Partial: resolveAssetsDir stays the REAL implementation (the wiki/graph viewer
// tests need it), wrapped in vi.fn so one test can force the markdown-renderer
// fallback to fail.
vi.mock("../graph/GraphExport.js", async (orig) => {
	const actual = await orig<typeof import("../graph/GraphExport.js")>();
	return { ...actual, resolveAssetsDir: vi.fn(actual.resolveAssetsDir) };
});

import { clearAuthCredentials } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { recentCommitHashes, runBackfill } from "../backfill/BackfillEngine.js";
import { runSync } from "../commands/SyncCommand.js";
import * as gitOps from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isLocalAgentUsable } from "../core/localagent/DetectAgents.js";
import { rebuildMemoryBank } from "../core/MemoryBankRebuild.js";
import { compileAllRepos } from "../core/MultiRepoCompile.js";
import { listPushControlRepos, setRepoPushDisabledByIdentity, triggerReenableDrain } from "../core/PushControl.js";
import { resolveSpaceBindingsForRepos } from "../core/PushControlSpaces.js";
import { NEUTRAL_SOURCE_COLOR, SOURCE_META } from "../core/references/SourceLabels.js";
import { initTelemetry, shutdownTelemetry } from "../core/Telemetry.js";
import { readTelemetryEvents } from "../core/TelemetryBuffer.js";
import { transcriptRepairState } from "../core/TranscriptRepair.js";
import { TRANSCRIPT_SOURCE_LABELS } from "../core/TranscriptSourceLabel.js";
import { getAggregateWikiFreshness } from "../core/WikiFreshness.js";
import { resolveAssetsDir as resolveGraphAssetsDir } from "../graph/GraphExport.js";
import * as installer from "../install/Installer.js";
import { withIsolatedHome } from "../testUtils/isolatedHome.js";
import { withDashboardDb, withReadonlyDashboardDb } from "./DashboardDb.js";
import { type DashboardModel, type DashboardScope, type DashboardView, TOOL_ROWS_LIMIT } from "./DashboardModel.js";
import {
	assembleDashboardHtml,
	createDashboardServer,
	DASHBOARD_HEALTH_SERVICE,
	DASHBOARD_SCRIPT_FILES,
	hasForeignOrigin,
	isAllowedHost,
	type ModelRequest,
	resolveDashboardAssetsDir,
	startDashboardServer,
	withTimeout,
} from "./DashboardServer.js";
import { markMemoriesReachability } from "./DbBackfill.js";
import { buildJourneys } from "./JourneysQuery.js";
import * as repoForget from "./RepoForget.js";
import * as repoRegistry from "./RepoRegistry.js";
import {
	applySettings,
	checkLocalFolder,
	countMissingForCwd,
	parseSettingsApplyInput,
	SettingsValidationError,
	setSyncSessions,
} from "./SettingsMutations.js";
import { applyStatsEvents } from "./StatsWriter.js";

let dir: string;
let assetsDir: string;
const servers: Server[] = [];

function writeTestAssets(base: string): string {
	const assets = join(base, "assets");
	mkdirSync(join(assets, "styles"), { recursive: true });
	mkdirSync(join(assets, "js"), { recursive: true });
	writeFileSync(
		join(assets, "index.html"),
		'<html><head><link rel="stylesheet" href="styles/main.css" /></head><body><!-- scripts:start --><!-- scripts:end --></body></html>',
	);
	writeFileSync(join(assets, "styles", "main.css"), "body{color:red}");
	// Derived, never restated: `resolveDashboardAssetsDir` rejects a tree missing
	// any of these, so a hand-kept copy that fell behind the constant would fail
	// every test using this fixture for a reason having nothing to do with the
	// test. (It had already drifted in order, harmlessly, which is exactly how the
	// membership drift that follows goes unnoticed.)
	for (const f of DASHBOARD_SCRIPT_FILES) writeFileSync(join(assets, "js", f), `/* ${f} */`);
	return assets;
}

/**
 * Writes a Memory Bank parent folder under `base/mb` plus a config dir at
 * `base/cfg` pointing `localFolder` at it, and returns the config dir — the seam
 * the Knowledge/Graph server reads through. Each repo gets `.jolli/config.json`,
 * optional `_wiki/*.md`, optional `.jolli/graph/graph.json`.
 */
function writeMemoryBank(
	base: string,
	repos: ReadonlyArray<{
		dir: string;
		repoName?: string;
		remoteUrl?: string;
		wiki?: Record<string, string>;
		graph?: string;
	}>,
): string {
	const mb = join(base, "mb");
	for (const r of repos) {
		const kbRoot = join(mb, r.dir);
		mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
		// `repoName` defaults to the dir name; `remoteUrl` is optional. A test sets them
		// so it can prove which token a route serves (dir name vs display name vs the
		// repoIdentity derived from the remote).
		writeFileSync(
			join(kbRoot, ".jolli", "config.json"),
			JSON.stringify({
				version: 1,
				sortOrder: "date",
				repoName: r.repoName ?? r.dir,
				...(r.remoteUrl ? { remoteUrl: r.remoteUrl } : {}),
			}),
		);
		if (r.wiki) {
			mkdirSync(join(kbRoot, "_wiki"), { recursive: true });
			for (const [file, body] of Object.entries(r.wiki)) writeFileSync(join(kbRoot, "_wiki", file), body);
		}
		if (r.graph !== undefined) {
			mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
			writeFileSync(join(kbRoot, ".jolli", "graph", "graph.json"), r.graph);
		}
	}
	const configDir = join(base, "cfg");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ localFolder: mb }));
	return configDir;
}

const model = (view: DashboardView): DashboardModel => ({
	schemaVersion: 1,
	view,
	tier: "installed",
	generatedAtMs: 0,
	timeZone: "UTC",
	scope: { kind: "all" },
	repos: [],
	coverage: [],
	menus: { knowledge: false, graph: false },
});

async function listen(server: Server): Promise<number> {
	servers.push(server);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });
}

beforeEach(() => {
	// Module-level `vi.fn()` mocks keep their call history across tests unless it
	// is cleared explicitly. Several assertions in this file care about "never"
	// or "exactly once" for the CURRENT request only, so each test needs a clean
	// slate while preserving the default mock implementations above.
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "jolli-dsrv-"));
	assetsDir = writeTestAssets(dir);
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	rmSync(dir, { recursive: true, force: true });
});

/* `dbPath` and `configDir` are defaulted to the per-test temp dir because
   omitting them is not "unused" — `createDashboardServer` falls back to the
   MACHINE's real `~/.jolli/jollimemory/jollimemory.db` and real repo registry,
   and one write route follows that fallback all the way to an INSERT:
   `projectRegistryEntry` (DashboardServer.ts) projects the registry into
   `repos`. So a write-surface test running with a mocked `readRepoRegistry`
   wrote its own fixture into the developer's live database — a repo named
   `acme-api` at `/tmp/acme-api`, `enabled_at: "t"`, `disabled_at` NULL, which
   every read surface then showed as a real repo in the picker. It is also not
   removable while it owns any row: the NO ACTION foreign keys reject the
   DELETE (`repos_no_delete` used to reject it outright, and was dropped by
   REPOS_DELETE_ALLOWED_DDL), so the cleanup is stamping `disabled_at`.
   Nothing failed — the enable tests assert an exact `{ok, repoIdentity}` body,
   which is what a SUCCESSFUL projection returns — so this was silent both ways.
   `over` still spreads last: a test wanting a specific path passes one. */
function testServer(over: Partial<Parameters<typeof createDashboardServer>[0]> = {}): Server {
	return createDashboardServer({
		port: 0,
		assetsDir,
		dbPath: join(dir, "testserver-default.db"),
		configDir: join(dir, "testserver-default-config"),
		buildModel: async (req) => model(req.view),
		...over,
	});
}

describe("security layers", () => {
	it("isAllowedHost accepts loopback forms only", () => {
		expect(isAllowedHost("127.0.0.1:1818", 1818)).toBe(true);
		expect(isAllowedHost("localhost:1818", 1818)).toBe(true);
		expect(isAllowedHost("LOCALHOST:1818", 1818)).toBe(true);
		expect(isAllowedHost("127.0.0.1", 1818)).toBe(true);
		expect(isAllowedHost("evil.com", 1818)).toBe(false);
		expect(isAllowedHost("127.0.0.1:9999", 1818)).toBe(false);
		expect(isAllowedHost(undefined, 1818)).toBe(false);
	});

	it("hasForeignOrigin rejects anything that is not this server", () => {
		expect(hasForeignOrigin(undefined, 1818)).toBe(false); // no Origin = same-origin nav
		expect(hasForeignOrigin("http://127.0.0.1:1818", 1818)).toBe(false);
		expect(hasForeignOrigin("http://localhost:1818", 1818)).toBe(false);
		expect(hasForeignOrigin("https://evil.com", 1818)).toBe(true);
		expect(hasForeignOrigin("http://evil.com:1818", 1818)).toBe(true);
		expect(hasForeignOrigin("not a url", 1818)).toBe(true);
	});

	it("403s a forged Host (DNS rebinding)", async () => {
		// fetch/undici refuses to override Host, so speak raw HTTP for this one.
		const { request } = await import("node:http");
		const port = await listen(testServer());
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(
				{ host: "127.0.0.1", port, path: "/memories", headers: { Host: "evil.com" } },
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(403);
	});

	it("403s a cross-origin request on every route, including the JSON endpoint", async () => {
		const port = await listen(testServer());
		expect((await get(port, "/api/model", { Origin: "https://evil.com" })).status).toBe(403);
		expect((await get(port, "/memories", { Origin: "https://evil.com" })).status).toBe(403);
	});

	it("serves every read path with no credential — the mutation token gates only POST/probe, never GET pages", async () => {
		const port = await listen(testServer());
		expect((await get(port, "/memories")).status).toBe(200);
		expect((await get(port, "/api/model")).status).toBe(200);
		// `/health` is back, but for the opposite purpose: it identifies this
		// listener to the NEXT launch, which stops it and takes the port. Nothing
		// attaches to a server it did not start.
		const health = await get(port, "/health");
		expect(health.status).toBe(200);
		// `service` is what the next launch requires before it signals the pid —
		// `{ok, pid}` alone is a payload unrelated services emit too, so dropping
		// this field turns the reclaim into "kill whatever holds the port".
		//
		// `platform`/`host` say which pid namespace `pid` belongs to. Dropping them
		// does not fail anything loudly: the launch simply goes back to resolving a
		// container's or WSL's process id locally, where it names either nothing or
		// a stranger it then kills.
		expect(await health.json()).toEqual({
			ok: true,
			pid: process.pid,
			service: DASHBOARD_HEALTH_SERVICE,
			platform: process.platform,
			host: hostname(),
		});
	});

	it("never emits Access-Control-Allow-Origin", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/memories");
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("405s a method that is neither GET nor POST, regardless of token", async () => {
		const port = await listen(testServer({ token: "t" }));
		const res = await fetch(`http://127.0.0.1:${port}/api/model`, {
			method: "PUT",
			headers: { "X-Jolli-Dashboard-Token": "t" },
		});
		expect(res.status).toBe(405);
	});
});

describe("navigation", () => {
	it("serves the page directly at /memories — no handshake, no cookie", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/memories");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("window.__JOLLI_DASHBOARD__");
		// The stylesheet is LINKED, not inlined — and the link resolves. Asserting
		// the tag alone would pass for a URL nothing serves, which is the one way
		// this can break: the page would render unstyled with a 404 in the console.
		const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
		expect(href).toMatch(/^\/assets\/main-[0-9a-f]{8}\.css$/);
		const css = await get(port, href as string);
		expect(css.status).toBe(200);
		expect(await css.text()).toContain("body{color:red}");
		// Nothing is set on the client: no cookie, so nothing to go stale.
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	it("redirects / to /dashboard, and builds no model to decide it", async () => {
		// The destination used to depend on whether anything was enabled, so this
		// route built a whole `repositories` model just to pick between two
		// targets. There is one target now, and "nothing enabled yet" is a state
		// the Dashboard renders rather than a place to be sent.
		const views: string[] = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					views.push(req.view);
					return model(req.view);
				},
			}),
		);
		const root = await get(port, "/");
		expect(root.status).toBe(302);
		expect(root.headers.get("location")).toBe("/dashboard");
		expect(views).toEqual([]);
	});

	it("gates nothing — every destination renders with zero repos", async () => {
		// The gate redirected these three to /repositories. That page is gone, so
		// a gate could only redirect to a 404 or to itself.
		const port = await listen(testServer());
		for (const path of ["/dashboard", "/dashboard/standup", "/memories"]) {
			expect((await get(port, path)).status, path).toBe(200);
		}
	});

	it("404s the retired /repositories page and its Pause/Resume endpoints", async () => {
		const port = await listen(testServer({ token: "t" }));
		expect((await get(port, "/repositories")).status).toBe(404);
		for (const path of ["/api/repos/disable", "/api/repos/resume"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "X-Jolli-Dashboard-Token": "t" },
				body: JSON.stringify({ repoIdentity: "r1" }),
			});
			expect(res.status, path).toBe(404);
		}
	});

	// One page, one URL: the legacy aliases were removed rather than kept as
	// redirects, so nav links / range control / repo filter cannot disagree
	// about where a view lives.
	it("404s the retired /stats and /standup aliases", async () => {
		const port = await listen(testServer());
		for (const path of ["/stats", "/standup"]) {
			expect((await get(port, path)).status, path).toBe(404);
		}
	});

	it("redirects the retired /decisions to /memories, permanently — a bookmark must not 404", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/decisions");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/memories");
	});

	it("serves the gated destinations once a repo is enabled", async () => {
		const port = await listen(
			testServer({
				buildModel: async (req) => ({
					...model(req.view),
					repos: [{ repoIdentity: "r1", repoName: "r1", worktreeRoot: "/r1", sessionsThisWeek: 0 }],
				}),
			}),
		);
		for (const path of ["/dashboard", "/dashboard/standup", "/memories"]) {
			expect((await get(port, path)).status, path).toBe(200);
		}
	});
});

describe("routes", () => {
	it("serves /api/model as JSON for the requested view and scope", async () => {
		const scopes: DashboardScope[] = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					scopes.push(req.scope);
					return model(req.view);
				},
			}),
		);
		const res = await get(port, "/api/model?view=standup&repo=r1");
		expect(res.status).toBe(200);
		expect(((await res.json()) as DashboardModel).view).toBe("standup");
		expect(scopes).toEqual([{ kind: "repo", repoIdentities: ["r1"] }]);
	});

	it("threads the standup whole-week paging offset from ?offset=, rejecting non-integer and negative", async () => {
		const reqs: ModelRequest[] = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					reqs.push(req);
					return model(req.view);
				},
			}),
		);
		await get(port, "/api/model?view=standup&offset=2");
		await get(port, "/api/model?view=standup");
		await get(port, "/api/model?view=standup&offset=-1");
		await get(port, "/api/model?view=standup&offset=abc");
		// Deep-linkable, so an out-of-range magnitude is clamped to the furthest page
		// (STANDUP_MAX_OFFSET = 52) rather than dropped or forwarded to addLocalDays' loop.
		await get(port, "/api/model?view=standup&offset=99999999");
		expect(reqs.map((r) => r.standupOffset)).toEqual([2, undefined, undefined, undefined, 52]);
	});

	it("reads a multi-repo scope from REPEATED repo params", async () => {
		// Repeated rather than comma-joined: an identity is a remote URL, so any
		// delimiter is a character one may legitimately contain.
		const scopes: DashboardScope[] = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					scopes.push(req.scope);
					return model(req.view);
				},
			}),
		);
		await get(port, "/api/model?view=stats&repo=r1&repo=https%3A%2F%2Fgithub.com%2Fa%2Fb");
		expect(scopes).toEqual([{ kind: "repo", repoIdentities: ["r1", "https://github.com/a/b"] }]);
	});

	it("reads a blank repo param as all repos, not as an identity nothing matches", async () => {
		const scopes: DashboardScope[] = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					scopes.push(req.scope);
					return model(req.view);
				},
			}),
		);
		await get(port, "/api/model?view=stats&repo=");
		expect(scopes).toEqual([{ kind: "all" }]);
	});

	it("defaults /api/model to the stats view and the all scope", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/api/model");
		expect(((await res.json()) as DashboardModel).view).toBe("stats");
	});

	// A cross-site `no-cors` GET reaches this route (no Origin to reject, a
	// loopback Host to accept), so the token plus Fetch-Metadata is what
	// separates our own page's poll from one. The settings view is what that
	// separation now protects — it is the only payload here carrying masked keys,
	// sign-in state and the Memory Bank path. Every other view stays a free
	// public read, including for a caller with no token at all: `curl
	// /api/model` must keep working. (This suite replaces the retired
	// `allowModelSpend` gate — no GET on this server spends money any more.)
	describe("/api/model settings gate", () => {
		const settingsServer = () => testServer({ token: "tok" });

		it("serves the settings view to our own token-bearing, same-site page", async () => {
			const port = await listen(settingsServer());
			const res = await get(port, "/api/model?view=settings", {
				"X-Jolli-Dashboard-Token": "tok",
				"Sec-Fetch-Site": "same-origin",
			});
			expect(res.status).toBe(200);
			expect(((await res.json()) as DashboardModel).view).toBe("settings");
		});

		// No Fetch-Metadata at all is `curl`, which the token alone answers for.
		it("serves the settings view to a token-bearing client that sends no Fetch-Metadata", async () => {
			const port = await listen(settingsServer());
			const res = await get(port, "/api/model?view=settings", { "X-Jolli-Dashboard-Token": "tok" });
			expect(res.status).toBe(200);
		});

		it("refuses the settings view without a token", async () => {
			const port = await listen(settingsServer());
			expect((await get(port, "/api/model?view=settings")).status).toBe(403);
		});

		it("refuses the settings view when the token is wrong", async () => {
			const port = await listen(settingsServer());
			const res = await get(port, "/api/model?view=settings", { "X-Jolli-Dashboard-Token": "nope" });
			expect(res.status).toBe(403);
		});

		// The half a token cannot cover: a hostile tab that somehow has the token
		// still announces itself in `Sec-Fetch-Site`.
		it("refuses the settings view cross-site even with a valid token", async () => {
			const port = await listen(settingsServer());
			const res = await get(port, "/api/model?view=settings", {
				"X-Jolli-Dashboard-Token": "tok",
				"Sec-Fetch-Site": "cross-site",
			});
			expect(res.status).toBe(403);
		});

		it("still answers a token-free call for every other view", async () => {
			const port = await listen(settingsServer());
			const res = await get(port, "/api/model?view=stats", { "Sec-Fetch-Site": "cross-site" });
			expect(res.status).toBe(200);
			expect(((await res.json()) as DashboardModel).view).toBe("stats");
		});
	});

	it("serves every view as a page and over the API, and rejects an unknown one", async () => {
		const port = await listen(testServer());
		const page = await get(port, "/memories");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toBe("text/html");
		// The API speaks view TOKENS, which are no longer the paths.
		for (const view of ["stats", "standup", "memories", "knowledge", "graph"] as const) {
			const api = await get(port, `/api/model?view=${view}`);
			expect(((await api.json()) as DashboardModel).view).toBe(view);
		}
		// An unknown ?view falls back to stats rather than erroring, but an
		// unknown PATH is still a 404 — a typo'd URL must not silently serve
		// something else.
		const fallback = await get(port, "/api/model?view=manager");
		expect(((await fallback.json()) as DashboardModel).view).toBe("stats");
		expect((await get(port, "/manager")).status).toBe(404);
	});

	it("maps the new nav paths to their view tokens — /dashboard and /dashboard/standup reuse stats/standup", async () => {
		const withRepo = testServer({
			buildModel: async (req) => ({
				...model(req.view),
				repos: [{ repoIdentity: "r1", repoName: "r1", worktreeRoot: "/r1", sessionsThisWeek: 0 }],
			}),
		});
		const port = await listen(withRepo);
		const cases: ReadonlyArray<[string, DashboardModel["view"]]> = [
			["/dashboard", "stats"],
			["/dashboard/standup", "standup"],
			["/skills", "skills"],
			// The router speaks PATHS and the API speaks view TOKENS, and the two lists
			// are separate for that reason (see `VIEW_TOKENS`) — so a page reachable at
			// its path can still be unreachable through `?view=`, silently falling back
			// to Stats. Every pair belongs in this table.
			["/mcps", "mcps"],
			["/memories", "memories"],
			["/knowledge", "knowledge"],
			["/graph", "graph"],
		];
		for (const [path, view] of cases) {
			const page = await get(port, path);
			expect(page.status, path).toBe(200);
			const api = await get(port, `/api/model?view=${view}`);
			expect(((await api.json()) as DashboardModel).view, path).toBe(view);
		}
	});

	it("does not expose the retired graph staleness endpoint", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/api/graph-version?repo=r1");
		expect(res.status).toBe(404);
	});

	describe("wiki-viewer & graph-viewer iframes", () => {
		it("renders a wiki page via marked, sandbox-isolated (frame-ancestors self, no-store)", async () => {
			// TWO repos SHARE the display name ("Repo Alpha"), so the served repo's token
			// must be its repoIdentity (to disambiguate) — differing from BOTH the kb dir
			// name ("repoA") and the shared display name. This proves the route injects
			// the derived identity via detailRepoToken, not either name.
			const configDir = writeMemoryBank(dir, [
				{
					dir: "repoA",
					repoName: "Repo Alpha",
					remoteUrl: "git@github.com:acme/repo-alpha.git",
					wiki: { "topic--a.md": "# Hello\n\nbody" },
				},
				{ dir: "repoB", repoName: "Repo Alpha", remoteUrl: "git@github.com:other/repo-alpha.git" },
			]);
			const port = await listen(testServer({ configDir }));
			const res = await get(port, "/wiki-viewer?kb=repoA&file=topic--a.md");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/html");
			expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts; frame-ancestors 'self'");
			expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
			expect(res.headers.get("cache-control")).toBe("no-store");
			const body = await res.text();
			// The vendored marked engine is inlined, and the page body is rendered by it.
			expect(body).toContain('id="md"');
			expect(body).toContain("window.marked.parse(");
			// The document must NOT carry the dashboard mutation token.
			expect(body).not.toContain("__JOLLI_DASHBOARD_TOKEN__");
			// It carries the link-rewrite script: source-commit links postMessage the
			// hash up to the parent, and other relative links are de-linked. (The
			// script's actual classification behavior is covered end-to-end in
			// WikiViewerScript.test.ts against real href shapes.)
			expect(body).toContain('window.parent.postMessage({type:"jolli-wiki-nav",hash:hash}');
			expect(body).toContain("a.parentNode.replaceChild(s,a)");
			// The owning repo's repoIdentity (derived from its remote URL) is injected as
			// the detailRepo scope token — NOT the kb dir name ("repoA") nor the display
			// name ("Repo Alpha"). End-to-end proof that resolveKbRepo → buildWikiViewerHtml
			// serves the identity (what resolveScope matches, unique across same-named
			// repos), not either name; all three values differ so it can't pass by accident.
			expect(body).toContain('window.__JOLLI_WIKI_DETAIL_REPO__ = "https://github.com/acme/repo-alpha";');
			expect(body).not.toContain('window.__JOLLI_WIKI_DETAIL_REPO__ = "repoA"');
			expect(body).not.toContain('window.__JOLLI_WIKI_DETAIL_REPO__ = "Repo Alpha"');
		});

		it("neutralizes a </script> breakout payload in the wiki body", async () => {
			const payload = "# Title\n\n</script><script>window.parent.__JOLLI_DASHBOARD_TOKEN__</script>";
			const configDir = writeMemoryBank(dir, [{ dir: "repoA", wiki: { "topic--evil.md": payload } }]);
			const port = await listen(testServer({ configDir }));
			const body = await (await get(port, "/wiki-viewer?kb=repoA&file=topic--evil.md")).text();
			// The raw closing tag must NOT survive verbatim — escapeForInlineScript
			// rewrote every `<` to `<`, so the inline <script> cannot be closed.
			expect(body).not.toContain("</script><script>window.parent");
			expect(body).toContain("\\u003c/script>\\u003cscript>window.parent");
		});

		it("400s a missing param and a bad file name (path-traversal guard)", async () => {
			const configDir = writeMemoryBank(dir, [{ dir: "repoA", wiki: { "topic--a.md": "# x\n" } }]);
			const port = await listen(testServer({ configDir }));
			expect((await get(port, "/wiki-viewer?kb=repoA")).status).toBe(400);
			expect((await get(port, "/wiki-viewer?file=topic--a.md")).status).toBe(400);
			expect((await get(port, "/wiki-viewer?kb=repoA&file=../../secret.md")).status).toBe(400);
		});

		it("404s an unknown repo and a missing wiki file with a framed message", async () => {
			const configDir = writeMemoryBank(dir, [{ dir: "repoA", wiki: { "topic--a.md": "# x\n" } }]);
			const port = await listen(testServer({ configDir }));
			const unknownRepo = await get(port, "/wiki-viewer?kb=nope&file=topic--a.md");
			expect(unknownRepo.status).toBe(404);
			expect(await unknownRepo.text()).toContain("could not be found");
			const missingFile = await get(port, "/wiki-viewer?kb=repoA&file=topic--missing.md");
			expect(missingFile.status).toBe(404);
		});

		it("frames a repo's graph (inlined __EMBEDDED_GRAPH__) with an in-header repo switcher", async () => {
			const configDir = writeMemoryBank(dir, [
				{ dir: "repoA", graph: '{"schemaVersion":4,"nodes":[]}' },
				{ dir: "repoB", graph: "{}" },
			]);
			const port = await listen(testServer({ configDir }));
			const res = await get(port, "/graph-viewer?kb=repoA");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts; frame-ancestors 'self'");
			expect(res.headers.get("cache-control")).toBe("no-store");
			const body = await res.text();
			expect(body).toContain("__EMBEDDED_GRAPH__");
			expect(body).not.toContain("__JOLLI_DASHBOARD_TOKEN__");
			// The repo switcher lists every graph-bearing repo, current one selected.
			expect(body).toContain('id="jolli-repo-switcher"');
			expect(body).toContain('<option value="repoA" selected>repoA</option>');
			expect(body).toContain('<option value="repoB">repoB</option>');
		});

		it("serves a topic's RAW markdown body over /graph-wiki (utf-8, no-store) for the graph reader", async () => {
			const configDir = writeMemoryBank(dir, [
				{ dir: "repoA", wiki: { "topic--auth.md": "# Auth\n\nbody text" } },
			]);
			const port = await listen(testServer({ configDir }));
			const res = await get(port, "/graph-wiki?kb=repoA&slug=auth");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
			expect(res.headers.get("cache-control")).toBe("no-store");
			// Raw markdown (the viz renders it client-side) — not a framed HTML document.
			expect(await res.text()).toBe("# Auth\n\nbody text");
		});

		it("/graph-wiki 400s missing params + a traversal slug, 404s an unknown repo / missing topic", async () => {
			const configDir = writeMemoryBank(dir, [{ dir: "repoA", wiki: { "topic--auth.md": "# x\n" } }]);
			const port = await listen(testServer({ configDir }));
			expect((await get(port, "/graph-wiki?kb=repoA")).status).toBe(400); // missing slug
			expect((await get(port, "/graph-wiki?slug=auth")).status).toBe(400); // missing kb
			expect((await get(port, "/graph-wiki?kb=repoA&slug=..")).status).toBe(400); // traversal
			expect((await get(port, "/graph-wiki?kb=repoA&slug=Bad_Slug")).status).toBe(400); // wrong shape
			expect((await get(port, "/graph-wiki?kb=nope&slug=auth")).status).toBe(404); // unknown repo
			expect((await get(port, "/graph-wiki?kb=repoA&slug=missing")).status).toBe(404); // missing topic
		});

		it("classes the REAL <body> for light theme (not the CSS comment's literal <body>)", async () => {
			const configDir = writeMemoryBank(dir, [{ dir: "repoA", graph: '{"schemaVersion":4,"nodes":[]}' }]);
			const port = await listen(testServer({ configDir }));
			// Assert on the body tag that follows </head> — the graph CSS contains a
			// literal "<body>" in a comment, so a lax `toContain` would pass on the
			// wrong match (the bug this guards against).
			const dark = await (await get(port, "/graph-viewer?kb=repoA")).text();
			expect(dark).toMatch(/<\/head>\s*<body>/);
			const light = await (await get(port, "/graph-viewer?kb=repoA&theme=light")).text();
			expect(light).toMatch(/<\/head>\s*<body class="vscode-light">/);
		});

		it("400s a missing kb, 404s an unknown repo, and shows guidance when a repo has no graph", async () => {
			const configDir = writeMemoryBank(dir, [{ dir: "repoA" }]);
			const port = await listen(testServer({ configDir }));
			expect((await get(port, "/graph-viewer")).status).toBe(400);
			expect((await get(port, "/graph-viewer?kb=nope")).status).toBe(404);
			const noGraph = await get(port, "/graph-viewer?kb=repoA");
			expect(noGraph.status).toBe(200);
			expect(await noGraph.text()).toContain("No knowledge graph yet");
		});
	});

	it("passes a valid dimension through to the model builder and drops an invalid one", async () => {
		const dimensions: Array<string | undefined> = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					dimensions.push(req.dimension);
					return model(req.view);
				},
			}),
		);
		await get(port, "/api/model?dimension=branch");
		await get(port, "/api/model?dimension=; DROP TABLE");
		await get(port, "/memories?dimension=ticket");
		expect(dimensions).toEqual(["branch", undefined, "ticket"]);
	});

	it("passes a hash query param through for the memories detail view", async () => {
		const hashes: Array<string | undefined> = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					hashes.push(req.hash);
					return model(req.view);
				},
			}),
		);
		await get(port, "/memories?hash=abc123");
		await get(port, "/memories");
		expect(hashes).toEqual(["abc123", undefined]);
	});

	it("passes the range and custom bounds through, dropping an unknown range", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					seen.push({ range: req.range, from: req.customFrom, to: req.customTo });
					return model(req.view);
				},
			}),
		);
		await get(port, "/memories?range=month");
		await get(port, "/memories?range=custom&from=2026-07-01&to=2026-07-15");
		await get(port, "/api/model?range=fortnight");
		// Bounds are forwarded verbatim — validation lives in resolveWindow, so the
		// server has exactly one job here and cannot drift out of step with it.
		await get(port, "/api/model?range=custom&from=nonsense&to=2026-07-15");
		expect(seen).toEqual([
			{ range: "month", from: undefined, to: undefined },
			{ range: "custom", from: "2026-07-01", to: "2026-07-15" },
			{ range: undefined, from: undefined, to: undefined },
			{ range: "custom", from: "nonsense", to: "2026-07-15" },
		]);
	});

	it("404s unknown paths and 500s a failing model build without crashing", async () => {
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					if (req.view === "standup") throw new Error("db exploded");
					return model(req.view);
				},
			}),
		);
		expect((await get(port, "/nope")).status).toBe(404);
		expect((await get(port, "/dashboard/standup")).status).toBe(500);
		// Still alive afterwards.
		expect((await get(port, "/memories")).status).toBe(200);
	});

	it("serves the journeys page and its model token", async () => {
		const port = await listen(
			testServer({
				buildModel: async (req) => ({
					...model(req.view),
					repos: [{ repoIdentity: "r1", repoName: "r1", worktreeRoot: "/r1", sessionsThisWeek: 0 }],
					...(req.view === "journeys"
						? {
								coaching: {
									roster: {
										label: "You",
										planFirst: { availability: "unavailable" },
										skills: { availability: "unavailable" },
										cost: { availability: "unavailable" },
										recall: { availability: "unavailable" },
										turnaround: { availability: "unavailable" },
										friction: { availability: "unavailable" },
									},
									adoptNext: [],
									queue: [],
									patterns: { established: [], emerging: [] },
									hero: [],
									featured: { smoothest: null, hardest: null },
									journeyCount: 0,
									indexedCommits: 0,
									windowStartMs: 0,
									windowEndMs: 0,
								},
							}
						: {}),
				}),
			}),
		);
		const page = await get(port, "/dashboard/journeys");
		expect(page.status).toBe(200);
		const res = await get(port, "/api/model?view=journeys");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { view: string; coaching?: unknown };
		expect(body.view).toBe("journeys");
		expect(body.coaching).toBeDefined();
	});

	it("rejects an /api/journey call with no id", async () => {
		const port = await listen(testServer());
		const response = await get(port, "/api/journey?repo=repo-a");
		expect(response.status).toBe(400);
	});

	it("404s an /api/journey id no window contains", async () => {
		const dbPath = join(dir, "journey-detail.db");
		const configDir = join(dir, "config-journey");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(testServer({ dbPath, configDir }));
		const response = await get(port, "/api/journey?repo=repo-a&id=T%00repo-a%00NOPE-1");
		expect(response.status).toBe(404);
	});

	// `id` is namespaced by repo identity already (JourneyKey.ts's SEP-joined
	// key), so `repo=` is an optional scope narrowing, never a requirement —
	// unlike `/api/memories`' bare commit hash, an id lookup under an "all
	// repos" scope cannot collide across repos.
	it("resolves an /api/journey call by id alone, with no repo param", async () => {
		const dbPath = join(dir, "journey-no-repo.db");
		const configDir = join(dir, "config-journey-no-repo");
		const nowMs = Date.now();
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-a",
						repoName: "repo-a",
						worktreeRoot: "/w/repo-a",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const journeyId = await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-a") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'reachable-hash', NULL, NULL, 'reachable-hash', 0, ?, 1, 1, ?)`,
				).run(id, JSON.stringify({ commitHash: "reachable-hash", branch: "solo", topics: [] }), nowMs);
				return buildJourneys(db, { kind: "all" }, nowMs - 86_400_000, nowMs + 86_400_000).journeys[0]?.id ?? "";
			},
			{ dbPath },
		);
		expect(journeyId).not.toBe("");

		const port = await listen(testServer({ dbPath, configDir }));
		const response = await get(
			port,
			`/api/journey?id=${encodeURIComponent(journeyId)}&fromMs=${nowMs - 86_400_000}&toMs=${nowMs + 86_400_000}`,
		);
		expect(response.status).toBe(200);
	});

	// Regression test for the midnight bug, expressed without needing a clock:
	// a journey id is only meaningful within the window that grouped it, so a
	// caller must be able to hand that exact window back rather than the route
	// re-resolving one of its own (which — with a REAL clock — could straddle a
	// local-midnight boundary and disagree with the feed about what "30d" means).
	it("resolves a journey via explicit fromMs/toMs even when the current relative window would exclude it", async () => {
		const dbPath = join(dir, "journey-explicit-window.db");
		const configDir = join(dir, "config-journey-explicit-window");
		const nowMs = Date.now();
		// Well outside the default 30-day relative window `resolveWindow` falls
		// back to when no range/from/to is given.
		const oldCommitMs = nowMs - 200 * 86_400_000;
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-a",
						repoName: "repo-a",
						worktreeRoot: "/w/repo-a",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const journeyId = await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-a") as {
					id: number;
				};
				// `listReachableCommits` is stubbed to return "reachable-hash" only
				// (see the module-level `vi.mock` above), so the commit hash matters.
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'reachable-hash', NULL, NULL, 'reachable-hash', 0, ?, 1, 1, ?)`,
				).run(id, JSON.stringify({ commitHash: "reachable-hash", branch: "solo", topics: [] }), oldCommitMs);
				// A wide window sees the commit — this is the id the feed would have
				// shown it under, had the feed itself been asked over that window.
				return buildJourneys(db, { kind: "all" }, oldCommitMs - 1000, nowMs + 1000).journeys[0]?.id ?? "";
			},
			{ dbPath },
		);
		expect(journeyId).not.toBe("");

		const port = await listen(testServer({ dbPath, configDir }));

		// Without explicit bounds, the route falls back to the default relative
		// window, which genuinely does not reach a 200-day-old commit.
		const relative = await get(port, `/api/journey?repo=repo-a&id=${encodeURIComponent(journeyId)}`);
		expect(relative.status).toBe(404);

		// The feed's own bounds, echoed back by the caller, resolve the SAME
		// journey — this is the fix: the route must not re-derive a window.
		const explicit = await get(
			port,
			`/api/journey?repo=repo-a&id=${encodeURIComponent(journeyId)}&fromMs=${oldCommitMs - 1000}&toMs=${nowMs + 1000}`,
		);
		expect(explicit.status).toBe(200);
	});

	// Both-or-neither: a half-supplied pair must not mix one echoed bound with
	// one freshly-resolved one, which would silently widen or narrow the query
	// in a way nobody asked for.
	it("falls back to the resolved window when only one of fromMs/toMs is supplied, rather than mixing", async () => {
		const dbPath = join(dir, "journey-half-bound.db");
		const configDir = join(dir, "config-journey-half-bound");
		const nowMs = Date.now();
		const oldCommitMs = nowMs - 200 * 86_400_000;
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-a",
						repoName: "repo-a",
						worktreeRoot: "/w/repo-a",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const journeyId = await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-a") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'reachable-hash', NULL, NULL, 'reachable-hash', 0, ?, 1, 1, ?)`,
				).run(id, JSON.stringify({ commitHash: "reachable-hash", branch: "solo", topics: [] }), oldCommitMs);
				return buildJourneys(db, { kind: "all" }, oldCommitMs - 1000, nowMs + 1000).journeys[0]?.id ?? "";
			},
			{ dbPath },
		);
		expect(journeyId).not.toBe("");

		const port = await listen(testServer({ dbPath, configDir }));

		// `fromMs` alone reaches back far enough to include the old commit — if it
		// were mixed with a freshly-resolved `toMs` (today) this would 200. The
		// both-or-neither rule instead falls all the way back to the resolved
		// 30-day window, which excludes it.
		const halfBound = await get(
			port,
			`/api/journey?repo=repo-a&id=${encodeURIComponent(journeyId)}&fromMs=${oldCommitMs - 1000}`,
		);
		expect(halfBound.status).toBe(404);

		// `Number.parseInt` accepts a trailing garbage suffix ("123abc" -> 123);
		// a malformed bound must fall back to the resolved window exactly like a
		// missing one, not silently parse a prefix of it.
		const malformed = await get(
			port,
			`/api/journey?repo=repo-a&id=${encodeURIComponent(journeyId)}&fromMs=${oldCommitMs - 1000}abc&toMs=${nowMs + 1000}`,
		);
		expect(malformed.status).toBe(404);

		// A reversed pair parses fine as two integers but describes no real
		// window; it must fall back rather than be honoured backwards.
		const reversed = await get(
			port,
			`/api/journey?repo=repo-a&id=${encodeURIComponent(journeyId)}&fromMs=${nowMs + 1000}&toMs=${oldCommitMs - 1000}`,
		);
		expect(reversed.status).toBe(404);
	});

	it("serves the whole journeys model from /api/journeys", async () => {
		const dbPath = join(dir, "journeys-feed.db");
		const configDir = join(dir, "config-journeys-feed");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(testServer({ dbPath, configDir }));
		const res = await get(port, "/api/journeys?range=30d");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { journeys: unknown[]; windowStartMs: number; windowEndMs: number };
		expect(Array.isArray(body.journeys)).toBe(true);
		expect(body.windowStartMs).toBeLessThan(body.windowEndMs);
	});

	it("honours explicit fromMs/toMs bounds", async () => {
		const dbPath = join(dir, "journeys-explicit.db");
		const configDir = join(dir, "config-journeys-explicit");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(testServer({ dbPath, configDir }));
		const from = 1_700_000_000_000;
		const to = from + 86_400_000;
		const res = await get(port, `/api/journeys?fromMs=${from}&toMs=${to}`);
		const body = (await res.json()) as { windowStartMs: number; windowEndMs: number };
		// Echoed back verbatim — the grouping is window-dependent, so a route that
		// re-resolved would answer about a different set than the caller asked for.
		expect(body.windowStartMs).toBe(from);
		expect(body.windowEndMs).toBe(to);
	});

	it("falls back to the range when only one bound is supplied", async () => {
		const dbPath = join(dir, "journeys-half-bound.db");
		const configDir = join(dir, "config-journeys-half-bound");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(testServer({ dbPath, configDir }));
		const res = await get(port, "/api/journeys?range=30d&fromMs=1700000000000");
		const body = (await res.json()) as { windowStartMs: number };
		// One bound alone is a window nobody computed; mixing it with a freshly
		// derived one would silently produce a third window.
		expect(body.windowStartMs).not.toBe(1_700_000_000_000);
	});

	it("clamps an explicit window wider than the scan ceiling", async () => {
		const dbPath = join(dir, "journeys-clamp.db");
		const configDir = join(dir, "config-journeys-clamp");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(testServer({ dbPath, configDir }));
		// A hostile span from the epoch to the far future must not reach the
		// read path at full width — the echo-back reports the clamped window
		// instead of the requested one.
		const res = await get(port, "/api/journeys?fromMs=0&toMs=9007199254740991");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { windowStartMs: number; windowEndMs: number };
		expect(body.windowEndMs - body.windowStartMs).toBeLessThanOrEqual(366 * 86_400_000);
	});

	it("carries the test-first signal on feed journeys, so the Patterns 'test-first' filter can match", async () => {
		// The Patterns page counts test-first journeys over the SAME window with
		// `withTests`, and clicking that pattern filters the FEED to them. If the
		// feed route omits `withTests`, every feed journey's `tested` is absent, the
		// filter matches nothing, and a pattern reporting N journeys opens an empty
		// list ("No journeys match this filter."). The feed must build the same
		// signal the pattern counted.
		const dbPath = join(dir, "journeys-testfirst.db");
		const configDir = join(dir, "config-journeys-testfirst");
		const at = 1_754_000_000_000;
		await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at, bootstrap_state) VALUES (1, 'repo-a', 'repo-a', '/tmp/repo-a', ?, 'done')",
				).run(new Date(at).toISOString());
				// `listReachableCommits` is mocked to `["reachable-hash"]`, and the feed
				// route drops any commit not still carried by a branch — so the seeded
				// commit must be that hash or the journey is filtered out before its
				// `tested` signal is ever read.
				const summary = {
					commitHash: "reachable-hash",
					commitMessage: "do the thing",
					commitDate: new Date(at).toISOString(),
					branch: "feature/reachable",
				};
				db.prepare(
					"INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms) VALUES (1, 'reachable-hash', NULL, NULL, 'reachable-hash', ?, ?, ?, ?)",
				).run(JSON.stringify(summary), at, at, at);
				const stored = {
					sessions: [{ sessionId: "s-t1", source: "codex", entries: [], testRuns: [at - 60_000] }],
				};
				db.prepare(
					"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (1, 't1', ?, ?)",
				).run(deflateSync(Buffer.from(JSON.stringify(stored), "utf8")), at);
				db.prepare(
					"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (1, 'reachable-hash', 't1')",
				).run();
			},
			{ dbPath },
		);
		const port = await listen(testServer({ dbPath, configDir }));
		const res = await get(port, `/api/journeys?fromMs=${at - 86_400_000}&toMs=${at + 86_400_000}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			journeys: ReadonlyArray<{ tested?: { availability: string; testFirst?: boolean } }>;
		};
		expect(body.journeys[0]?.tested).toEqual({ availability: "measured", testFirst: true });
	});

	it("500s /api/journeys with a generic message when the read fails", async () => {
		// A database the service cannot open — the route's try/catch must turn
		// it into the same generic 500 as any other read failure, never surface
		// the underlying path or error text.
		const port = await listen(testServer({ dbPath: join(dir, "no-such-dir", "missing.db") }));
		const res = await get(port, "/api/journeys?range=30d");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("could not read journeys");
		expect(body.error).not.toContain("no-such-dir");
	});

	it("500s /api/journey with a generic message when the read fails", async () => {
		const port = await listen(testServer({ dbPath: join(dir, "no-such-dir", "missing.db") }));
		const res = await get(port, "/api/journey?range=30d&id=T%00repo-a%00X");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("could not read that journey");
		expect(body.error).not.toContain("no-such-dir");
	});
});

/**
 * Where `main.js`'s tag starts — the "app scripts begin here" marker the inline
 * data blocks must precede.
 *
 * ⚠ Not `indexOf("/assets/main-")`: the stylesheet is `main-<hash>.css` and it
 * sits in the `<head>`, so the loose match finds it first and every ordering
 * assertion silently compares against the wrong element.
 */
function mainScriptAt(html: string): number {
	const at = html.search(/<script src="\/assets\/main-[0-9a-f]{8}\.js"/);
	expect(at, "main.js script tag").toBeGreaterThan(-1);
	return at;
}

describe("assembleDashboardHtml", () => {
	it("throws on a template missing its markers", () => {
		writeFileSync(join(assetsDir, "index.html"), "<html><body>no markers</body></html>");
		expect(() => assembleDashboardHtml(assetsDir, "{}")).toThrow(/stylesheet marker/);
		writeFileSync(join(assetsDir, "index.html"), '<html><link rel="stylesheet" href="styles/main.css" /></html>');
		expect(() => assembleDashboardHtml(assetsDir, "{}")).toThrow(/scripts block/);
	});

	it("neutralizes </script> breakouts in the embedded model", () => {
		const html = assembleDashboardHtml(assetsDir, JSON.stringify({ title: "</script><script>alert(1)" }));
		expect(html).not.toContain("</script><script>alert(1)");
		expect(html).toContain("\\u003c/script>");
	});

	// A `<!--` in model text used to survive the escape and put the tokenizer
	// into script-data-escaped state, so the data block's own `</script>` no
	// longer closed it and every app script after it was swallowed as text.
	it("neutralizes a <!-- comment opener in the embedded model", () => {
		const html = assembleDashboardHtml(assetsDir, JSON.stringify({ title: "<!--<script>" }));
		expect(html).not.toContain("<!--");
		// The model block still closes: the app scripts after it stay real tags.
		// Asserted against the LINKED script now that the bodies are external — the
		// property under test is the tokenizer state, not where the code lives.
		expect(html).toMatch(/<script src="\/assets\/main-[0-9a-f]{8}\.js"><\/script>/);
		expect(html.indexOf("window.__JOLLI_DASHBOARD__")).toBeLessThan(mainScriptAt(html));
	});

	// The agent-name half of `JD.sourceBadge`. Inlined from the CLI's own map so
	// the page holds no copy of it — asserted against the constant rather than
	// against literals, which is the whole point: a label added there must reach
	// the dashboard without anyone editing an asset file.
	it("inlines the transcript source labels ahead of the app scripts", () => {
		const html = assembleDashboardHtml(assetsDir, "{}");
		expect(html).toContain(`window.__JOLLI_SOURCE_LABELS__ = ${JSON.stringify(TRANSCRIPT_SOURCE_LABELS)}`);
		expect(html.indexOf("__JOLLI_SOURCE_LABELS__")).toBeLessThan(mainScriptAt(html));
	});

	// Unlike the token, which is omitted when absent: a page without the labels
	// silently prints raw transcript tags (`cursor-cli`), and there is no caller
	// that would want that.
	it("inlines the labels even with no mutation token", () => {
		expect(assembleDashboardHtml(assetsDir, "{}")).toContain("__JOLLI_SOURCE_LABELS__");
		expect(assembleDashboardHtml(assetsDir, "{}")).not.toContain("__JOLLI_DASHBOARD_TOKEN__");
	});

	// The REFERENCE-source half, for `JD.contextBadge`. Same rule as the labels
	// above and asserted the same way — against the constant, because the whole
	// point is that adding a source to SOURCE_META reaches the dashboard without
	// anyone editing an asset file. The neutral fallback rides along rather than
	// being re-typed client-side.
	it("inlines the reference source metadata ahead of the app scripts", () => {
		const html = assembleDashboardHtml(assetsDir, "{}");
		expect(html).toContain(
			`window.__JOLLI_SOURCE_META__ = ${JSON.stringify({ meta: SOURCE_META, neutral: NEUTRAL_SOURCE_COLOR })}`,
		);
		expect(html.indexOf("__JOLLI_SOURCE_META__")).toBeLessThan(mainScriptAt(html));
	});
});

describe("hashed asset routes", () => {
	/** The CSS URL the page links, which is also a key in the served map. */
	const cssUrlFrom = (html: string): string => {
		const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
		expect(href, "stylesheet link").toBeTruthy();
		return href as string;
	};

	it("serves every URL the page links, and 404s anything else under /assets/", async () => {
		// The page is only as good as its links. Asserting the tags without
		// fetching them would pass for a bundle that renders a document full of
		// 404s — unstyled, and with no JavaScript at all.
		const port = await listen(testServer());
		const html = await (await get(port, "/dashboard")).text();
		const urls = [cssUrlFrom(html), ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1] as string)];
		expect(urls.length).toBe(DASHBOARD_SCRIPT_FILES.length + 1);
		for (const url of urls) {
			expect((await get(port, url)).status, url).toBe(200);
		}
		expect((await get(port, "/assets/nope-00000000.js")).status).toBe(404);
	});

	it("answers by exact path, so a traversal is just a miss", async () => {
		// There is no filesystem join on this route at all — the map built at
		// startup IS the allowlist — so these are 404s rather than reads. Asserted
		// because the absence of a join is exactly the kind of thing a later
		// "improvement" re-introduces.
		const port = await listen(testServer());
		for (const path of [
			"/assets/../../../../etc/passwd",
			"/assets/..%2f..%2fetc%2fpasswd",
			"/assets/js/main.js",
			"/assets/",
		]) {
			expect((await get(port, path)).status, path).toBe(404);
		}
	});

	it("caches immutably and revalidates on a strong validator", async () => {
		// `immutable` for a year is only correct because the URL names the content:
		// an upgrade changes the bytes, so it changes the URL, so a cached copy can
		// never be served for new content.
		const port = await listen(testServer());
		const html = await (await get(port, "/dashboard")).text();
		const url = cssUrlFrom(html);

		const first = await get(port, url);
		expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		const etag = first.headers.get("etag");
		expect(etag).toMatch(/^"[0-9a-f]{8}"$/);

		const revalidated = await get(port, url, { "If-None-Match": etag as string });
		expect(revalidated.status).toBe(304);
		expect(await revalidated.text()).toBe("");
	});

	it("gzips an asset for a client that takes it, and not for one that does not", async () => {
		const port = await listen(testServer());
		const html = await (await get(port, "/dashboard")).text();
		const url = cssUrlFrom(html);

		const zipped = await get(port, url, { "Accept-Encoding": "gzip" });
		// `fetch` decodes transparently, so the header is what proves it — and the
		// body must still come out identical after decoding.
		expect(zipped.headers.get("content-encoding")).toBe("gzip");
		expect(zipped.headers.get("vary")).toBe("Accept-Encoding");
		expect(await zipped.text()).toContain("body{color:red}");

		const plain = await get(port, url, { "Accept-Encoding": "identity" });
		expect(plain.headers.get("content-encoding")).toBeNull();
		expect(await plain.text()).toContain("body{color:red}");
	});

	it("reads the q-values, so `gzip;q=0` is a refusal and `*` is a yes", async () => {
		// The substring test this replaced answered yes to both `gzip` and
		// `gzip;q=0` — and the second is a client saying it CANNOT decode gzip
		// (RFC 9110 §12.5.3), so it got a body it had refused. No browser sends
		// either form; the clients that do are curl, proxies and health checkers.
		const port = await listen(testServer());
		const url = cssUrlFrom(await (await get(port, "/dashboard")).text());

		for (const [accept, encoded] of [
			["gzip;q=0", false],
			["gzip;q=0.0", false],
			["gzip;q=0.5", true],
			["*", true],
			["*;q=0", false],
			// An explicit entry outranks the wildcard, whichever way each points.
			["*;q=0, gzip", true],
			["gzip;q=0, *", false],
			["deflate, gzip;q=0", false],
		] as ReadonlyArray<[string, boolean]>) {
			const res = await get(port, url, { "Accept-Encoding": accept });
			expect(res.headers.get("content-encoding"), accept).toBe(encoded ? "gzip" : null);
			expect(await res.text(), accept).toContain("body{color:red}");
		}
	});

	it("keeps the document out of the cache while its assets stay in it", async () => {
		// The document carries the model and the mutation token, both per request;
		// the assets carry neither. Serving them under one policy is what the split
		// exists to avoid.
		const port = await listen(testServer());
		const page = await get(port, "/dashboard");
		expect(page.headers.get("cache-control")).toBe("no-store");
		const url = cssUrlFrom(await page.text());
		expect((await get(port, url)).headers.get("cache-control")).toContain("immutable");
	});

	it("gzips /api/model, which the stats page re-fetches every 30s", async () => {
		const port = await listen(
			testServer({
				// Big enough to clear the compress-it-at-all floor.
				buildModel: async (req) => ({ ...model(req.view), filler: "x".repeat(4096) }) as never,
			}),
		);
		const res = await get(port, "/api/model?view=stats", { "Accept-Encoding": "gzip" });
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(((await res.json()) as DashboardModel).view).toBe("stats");
	});

	it("leaves a small payload uncompressed", async () => {
		// Below the floor gzip's framing plus the CPU cost buys nothing, and most
		// JSON this server sends is a small view model.
		const port = await listen(testServer());
		const res = await get(port, "/api/model?view=standup", { "Accept-Encoding": "gzip" });
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(((await res.json()) as DashboardModel).view).toBe("standup");
	});
});

describe("DASHBOARD_SCRIPT_FILES tracks the page template", () => {
	/**
	 * The one direction nothing else could see, and it shipped: `journeys.js` was
	 * added to `index.html` and to neither this constant nor the plugin publish
	 * libs, so the assembled page carried `main.js`'s call to
	 * `window.JD.renderJourneys` with no file defining it — a TypeError on every
	 * visit to `/dashboard/journeys`.
	 *
	 * `assembleDashboardHtml` REPLACES the whole `scripts:start/end` block, so the
	 * `<script src>` tags never load anything at runtime; they are the template's
	 * own record of what the page needs. That makes them worth nothing as a
	 * mechanism and everything as an assertion — and it is why the omission is
	 * invisible everywhere else: `resolveDashboardAssetsDir` probes only files the
	 * constant already names, and `PluginDashboardAssets.test.ts` compares the
	 * publish libs against that same constant. Both agree with each other while
	 * both are missing the file.
	 *
	 * Order is asserted, not just membership: the list is a load order (shared
	 * helpers, then page modules, then `main.js` boots), so a page that loads
	 * `main.js` first is as broken as one missing a file.
	 */
	it("lists exactly the scripts index.html declares, in the same order", () => {
		const html = readFileSync(join(resolveDashboardAssetsDir(), "index.html"), "utf8");
		const block = /<!-- scripts:start -->([\s\S]*?)<!-- scripts:end -->/u.exec(html)?.[1] ?? "";
		const declared = [...block.matchAll(/<script src="js\/([^"]+)"><\/script>/gu)].map((m) => m[1]);

		expect(declared).toEqual([...DASHBOARD_SCRIPT_FILES]);
	});
});

describe("resolveDashboardAssetsDir", () => {
	it("finds assets beside the module (running from source)", () => {
		expect(resolveDashboardAssetsDir()).toContain(join("dashboard", "assets"));
	});

	/** A dist-style tree carrying every file `assembleDashboardHtml` reads. */
	function writeCompleteAssets(base: string): string {
		const assets = join(base, "dashboard-assets");
		mkdirSync(join(assets, "styles"), { recursive: true });
		mkdirSync(join(assets, "js"), { recursive: true });
		writeFileSync(join(assets, "index.html"), "x");
		writeFileSync(join(assets, "styles", "main.css"), "");
		for (const f of DASHBOARD_SCRIPT_FILES) writeFileSync(join(assets, "js", f), "");
		return assets;
	}

	it("finds a dist-style dashboard-assets dir and throws when nothing exists", () => {
		const base = join(dir, "distlike");
		// Written first, on its own line: argument evaluation order would otherwise
		// probe the directory before the helper creates it.
		const assets = writeCompleteAssets(base);
		expect(resolveDashboardAssetsDir(base)).toBe(assets);
		expect(() => resolveDashboardAssetsDir(join(dir, "empty"))).toThrow(/reinstall/);
	});

	it("refuses a tree with index.html but a missing stylesheet or script", () => {
		// The probe covers every file the render reads, so a marketplace .gitignore
		// that swallowed `js/` or `*.css` fails at the door with one clear message
		// instead of throwing ENOENT from inside the render on every page load.
		const noCss = join(dir, "nocss");
		mkdirSync(join(noCss, "dashboard-assets"), { recursive: true });
		writeFileSync(join(noCss, "dashboard-assets", "index.html"), "x");
		expect(() => resolveDashboardAssetsDir(noCss)).toThrow(/reinstall/);

		const noJs = join(dir, "nojs");
		const assets = writeCompleteAssets(noJs);
		rmSync(join(assets, "js", DASHBOARD_SCRIPT_FILES[0]));
		expect(() => resolveDashboardAssetsDir(noJs)).toThrow(/reinstall/);
	});

	it("is resolved and used lazily by the server when no assetsDir is injected", async () => {
		const server = createDashboardServer({ port: 0, buildModel: async (req) => model(req.view) });
		const port = await listen(server);
		const res = await get(port, "/memories");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("window.__JOLLI_DASHBOARD__");
	});
});

describe("startDashboardServer", () => {
	it("binds and writes no state file", async () => {
		const started = await startDashboardServer({
			port: 0,
			assetsDir,
			buildModel: async (req) => model(req.view),
			configDir: dir,
		});
		servers.push(started.server);
		expect(started.port).toBeGreaterThan(0);
		// The pid/port record is gone with the daemon: nothing discovers this
		// server, because nothing else is meant to attach to it.
		expect(existsSync(join(dir, "dashboard.json"))).toBe(false);
	});

	it("reports fellBack=false for the first candidate it takes", async () => {
		const started = await startDashboardServer({
			port: 0,
			assetsDir,
			buildModel: async (req) => model(req.view),
			configDir: dir,
		});
		servers.push(started.server);
		// An explicit port is a single candidate, so index 0 is the only outcome —
		// which is also why an occupied explicit port throws rather than moving.
		expect(started.fellBack).toBe(false);
	});

	it("surfaces a bind failure when the only candidate is taken", async () => {
		const first = await startDashboardServer({
			port: 0,
			assetsDir,
			buildModel: async (req) => model(req.view),
			configDir: dir,
		});
		servers.push(first.server);
		await expect(
			startDashboardServer({
				port: first.port,
				assetsDir,
				buildModel: async (req) => model(req.view),
				configDir: dir,
			}),
		).rejects.toThrow();
	});
});

describe("write surface", () => {
	const TOKEN = "test-token-0123456789abcdef";
	const HEADERS = { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" };

	function writeServer(over: Partial<Parameters<typeof createDashboardServer>[0]> = {}): Server {
		return testServer({ token: TOKEN, ...over });
	}

	it("403s any POST without a valid token", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, { method: "POST", body: "{}" });
		expect(res.status).toBe(403);
	});

	it("403s a POST whose token has the right char count but a different byte length", async () => {
		// Node decodes header bytes as latin1, so one non-ASCII byte is one JS char but
		// two UTF-8 bytes. Comparing STRING lengths let such a header reach
		// `timingSafeEqual` with mismatched buffers, which throws — turning the 403
		// into a 500.
		const forged = `${"é".repeat(TOKEN.length - 1)}x`;
		expect(forged.length).toBe(TOKEN.length);
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: { "X-Jolli-Dashboard-Token": forged, "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(403);
	});

	it("sends anti-framing headers on every response, including the JSON routes", async () => {
		// The Origin check cannot see a clickjack: a page that FRAMES this server
		// issues same-origin requests from inside the frame, Origin and all, and the
		// port is one of two hard-coded candidates. One tricked click on an overlaid
		// frame was enough to POST /api/settings/apply with the page's own token.
		const port = await listen(writeServer());
		for (const path of ["/memories", "/api/model"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`);
			expect(res.headers.get("x-frame-options")).toBe("DENY");
			expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		}
	});

	it("403s a POST carrying the wrong token", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: { "X-Jolli-Dashboard-Token": "wrong", "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(403);
	});

	it("404s an unknown POST path even with a valid token", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/unknown`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(res.status).toBe(404);
	});

	it("400s a malformed JSON body", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	it("400s a well-formed JSON body that isn't an object", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: "42",
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({ error: "expected a JSON object body" });
	});

	it("413s an oversized body", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: "x".repeat(70 * 1024),
		});
		expect(res.status).toBe(413);
	});

	it("enables a repo (installs + registers) and returns only its identity", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ path: "/tmp/acme-api" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true, repoIdentity: "r1" });
		// Same `clearManualDisableOnSuccess` reasoning as resume below: a repo the
		// user paused earlier must come back live, not just re-hooked.
		expect(installer.install).toHaveBeenCalledWith("/tmp/acme-api", {
			source: "cli",
			clearManualDisableOnSuccess: true,
		});
		expect(repoRegistry.registerRepo).toHaveBeenCalled();
	});

	// Backfill has no entry point in this server: a `backfill`/`count` body is
	// inert, not a request to start generating. Guards the removal — a
	// reintroduced branch here would spend LLM budget from a browser tab.
	it("ignores backfill/count fields on enable instead of starting any work", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ path: "/tmp/acme-api", backfill: true, count: 5 }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true, repoIdentity: "r1" });
	});

	describe("forget", () => {
		const FORGOTTEN = {
			identity: "r1",
			removedFromRegistry: true,
			repoRowDeleted: true,
			childRowsDeleted: 3,
			pendingEventsDeleted: 0,
		};

		beforeEach(() => {
			vi.mocked(repoForget.forgetRepo).mockReset();
			// Restores the real implementation the factory passed to `vi.fn(impl)`, so a
			// verdict one test forced cannot leak into the next.
			vi.mocked(repoForget.classifyRegistryEntry).mockReset();
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({ version: 1, repos: [] });
		});

		const post = async (body: unknown): Promise<Response> => {
			const port = await listen(writeServer());
			return fetch(`http://127.0.0.1:${port}/api/repos/forget`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify(body),
			});
		};

		it("400s without a repoIdentity", async () => {
			expect((await post({})).status).toBe(400);
			expect(repoForget.forgetRepo).not.toHaveBeenCalled();
		});

		it("400s a whitespace-only repoIdentity", async () => {
			expect((await post({ repoIdentity: "   " })).status).toBe(400);
		});

		it("forgets a dead entry and reports what went", async () => {
			vi.mocked(repoForget.forgetRepo).mockResolvedValue(FORGOTTEN);
			const res = await post({ repoIdentity: "r1" });
			expect(res.status).toBe(200);
			expect((await res.json()) as Record<string, unknown>).toEqual({
				ok: true,
				repoIdentity: "r1",
				removedFromRegistry: true,
				repoRowDeleted: true,
				childRowsDeleted: 3,
			});
		});

		it("409s a repository that still exists on disk, without calling forget", async () => {
			// The control is drawn from a payload that can be minutes old, so state —
			// not the page — is what says no. 409 because the request was well-formed.
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
				version: 1,
				repos: [{ repoIdentity: "r1", repoName: "r", worktreeRoot: dir, enabledAt: "t" }],
			});
			const res = await post({ repoIdentity: "r1" });
			expect(res.status).toBe(409);
			expect((await res.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining("on disk"),
			});
			expect(repoForget.forgetRepo).not.toHaveBeenCalled();
		});

		it("consults every recorded clone, not just the displayed root", async () => {
			// A registry entry is keyed by IDENTITY, so a second clone shares the row —
			// `worktreeRoot` alone would report a live repo as gone.
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
				version: 1,
				repos: [
					{
						repoIdentity: "r1",
						repoName: "r",
						worktreeRoot: join(dir, "no-such-clone"),
						worktrees: [join(dir, "no-such-clone"), dir],
						enabledAt: "t",
					},
				],
			});
			expect((await post({ repoIdentity: "r1" })).status).toBe(409);
		});

		it("409s a repository whose volume this machine cannot reach, without calling forget", async () => {
			// The one verdict `doctor` refuses even under `--fix --forget-dead-repos`: an
			// unplugged drive or an unmounted share is a repo the user expects back, and
			// `existsSync` alone cannot tell it from a deleted folder. Before this gate a
			// single confirm deleted twelve child tables for a repository that was merely
			// unplugged.
			vi.mocked(repoForget.classifyRegistryEntry).mockReturnValueOnce("unavailable");
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
				version: 1,
				repos: [{ repoIdentity: "r1", repoName: "r", worktreeRoot: "Z:\\gone\\repo", enabledAt: "t" }],
			});
			const res = await post({ repoIdentity: "r1" });
			expect(res.status).toBe(409);
			expect((await res.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining("cannot reach"),
			});
			expect(repoForget.forgetRepo).not.toHaveBeenCalled();
		});

		it("removes an unreachable-volume repo once the request says the user was told", async () => {
			// B: the user is the one who knows whether that drive is coming back, so the
			// refusal is a re-ask rather than a dead end. The flag is the record that a
			// human saw the volume-specific sentence — without it a stale click and an
			// informed one are the same bytes.
			vi.mocked(repoForget.classifyRegistryEntry).mockReturnValueOnce("unavailable");
			vi.mocked(repoForget.forgetRepo).mockResolvedValue(FORGOTTEN);
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
				version: 1,
				repos: [{ repoIdentity: "r1", repoName: "r", worktreeRoot: "Z:\\gone\\repo", enabledAt: "t" }],
			});
			const res = await post({ repoIdentity: "r1", acknowledgeUnavailableVolume: true });
			expect(res.status).toBe(200);
			expect(repoForget.forgetRepo).toHaveBeenCalled();
		});

		it("tags the refusal so the page can re-ask instead of just reporting failure", async () => {
			vi.mocked(repoForget.classifyRegistryEntry).mockReturnValueOnce("unavailable");
			// A registry ENTRY, so the verdict comes from the classifier rather than from
			// `classifyProjectedRoot`'s no-database shortcut.
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
				version: 1,
				repos: [{ repoIdentity: "r1", repoName: "r", worktreeRoot: "Z:\\gone\\repo", enabledAt: "t" }],
			});
			const res = await post({ repoIdentity: "r1" });
			expect(res.status).toBe(409);
			expect((await res.json()) as Record<string, unknown>).toMatchObject({ volumeUnavailable: true });
		});

		it("ignores the acknowledgement for a repository that still exists", async () => {
			// The flag speaks for ONE verdict. A live checkout is refused whatever the
			// body claims — that answer is not the user's to override from here.
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
				version: 1,
				repos: [{ repoIdentity: "r1", repoName: "r", worktreeRoot: dir, enabledAt: "t" }],
			});
			const res = await post({ repoIdentity: "r1", acknowledgeUnavailableVolume: true });
			expect(res.status).toBe(409);
			expect((await res.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining("still exists on disk"),
			});
			expect(repoForget.forgetRepo).not.toHaveBeenCalled();
		});

		it("applies the same volume gate to a row the registry does not list", async () => {
			// The unregistered half is the identical hazard through the identical button,
			// so it is judged by the same classifier on a synthetic single-path entry —
			// not by a second copy of the rule that could drift.
			vi.mocked(repoForget.classifyRegistryEntry).mockReturnValueOnce("unavailable");
			const dbPath = join(dir, "projected-unavailable.db");
			await applyStatsEvents(
				[
					{
						producerKind: "cli",
						event: {
							type: "repo.enabled",
							repoIdentity: "r1",
							repoName: "r",
							worktreeRoot: "Z:\\gone\\repo",
							enabledAt: "t",
						},
					},
				],
				{ producerKind: "cli", dbPath },
			);
			const port = await listen(writeServer({ dbPath }));
			const res = await fetch(`http://127.0.0.1:${port}/api/repos/forget`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ repoIdentity: "r1" }),
			});
			expect(res.status).toBe(409);
			expect(repoForget.forgetRepo).not.toHaveBeenCalled();
		});

		it("backs the registry up before removing anything", async () => {
			// Ordering, for the reason `applyRepoRegistryFix` states: a copy taken after
			// the first removal is a copy of the damage. It protects the REGISTRATION and
			// not the memories — that file holds none — so it is not what makes this safe.
			const configDir = join(dir, "forget-backup-config");
			mkdirSync(configDir, { recursive: true });
			const registryPath = join(configDir, "dashboard-repos.json");
			writeFileSync(registryPath, JSON.stringify({ version: 1, repos: [] }));
			// Recorded rather than asserted in place: this proves the ORDERING (the copy is
			// already on disk when the removal runs), and a throw from inside the mock
			// would surface as a 500 instead of naming the ordering.
			let backedUpBeforeRemoval = false;
			vi.mocked(repoForget.forgetRepo).mockImplementation(async () => {
				backedUpBeforeRemoval = readdirSync(configDir).some((f) => f.endsWith(".bak"));
				return FORGOTTEN;
			});

			const port = await listen(writeServer({ configDir }));
			const res = await fetch(`http://127.0.0.1:${port}/api/repos/forget`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ repoIdentity: "r1" }),
			});

			expect(res.status).toBe(200);
			expect(backedUpBeforeRemoval).toBe(true);
			const backups = readdirSync(configDir).filter((f) => f.endsWith(".bak"));
			expect(backups).toHaveLength(1);
			expect(readFileSync(join(configDir, backups[0]), "utf-8")).toBe(JSON.stringify({ version: 1, repos: [] }));
		});

		it("500s without removing anything when the registry could not be backed up", async () => {
			// A removal that could not be backed up is not the operation the user
			// consented to — and the message names the step that failed, since "could not
			// forget" would point at one that never ran.
			const configDir = join(dir, "forget-backup-fail-config");
			mkdirSync(configDir, { recursive: true });
			// A DIRECTORY where the registry file belongs: it exists (so the backup is
			// attempted) and `copyFileSync` cannot read it.
			mkdirSync(join(configDir, "dashboard-repos.json"), { recursive: true });

			const port = await listen(writeServer({ configDir }));
			const res = await fetch(`http://127.0.0.1:${port}/api/repos/forget`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ repoIdentity: "r1" }),
			});

			expect(res.status).toBe(500);
			expect((await res.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining("back up"),
			});
			expect(repoForget.forgetRepo).not.toHaveBeenCalled();
		});

		it("404s when there was nothing left to remove", async () => {
			// A second window may already have removed it; a cheerful 200 would reload
			// to the same list.
			vi.mocked(repoForget.forgetRepo).mockResolvedValue({
				identity: "r1",
				removedFromRegistry: false,
				repoRowDeleted: false,
				childRowsDeleted: 0,
				pendingEventsDeleted: 0,
			});
			expect((await post({ repoIdentity: "r1" })).status).toBe(404);
		});

		it("500s when the removal reported an error rather than claiming success", async () => {
			vi.mocked(repoForget.forgetRepo).mockResolvedValue({
				identity: "r1",
				removedFromRegistry: false,
				repoRowDeleted: false,
				childRowsDeleted: 0,
				pendingEventsDeleted: 0,
				error: "database is locked",
			});
			const res = await post({ repoIdentity: "r1" });
			expect(res.status).toBe(500);
			expect((await res.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining("database is locked"),
			});
		});

		it("500s when the removal throws", async () => {
			vi.mocked(repoForget.forgetRepo).mockRejectedValue(new Error("node:sqlite is unavailable"));
			expect((await post({ repoIdentity: "r1" })).status).toBe(500);
		});
	});

	it("400s enable with no path", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(res.status).toBe(400);
	});

	it("treats an empty POST body the same as an empty JSON object", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: "",
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({ error: "path is required" });
	});

	it("500s enable when install fails, surfacing its message", async () => {
		vi.mocked(installer.install).mockResolvedValueOnce({ success: false, message: "disk full", warnings: [] });
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ path: "/tmp/acme-api" }),
		});
		expect(res.status).toBe(500);
		expect((await res.json()) as { error: string }).toMatchObject({ error: "disk full" });
	});

	// The retired routes. A 404 (not a 403) because the token check runs first
	// for every POST — these are gone from the route table entirely.
	it("404s the retired backfill and job routes", async () => {
		const port = await listen(writeServer());
		const post = await fetch(`http://127.0.0.1:${port}/api/repos/backfill`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1", count: 3 }),
		});
		expect(post.status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/api/jobs/job-1`)).status).toBe(404);
	});

	// The deliberate asymmetry with enable/resume: this is a hook repair, not an
	// un-pause request, so the exact-match assertion below also pins the ABSENCE of
	// `clearManualDisableOnSuccess` — adding it here would silently un-pause a repo
	// the user chose to pause.
	//
	// It equally pins the absence of `repoHooksOnly`, which reads like the option
	// this route wants and is in fact the PLUGIN BOOTSTRAP mode: it is
	// host-parameterized by the source tag, `pluginBootstrapHost` maps an unmapped
	// tag (`"cli"`, ours) to `"claude"`, and that branch runs
	// `removeClaudeLegacySkills` — so passing it made this button delete the
	// repo's `.claude/skills/jolli-*`, which skill-revision gating then stops
	// `jolli enable` from putting back.
	it("reinstalls hooks for a registered repo without clearing a pause", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: "/tmp/acme-api", enabledAt: "t" }],
		});
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/hooks/reinstall`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});
		expect(res.status).toBe(200);
		expect(installer.install).toHaveBeenCalledWith("/tmp/acme-api", { source: "cli" });
	});

	it("500s hooks reinstall when install fails, surfacing its message", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: "/tmp/acme-api", enabledAt: "t" }],
		});
		vi.mocked(installer.install).mockResolvedValueOnce({ success: false, message: "locked", warnings: [] });
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/hooks/reinstall`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});
		expect(res.status).toBe(500);
		expect((await res.json()) as { error: string }).toMatchObject({ error: "locked" });
	});

	it("400s hooks-reinstall when repoIdentity is missing", async () => {
		const port = await listen(writeServer());
		for (const path of ["/api/hooks/reinstall"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: HEADERS,
				body: "{}",
			});
			expect(res.status, path).toBe(400);
		}
	});

	it("404s hooks-reinstall for an unregistered repoIdentity", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({ version: 1, repos: [] });
		const port = await listen(writeServer());
		for (const path of ["/api/hooks/reinstall"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ repoIdentity: "unknown" }),
			});
			expect(res.status, path).toBe(404);
		}
	});

	it("403s /api/repo-probe without a valid token, even as GET", async () => {
		const port = await listen(writeServer());
		expect((await fetch(`http://127.0.0.1:${port}/api/repo-probe?path=/tmp`)).status).toBe(403);
	});

	it("400s /api/repo-probe with a valid token but no path", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repo-probe`, {
			headers: { "X-Jolli-Dashboard-Token": TOKEN },
		});
		expect(res.status).toBe(400);
	});

	it("probes a real path once a valid token and path are presented", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repo-probe?path=${encodeURIComponent(dir)}`, {
			headers: { "X-Jolli-Dashboard-Token": TOKEN },
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { isGitRepo: boolean }).toMatchObject({ isGitRepo: false });
	});
});

describe("defaultModelBuilder (no injected buildModel)", () => {
	// Exercises the real query path against an actual migrated SQLite dashboard
	// db — every other test in this file injects `buildModel` and never touches
	// this code path at all.
	it("builds each view from a real database, and refuses the retired one", async () => {
		const dbPath = join(dir, "dashboard.db");
		const configDir = join(dir, "config");
		await withDashboardDb(() => {}, { dbPath });

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		for (const view of ["stats", "standup", "memories"] as const) {
			const res = await get(port, `/api/model?view=${view}`);
			expect(res.status, view).toBe(200);
			expect(((await res.json()) as DashboardModel).view, view).toBe(view);
		}
		// `repositories` is no longer a view token, and an unknown one falls back
		// to stats rather than erroring — so a stale link renders a real page.
		const retired = await get(port, "/api/model?view=repositories");
		expect(retired.status).toBe(200);
		expect(((await retired.json()) as DashboardModel).view).toBe("stats");
	});

	it("recreates a database that is missing at request time, and still renders", async () => {
		// The render path no longer runs `ensureDashboardDbExists` ahead of every
		// read — that was a WRITABLE open on every 30 s poll, to pre-empt a case
		// that happens approximately never. The recovery it bought is kept, moved
		// to the moment the read-only open actually fails: without it the request
		// 500s as plain text, and a page with no scripts on it never polls again,
		// so the browser cannot come back on its own.
		//
		// Asserted on a path that was never created, which is also the shape of a
		// database wiped under a running server.
		const dbPath = join(dir, "vanished", "dashboard.db");
		const configDir = join(dir, "vanished-config");
		expect(existsSync(dbPath)).toBe(false);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(200);
		expect(((await res.json()) as DashboardModel).view).toBe("stats");
		expect(existsSync(dbPath)).toBe(true);
	});

	it("recreates a schema for a database file that has none", async () => {
		// The same recovery, arriving under a different error code. SQLite opens a
		// zero-length file as a valid EMPTY database, so this one gets past the open
		// and fails at the first query with `no such table` — `classifyScanError`
		// calls that `schema`, not `permission`. It is the second half of the case the
		// test above covers (a wipe or a `doctor` mid-restore), so narrowing the
		// recovery to `permission` alone left exactly this shape answering the
		// scriptless 500 the recovery exists to prevent.
		const dbPath = join(dir, "empty.db");
		const configDir = join(dir, "empty-config");
		writeFileSync(dbPath, "");

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(200);
		expect(((await res.json()) as DashboardModel).view).toBe("stats");
		expect(readFileSync(dbPath).length).toBeGreaterThan(0);
	});

	it("does not answer a broken query by re-running migrations", async () => {
		// The `catch` covers the whole read, not just the open, so `classifyScanError`
		// answers `schema` both for a database with no tables and for a query naming a
		// table THIS BUILD got wrong. A complete migration log with a table missing
		// under it is the second shape, and what this pins is the outcome: the real
		// failure reaches the caller and the file is left exactly as it was.
		//
		// ⚠ It does NOT pin `readWithRecovery`'s `schemaIsComplete` guard, and that is
		// worth knowing before trusting it as one. Without the guard the recovery still
		// writes nothing here — `ensureDashboardDbExists` finds the log complete and
		// short-circuits before its writable open — so both paths end in this same 500
		// with the table still gone. What the guard buys is not visible from out here:
		// an honest log line, and not rebuilding the whole model a second time to fail
		// the same way. Measured by removing it: this case stays green.
		const dbPath = join(dir, "dropped.db");
		const configDir = join(dir, "dropped-config");
		await withDashboardDb((db) => db.exec("DROP TABLE sessions"), { dbPath });

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(500);
		// Read-only on purpose: a writable open here would migrate and recreate the
		// table itself, and the assertion would pass whatever the server had done.
		const tables = await withReadonlyDashboardDb(
			(db) => db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").all(),
			{ dbPath },
		);
		expect(tables).toEqual([]);
	});

	it("does not answer a corrupt database by writing a schema over it", async () => {
		// The recovery covers `permission` (SQLITE_CANTOPEN) and `schema` (a file with
		// no tables in it). A `corrupt` or `locked` file is a different problem, and
		// creating a schema on top of one would be destructive — so it must surface as
		// the 500 it is.
		const dbPath = join(dir, "corrupt.db");
		const configDir = join(dir, "corrupt-config");
		writeFileSync(dbPath, "this is not a sqlite database, not even close");

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(500);
		expect(readFileSync(dbPath, "utf8")).toBe("this is not a sqlite database, not even close");
	});

	// The optional sidebar rows come from config, and they are read on EVERY view
	// rather than only on settings — the sidebar is shell furniture, so a flag that
	// arrived on one view only would leave the nav guessing everywhere else. Both
	// halves are asserted here because only this block runs the real builder.
	it("reads the optional menu flags from config, on every view", async () => {
		const dbPath = join(dir, "menus.db");
		const configDir = join(dir, "menus-config");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ dashboardKnowledgeMenuEnabled: true, dashboardGraphMenuEnabled: false }),
		);
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		for (const view of ["stats", "standup", "memories", "knowledge", "graph"] as const) {
			const res = await get(port, `/api/model?view=${view}`);
			expect(((await res.json()) as DashboardModel).menus, view).toEqual({ knowledge: true, graph: false });
		}
	});

	// A config with neither key — every install before this shipped — must read as
	// both hidden. `=== true` gives that; the test is what stops a later `!== false`
	// from quietly reversing the default for everyone.
	it("defaults both optional menu flags to hidden when config says nothing", async () => {
		const dbPath = join(dir, "menus-default.db");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "menus-default-config") }),
		);
		const res = await get(port, "/api/model?view=stats");
		expect(((await res.json()) as DashboardModel).menus).toEqual({ knowledge: false, graph: false });
	});

	// `configDir` is optional on this builder, and every caller in production
	// resolves it before getting here — so the machine-global fallback is only
	// reachable through a hand-built server. It still has to read the same file the
	// resolved path would, which is what this pins: HOME is redirected, a config is
	// written where `getGlobalConfigDir()` will look, and the flags come back.
	it("falls back to the machine-global config dir when none is given", async () => {
		// `withIsolatedHome`, never a hand-rolled `process.env.HOME = …`: that is
		// isolation on POSIX and a NO-OP on Windows, where `os.homedir()` reads
		// USERPROFILE — so the hand-rolled form writes into the developer's real
		// `~/.jolli/jollimemory/`. The helper's own docstring records that damage.
		const home = join(dir, "fallback-home");
		mkdirSync(join(home, ".jolli", "jollimemory"), { recursive: true });
		writeFileSync(
			join(home, ".jolli", "jollimemory", "config.json"),
			JSON.stringify({ dashboardGraphMenuEnabled: true }),
		);
		await withIsolatedHome(home, async () => {
			const dbPath = join(dir, "menus-global.db");
			await withDashboardDb(() => {}, { dbPath });
			const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath }));
			const res = await get(port, "/api/model?view=stats");
			expect(((await res.json()) as DashboardModel).menus).toEqual({ knowledge: false, graph: true });
		});
	});

	// Hiding a row does NOT close its route: only the sidebar entry is gated, so a
	// bookmark still opens the page rather than being redirected somewhere the
	// reader did not ask for. A gate added here later would break this.
	it("keeps /knowledge and /graph routed while both menu flags are off", async () => {
		const dbPath = join(dir, "menus-routes.db");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "menus-routes-config") }),
		);
		for (const path of ["/knowledge", "/graph"]) {
			expect((await get(port, path)).status, path).toBe(200);
		}
	});

	/** Seeds one enabled repo whose projected `worktree_root` is `root`. */
	async function seedRepo(dbPath: string, root: string): Promise<void> {
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: root,
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
	}

	async function repoOptions(port: number): Promise<ReadonlyArray<{ missing?: boolean }>> {
		return ((await (await get(port, "/api/model?view=stats")).json()) as DashboardModel).repos;
	}

	// `worktree_root` carries the registry entry's single `worktreeRoot`, but an
	// entry is keyed by repo IDENTITY and can list several clones — so the row alone
	// renders a forget ✕ over a repo whose sibling checkout is alive and well.
	it("asks the registry about every clone before marking a repo missing", async () => {
		const dbPath = join(dir, "clones.db");
		const dead = join(dir, "clone-dead");
		const live = join(dir, "clone-live");
		mkdirSync(live, { recursive: true });
		await seedRepo(dbPath, dead);
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "clones-config") }),
		);

		// Default mock: an empty registry, so nothing outranks the row.
		expect((await repoOptions(port))[0].missing).toBe(true);

		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
			version: 1,
			repos: [
				{
					repoIdentity: "repo-1",
					repoName: "jolli",
					worktreeRoot: dead,
					worktrees: [dead, live],
					enabledAt: "t",
				},
			],
		});
		expect((await repoOptions(port))[0].missing).toBeUndefined();
	});

	// The memo is real-time-generational and nothing else invalidates it, so a
	// checkout that existed by the time the user clicked Enable would keep rendering
	// with a forget ✕ for the rest of the window — on the repo they just enabled.
	it("drops the worktree-existence memo when a repo is enabled", async () => {
		const TOKEN = "enable-memo-0123456789abcdef";
		const dbPath = join(dir, "enable-memo.db");
		const checkout = join(dir, "enabled-checkout");
		await seedRepo(dbPath, checkout);
		const port = await listen(
			createDashboardServer({
				port: 0,
				assetsDir,
				dbPath,
				configDir: join(dir, "enable-memo-config"),
				token: TOKEN,
			}),
		);

		expect((await repoOptions(port))[0].missing).toBe(true);
		mkdirSync(checkout, { recursive: true });
		// Still missing: served from the memo, which is the whole point of it.
		expect((await repoOptions(port))[0].missing).toBe(true);

		const enabled = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" },
			body: JSON.stringify({ path: checkout }),
		});
		expect(enabled.status).toBe(200);

		expect((await repoOptions(port))[0].missing).toBeUndefined();
	});

	// The journeys view now inlines a `coaching` payload and moves the feed
	// behind `/api/journeys` — the model injected into the page must carry the
	// former and never the latter, or every page load pays ~107 KB for rows the
	// reader usually never opens.
	it("does not inline the journey feed into the journeys page", async () => {
		const dbPath = join(dir, "journeys-inline.db");
		const configDir = join(dir, "config-journeys-inline");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const html = await (await get(port, "/dashboard/journeys")).text();
		// The model is injected as `window.__JOLLI_DASHBOARD__ = <json>;` by
		// `assembleDashboardHtml`.
		const json = /window\.__JOLLI_DASHBOARD__ = (.*?);<\/script>/s.exec(html)?.[1] ?? "";
		const body = JSON.parse(json) as { coaching?: unknown; journeys?: unknown };
		expect(body.coaching).toBeTruthy();
		// The feed is behind a modal; inlining it would pay for it on every load.
		expect(body.journeys).toBeUndefined();
	});

	it("reads knowledge and graph models off the Memory Bank folder", async () => {
		const dbPath = join(dir, "kg.db");
		const configDir = writeMemoryBank(dir, [
			{ dir: "repoA", wiki: { "_index.md": "# repoA Wiki\n" }, graph: '{"nodes":[]}' },
		]);
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const knowledge = (await (await get(port, "/api/model?view=knowledge")).json()) as DashboardModel;
		expect(knowledge.view).toBe("knowledge");
		expect(knowledge.knowledge?.repos[0]?.repoName).toBe("repoA");
		expect(knowledge.knowledge?.repos[0]?.graphAvailable).toBe(true);

		const graph = (await (await get(port, "/api/model?view=graph")).json()) as DashboardModel;
		expect(graph.view).toBe("graph");
		expect(graph.graph?.repos[0]?.graphAvailable).toBe(true);
	});

	// The Memories view filters rows a rebase left behind — but from the
	// materialised `memories.reachable` column now, not a per-request `git
	// rev-list`. The async sweep marks the rewritten row unreachable; the list
	// filters `reachable = 1` in SQL, and no git runs on the read path.
	it("prunes memory rows the reachability column marks unreachable, with no git on the read path", async () => {
		const dbPath = join(dir, "memories-reach.db");
		const configDir = join(dir, "config");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				for (const hash of ["reachable-hash", "rewritten-hash"]) {
					db.prepare(
						`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
						                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
						 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, 1)`,
					).run(id, hash, hash, JSON.stringify({ commitHash: hash, topics: [] }));
				}
				// The reconcile sweep's answer: only "reachable-hash" is on a branch.
				markMemoriesReachability(db, "repo-1", new Set(["reachable-hash"]));
			},
			{ dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/model?view=memories");

		expect(res.status).toBe(200);
		const body = (await res.json()) as DashboardModel;
		expect(body.view).toBe("memories");
		// Reachability is a column now — the read path pays no `git rev-list`.
		expect(gitOps.listReachableCommits).not.toHaveBeenCalled();
		expect((body.memories?.items ?? []).map((item) => item.commitHash)).toEqual(["reachable-hash"]);
	});

	// The other async read the Memories view pays for, and the only one that is
	// per-SELECTION rather than per-repo: which of spec §9's three sentences an
	// empty conversations list is allowed to print. Nothing else in the payload
	// fails when this stops being computed — the page just quietly reverts to the
	// plainest wording — so this is the test that notices.
	it("attaches the transcript repair state to the selected memory, and skips it with no selection", async () => {
		const dbPath = join(dir, "memories-repair.db");
		const configDir = join(dir, "config-repair");
		const hash = "a".repeat(40);
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, 1)`,
				).run(id, hash, hash, JSON.stringify({ commitHash: hash, topics: [] }));
			},
			{ dbPath },
		);
		// Reachability filters the tree ROWS, never the detail pane, so the stub's
		// default answer is left alone here — the selected memory resolves by hash.
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const selected = (await (await get(port, `/api/model?view=memories&hash=${hash}`)).json()) as DashboardModel;
		expect(selected.memories?.selected?.transcriptRepairState).toBe("repairable");

		// A tree render with no `?hash=` has no detail pane to word, so it must
		// not pay the ledger read at all.
		vi.mocked(transcriptRepairState).mockClear();
		await get(port, "/api/model?view=memories");
		expect(transcriptRepairState).not.toHaveBeenCalled();
	});

	// The `/` redirect builds no model at all now — it has one destination, so
	// there is nothing to read `repos.length` for. And the page it lands on no
	// longer pays git either: reachability is the materialised column.
	it("does no git work for the / redirect, and none on the page either", async () => {
		const dbPath = join(dir, "root-redirect.db");
		const configDir = join(dir, "config-root");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const root = await get(port, "/");
		expect(root.status).toBe(302);
		expect(root.headers.get("location")).toBe("/dashboard");
		expect(gitOps.listReachableCommits).not.toHaveBeenCalled();

		expect((await get(port, "/memories")).status).toBe(200);
		expect(gitOps.listReachableCommits).not.toHaveBeenCalled();
	});

	// The "Load more" fetch. Filtered by the SAME reachability the page render
	// uses — that is what makes the cursor a position in the list the client is
	// actually holding, rather than in a longer one only this route can see.
	it("serves one page of memories after a cursor, and rejects half a cursor", async () => {
		const dbPath = join(dir, "memories-page.db");
		const configDir = join(dir, "config-page");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				// The sweep marks only "reachable-hash" reachable; the second row is here
				// to prove the route filters `reachable = 1` like the page does.
				for (const [hash, dateMs] of [
					["reachable-hash", 2],
					["rewritten-hash", 1],
				] as const) {
					db.prepare(
						`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
						                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
						 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)`,
					).run(id, hash, hash, JSON.stringify({ commitHash: hash, topics: [] }), dateMs);
				}
				markMemoriesReachability(db, "repo-1", new Set(["reachable-hash"]));
			},
			{ dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const first = await get(port, "/api/memories");
		expect(first.status).toBe(200);
		expect(
			((await first.json()) as { items: Array<{ commitHash: string }> }).items.map((i) => i.commitHash),
		).toEqual(["reachable-hash"]);

		// Cursor on the only reachable row — nothing follows it.
		const after = await get(port, "/api/memories?afterRepo=repo-1&afterHash=reachable-hash");
		expect(after.status).toBe(200);
		const afterBody = (await after.json()) as { items: unknown[]; cursorMissing?: true };
		expect(afterBody.items).toEqual([]);
		expect(afterBody.cursorMissing).toBeUndefined();

		// The unreachable row is not a position in this list.
		const missing = await get(port, "/api/memories?afterRepo=repo-1&afterHash=rewritten-hash");
		expect(((await missing.json()) as { cursorMissing?: true }).cursorMissing).toBe(true);

		// Half a cursor cannot identify a row, and paging from the top instead
		// would look like a working button that repeats the first page.
		expect((await get(port, "/api/memories?afterHash=reachable-hash")).status).toBe(400);
		expect((await get(port, "/api/memories?afterRepo=repo-1")).status).toBe(400);
	});

	// The Skills / MCPs cards' "Show more" fetch. Paged in SQL, so this route
	// opens the database itself rather than going through buildModel — the page
	// past the first one is not part of any page payload.
	it("serves one page of a tool-usage list, and rejects a list or offset it cannot page", async () => {
		const dbPath = join(dir, "tool-usage-page.db");
		const configDir = join(dir, "config-tools");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "s1",
						updatedAtMs: Date.now() - 3_600_000,
						tools: [
							{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 9 },
							{ name: "github.list_prs", kind: "mcp", server: "github", calls: 4 },
						],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const second = await get(port, "/api/tool-usage?list=server&offset=1");
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({
			list: "server",
			offset: 1,
			totalCount: 2,
			rows: [{ server: "github", calls: 4 }],
		});
		// Window fields are forwarded independently. A non-custom range ignores the
		// extra bounds in the query layer, but the route must not drop them silently.
		expect((await get(port, "/api/tool-usage?list=server&range=3m&from=ignored&to=ignored")).status).toBe(200);

		// An unknown list is a 400, never a fallback to the first one: the answer
		// would be a page of the WRONG list, which the client appends to the one it
		// asked about.
		expect((await get(port, "/api/tool-usage?list=servers")).status).toBe(400);
		expect((await get(port, "/api/tool-usage")).status).toBe(400);
		// A non-numeric offset would otherwise be read as 0 and answer a "Show more"
		// click with the page the client already holds — a button that does nothing.
		expect((await get(port, "/api/tool-usage?list=server&offset=abc")).status).toBe(400);
		// Absent means the first page, which is the one case a default is right.
		expect((await get(port, "/api/tool-usage?list=skill")).status).toBe(200);
	});

	// The poll path's shape: re-reading a list the reader has already expanded takes
	// as many rows as are on screen, which is a number only the client knows.
	it("serves a caller-supplied tool-usage limit, clamped, and rejects one it cannot read", async () => {
		const dbPath = join(dir, "tool-usage-limit.db");
		const configDir = join(dir, "config-tool-limit");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "s1",
						updatedAtMs: Date.now() - 3_600_000,
						tools: Array.from({ length: 12 }, (_, i) => ({
							name: `srv${String(i).padStart(2, "0")}.run`,
							kind: "mcp" as const,
							server: `srv${String(i).padStart(2, "0")}`,
							calls: 12 - i,
						})),
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		// Absent is still one page — the shape a Show more click asks for.
		const onePage = await get(port, "/api/tool-usage?list=server");
		expect(((await onePage.json()) as { rows: unknown[] }).rows).toHaveLength(TOOL_ROWS_LIMIT);

		// A wider one answers the poll's question: all 12 rows in one read, so the
		// client can compare them against the 12 it is displaying.
		const wide = await get(port, "/api/tool-usage?list=server&limit=12");
		expect(((await wide.json()) as { rows: unknown[] }).rows).toHaveLength(12);

		// Clamped, not rejected: past the cap the client receives fewer rows than it
		// asked for, reads that as "the card changed", and collapses to the first page.
		// Turning an unbounded read into a 400 instead would break that degradation.
		const past = await get(port, "/api/tool-usage?list=server&limit=1000000");
		expect(past.status).toBe(200);
		expect(((await past.json()) as { rows: unknown[] }).rows).toHaveLength(12);

		// Floored to at least one row rather than answering an empty page.
		const zero = await get(port, "/api/tool-usage?list=server&limit=0");
		expect(((await zero.json()) as { rows: unknown[] }).rows).toHaveLength(1);

		// Same rule as `offset`: a value this route cannot read is the caller's bug,
		// and silently answering a different question is what hides it.
		expect((await get(port, "/api/tool-usage?list=server&limit=abc")).status).toBe(400);
	});

	it("serves one skill detail and distinguishes a bad name from a missing skill", async () => {
		const dbPath = join(dir, "skill-detail.db");
		const configDir = join(dir, "config-skill-detail");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "review-session",
						updatedAtMs: Date.now() - 3_600_000,
						tools: [{ name: "code-review", kind: "skill", calls: 2, plugin: "superpowers" }],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const ok = await get(port, "/api/skill-detail?name=%20code-review%20&range=3m&from=ignored&to=ignored");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			name: "code-review",
			sessions: 1,
			calls: 2,
			plugin: "superpowers",
			agents: [{ source: "claude", sessions: 1, calls: 2 }],
		});

		expect((await get(port, "/api/skill-detail")).status).toBe(400);
		expect((await get(port, "/api/skill-detail?name=%20%20")).status).toBe(400);
		expect((await get(port, "/api/skill-detail?name=missing")).status).toBe(404);
	});

	it("serves one MCP server detail and distinguishes a bad name from a silent server", async () => {
		const dbPath = join(dir, "mcp-detail.db");
		const configDir = join(dir, "config-mcp-detail");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "linear-session",
						updatedAtMs: Date.now() - 3_600_000,
						tools: [
							{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 4 },
							{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 1 },
						],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		// Trimmed, and the window params are read the same way `/api/skill-detail` reads them.
		const ok = await get(port, "/api/mcp-detail?server=%20linear%20&range=3m&from=ignored&to=ignored");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			server: "linear",
			sessions: 1,
			calls: 5,
			toolCount: 2,
			tools: [
				{ name: "list_issues", calls: 4, sessions: 1 },
				{ name: "get_issue", calls: 1, sessions: 1 },
			],
			agents: [{ source: "claude", calls: 5 }],
			repos: ["jolli"],
		});

		expect((await get(port, "/api/mcp-detail")).status).toBe(400);
		expect((await get(port, "/api/mcp-detail?server=%20%20")).status).toBe(400);
		// A server with no captured call in the window is a 404 — this page never
		// claims to list CONFIGURED servers, so there is no third state to report.
		expect((await get(port, "/api/mcp-detail?server=missing")).status).toBe(404);
	});

	it("anchors tool usage and both detail presets to the page model's clock", async () => {
		const dbPath = join(dir, "mcp-detail-anchor.db");
		const configDir = join(dir, "config-mcp-detail-anchor");
		// 23:59 in Asia/Shanghai, this test process's configured zone. By the time
		// the route is exercised the real clock is long past this day; without the
		// anchor a visible `today` row therefore becomes a 404 deterministically.
		const generatedAtMs = Date.parse("2026-07-30T15:59:00Z");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "linear-before-midnight",
						updatedAtMs: generatedAtMs - 3_600_000,
						tools: [
							{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 },
							{ name: "code-review", kind: "skill", calls: 1 },
						],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		expect((await get(port, `/api/mcp-detail?server=linear&range=today&nowMs=${generatedAtMs}`)).status).toBe(200);
		expect((await get(port, `/api/skill-detail?name=code-review&range=today&nowMs=${generatedAtMs}`)).status).toBe(
			200,
		);
		const usage = await get(port, `/api/tool-usage?list=skill&range=today&nowMs=${generatedAtMs}`);
		expect(usage.status).toBe(200);
		expect(await usage.json()).toMatchObject({ totalCount: 1, rows: [{ name: "code-review" }] });

		for (const bad of ["", "nope", "-1", "1.5", "8640000000000000", "9007199254740992"]) {
			for (const path of [
				`/api/mcp-detail?server=linear&range=today&nowMs=${bad}`,
				`/api/skill-detail?name=code-review&range=today&nowMs=${bad}`,
				`/api/tool-usage?list=skill&range=today&nowMs=${bad}`,
			]) {
				expect((await get(port, path)).status).toBe(400);
			}
		}
	});

	it("500s dashboard detail reads when the dashboard database is invalid", async () => {
		const dbPath = join(dir, "broken-tool-reads.db");
		writeFileSync(dbPath, "this is not a database");
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config-broken-tools") }),
		);

		expect((await get(port, "/api/tool-usage?list=skill")).status).toBe(500);
		expect((await get(port, "/api/skill-detail?name=code-review")).status).toBe(500);
		expect((await get(port, "/api/mcp-detail?server=linear")).status).toBe(500);
		expect((await get(port, "/api/context?repo=repo-1&kind=plan&key=p1")).status).toBe(500);
		expect((await get(port, "/api/conversation?repo=repo-1&hash=abc&source=claude&session=s1")).status).toBe(500);
	});

	it("uses the isolated machine-global database for tool and skill detail when dbPath is omitted", async () => {
		const home = join(dir, "skill-detail-home");
		await withIsolatedHome(home, async () => {
			await withDashboardDb(() => {});
			const port = await listen(
				createDashboardServer({
					port: 0,
					assetsDir,
					configDir: join(dir, "config-global-skill-detail"),
				}),
			);

			expect((await get(port, "/api/tool-usage?list=skill")).status).toBe(200);
			expect((await get(port, "/api/skill-detail?name=missing")).status).toBe(404);
		});
	});

	// The Context dialog's fetch. A read like every other GET here — no token —
	// and it opens the database itself rather than going through buildModel,
	// because a document body is not part of any page payload.
	it("serves one plan/note body over /api/context, and 400/404s a bad request", async () => {
		const dbPath = join(dir, "context-doc.db");
		const configDir = join(dir, "config-ctx");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO context (repo_id, kind, context_key, title, body_md, created_at_ms)
					 VALUES (?, 'plan', 'p1', 'The plan', '# The plan', 1)`,
				).run(id);
			},
			{ dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const ok = await get(port, "/api/context?repo=repo-1&kind=plan&key=p1");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ kind: "plan", title: "The plan", bodyMd: "# The plan" });

		// Unknown document — a 404, not an empty 200 that reads as "no content".
		expect((await get(port, "/api/context?repo=repo-1&kind=plan&key=nope")).status).toBe(404);
		// Every context kind is viewable now, so `reference` is a 404 (no such
		// document) rather than a 400 (no such kind) — only an unknown KIND is a
		// bad request.
		expect((await get(port, "/api/context?repo=repo-1&kind=reference&key=p1")).status).toBe(404);
		expect((await get(port, "/api/context?repo=repo-1&kind=nonsense&key=p1")).status).toBe(400);
		expect((await get(port, "/api/context?kind=plan&key=p1")).status).toBe(400);
	});

	/**
	 * The Context dialog's frame. Same read as `/api/context`, rendered instead of
	 * returned — the dialog used to show raw markdown source because injecting an
	 * agent-written document into the token-bearing page was the only alternative
	 * on the table. The sandbox is what makes rendering it safe.
	 */
	it("renders one context body as a sandboxed markdown document over /context-viewer", async () => {
		const dbPath = join(dir, "context-viewer.db");
		const configDir = join(dir, "config-ctxview");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO context (repo_id, kind, context_key, title, body_md, created_at_ms)
					 VALUES (?, 'plan', 'p1', 'The plan', '# Heading\n\n| a | b |\n| - | - |\n| 1 | 2 |', 1)`,
				).run(id);
			},
			{ dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const ok = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=p1");
		expect(ok.status).toBe(200);
		// The sandbox is the isolation, not the CSP's frame-ancestors — see
		// sendViewerHtml. Without it the rendered HTML shares an origin with the
		// page holding the mutation token.
		expect(ok.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		const html = await ok.text();
		// The renderer is inlined, and the body reaches it as a JS string rather
		// than as pre-rendered markup.
		expect(html).toContain("marked");
		expect(html).toContain("window.marked.parse");
		expect(html).toContain("# Heading");
		// The link bridge: a sandboxed frame cannot navigate on its own.
		expect(html).toContain("jolli-context-nav");

		// The theme rides in so the frame matches the dialog around it; the
		// dashboard honours an explicit data-theme, not just prefers-color-scheme.
		const dark = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=p1&theme=dark");
		expect(await dark.text()).toContain('data-theme="dark"');
		// A closed set — it is interpolated as a bare attribute value.
		const bogus = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=p1&theme=' onload=x");
		expect(await bogus.text()).not.toContain("onload");

		// A framed message document, not a bare error: this renders inside the
		// dialog, where a browser error page would be the only thing the user sees.
		const missing = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=nope");
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain("could not be found");
		expect((await get(port, "/context-viewer?repo=repo-1&kind=nonsense&key=p1")).status).toBe(400);
		expect((await get(port, "/context-viewer?kind=plan&key=p1")).status).toBe(400);

		// The run above took the GRAPH fallback, which is the source-run path — the
		// test assets have no `vendor/`. The shipped path is the dashboard copy, and
		// it is the one that matters: only the CLI's own dist carries `graph-assets/`
		// at all, so on `vscode/dist` and the three plugin bundles a viewer resolving
		// `marked` from the graph tree would 500, exactly as /wiki-viewer already
		// does there. Prove the dashboard copy wins by making it distinguishable.
		const stagedAssets = writeTestAssets(join(dir, "staged"));
		mkdirSync(join(stagedAssets, "vendor"), { recursive: true });
		writeFileSync(
			join(stagedAssets, "vendor", "marked.min.js"),
			'window.marked={parse:function(s){return "STAGED_COPY:"+s}};',
		);
		const stagedPort = await listen(createDashboardServer({ port: 0, assetsDir: stagedAssets, dbPath, configDir }));
		const staged = await get(stagedPort, "/context-viewer?repo=repo-1&kind=plan&key=p1");
		expect(staged.status).toBe(200);
		expect(await staged.text()).toContain("STAGED_COPY");
	});

	it("answers a failed read with a framed message, not the outer handler's plain text", async () => {
		// Every other exit from this route is a framed document, because what
		// receives it is an iframe inside the Context dialog. Left to the outer
		// handler, a database failure renders there as a bare unstyled line the
		// reader cannot scroll away from — and 500, not 404: "could not be found"
		// would send them looking for a document that is still on disk.
		const dbPath = join(dir, "context-viewer-broken.db");
		const configDir = join(dir, "config-ctxview-broken");
		writeFileSync(dbPath, "this is not a database");

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=p1");
		expect(res.status).toBe(500);
		expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(await res.text()).toContain("could not be read");
	});

	// The Conversation dialog's read. JSON rather than a framed viewer: a
	// transcript turn is rendered as TEXT on both surfaces, so there is no
	// agent-authored HTML here to isolate.
	it("400s and 404s a bad /api/conversation request", async () => {
		const dbPath = join(dir, "conversation.db");
		const configDir = join(dir, "config-conv");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		// All four params are required — a partial request is a bad request, not an
		// empty 200 that would read as "this conversation has no turns".
		for (const query of [
			"repo=repo-1&hash=abc&source=claude",
			"repo=repo-1&hash=abc&session=s1",
			"repo=repo-1&source=claude&session=s1",
			"hash=abc&source=claude&session=s1",
		]) {
			expect((await get(port, `/api/conversation?${query}`)).status, query).toBe(400);
		}
		expect((await get(port, "/api/conversation?repo=repo-1&hash=abc&source=claude&session=nope")).status).toBe(404);
	});
});

describe("Decisions card gist (Stats view only)", () => {
	async function seedDecisionCommit(dbPath: string, commitHash: string, decisionText: string): Promise<number> {
		const committedAtMs = Date.now() - 3_600_000;
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				{
					producerKind: "bootstrap",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: commitHash,
						committedAtMs,
						branch: "main",
						message: "feat: x",
						turns: 5,
						tokens: 100,
						estCostUsd: 1,
						insights: [{ kind: "decision", text: decisionText }],
						references: [],
						sessionLinks: [],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		// Insights are derived from the summary's topics at query time — see
		// applySummaryEvents in DashboardQuery.test.ts for the same fixture shape.
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				const summary = { commitHash, topics: [{ title: "t0", decisions: decisionText }] };
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)
					 ON CONFLICT(repo_id, commit_hash) DO UPDATE SET
					   summary_json = excluded.summary_json, commit_date_ms = excluded.commit_date_ms`,
				).run(id, commitHash, commitHash, JSON.stringify(summary), committedAtMs);
			},
			{ dbPath },
		);
		return committedAtMs;
	}

	// The Decisions card is served straight from the database: the latest
	// decision arrives as its OWNING TOPIC'S TITLE, with the decision prose left
	// behind entirely. There is nothing left to gate — the display-time LLM call
	// that used to compress that prose is retired (JOLLI-2209), so a token-free
	// call gets the identical payload.
	it("serves the latest decision as its topic title, with no decision prose on the wire", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem1", "- **Picked SQLite**: needed local durability without a server.");

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config"), token: "tok" }),
		);
		const res = await get(port, "/api/model?view=stats", { "X-Jolli-Dashboard-Token": "tok" });

		expect(res.status).toBe(200);
		const latest = ((await res.json()) as DashboardModel).stats?.decisions?.latest;
		// `t0` is seedDecisionCommit's topic title.
		expect(latest).toMatchObject({ commitHash: "mem1", title: "t0" });
		expect(latest).not.toHaveProperty("text");
		expect(latest).not.toHaveProperty("gist");
	});

	it("serves a token-free stats call the same decision payload", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem1", "- **Picked SQLite**: needed local durability without a server.");

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config"), token: "tok" }),
		);
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(200);
		expect(((await res.json()) as DashboardModel).stats?.decisions?.latest).toMatchObject({
			commitHash: "mem1",
			title: "t0",
		});
	});

	it("filters the standup board to the local git identity, read per enabled repo", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem4", "picked sqlite");
		// A placeholder row from a hook that wrote before the registry projected:
		// `cwd: ''` would silently read whichever repo the server was launched in.
		await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, '', 't')",
				).run("repo-2", "placeholder");
			},
			{ dbPath },
		);

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config") }),
		);
		const body = (await (await get(port, "/api/model?view=standup")).json()) as DashboardModel;

		expect(vi.mocked(gitOps.readLocalGitIdentity).mock.calls).toEqual([["/w"]]);
		expect(body.standup?.authoredBy).toBe("me@example.com");
		// The seeded commit carries no author, so the filter excludes it — the proof
		// the identity reached the query rather than being resolved and dropped.
		expect((body.standup?.days ?? []).flatMap((d) => d.commits)).toEqual([]);
	});

	it("never reads the git identity for views other than Standup", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem5", "picked sqlite");
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config") }),
		);
		expect((await get(port, "/api/model?view=stats")).status).toBe(200);
		expect(gitOps.readLocalGitIdentity).not.toHaveBeenCalled();
	});
});

describe("telemetry beacon", () => {
	// The endpoint sits BEFORE the mutation-token gate on purpose (the token is
	// inlined only into the write-surface pages), so it must accept a tokenless
	// POST — the exact opposite of every /api/repos/* route above.
	async function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
		return fetch(`http://127.0.0.1:${port}/api/telemetry`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	}

	afterEach(() => {
		// The telemetry context is a module singleton — never leak it between tests.
		shutdownTelemetry();
	});

	it("accepts a tokenless beacon (204) and forwards it stamped web-local", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		const res = await post(port, { event: "dashboard_opened", properties: { first_run: true } });
		expect(res.status).toBe(204);
		const events = await readTelemetryEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventName: "dashboard_opened",
			surface: "web-local",
			properties: { first_run: true },
		});
	});

	it("drops an unregistered event name but still answers 204", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		const res = await post(port, { event: "totally_made_up_event", properties: {} });
		expect(res.status).toBe(204);
		expect(await readTelemetryEvents(dir)).toEqual([]);
	});

	it("drops a registered event that is NOT a dashboard event (no forging via web-local)", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		// `search_performed` is a real registered event, but not one the local web
		// view emits — the beacon must refuse to stamp it web-local.
		const res = await post(port, { event: "search_performed", properties: { hit: true } });
		expect(res.status).toBe(204);
		expect(await readTelemetryEvents(dir)).toEqual([]);
	});

	it("answers 204 on a malformed body — a beacon is never taught to retry", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		const res = await post(port, "}{ not json");
		expect(res.status).toBe(204);
		expect(await readTelemetryEvents(dir)).toEqual([]);
	});

	it("answers 204 for a valid event even when telemetry is opted out, buffering nothing", async () => {
		initTelemetry({
			cwd: dir,
			installId: "install-1",
			origin: "https://acme.jolli.ai",
			config: { telemetry: "off" },
			env: {},
		});
		const port = await listen(testServer());
		const res = await post(port, { event: "range_changed", properties: { range: "7d" } });
		expect(res.status).toBe(204);
		expect(await readTelemetryEvents(dir)).toEqual([]);
	});
});

describe("wiki freshness + rebuild endpoints", () => {
	const TOKEN = "wiki-token-0123456789abcdef";
	const HEADERS = { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" };

	const AGG = {
		repos: [],
		behindRepoNames: ["acme-api"],
		pending: { summary: 3, total: 3 },
		lastRebuiltAt: "2026-08-10T00:00:00.000Z",
		everBuilt: true,
		severity: "info" as const,
	};

	// A configDir whose config.json points `localFolder` at a real Memory Bank
	// dir, so `loadConfigFromDir` returns a localFolder and the endpoints proceed.
	// The aggregate freshness and the compile sweep are BOTH mocked, so the folder
	// contents are irrelevant — only that `localFolder` is set.
	function wikiServer(): Server {
		const configDir = writeMemoryBank(dir, [{ dir: "acme-api" }]);
		return testServer({ token: TOKEN, configDir });
	}

	// A configDir with a config.json that has NO localFolder (Memory Bank not set).
	function noFolderServer(): Server {
		const configDir = join(dir, "cfg-empty");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), "{}");
		return testServer({ token: TOKEN, configDir });
	}

	it("GET /api/wiki/freshness returns the aggregate freshness + inFlight", async () => {
		vi.mocked(getAggregateWikiFreshness).mockResolvedValue(AGG);
		const port = await listen(wikiServer());
		const res = await get(port, "/api/wiki/freshness");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			available: true,
			inFlight: false,
			severity: "info",
			behindRepoNames: ["acme-api"],
			pending: { summary: 3, total: 3 },
		});
		// A per-process nonce the page keys its banner-dismiss on (restart → new
		// nonce → dismissed banner reappears). Just needs to be a non-empty string.
		expect(typeof body.nonce).toBe("string");
		expect((body.nonce as string).length).toBeGreaterThan(0);
	});

	it("GET /api/wiki/freshness reports available:false when no Memory Bank folder is configured", async () => {
		const port = await listen(noFolderServer());
		const res = await get(port, "/api/wiki/freshness");
		expect(res.status).toBe(200);
		expect((await res.json()) as { available: boolean }).toEqual({ available: false });
	});

	it("GET /api/wiki/freshness 500s when freshness computation throws", async () => {
		vi.mocked(getAggregateWikiFreshness).mockRejectedValueOnce(new Error("boom"));
		const port = await listen(wikiServer());
		const res = await get(port, "/api/wiki/freshness");
		expect(res.status).toBe(500);
	});

	it("POST /api/wiki/rebuild launches the folder-wide compile and returns 202", async () => {
		vi.mocked(compileAllRepos).mockResolvedValue({ repos: [], totalIngested: 0, failed: 0 });
		const port = await listen(wikiServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(res.status).toBe(202);
		// Fire-and-forget: the sweep is kicked off after the 202 is sent.
		await vi.waitFor(() => expect(compileAllRepos).toHaveBeenCalled());
		expect(vi.mocked(compileAllRepos).mock.calls[0][0]).toMatch(/[\\/]mb$/);
	});

	it("POST /api/wiki/rebuild 409s when a rebuild is already in flight (no second sweep)", async () => {
		// Hold the first sweep pending so the in-flight flag stays set for POST #2.
		let release: (() => void) | undefined;
		vi.mocked(compileAllRepos).mockImplementationOnce(
			() =>
				new Promise((r) => {
					release = () => r({ repos: [], totalIngested: 0, failed: 0 });
				}),
		);
		const port = await listen(wikiServer());
		const first = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(first.status).toBe(202);
		await vi.waitFor(() => expect(compileAllRepos).toHaveBeenCalledTimes(1));
		const second = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(second.status).toBe(409);
		expect(compileAllRepos).toHaveBeenCalledTimes(1);
		release?.(); // let the first sweep finish so no promise dangles
	});

	it("POST /api/wiki/rebuild clears the in-flight flag when the sweep throws (a later rebuild still starts)", async () => {
		// The fire-and-forget sweep rejects; the handler's catch + finally must
		// still clear the flag, so a subsequent rebuild is accepted (202, not 409).
		vi.mocked(compileAllRepos).mockRejectedValueOnce(new Error("boom"));
		const port = await listen(wikiServer());
		const first = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(first.status).toBe(202);
		await vi.waitFor(() => expect(compileAllRepos).toHaveBeenCalledTimes(1));
		// Flag cleared by the finally → a fresh rebuild starts again.
		await vi.waitFor(async () => {
			const again = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
				method: "POST",
				headers: HEADERS,
				body: "{}",
			});
			expect(again.status).toBe(202);
		});
	});

	it("POST /api/wiki/rebuild 400s when no Memory Bank folder is configured", async () => {
		const port = await listen(noFolderServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(res.status).toBe(400);
		expect(compileAllRepos).not.toHaveBeenCalled();
	});

	it("POST /api/wiki/rebuild 400s (no silent no-op) when no usable LLM provider is configured", async () => {
		vi.mocked(resolveLlmCredentialSource).mockReturnValueOnce(null);
		const port = await listen(wikiServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
			method: "POST",
			headers: HEADERS,
			body: "{}",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/AI provider/);
		expect(compileAllRepos).not.toHaveBeenCalled();
	});
});

describe("withTimeout", () => {
	it("resolves with the value when the promise settles in time", async () => {
		await expect(withTimeout(Promise.resolve(42), 1000, "late")).resolves.toBe(42);
	});

	it("rejects with the message when the promise never settles", async () => {
		await expect(withTimeout(new Promise<never>(() => {}), 5, "timed out")).rejects.toThrow("timed out");
	});

	it("passes an Error rejection through untouched", async () => {
		const err = new Error("boom");
		await expect(withTimeout(Promise.reject(err), 1000, "late")).rejects.toBe(err);
	});

	it("wraps a non-Error rejection in an Error", async () => {
		await expect(withTimeout(Promise.reject("plain"), 1000, "late")).rejects.toThrow("plain");
	});
});

describe("settings, auth and misc endpoints", () => {
	const TOKEN = "settings-token-0123456789abcdef";
	const HEADERS = { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" };

	function svr(over: Partial<Parameters<typeof createDashboardServer>[0]> = {}): Server {
		return testServer({ token: TOKEN, ...over });
	}
	const postJson = (port: number, path: string, body: unknown): Promise<Response> =>
		fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });

	describe("GET /api/settings/check-folder", () => {
		it("403s without a valid token", async () => {
			const port = await listen(svr());
			expect((await get(port, "/api/settings/check-folder?path=/tmp")).status).toBe(403);
		});

		it("checks the folder with a token, defaulting a missing path to empty", async () => {
			vi.mocked(checkLocalFolder).mockResolvedValue("writable" as never);
			const port = await listen(svr());
			const withPath = await get(port, "/api/settings/check-folder?path=/tmp", {
				"X-Jolli-Dashboard-Token": TOKEN,
			});
			expect(withPath.status).toBe(200);
			expect(await withPath.json()).toEqual({ status: "writable" });
			await get(port, "/api/settings/check-folder", { "X-Jolli-Dashboard-Token": TOKEN });
			expect(vi.mocked(checkLocalFolder).mock.calls.map((c) => c[0])).toEqual(["/tmp", ""]);
		});
	});

	describe("GET /api/settings/push-repos", () => {
		it("lists the machine-wide push repos, folder omitted when unconfigured", async () => {
			vi.mocked(listPushControlRepos).mockResolvedValueOnce([]);
			const port = await listen(svr());
			const res = await get(port, "/api/settings/push-repos");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ repos: [] });
			// No localFolder in the test config → the option is dropped (the `?? {}` arm).
			expect(vi.mocked(listPushControlRepos).mock.calls[0]?.[0]).not.toHaveProperty("localFolder");
		});

		it("forwards the configured Memory Bank folder", async () => {
			vi.mocked(listPushControlRepos).mockResolvedValueOnce([]);
			const configDir = writeMemoryBank(dir, [{ dir: "acme-api" }]);
			const port = await listen(svr({ configDir }));
			await get(port, "/api/settings/push-repos");
			expect(vi.mocked(listPushControlRepos).mock.calls[0]?.[0]).toHaveProperty("localFolder");
		});

		it("500s when the push-control read fails", async () => {
			vi.mocked(listPushControlRepos).mockRejectedValueOnce(new Error("locked"));
			const port = await listen(svr());
			expect((await get(port, "/api/settings/push-repos")).status).toBe(500);
		});
	});

	// JOLLI-2152: mirrors the VS Code panel's per-repo Space column. Gated the
	// same as `/api/model?view=settings` — token AND same-site — because the
	// current repo's row calls the real front-door probe (auto-binds when
	// exactly one Space is bindable) and every row's Space name is key-derived
	// material; see the module header's layer 3.
	describe("GET /api/settings/space-bindings", () => {
		function writeJolliApiKeyConfig(base: string): string {
			const configDir = join(base, "jolli-key-config");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "config.json"), JSON.stringify({ jolliApiKey: "sk-jol-test" }));
			return configDir;
		}

		it("refuses without a token", async () => {
			const port = await listen(svr());
			expect((await get(port, "/api/settings/space-bindings")).status).toBe(403);
			expect(resolveSpaceBindingsForRepos).not.toHaveBeenCalled();
		});

		it("refuses when the token is wrong", async () => {
			const port = await listen(svr());
			const res = await get(port, "/api/settings/space-bindings", { "X-Jolli-Dashboard-Token": "nope" });
			expect(res.status).toBe(403);
		});

		// The half a token cannot cover: a hostile tab that somehow has the token
		// still announces itself in `Sec-Fetch-Site`.
		it("refuses cross-site even with a valid token", async () => {
			const port = await listen(svr());
			const res = await get(port, "/api/settings/space-bindings", {
				"X-Jolli-Dashboard-Token": TOKEN,
				"Sec-Fetch-Site": "cross-site",
			});
			expect(res.status).toBe(403);
			expect(resolveSpaceBindingsForRepos).not.toHaveBeenCalled();
		});

		it("reports signedOut with no bindings and never calls the resolver when no jolliApiKey is configured", async () => {
			const port = await listen(svr());
			const res = await get(port, "/api/settings/space-bindings", { "X-Jolli-Dashboard-Token": TOKEN });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ signedOut: true, bindings: {} });
			expect(resolveSpaceBindingsForRepos).not.toHaveBeenCalled();
		});

		it("resolves and formats bindings for each listed repo when signed in", async () => {
			const configDir = writeJolliApiKeyConfig(dir);
			vi.mocked(listPushControlRepos).mockResolvedValueOnce([
				{
					repoIdentity: "https://github.com/acme/widgets",
					repoName: "widgets",
					pushDisabled: false,
					isCurrentRepo: true,
				},
			]);
			vi.mocked(resolveSpaceBindingsForRepos).mockResolvedValueOnce(
				new Map([
					[
						"https://github.com/acme/widgets",
						{ kind: "bound", spaceName: "Acme Core", canPush: true, canRebind: false },
					],
				]),
			);
			const port = await listen(svr({ configDir }));

			const res = await get(port, "/api/settings/space-bindings", { "X-Jolli-Dashboard-Token": TOKEN });

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				signedOut: false,
				bindings: {
					"https://github.com/acme/widgets": {
						state: "bound",
						label: '"Acme Core"',
						title: 'This repo\'s memories push into the Jolli Space "Acme Core".',
					},
				},
			});
			expect(vi.mocked(resolveSpaceBindingsForRepos).mock.calls[0]?.[1]).toBe("sk-jol-test");
			// Must thread the server's own configDir through, like every other
			// registry-touching route in this file — otherwise the registry lookup
			// for non-current rows silently falls back to the machine-global dir.
			expect(vi.mocked(resolveSpaceBindingsForRepos).mock.calls[0]?.[2]).toMatchObject({ configDir });
		});

		it("500s when the resolver fails", async () => {
			const configDir = writeJolliApiKeyConfig(dir);
			vi.mocked(resolveSpaceBindingsForRepos).mockRejectedValueOnce(new Error("boom"));
			const port = await listen(svr({ configDir }));
			expect((await get(port, "/api/settings/space-bindings", { "X-Jolli-Dashboard-Token": TOKEN })).status).toBe(
				500,
			);
		});
	});

	describe("GET /api/settings/missing-summaries", () => {
		it("returns the count when the cwd is a project", async () => {
			vi.mocked(countMissingForCwd).mockResolvedValueOnce({ missing: 5 } as never);
			const port = await listen(svr());
			const res = await get(port, "/api/settings/missing-summaries");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ missing: 5 });
		});

		it("returns { missing: null } when the cwd is not a project", async () => {
			vi.mocked(countMissingForCwd).mockResolvedValueOnce(null as never);
			const port = await listen(svr());
			expect(await (await get(port, "/api/settings/missing-summaries")).json()).toEqual({ missing: null });
		});

		it("500s when the count fails", async () => {
			vi.mocked(countMissingForCwd).mockRejectedValueOnce(new Error("boom"));
			const port = await listen(svr());
			expect((await get(port, "/api/settings/missing-summaries")).status).toBe(500);
		});
	});

	describe("POST /api/settings/apply", () => {
		it("400s an invalid body via SettingsValidationError from the parser", async () => {
			vi.mocked(parseSettingsApplyInput).mockImplementationOnce(() => {
				throw new SettingsValidationError("bad input");
			});
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/apply", {});
			expect(res.status).toBe(400);
			expect((await res.json()) as { error: string }).toMatchObject({ error: "bad input" });
		});

		it("lets a non-validation parse error reach the outer 500 handler", async () => {
			vi.mocked(parseSettingsApplyInput).mockImplementationOnce(() => {
				throw new Error("unexpected");
			});
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/apply", {})).status).toBe(500);
		});

		it("applies settings and returns the hook failures", async () => {
			vi.mocked(parseSettingsApplyInput).mockReturnValueOnce({} as never);
			vi.mocked(applySettings).mockResolvedValueOnce({ hookFailures: ["h1"] } as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/apply", {});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, hookFailures: ["h1"] });
		});

		it("resolves the config dir globally when none was injected", async () => {
			vi.mocked(parseSettingsApplyInput).mockReturnValueOnce({} as never);
			vi.mocked(applySettings).mockResolvedValueOnce({ hookFailures: [] } as never);
			const port = await listen(svr({ configDir: undefined }));
			expect((await postJson(port, "/api/settings/apply", {})).status).toBe(200);
		});

		it("400s when applySettings raises a validation error", async () => {
			vi.mocked(parseSettingsApplyInput).mockReturnValueOnce({} as never);
			vi.mocked(applySettings).mockRejectedValueOnce(new SettingsValidationError("nope"));
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/apply", {});
			expect(res.status).toBe(400);
			expect((await res.json()) as { error: string }).toMatchObject({ error: "nope" });
		});

		it("500s when applySettings fails for any other reason", async () => {
			vi.mocked(parseSettingsApplyInput).mockReturnValueOnce({} as never);
			vi.mocked(applySettings).mockRejectedValueOnce(new Error("disk"));
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/apply", {})).status).toBe(500);
		});
	});

	describe("POST /api/settings/set-push", () => {
		it("400s without a repoIdentity", async () => {
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/set-push", { disabled: true })).status).toBe(400);
		});

		it("400s when disabled is not a boolean", async () => {
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/set-push", { repoIdentity: "r1" })).status).toBe(400);
		});

		it("disables a repo's push", async () => {
			vi.mocked(setRepoPushDisabledByIdentity).mockResolvedValueOnce({ disabled: true } as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/set-push", { repoIdentity: "r1", disabled: true });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, disabled: true });
			expect(triggerReenableDrain).not.toHaveBeenCalled();
		});

		it("re-enables the current repo and kicks off its drain, surfacing a corrupt-store recovery", async () => {
			vi.mocked(setRepoPushDisabledByIdentity).mockResolvedValueOnce({
				disabled: false,
				recoveredFromCorrupt: true,
			} as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/set-push", {
				repoIdentity: "r1",
				disabled: false,
				isCurrentRepo: true,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, disabled: false, recoveredFromCorrupt: true });
			expect(triggerReenableDrain).toHaveBeenCalledTimes(1);
		});

		it("500s when the store write fails", async () => {
			vi.mocked(setRepoPushDisabledByIdentity).mockRejectedValueOnce(new Error("locked"));
			const port = await listen(svr());
			expect(
				(await postJson(port, "/api/settings/set-push", { repoIdentity: "r1", disabled: true })).status,
			).toBe(500);
		});
	});

	describe("POST /api/settings/set-sync-sessions", () => {
		it("400s when enabled is not a boolean", async () => {
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/set-sync-sessions", {})).status).toBe(400);
		});

		it("applies the session-statistics switch", async () => {
			vi.mocked(setSyncSessions).mockResolvedValueOnce({ syncSessions: true } as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/set-sync-sessions", { enabled: true });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, syncSessions: true });
		});

		it("resolves the config dir globally when none was injected", async () => {
			vi.mocked(setSyncSessions).mockResolvedValueOnce({ syncSessions: false } as never);
			const port = await listen(svr({ configDir: undefined }));
			expect((await postJson(port, "/api/settings/set-sync-sessions", { enabled: false })).status).toBe(200);
		});

		it("500s when the switch write fails", async () => {
			vi.mocked(setSyncSessions).mockRejectedValueOnce(new Error("boom"));
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/set-sync-sessions", { enabled: true })).status).toBe(500);
		});
	});

	describe("POST /api/settings/probe-local-agent", () => {
		it("400s without a tool", async () => {
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/probe-local-agent", {})).status).toBe(400);
		});

		it("reports whether the tool is usable", async () => {
			vi.mocked(isLocalAgentUsable).mockResolvedValueOnce(true);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/probe-local-agent", { tool: "claude-code" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, usable: true });
		});

		it("500s when the probe throws", async () => {
			vi.mocked(isLocalAgentUsable).mockRejectedValueOnce(new Error("spawn failed"));
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/probe-local-agent", { tool: "claude-code" })).status).toBe(500);
		});
	});

	describe("POST /api/settings/migrate", () => {
		it("migrates and returns the result", async () => {
			vi.mocked(rebuildMemoryBank).mockResolvedValueOnce({ ok: true } as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/migrate", {});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
		});

		it("400s a failed migrate, surfacing the reason as error", async () => {
			vi.mocked(rebuildMemoryBank).mockResolvedValueOnce({ ok: false, message: "no memories" } as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/migrate", {});
			expect(res.status).toBe(400);
			expect((await res.json()) as { error: string }).toMatchObject({ error: "no memories" });
		});

		it("500s when the migrate throws", async () => {
			vi.mocked(rebuildMemoryBank).mockRejectedValueOnce(new Error("boom"));
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/migrate", {})).status).toBe(500);
		});
	});

	describe("POST /api/settings/generate-missing", () => {
		it("backfills the launch repo's missing summaries", async () => {
			vi.mocked(gitOps.getProjectRootDir).mockResolvedValueOnce("/tmp/repo");
			vi.mocked(recentCommitHashes).mockResolvedValueOnce(["h1"]);
			vi.mocked(runBackfill).mockResolvedValueOnce({ generated: 1, errors: 0, total: 1 } as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/generate-missing", {});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, generated: 1, errors: 0, total: 1 });
		});

		it("400s when the launch cwd is not a git repository", async () => {
			vi.mocked(gitOps.getProjectRootDir).mockRejectedValueOnce(new Error("not a repo"));
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/generate-missing", {})).status).toBe(400);
		});

		it("500s when the backfill throws", async () => {
			vi.mocked(gitOps.getProjectRootDir).mockResolvedValueOnce("/tmp/repo");
			vi.mocked(runBackfill).mockRejectedValueOnce(new Error("model down"));
			const port = await listen(svr());
			expect((await postJson(port, "/api/settings/generate-missing", {})).status).toBe(500);
		});
	});

	describe("auth and sync passthrough routes", () => {
		it("signs in via the shared browserLogin flow", async () => {
			vi.mocked(browserLogin).mockResolvedValueOnce(undefined as never);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/signin", {});
			expect(res.status).toBe(200);
			expect(browserLogin).toHaveBeenCalledTimes(1);
		});

		it("signs out by clearing the auth credentials", async () => {
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/signout", {});
			expect(res.status).toBe(200);
			expect(clearAuthCredentials).toHaveBeenCalledTimes(1);
		});

		it("runs a manual sync", async () => {
			vi.mocked(runSync).mockResolvedValueOnce(0);
			const port = await listen(svr());
			const res = await postJson(port, "/api/settings/sync-now", {});
			expect(res.status).toBe(200);
			expect(runSync).toHaveBeenCalledTimes(1);
		});
	});
});

describe("enable — registry projection", () => {
	const TOKEN = "enable-token-0123456789abcdef";
	const HEADERS = { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" };
	const enable = (port: number, path: string): Promise<Response> =>
		fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ path }),
		});

	it("400s a path that is not a git repository", async () => {
		vi.mocked(gitOps.getProjectRootDir).mockRejectedValueOnce(new Error("not a repo"));
		const port = await listen(testServer({ token: TOKEN, dbPath: join(dir, "enable-notgit.db") }));
		expect((await enable(port, "/tmp/x")).status).toBe(400);
	});

	it("projects the registered repo into the repos table", async () => {
		// A matching registry entry drives the find predicate and the withDashboardDb
		// projection callback — both are skipped by the empty-registry default.
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: join(dir, "acme"), enabledAt: "t" }],
		});
		const port = await listen(testServer({ token: TOKEN, dbPath: join(dir, "enable-project.db") }));
		const res = await enable(port, "/tmp/acme-api");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, repoIdentity: "r1" });
	});

	it("warns when the projection write fails, without failing the enable", async () => {
		const corrupt = join(dir, "enable-corrupt.db");
		writeFileSync(corrupt, "this is not a database");
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: join(dir, "acme"), enabledAt: "t" }],
		});
		const port = await listen(testServer({ token: TOKEN, dbPath: corrupt }));
		const res = await enable(port, "/tmp/acme-api");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; repoIdentity: string; warning?: string };
		expect(body.repoIdentity).toBe("r1");
		expect(body.warning).toMatch(/out of date/);
	});
});

describe("forget — projected-root classification", () => {
	const TOKEN = "forget-token-0123456789abcdef";
	const HEADERS = { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" };
	const FORGOTTEN = {
		identity: "r1",
		removedFromRegistry: true,
		repoRowDeleted: true,
		childRowsDeleted: 0,
		pendingEventsDeleted: 0,
	};
	const forget = (port: number): Promise<Response> =>
		fetch(`http://127.0.0.1:${port}/api/repos/forget`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});

	beforeEach(() => {
		vi.mocked(repoForget.forgetRepo).mockReset();
		vi.mocked(repoForget.classifyRegistryEntry).mockReset();
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({ version: 1, repos: [] });
	});

	it("treats an identity with no database as dead and forgets it", async () => {
		// No projected row can exist without a database — the no-db shortcut returns
		// "dead" rather than the fail-safe "live" branch.
		vi.mocked(repoForget.forgetRepo).mockResolvedValue(FORGOTTEN);
		const port = await listen(testServer({ token: TOKEN, dbPath: join(dir, "no-such-forget.db") }));
		expect((await forget(port)).status).toBe(200);
	});

	it("treats an identity the database does not project as dead and forgets it", async () => {
		vi.mocked(repoForget.forgetRepo).mockResolvedValue(FORGOTTEN);
		const dbPath = join(dir, "forget-empty.db");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(testServer({ token: TOKEN, dbPath }));
		expect((await forget(port)).status).toBe(200);
	});

	it("fails safe (409) when the projected-root read throws", async () => {
		// A read it could not do is not evidence the checkout is gone — the classifier
		// answers "live", so the row is refused rather than deleted.
		const corrupt = join(dir, "forget-corrupt.db");
		writeFileSync(corrupt, "this is not a database");
		const port = await listen(testServer({ token: TOKEN, dbPath: corrupt }));
		const res = await forget(port);
		expect(res.status).toBe(409);
		expect(repoForget.forgetRepo).not.toHaveBeenCalled();
	});
});

describe("read routes carry a detail-repo scope token", () => {
	it("threads ?detailRepo into the model request", async () => {
		const seen: Array<string | undefined> = [];
		const port = await listen(
			testServer({
				buildModel: async (req) => {
					seen.push(req.detailRepoIdentity);
					return model(req.view);
				},
			}),
		);
		await get(port, "/memories?hash=abc&detailRepo=repo-x");
		await get(port, "/memories?hash=abc");
		expect(seen).toEqual(["repo-x", undefined]);
	});
});

describe("outer request-handler error paths", () => {
	it("500s when serialization throws, and survives it", async () => {
		// This used to answer 200-then-nothing: `sendJson` wrote the header first and
		// `JSON.stringify` threw on the BigInt afterwards, so the outer catch saw
		// `headersSent` and could only end a response it had already promised was a
		// success. `/api/model` now serialises BEFORE writing the header (it has to —
		// gzip needs the bytes to know the length), so the throw arrives while a real
		// status can still be sent. A client that asked for JSON and got half a 200
		// has no way to tell that from an empty model.
		const port = await listen(
			testServer({
				buildModel: async (req) =>
					req.view === "stats" ? ({ view: "stats", bad: 10n } as never) : model(req.view),
			}),
		);
		const res = await get(port, "/api/model?view=stats");
		expect(res.status).toBe(500);
		// The server survives and answers the next request normally.
		expect((await get(port, "/memories")).status).toBe(200);
	});
});

describe("context-viewer parameter handling", () => {
	it("400s when kind or key is missing", async () => {
		const configDir = writeMemoryBank(dir, [{ dir: "repoA" }]);
		const port = await listen(testServer({ configDir }));
		expect((await get(port, "/context-viewer?repo=r&key=k")).status).toBe(400);
		expect((await get(port, "/context-viewer?repo=r&kind=plan")).status).toBe(400);
	});

	it("shows a guidance message when the markdown renderer cannot be found", async () => {
		// Both marked sources are absent: the test assets carry no vendor/ copy, and
		// resolveGraphAssetsDir is forced to throw — the route returns a friendly 200
		// rather than a 500.
		const dbPath = join(dir, "ctxview-nomarked.db");
		const configDir = join(dir, "config-ctxview-nomarked");
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO context (repo_id, kind, context_key, title, body_md, created_at_ms)
					 VALUES (?, 'plan', 'p1', 'The plan', '# The plan', 1)`,
				).run(id);
			},
			{ dbPath },
		);
		vi.mocked(resolveGraphAssetsDir).mockImplementationOnce(() => {
			throw new Error("no viz assets");
		});
		const port = await listen(testServer({ dbPath, configDir }));
		const res = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=p1");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("markdown renderer is missing");
	});
});

describe("/api/context missing kind or key", () => {
	it("400s a request missing kind and a request missing key", async () => {
		const port = await listen(testServer());
		expect((await get(port, "/api/context?repo=r&key=k")).status).toBe(400);
		expect((await get(port, "/api/context?repo=r&kind=plan")).status).toBe(400);
	});
});

describe("more read-route edges", () => {
	async function seedRepoRow(dbPath: string): Promise<void> {
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w/jolli",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
	}

	it("resolves the dashboard assets lazily for /context-viewer when none is injected", async () => {
		// No `assetsDir` option → the route falls through to resolveDashboardAssetsDir
		// (the right arm of `options.assetsDir ?? …`) and still renders the doc.
		const dbPath = join(dir, "ctxview-lazy.db");
		const configDir = join(dir, "config-ctxview-lazy");
		await seedRepoRow(dbPath);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO context (repo_id, kind, context_key, title, body_md, created_at_ms)
					 VALUES (?, 'plan', 'p1', 'The plan', '# The plan', 1)`,
				).run(id);
			},
			{ dbPath },
		);
		const port = await listen(createDashboardServer({ port: 0, dbPath, configDir }));
		const res = await get(port, "/context-viewer?repo=repo-1&kind=plan&key=p1");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("window.marked.parse");
	});

	it("serves a found conversation's turns over /api/conversation", async () => {
		const dbPath = join(dir, "conversation-ok.db");
		const configDir = join(dir, "config-conv-ok");
		await seedRepoRow(dbPath);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'abc', NULL, NULL, 'abc', 0, ?, 1, 1, 1)`,
				).run(id, JSON.stringify({ commitHash: "abc", topics: [] }));
				const stored = {
					sessions: [
						{
							sessionId: "s1",
							source: "claude",
							entries: [{ role: "user", content: "hello there" }],
						},
					],
				};
				db.prepare(
					"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, 't1', ?, 1)",
				).run(id, deflateSync(Buffer.from(JSON.stringify(stored), "utf8")));
				db.prepare(
					"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, 'abc', 't1')",
				).run(id);
			},
			{ dbPath },
		);
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/conversation?repo=repo-1&hash=abc&source=claude&session=s1");
		expect(res.status).toBe(200);
		const doc = (await res.json()) as { entries: Array<{ content: string }> };
		expect(doc.entries[0]?.content).toBe("hello there");
	});

	it("500s /api/memories when the dashboard database is invalid", async () => {
		const dbPath = join(dir, "broken-memories.db");
		writeFileSync(dbPath, "this is not a database");
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config-broken-mem") }),
		);
		expect((await get(port, "/api/memories")).status).toBe(500);
	});
});

describe("startDashboardServer without an explicit port", () => {
	it("binds a preferred candidate and logs later server errors without crashing", async () => {
		const started = await startDashboardServer({
			assetsDir,
			buildModel: async (req) => model(req.view),
			configDir: dir,
		});
		servers.push(started.server);
		expect(started.port).toBeGreaterThan(0);
		// The post-listening error handler just logs — emitting an error must not throw.
		expect(() => started.server.emit("error", new Error("late error"))).not.toThrow();
	});
});

describe("machine-global fallbacks (no dbPath, no configDir)", () => {
	it("serves read + config routes against the machine-global db and config", async () => {
		const home = join(dir, "mg-home");
		await withIsolatedHome(home, async () => {
			await withDashboardDb(() => {});
			const TOKEN = "mg-token-0123456789abcdef";
			const port = await listen(createDashboardServer({ port: 0, assetsDir, token: TOKEN }));
			// defaultModelBuilder with no dbPath (the `{}` ensureDashboardDbExists arm).
			expect((await get(port, "/api/model?view=stats")).status).toBe(200);
			expect((await get(port, "/api/memories")).status).toBe(200);
			expect((await get(port, "/api/journeys?range=30d")).status).toBe(200);
			// A journey feed with no range and no explicit window falls back to the
			// default range (the `?? JOURNEYS_DEFAULT_RANGE` arm).
			expect((await get(port, "/api/journeys")).status).toBe(200);
			expect((await get(port, "/api/journey?id=x&fromMs=1&toMs=2")).status).toBe(404);
			expect((await get(port, "/api/context?repo=r&kind=plan&key=k")).status).toBe(404);
			expect((await get(port, "/api/conversation?repo=r&hash=h&source=claude&session=s")).status).toBe(404);
			expect((await get(port, "/context-viewer?repo=r&kind=plan&key=k")).status).toBe(404);
			expect((await get(port, "/api/settings/push-repos")).status).toBe(200);
			expect((await get(port, "/api/wiki/freshness")).status).toBe(200);
			// Wiki rebuild with no configured Memory Bank folder → 400 (still runs the
			// config-dir fallback).
			const reb = await fetch(`http://127.0.0.1:${port}/api/wiki/rebuild`, {
				method: "POST",
				headers: { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" },
				body: "{}",
			});
			expect(reb.status).toBe(400);
		});
	});

	it("classifies and forgets a dead identity against the machine-global db", async () => {
		const home = join(dir, "mg-home-forget");
		await withIsolatedHome(home, async () => {
			await withDashboardDb(() => {});
			const TOKEN = "mg-forget-0123456789abcdef";
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({ version: 1, repos: [] });
			vi.mocked(repoForget.forgetRepo).mockResolvedValueOnce({
				identity: "r1",
				removedFromRegistry: true,
				repoRowDeleted: true,
				childRowsDeleted: 0,
				pendingEventsDeleted: 0,
			});
			const port = await listen(createDashboardServer({ port: 0, assetsDir, token: TOKEN }));
			const res = await fetch(`http://127.0.0.1:${port}/api/repos/forget`, {
				method: "POST",
				headers: { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" },
				body: JSON.stringify({ repoIdentity: "r1" }),
			});
			expect(res.status).toBe(200);
		});
	});

	it("projects a registered repo against the machine-global db on enable", async () => {
		const home = join(dir, "mg-home-enable");
		await withIsolatedHome(home, async () => {
			await withDashboardDb(() => {});
			const TOKEN = "mg-enable-0123456789abcdef";
			vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
				version: 1,
				repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: join(dir, "acme"), enabledAt: "t" }],
			});
			const port = await listen(createDashboardServer({ port: 0, assetsDir, token: TOKEN }));
			const res = await fetch(`http://127.0.0.1:${port}/api/repos/enable`, {
				method: "POST",
				headers: { "X-Jolli-Dashboard-Token": TOKEN, "content-type": "application/json" },
				body: JSON.stringify({ path: "/tmp/acme-api" }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, repoIdentity: "r1" });
		});
	});
});

describe("telemetry beacon — payload shape branches", () => {
	afterEach(() => {
		shutdownTelemetry();
	});

	async function post(port: number, body: unknown): Promise<Response> {
		return fetch(`http://127.0.0.1:${port}/api/telemetry`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	}

	it("drops a beacon whose event is not a string", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		expect((await post(port, { event: 123, properties: {} })).status).toBe(204);
		expect(await readTelemetryEvents(dir)).toEqual([]);
	});

	it("treats a non-object properties field as empty and still forwards the event", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		expect((await post(port, { event: "dashboard_opened" })).status).toBe(204);
		const events = await readTelemetryEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ eventName: "dashboard_opened", properties: {} });
	});

	it("drops a well-formed body that is not a JSON object", async () => {
		initTelemetry({ cwd: dir, installId: "install-1", origin: "https://acme.jolli.ai", config: {}, env: {} });
		const port = await listen(testServer());
		expect((await post(port, "42")).status).toBe(204);
		expect(await readTelemetryEvents(dir)).toEqual([]);
	});
});

describe("defaultModelBuilder — reachability and identity edges", () => {
	async function seedRepo(dbPath: string, root: string): Promise<void> {
		await applyStatsEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: root,
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
	}

	it("caches each worktree's git identity across standup requests on one server", async () => {
		const dbPath = join(dir, "identity-cache.db");
		const configDir = join(dir, "config-identity");
		await seedRepo(dbPath, "/w/jolli");
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		expect((await get(port, "/api/model?view=standup")).status).toBe(200);
		// Second request is served from the per-server identity cache — one git read only.
		expect((await get(port, "/api/model?view=standup")).status).toBe(200);
		expect(vi.mocked(gitOps.readLocalGitIdentity).mock.calls).toEqual([["/w/jolli"]]);
	});

	it("tolerates a repo whose reachable-commit read returns nothing", async () => {
		const dbPath = join(dir, "reach-null.db");
		const configDir = join(dir, "config-reach-null");
		await seedRepo(dbPath, "/w/jolli");
		vi.mocked(gitOps.listReachableCommits).mockResolvedValueOnce(null);
		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		expect((await get(port, "/api/model?view=memories")).status).toBe(200);
	});

	it("builds the settings view from config, not the database", async () => {
		const dbPath = join(dir, "settings-view.db");
		const configDir = join(dir, "config-settings-view");
		await withDashboardDb(() => {}, { dbPath });
		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir, token: "sv", serverCwd: process.cwd() }),
		);
		const res = await get(port, "/api/model?view=settings", { "X-Jolli-Dashboard-Token": "sv" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as DashboardModel).view).toBe("settings");
	});
});
