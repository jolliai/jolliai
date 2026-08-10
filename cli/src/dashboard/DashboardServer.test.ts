import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
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
// The real getDecisionGist makes an LLM call — mocked here so the
// defaultModelBuilder wiring test below can control its result directly,
// same as DecisionGist.test.ts covers the LLM call/cache/fail-open behavior.
const mockGetDecisionGist = vi.fn<(commitHash: string, text: string, config: unknown) => Promise<string | undefined>>();
vi.mock("./DecisionGist.js", () => ({
	getDecisionGist: (commitHash: string, text: string, config: unknown) =>
		mockGetDecisionGist(commitHash, text, config),
}));
// unlink is wrapped (not replaced) so every other state-file test keeps its
// real filesystem behavior — only the non-ENOENT-unlink-error test below ever
// overrides it, and only for its own call.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, unlink: vi.fn(actual.unlink) };
});

import { unlink } from "node:fs/promises";
import * as gitOps from "../core/GitOps.js";
import { initTelemetry, shutdownTelemetry } from "../core/Telemetry.js";
import { readTelemetryEvents } from "../core/TelemetryBuffer.js";
import * as installer from "../install/Installer.js";
import { withDashboardDb } from "./DashboardDb.js";
import type { DashboardModel, DashboardScope, DashboardView } from "./DashboardModel.js";
import {
	assembleDashboardHtml,
	clearDashboardState,
	createDashboardServer,
	DASHBOARD_SCRIPT_FILES,
	getDashboardStatePath,
	hasForeignOrigin,
	isAllowedHost,
	readDashboardState,
	resolveDashboardAssetsDir,
	startDashboardServer,
	writeDashboardState,
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
		"repositories.js",
		"memories.js",
		"settings.js",
		"main.js",
	]) {
		writeFileSync(join(assets, "js", f), `/* ${f} */`);
	}
	return assets;
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

function testServer(over: Partial<Parameters<typeof createDashboardServer>[0]> = {}): Server {
	return createDashboardServer({
		port: 0,
		assetsDir,
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
				{ host: "127.0.0.1", port, path: "/repositories", headers: { Host: "evil.com" } },
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
		expect((await get(port, "/repositories", { Origin: "https://evil.com" })).status).toBe(403);
	});

	it("serves every read path with no credential — the mutation token gates only POST/browse/probe, never GET pages", async () => {
		const port = await listen(testServer());
		expect((await get(port, "/repositories")).status).toBe(200);
		expect((await get(port, "/api/model")).status).toBe(200);
		const health = await get(port, "/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ ok: true, pid: process.pid });
	});

	it("never emits Access-Control-Allow-Origin", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/repositories");
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
	it("serves the page directly at /repositories — no handshake, no cookie", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/repositories");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("window.__JOLLI_DASHBOARD__");
		expect(html).toContain("body{color:red}"); // inlined CSS
		// Nothing is set on the client: no cookie, so nothing to go stale.
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	it("redirects / to /repositories when nothing is enabled yet", async () => {
		const port = await listen(testServer());
		const root = await get(port, "/");
		expect(root.status).toBe(302);
		expect(root.headers.get("location")).toBe("/repositories");
	});

	it("redirects / to /dashboard once a repo is enabled", async () => {
		const port = await listen(
			testServer({
				buildModel: async (req) => ({
					...model(req.view),
					repos: [{ repoIdentity: "r1", repoName: "r1", worktreeRoot: "/r1", sessionsThisWeek: 0 }],
				}),
			}),
		);
		const root = await get(port, "/");
		expect(root.status).toBe(302);
		expect(root.headers.get("location")).toBe("/dashboard");
	});

	it("gates the new destinations behind /repositories when no repo is enabled", async () => {
		const port = await listen(testServer());
		for (const path of ["/dashboard", "/dashboard/standup", "/memories"]) {
			const res = await get(port, path);
			expect(res.status, path).toBe(302);
			expect(res.headers.get("location"), path).toBe("/repositories");
		}
	});

	it("keeps Repositories reachable with zero repos — it is the page that opens the gate", async () => {
		const port = await listen(testServer());
		expect((await get(port, "/repositories")).status).toBe(200);
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
		expect(scopes).toEqual([{ kind: "repo", repoIdentity: "r1" }]);
	});

	it("defaults /api/model to the stats view and the all scope", async () => {
		const port = await listen(testServer());
		const res = await get(port, "/api/model");
		expect(((await res.json()) as DashboardModel).view).toBe("stats");
	});

	// A cross-site `no-cors` GET reaches this route (no Origin to reject, a
	// loopback Host to accept), so the token is what separates our own page's
	// poll from one — and only the money-spending part of the answer depends
	// on it. The route itself stays open: `curl /api/model` must keep working.
	describe("/api/model model-spend gate", () => {
		const spendFlags: Array<boolean | undefined> = [];
		const spyServer = () =>
			testServer({
				token: "tok",
				buildModel: async (req) => {
					spendFlags.push(req.allowModelSpend);
					return model(req.view);
				},
			});

		beforeEach(() => spendFlags.splice(0));

		it("withholds spend from a token-free call but still answers it", async () => {
			const port = await listen(spyServer());
			const res = await get(port, "/api/model?view=stats");
			expect(res.status).toBe(200);
			expect(((await res.json()) as DashboardModel).view).toBe("stats");
			expect(spendFlags).toEqual([false]);
		});

		it("withholds spend when the token is wrong", async () => {
			const port = await listen(spyServer());
			await get(port, "/api/model?view=stats", { "X-Jolli-Dashboard-Token": "nope" });
			expect(spendFlags).toEqual([false]);
		});

		it("allows spend for our own page's poll, which carries the token", async () => {
			const port = await listen(spyServer());
			await get(port, "/api/model?view=stats", { "X-Jolli-Dashboard-Token": "tok" });
			expect(spendFlags).toEqual([true]);
		});

		// `/repositories` rather than a GATED_PATH: the shared `model()` helper
		// has no repos, so /dashboard would 302 before rendering.
		it("allows spend for a page render — the by-hand URL keeps its full payload", async () => {
			const port = await listen(spyServer());
			expect((await get(port, "/repositories")).status).toBe(200);
			expect(spendFlags).toEqual([true]);
		});

		// The page routes take no token (that is the product call), so this is
		// the only thing standing between `<img src="…/stats">` on a hostile tab
		// and a real LLM call.
		it("withholds spend from a cross-site page load", async () => {
			const port = await listen(spyServer());
			const res = await get(port, "/repositories", { "Sec-Fetch-Site": "cross-site" });
			expect(res.status).toBe(200);
			expect(spendFlags).toEqual([false]);
		});

		it("withholds spend from a cross-site /api/model even with a valid token", async () => {
			const port = await listen(spyServer());
			await get(port, "/api/model?view=stats", {
				"X-Jolli-Dashboard-Token": "tok",
				"Sec-Fetch-Site": "cross-site",
			});
			expect(spendFlags).toEqual([false]);
		});

		it("still allows spend for our own page's same-origin poll", async () => {
			const port = await listen(spyServer());
			await get(port, "/api/model?view=stats", {
				"X-Jolli-Dashboard-Token": "tok",
				"Sec-Fetch-Site": "same-origin",
			});
			expect(spendFlags).toEqual([true]);
		});
	});

	it("serves every view as a page and over the API, and rejects an unknown one", async () => {
		const port = await listen(testServer());
		const page = await get(port, "/repositories");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toBe("text/html");
		// The API speaks view TOKENS, which are no longer the paths.
		for (const view of ["stats", "standup", "repositories", "memories"] as const) {
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
			["/repositories", "repositories"],
			["/dashboard", "stats"],
			["/dashboard/standup", "standup"],
			["/memories", "memories"],
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
		await get(port, "/repositories?dimension=ticket");
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
		await get(port, "/repositories?range=month");
		await get(port, "/repositories?range=custom&from=2026-07-01&to=2026-07-15");
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
		expect((await get(port, "/health")).status).toBe(200);
	});
});

describe("idle shutdown", () => {
	it("closes the server once no request has arrived within the timeout", async () => {
		vi.useFakeTimers();
		try {
			let nowMs = 0;
			const onIdleShutdown = vi.fn();
			const server = testServer({ idleTimeoutMs: 120_000, now: () => nowMs, onIdleShutdown });
			const port = await listen(server);
			expect(port).toBeGreaterThan(0);
			nowMs = 200_000; // idle past the timeout
			await vi.advanceTimersByTimeAsync(60_000); // one poll tick
			expect(onIdleShutdown).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not shut down on a poll tick that is not yet idle", async () => {
		vi.useFakeTimers();
		try {
			let nowMs = 0;
			const onIdleShutdown = vi.fn();
			const server = testServer({ idleTimeoutMs: 120_000, now: () => nowMs, onIdleShutdown });
			const port = await listen(server);
			expect(port).toBeGreaterThan(0);
			nowMs = 30_000; // well under the timeout
			await vi.advanceTimersByTimeAsync(60_000); // one poll tick, not idle yet
			expect(onIdleShutdown).not.toHaveBeenCalled();
			nowMs = 200_000; // now past the timeout
			await vi.advanceTimersByTimeAsync(60_000); // next poll tick
			expect(onIdleShutdown).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not arm the poll on a server that never bound", async () => {
		// `startDashboardServer` builds one server per candidate port and discards the
		// EADDRINUSE losers. A poll armed at construction outlived that discard —
		// nothing cleared it, `close()` on a never-listened server still invokes its
		// callback, and `unref` cannot help while a live sibling keeps the loop alive.
		// So the loser's frozen `lastRequestMs` fired hours later and shut down the
		// HEALTHY server sharing the process, deleting dashboard.json with it.
		vi.useFakeTimers();
		try {
			const onIdleShutdown = vi.fn();
			// Never listened: no `listen()` call at all.
			testServer({ idleTimeoutMs: 120_000, now: () => 1e12, onIdleShutdown });
			await vi.advanceTimersByTimeAsync(600_000);
			expect(onIdleShutdown).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("starts the idle clock when it begins SERVING, not when it was constructed", async () => {
		vi.useFakeTimers();
		try {
			// A loser can sit around a while before the winner binds; counting that
			// wait against the winner's idle budget would shut it down early.
			let nowMs = 0;
			const onIdleShutdown = vi.fn();
			const server = testServer({ idleTimeoutMs: 120_000, now: () => nowMs, onIdleShutdown });
			nowMs = 10_000_000; // long gap between construction and listen
			await listen(server);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(onIdleShutdown).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not arm the poll when the timeout is disabled", async () => {
		vi.useFakeTimers();
		try {
			const onIdleShutdown = vi.fn();
			const server = testServer({ idleTimeoutMs: 0, now: () => 1e12, onIdleShutdown });
			await listen(server);
			await vi.advanceTimersByTimeAsync(600_000);
			expect(onIdleShutdown).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
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
		const res = await get(port, "/repositories");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("window.__JOLLI_DASHBOARD__");
	});
});

describe("state file", () => {
	it("round-trips dashboard.json with 0600 and clears it", async () => {
		const state = {
			pid: process.pid,
			port: 12345,
			startedAt: "2026-07-30T00:00:00.000Z",
			schemaVersion: 1,
		};
		await writeDashboardState(state, dir);
		expect(await readDashboardState(dir)).toEqual(state);
		await clearDashboardState(dir);
		expect(await readDashboardState(dir)).toBeNull();
		// Clearing an absent file is fine.
		await clearDashboardState(dir);
	});

	it("clears the state file only for the pid that owns it", async () => {
		const state = { pid: 111, port: 12345, startedAt: "2026-07-30T00:00:00.000Z", schemaVersion: 1 };
		await writeDashboardState(state, dir);
		// A server exiting after its record was replaced must leave the successor's
		// record alone, or the live server becomes unfindable to every launcher.
		await clearDashboardState(dir, 222);
		expect(await readDashboardState(dir)).toEqual(state);
		await clearDashboardState(dir, 111);
		expect(await readDashboardState(dir)).toBeNull();
		// An absent (or unreadable) record is nobody's to protect.
		await clearDashboardState(dir, 111);
	});

	it("returns null for corrupt or wrong-shape state", async () => {
		writeFileSync(getDashboardStatePath(dir), "{broken");
		expect(await readDashboardState(dir)).toBeNull();
		writeFileSync(getDashboardStatePath(dir), JSON.stringify({ port: "not-a-number" }));
		expect(await readDashboardState(dir)).toBeNull();
	});

	it("swallows a non-ENOENT unlink failure while clearing the state file", async () => {
		const state = { pid: process.pid, port: 12345, startedAt: "2026-07-30T00:00:00.000Z", schemaVersion: 1 };
		await writeDashboardState(state, dir);
		vi.mocked(unlink).mockRejectedValueOnce(new Error("EPERM: permission denied"));
		await expect(clearDashboardState(dir)).resolves.toBeUndefined();
	});
});

describe("startDashboardServer", () => {
	it("binds a preferred (here: explicit) port and persists dashboard.json", async () => {
		const started = await startDashboardServer({
			port: 0,
			assetsDir,
			buildModel: async (req) => model(req.view),
			configDir: dir,
			now: () => 1_700_000_000_000,
		});
		servers.push(started.server);
		expect(started.port).toBeGreaterThan(0);
		const state = await readDashboardState(dir);
		expect(state).toMatchObject({ pid: process.pid, port: started.port });
	});

	it("falls back to the next candidate when a preferred port is taken", async () => {
		const first = await startDashboardServer({
			port: 0,
			assetsDir,
			buildModel: async (req) => model(req.view),
			configDir: dir,
		});
		servers.push(first.server);
		// Occupy → same explicit port now collides → error surfaces (single candidate).
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
		// frame was enough to POST /api/repos/disable with the page's own token.
		const port = await listen(writeServer());
		for (const path of ["/repositories", "/api/model"]) {
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

	it("disables a registered repo: uninstalls with persistManualDisable, then deregisters", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
			version: 1,
			repos: [
				{
					repoIdentity: "r1",
					repoName: "acme-api",
					worktreeRoot: "/tmp/acme-api",
					enabledAt: "2026-01-01T00:00:00Z",
				},
			],
		});
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/disable`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});
		expect(res.status).toBe(200);
		expect(installer.uninstall).toHaveBeenCalledWith(
			"/tmp/acme-api",
			expect.objectContaining({ preserveMenu: true, persistManualDisable: true }),
		);
		expect(repoRegistry.deregisterRepo).toHaveBeenCalled();
	});

	it("500s disable when uninstall fails, surfacing its message", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: "/tmp/acme-api", enabledAt: "t" }],
		});
		vi.mocked(installer.uninstall).mockResolvedValueOnce({ success: false, message: "in use", warnings: [] });
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/disable`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});
		expect(res.status).toBe(500);
		expect((await res.json()) as { error: string }).toMatchObject({ error: "in use" });
	});

	// The whole point of resume. Pausing writes `userDisabled: true` (uninstall's
	// persistManualDisable), and that flag stops capture on its own — so a resume
	// that reinstalls the hooks but leaves it set returns 200 and silently keeps the
	// repo dead. Only `clearManualDisableOnSuccess` clears it, so assert on the
	// option, not just on the reinstall having happened.
	it("resumes a registered repo: reinstalls (clearing the pause) and re-registers", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValueOnce({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: "/tmp/acme-api", enabledAt: "t" }],
		});
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/resume`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});
		expect(res.status).toBe(200);
		expect(installer.install).toHaveBeenCalledWith("/tmp/acme-api", {
			source: "cli",
			clearManualDisableOnSuccess: true,
		});
		expect(repoRegistry.registerRepo).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/acme-api" }));
	});

	it("500s resume when install fails, surfacing its message", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: "/tmp/acme-api", enabledAt: "t" }],
		});
		vi.mocked(installer.install).mockResolvedValueOnce({ success: false, message: "no credential", warnings: [] });
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/repos/resume`, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ repoIdentity: "r1" }),
		});
		expect(res.status).toBe(500);
		expect((await res.json()) as { error: string }).toMatchObject({ error: "no credential" });
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

	it("400s disable/resume/hooks-reinstall when repoIdentity is missing", async () => {
		const port = await listen(writeServer());
		for (const path of ["/api/repos/disable", "/api/repos/resume", "/api/hooks/reinstall"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: HEADERS,
				body: "{}",
			});
			expect(res.status, path).toBe(400);
		}
	});

	it("404s disable/resume/hooks-reinstall for an unregistered repoIdentity", async () => {
		vi.mocked(repoRegistry.readRepoRegistry).mockResolvedValue({ version: 1, repos: [] });
		const port = await listen(writeServer());
		for (const path of ["/api/repos/disable", "/api/repos/resume", "/api/hooks/reinstall"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ repoIdentity: "unknown" }),
			});
			expect(res.status, path).toBe(404);
		}
	});

	it("403s /api/browse and /api/repo-probe without a valid token, even as GET", async () => {
		const port = await listen(writeServer());
		expect((await fetch(`http://127.0.0.1:${port}/api/browse`)).status).toBe(403);
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

	it("browses a real directory once a valid token is presented", async () => {
		const port = await listen(writeServer());
		const scratch = mkdtempSync(join(tmpdir(), "jolli-browse-"));
		mkdirSync(join(scratch, "sub-repo"));
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(scratch)}`, {
				headers: { "X-Jolli-Dashboard-Token": TOKEN },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { entries: ReadonlyArray<{ name: string }> };
			expect(body.entries.map((e) => e.name)).toContain("sub-repo");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("400s a relative browse path", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=relative`, {
			headers: { "X-Jolli-Dashboard-Token": TOKEN },
		});
		expect(res.status).toBe(400);
	});

	it("browses the default path when none is given", async () => {
		const port = await listen(writeServer());
		const res = await fetch(`http://127.0.0.1:${port}/api/browse`, {
			headers: { "X-Jolli-Dashboard-Token": TOKEN },
		});
		expect(res.status).toBe(200);
	});

	it("500s /api/browse on an unexpected (non-BrowseError) failure", async () => {
		const browseModule = await import("./Browse.js");
		const spy = vi.spyOn(browseModule, "browseDirectory").mockRejectedValueOnce(new Error("unexpected"));
		try {
			const port = await listen(writeServer());
			const res = await fetch(`http://127.0.0.1:${port}/api/browse?path=/tmp`, {
				headers: { "X-Jolli-Dashboard-Token": TOKEN },
			});
			expect(res.status).toBe(500);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("defaultModelBuilder (no injected buildModel)", () => {
	// Exercises the real per-view async reads (Repositories only) against an actual
	// migrated SQLite dashboard db — every other test in this file injects
	// `buildModel` and never touches this code path at all.
	it("reads repositories for the Repositories view", async () => {
		const dbPath = join(dir, "dashboard.db");
		const configDir = join(dir, "config");
		await withDashboardDb(() => {}, { dbPath });

		const port = await listen(createDashboardServer({ port: 0, assetsDir, dbPath, configDir }));

		const stats = await get(port, "/api/model?view=stats");
		expect(stats.status).toBe(200);
		expect(((await stats.json()) as DashboardModel).view).toBe("stats");

		const repositories = await get(port, "/api/model?view=repositories");
		expect(repositories.status).toBe(200);
		expect(((await repositories.json()) as DashboardModel).view).toBe("repositories");
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

	// The `/` redirect reads `repos.length` and nothing else. It builds the
	// `repositories` model to avoid the stats view's LLM call, and that view now
	// pays a per-repo `git rev-list` for its memory badge — a badge this response
	// discards, and which the page it redirects to computes again anyway.
	it("skips the reachability fan-out for the / redirect, but pays it on the page itself", async () => {
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

		expect((await get(port, "/repositories")).status).toBe(200);
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

	beforeEach(() => {
		mockGetDecisionGist.mockReset();
	});

	it("attaches the gist returned by getDecisionGist to the Stats view's latest decision", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem1", "- **Picked SQLite**: needed local durability without a server.");
		mockGetDecisionGist.mockResolvedValueOnce("Picked SQLite for local durability.");

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config"), token: "tok" }),
		);
		const res = await get(port, "/api/model?view=stats", { "X-Jolli-Dashboard-Token": "tok" });

		expect(res.status).toBe(200);
		const body = (await res.json()) as DashboardModel;
		expect(body.stats?.decisions?.latest).toMatchObject({
			commitHash: "mem1",
			gist: "Picked SQLite for local durability.",
		});
		expect(mockGetDecisionGist).toHaveBeenCalledWith(
			"mem1",
			"- **Picked SQLite**: needed local durability without a server.",
			expect.anything(),
		);
	});

	// The actual protection: this is the only browser-reachable route that can
	// spend money, and a cross-site tab can reach it. It must answer — with the
	// decision, un-compressed — without ever calling the model.
	it("serves a token-free /api/model?view=stats without calling getDecisionGist", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem1", "- **Picked SQLite**: needed local durability without a server.");
		mockGetDecisionGist.mockResolvedValue("should never be reached");

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config"), token: "tok" }),
		);
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(200);
		const latest = ((await res.json()) as DashboardModel).stats?.decisions?.latest;
		expect(latest).toMatchObject({ commitHash: "mem1" });
		expect(latest).not.toHaveProperty("gist");
		expect(mockGetDecisionGist).not.toHaveBeenCalled();
	});

	it("falls back to the raw decision text when getDecisionGist fails open", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem2", "picked sqlite");
		mockGetDecisionGist.mockResolvedValueOnce(undefined);

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config") }),
		);
		const res = await get(port, "/api/model?view=stats");

		expect(res.status).toBe(200);
		const body = (await res.json()) as DashboardModel;
		expect(body.stats?.decisions?.latest).toMatchObject({ commitHash: "mem2", text: "picked sqlite" });
		expect(body.stats?.decisions?.latest).not.toHaveProperty("gist");
	});

	it("never calls getDecisionGist for views other than Stats", async () => {
		const dbPath = join(dir, "dashboard.db");
		await seedDecisionCommit(dbPath, "mem3", "picked sqlite");

		const port = await listen(
			createDashboardServer({ port: 0, assetsDir, dbPath, configDir: join(dir, "config") }),
		);
		const res = await get(port, "/api/model?view=standup");

		expect(res.status).toBe(200);
		expect(mockGetDecisionGist).not.toHaveBeenCalled();
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
