/**
 * Integration tests for the Settings HTTP endpoints against a REAL
 * createDashboardServer (no module mocks), a temp config dir, and a temp git
 * repo as the server's cwd. Kept out of `DashboardServer.test.ts` because that
 * file fully mocks `GitOps`, which the config/push/backfill paths here need for
 * real. The genuinely external actions (sign in/out, sync-now) are not driven
 * here — they touch the machine-global auth config or the network and are
 * covered where their core lives.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardModel, DashboardView } from "./DashboardModel.js";
import { createDashboardServer, withTimeout } from "./DashboardServer.js";

let dir: string;
let configDir: string;
let repoCwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
const servers: Server[] = [];

const TOKEN = "test-token";

function baseModel(view: DashboardView): DashboardModel {
	return {
		schemaVersion: 2,
		view,
		tier: "installed",
		generatedAtMs: 0,
		timeZone: "UTC",
		scope: { kind: "all" },
		repos: [],
		coverage: [],
	};
}

async function startServer(): Promise<number> {
	const server = createDashboardServer({
		port: 0,
		token: TOKEN,
		configDir,
		serverCwd: repoCwd,
		idleTimeoutMs: 0,
		buildModel: async (req) => baseModel(req.view),
	});
	servers.push(server);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
}

function post(port: number, path: string, body: unknown, token: string = TOKEN): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "X-Jolli-Dashboard-Token": token },
		body: JSON.stringify(body),
	});
}

function get(port: number, path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, { headers: { "X-Jolli-Dashboard-Token": TOKEN } });
}

async function jbody(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-setep-"));
	// Isolate HOME so the push-control store the set-push test writes never lands
	// in the developer's real ~/.jolli.
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	const home = mkdtempSync(join(dir, "home-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	configDir = mkdtempSync(join(dir, "cfg-"));
	// Point localFolder at an empty temp Memory Bank so listPushControlRepos scans
	// nothing real on this machine (it otherwise falls back to the default folder).
	const emptyBank = mkdtempSync(join(dir, "bank-"));
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ localFolder: emptyBank }));
	repoCwd = mkdtempSync(join(dir, "repo-"));
	execFileSync("git", ["init", "-q"], { cwd: repoCwd });
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = savedUserProfile;
	rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/settings/apply", () => {
	function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			claudeEnabled: true,
			codexEnabled: true,
			geminiEnabled: true,
			openCodeEnabled: true,
			cursorEnabled: true,
			devinEnabled: true,
			copilotEnabled: true,
			clineEnabled: true,
			antigravityEnabled: true,
			kimiEnabled: true,
			globalInstructions: "default",
			aiProvider: "anthropic",
			model: "sonnet",
			apiKey: "",
			jolliApiKey: "",
			localAgentTool: "claude-code",
			localFolder: "",
			compileExcludeFolders: "",
			syncTranscripts: false,
			dcoSignoff: false,
			excludePatterns: "",
			...over,
		};
	}

	it("persists a valid submission and reports no hook failures", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/apply", validBody({ dcoSignoff: true, codexEnabled: false }));
		expect(res.status).toBe(200);
		const data = await jbody(res);
		expect(data.ok).toBe(true);
		expect(data.hookFailures).toEqual([]);
		const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")) as Record<string, unknown>;
		expect(config.dcoSignoff).toBe(true);
		expect(config.codexEnabled).toBe(false);
	});

	it("400s an invalid provider", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/apply", validBody({ aiProvider: "openai" }));
		expect(res.status).toBe(400);
		expect((await jbody(res)).error).toMatch(/aiProvider/);
	});

	it("400s a submission with every agent disabled", async () => {
		const port = await startServer();
		const allOff = validBody();
		for (const k of Object.keys(allOff)) if (k.endsWith("Enabled")) allOff[k] = false;
		const res = await post(port, "/api/settings/apply", allOff);
		expect(res.status).toBe(400);
	});

	it("403s without the token", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/apply", validBody(), "wrong");
		expect(res.status).toBe(403);
	});
});

describe("POST /api/settings/set-push validation", () => {
	it("400s a missing repoIdentity", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/set-push", { disabled: true });
		expect(res.status).toBe(400);
		expect((await jbody(res)).error).toMatch(/repoIdentity/);
	});

	it("400s a non-boolean disabled", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/set-push", { repoIdentity: "https://x/y" });
		expect(res.status).toBe(400);
		expect((await jbody(res)).error).toMatch(/disabled/);
	});

	it("toggles push off then back on for a repo identity (immediate)", async () => {
		const port = await startServer();
		const id = "https://github.com/acme/api";
		const off = await post(port, "/api/settings/set-push", { repoIdentity: id, disabled: true });
		expect(off.status).toBe(200);
		expect((await jbody(off)).disabled).toBe(true);
		// Re-enable the current repo → also exercises the triggerReenableDrain branch.
		const on = await post(port, "/api/settings/set-push", {
			repoIdentity: id,
			disabled: false,
			isCurrentRepo: true,
		});
		expect(on.status).toBe(200);
		expect((await jbody(on)).disabled).toBe(false);
	});
});

describe("POST /api/settings/probe-local-agent validation", () => {
	it("400s a missing tool", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/probe-local-agent", {});
		expect(res.status).toBe(400);
	});
});

describe("GET /api/settings/push-repos", () => {
	it("lists the launch repo (always included) and none from the empty Memory Bank", async () => {
		const port = await startServer();
		const res = await get(port, "/api/settings/push-repos");
		expect(res.status).toBe(200);
		const repos = (await jbody(res)).repos as Array<Record<string, unknown>>;
		// The current repo is always included even without a git remote (file:// id);
		// the empty Memory Bank contributes nothing.
		expect(repos.length).toBe(1);
		expect(repos[0].isCurrentRepo).toBe(true);
		expect(repos[0].pushDisabled).toBe(false);
	});
});

describe("GET /api/settings/missing-summaries", () => {
	it("returns a count for the launch repo", async () => {
		const port = await startServer();
		const res = await get(port, "/api/settings/missing-summaries");
		expect(res.status).toBe(200);
		const data = await jbody(res);
		// A fresh repo has no commits → 0 missing of 0 (a real count, not the n/a shape).
		expect(data.missing).toBe(0);
		expect(data.total).toBe(0);
		// The launch repo's name rides along so the panel can name (and highlight) it.
		expect(typeof data.repoName).toBe("string");
		expect((data.repoName as string).length).toBeGreaterThan(0);
	});
});

describe("GET /api/settings/check-folder", () => {
	it("reports ok for an existing folder and missing for a non-existent one", async () => {
		const port = await startServer();
		const existing = mkdtempSync(join(dir, "cf-exists-"));
		const okRes = await get(port, `/api/settings/check-folder?path=${encodeURIComponent(existing)}`);
		expect(okRes.status).toBe(200);
		expect((await jbody(okRes)).status).toBe("ok");
		const missRes = await get(port, `/api/settings/check-folder?path=${encodeURIComponent(join(dir, "cf-nope"))}`);
		expect((await jbody(missRes)).status).toBe("missing");
	});

	it("403s without a valid token — it reveals filesystem existence", async () => {
		const port = await startServer();
		const res = await fetch(`http://127.0.0.1:${port}/api/settings/check-folder?path=${encodeURIComponent(dir)}`);
		expect(res.status).toBe(403);
	});
});

describe("POST /api/settings/generate-missing", () => {
	it("runs a backfill over the (empty) launch repo", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/generate-missing", {});
		expect(res.status).toBe(200);
		expect((await jbody(res)).ok).toBe(true);
	});

	it("400s when the server was not started inside a git repository", async () => {
		// Point the server's cwd at a plain (non-git) directory.
		repoCwd = mkdtempSync(join(dir, "plain-"));
		const port = await startServer();
		const res = await post(port, "/api/settings/generate-missing", {});
		expect(res.status).toBe(400);
		expect((await jbody(res)).error).toMatch(/git repository/i);
	});
});

describe("POST /api/settings/migrate", () => {
	it("400s when the launch repo has no stored memories", async () => {
		const port = await startServer();
		const res = await post(port, "/api/settings/migrate", {});
		expect(res.status).toBe(400);
		expect((await jbody(res)).message).toMatch(/no stored memories/i);
	});
});

describe("real model builder for /settings", () => {
	// Exercises the REAL defaultModelBuilder (no buildModel override) so the
	// DashboardServer settings-model branch and DashboardQuery's `case "settings"`
	// both run end to end against a temp DB + temp config + temp git repo.
	async function startRealServer(): Promise<number> {
		const server = createDashboardServer({
			port: 0,
			token: TOKEN,
			configDir,
			serverCwd: repoCwd,
			dbPath: join(dir, "dash.db"),
			idleTimeoutMs: 0,
		});
		servers.push(server);
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				resolve(typeof addr === "object" && addr ? addr.port : 0);
			});
		});
	}

	it("serves a settings model via /api/model?view=settings", async () => {
		const port = await startRealServer();
		const res = await get(port, "/api/model?view=settings");
		expect(res.status).toBe(200);
		const model = await jbody(res);
		expect(model.view).toBe("settings");
		const settings = model.settings as Record<string, Record<string, unknown>>;
		expect(settings).toBeTruthy();
		expect(settings.agents.claudeEnabled).toBe(true);
		expect(settings.summary.aiProvider).toBe("anthropic");
		expect(settings.others).toBeTruthy();
	});

	it("403s on /api/model?view=settings without the token — the payload carries masked keys", async () => {
		const port = await startRealServer();
		// No X-Jolli-Dashboard-Token header (unlike the `get` helper), so this is a
		// token-free reader — it must NOT receive the settings payload.
		const res = await fetch(`http://127.0.0.1:${port}/api/model?view=settings`);
		expect(res.status).toBe(403);
	});

	it("still serves a non-settings /api/model view without the token", async () => {
		const port = await startRealServer();
		const res = await fetch(`http://127.0.0.1:${port}/api/model?view=stats`);
		expect(res.status).toBe(200);
	});
});

describe("withTimeout", () => {
	it("resolves when the promise settles in time", async () => {
		await expect(withTimeout(Promise.resolve(7), 1000, "too slow")).resolves.toBe(7);
	});

	it("rejects with the given message when the promise is too slow", async () => {
		const never = new Promise<number>(() => {});
		await expect(withTimeout(never, 10, "too slow")).rejects.toThrow("too slow");
	});

	it("propagates the underlying rejection", async () => {
		await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "too slow")).rejects.toThrow("boom");
	});
});
