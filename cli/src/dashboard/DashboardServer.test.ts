import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
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
vi.mock("./RepoRegistry.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./RepoRegistry.js")>()),
	registerRepo: vi.fn().mockResolvedValue({
		repoIdentity: "r1",
		repoName: "acme-api",
		worktreeRoot: "/tmp/acme-api",
		enabledAt: "2026-01-01T00:00:00.000Z",
	}),
	deregisterRepo: vi.fn().mockResolvedValue("r1"),
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
vi.mock("../core/MultiRepoCompile.js", () => ({
	compileAllRepos: vi.fn(async () => ({ repos: [], totalIngested: 0, failed: 0 })),
}));
// Partial mock so the rebuild endpoint's up-front provider gate is controllable;
// default = a usable provider so the happy-path rebuild tests proceed.
vi.mock("../core/LlmClient.js", async (orig) => ({
	...(await orig<typeof import("../core/LlmClient.js")>()),
	resolveLlmCredentialSource: vi.fn(() => "local-agent"),
}));

import * as gitOps from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { compileAllRepos } from "../core/MultiRepoCompile.js";
import { initTelemetry, shutdownTelemetry } from "../core/Telemetry.js";
import { readTelemetryEvents } from "../core/TelemetryBuffer.js";
import { TRANSCRIPT_SOURCE_LABELS } from "../core/TranscriptSourceLabel.js";
import { getAggregateWikiFreshness } from "../core/WikiFreshness.js";
import * as installer from "../install/Installer.js";
import { withDashboardDb } from "./DashboardDb.js";
import { type DashboardModel, type DashboardScope, type DashboardView, TOOL_ROWS_LIMIT } from "./DashboardModel.js";
import {
	assembleDashboardHtml,
	createDashboardServer,
	DASHBOARD_HEALTH_SERVICE,
	DASHBOARD_SCRIPT_FILES,
	hasForeignOrigin,
	isAllowedHost,
	resolveDashboardAssetsDir,
	startDashboardServer,
} from "./DashboardServer.js";
import * as repoRegistry from "./RepoRegistry.js";
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
	for (const f of [
		"format.js",
		"charts.js",
		"shell.js",
		"stats.js",
		"standup.js",
		"graph.js",
		"memories.js",
		"knowledge.js",
		"settings.js",
		"main.js",
	]) {
		writeFileSync(join(assets, "js", f), `/* ${f} */`);
	}
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
		expect(html).toContain("body{color:red}"); // inlined CSS
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
});

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
		expect(html).toContain("/* main.js */");
		expect(html.indexOf("window.__JOLLI_DASHBOARD__")).toBeLessThan(html.indexOf("/* main.js */"));
	});

	// The agent-name half of `JD.sourceBadge`. Inlined from the CLI's own map so
	// the page holds no copy of it — asserted against the constant rather than
	// against literals, which is the whole point: a label added there must reach
	// the dashboard without anyone editing an asset file.
	it("inlines the transcript source labels ahead of the app scripts", () => {
		const html = assembleDashboardHtml(assetsDir, "{}");
		expect(html).toContain(`window.__JOLLI_SOURCE_LABELS__ = ${JSON.stringify(TRANSCRIPT_SOURCE_LABELS)}`);
		expect(html.indexOf("__JOLLI_SOURCE_LABELS__")).toBeLessThan(html.indexOf("/* main.js */"));
	});

	// Unlike the token, which is omitted when absent: a page without the labels
	// silently prints raw transcript tags (`cursor-cli`), and there is no caller
	// that would want that.
	it("inlines the labels even with no mutation token", () => {
		expect(assembleDashboardHtml(assetsDir, "{}")).toContain("__JOLLI_SOURCE_LABELS__");
		expect(assembleDashboardHtml(assetsDir, "{}")).not.toContain("__JOLLI_DASHBOARD_TOKEN__");
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

	// Memories is the one view that reads git before querying: a rebase leaves
	// rewritten commits in `memories` forever, so the list is filtered against
	// what is still reachable. Only this view pays that cost, and only for
	// repos that are still enabled.
	it("reads reachable commits for the Memories view, and prunes rows that no branch reaches", async () => {
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
			},
			{ dbPath },
		);

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));
		const res = await get(port, "/api/model?view=memories");

		expect(res.status).toBe(200);
		const body = (await res.json()) as DashboardModel;
		expect(body.view).toBe("memories");
		expect(gitOps.listReachableCommits).toHaveBeenCalledWith("/w/jolli");
		expect((body.memories?.items ?? []).map((item) => item.commitHash)).toEqual(["reachable-hash"]);
	});

	// The `/` redirect builds no model at all now — it has one destination, so
	// there is nothing to read `repos.length` for. The page it lands on still
	// pays the per-repo `git rev-list` its memory rows are filtered by.
	it("does no git work for the / redirect, but pays it on the page itself", async () => {
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
		expect(gitOps.listReachableCommits).toHaveBeenCalledWith("/w/jolli");
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
				// `listReachableCommits` is stubbed to return "reachable-hash" only, so
				// the second row is here to prove the route filters like the page does.
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
		expect(body.standup?.todayCommits).toEqual([]);
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
