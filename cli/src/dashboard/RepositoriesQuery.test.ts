import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import type { RepoRegistryFile } from "./RepoRegistry.js";
import { buildRepositoriesModel, HOOKS_MANIFEST } from "./RepositoriesQuery.js";
import { applyStatsEvents } from "./StatsWriter.js";

function writeRegistry(configDir: string, file: RepoRegistryFile): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "dashboard-repos.json"), JSON.stringify(file));
}

describe("buildRepositoriesModel", () => {
	let dir: string;
	let dbPath: string;
	let configDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-reposquery-"));
		dbPath = join(dir, "dashboard.db");
		configDir = join(dir, "config");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an empty list and the static hooks manifest when nothing is registered", async () => {
		writeRegistry(configDir, { version: 1, repos: [] });
		const model = await withDashboardDb((db) => buildRepositoriesModel(db, configDir), { dbPath });
		expect(model.repos).toEqual([]);
		expect(model.hooksManifest).toEqual(HOOKS_MANIFEST);
	});

	it("lists both enabled and disabled (paused) repos — the registry never deletes", async () => {
		writeRegistry(configDir, {
			version: 1,
			repos: [
				{
					repoIdentity: "r1",
					repoName: "acme-api",
					worktreeRoot: "/w/api",
					remoteUrl: "https://github.com/acme/acme-api",
					enabledAt: "t",
				},
				{ repoIdentity: "r2", repoName: "acme-web", worktreeRoot: "/w/web", enabledAt: "t", disabledAt: "t2" },
			],
		});
		const model = await withDashboardDb((db) => buildRepositoriesModel(db, configDir), { dbPath });
		expect(model.repos).toEqual([
			{
				repoIdentity: "r1",
				repoName: "acme-api",
				worktreeRoot: "/w/api",
				remoteUrl: "https://github.com/acme/acme-api",
				enabled: true,
				memories: 0,
				sessions: 0,
			},
			{
				repoIdentity: "r2",
				repoName: "acme-web",
				worktreeRoot: "/w/web",
				// Local-only repo: no remote, so no URL to show — the row omits it.
				remoteUrl: undefined,
				enabled: false,
				memories: 0,
				sessions: 0,
			},
		]);
	});

	it("joins real memory and session counts from the database", async () => {
		writeRegistry(configDir, {
			version: 1,
			repos: [{ repoIdentity: "repo-1", repoName: "jolli", worktreeRoot: "/w", enabledAt: "t" }],
		});
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
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "s1",
						updatedAtMs: 1000,
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, NULL, NULL, ?, 0, '{}', 1, 1, 1)`,
				).run(id, "a".repeat(40), "a".repeat(40));
				// An amend/rebase follow-up files under the original as a CHILD; it is
				// the same memory, so the repo still counts 1 (matches the Memories
				// browser, which lists roots only).
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, ?, 0, ?, 1, '{}', 2, 2, 2)`,
				).run(id, "b".repeat(40), "a".repeat(40), "a".repeat(40));
			},
			{ dbPath },
		);

		const model = await withDashboardDb((db) => buildRepositoriesModel(db, configDir), { dbPath });
		expect(model.repos[0].memories).toBe(1);
		expect(model.repos[0].sessions).toBeGreaterThanOrEqual(1);
	});

	// The model carries repos and the manifest, nothing else: there is no job
	// field to rejoin because this server starts no long-running work.
	it("returns only repos and the hooks manifest", async () => {
		writeRegistry(configDir, {
			version: 1,
			repos: [{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: "/w/api", enabledAt: "t" }],
		});
		const model = await withDashboardDb((db) => buildRepositoriesModel(db, configDir), { dbPath });
		expect(Object.keys(model).sort()).toEqual(["hooksManifest", "repos"]);
	});
});
