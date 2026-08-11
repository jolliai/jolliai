import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMemoryBank } from "./MemoryBankRebuild.js";
import { writeManualDisableFlag } from "./RepoProfile.js";
import { resolveSotStorage } from "./SotStorageResolver.js";

/** A minimal v3 summary index for one commit. */
function makeIndex(hash: string): string {
	return JSON.stringify({
		version: 3,
		entries: [
			{
				commitHash: hash,
				parentCommitHash: null,
				commitMessage: "seed",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
			},
		],
	});
}

/** A minimal v3 summary body. */
function makeSummary(hash: string): string {
	return JSON.stringify({
		version: 3,
		commitHash: hash,
		commitMessage: "seed",
		commitAuthor: "Alice",
		commitDate: "2026-01-15T10:00:00Z",
		branch: "main",
		generatedAt: "2026-01-15T10:00:00Z",
		topics: [{ title: "Topic", trigger: "t", response: "r", decisions: "d" }],
		stats: { filesChanged: 1, insertions: 2, deletions: 0 },
	});
}

let dir: string;

function initRepo(): string {
	const repo = mkdtempSync(join(dir, "repo-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	return repo;
}

const GIT_IDENT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
} as const;

const savedEnv: Record<string, string | undefined> = {};
const MANAGED_ENV = ["HOME", "USERPROFILE", ...Object.keys(GIT_IDENT_ENV)];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-mbr-"));
	for (const k of MANAGED_ENV) savedEnv[k] = process.env[k];
	// Isolate the machine-global config + default Memory Bank root to a temp HOME
	// so `rebuildMemoryBank` (which reads the global config and migrates into the
	// default folder when no localFolder is set) never touches the real one.
	const home = mkdtempSync(join(dir, "home-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	// Nuking HOME also nukes the global git identity, so set one explicitly via env
	// — inherited by BOTH the explicit `git commit` and the internal orphan
	// commit-tree, keeping the test identity-independent on CI (gitEnv.ts leaves
	// user.name empty on purpose).
	Object.assign(process.env, GIT_IDENT_ENV);
});

afterEach(() => {
	for (const k of MANAGED_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("rebuildMemoryBank", () => {
	it("refuses a manually-disabled repo", async () => {
		const repo = initRepo();
		await writeManualDisableFlag(repo, true);
		const result = await rebuildMemoryBank(repo);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/disabled/i);
	});

	it("refuses when there are no stored memories to rebuild", async () => {
		const repo = initRepo();
		const result = await rebuildMemoryBank(repo);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/no stored memories/i);
	});

	it("migrates stored memories into a fresh Memory Bank folder", async () => {
		const repo = initRepo();
		// A commit so the system-of-record storage has a HEAD to anchor to.
		writeFileSync(join(repo, "f.txt"), "hi");
		execFileSync("git", ["add", "-A"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

		// HOME is already isolated (beforeEach), so migration lands in the temp
		// default Memory Bank folder under it — never the real one.
		// Seed the system-of-record with one summary so detectStoredMemories → "some".
		const sot = await resolveSotStorage(repo);
		const hash = "abc123def456";
		await sot.writeFiles(
			[
				{ path: "index.json", content: makeIndex(hash) },
				{ path: `summaries/${hash}.json`, content: makeSummary(hash) },
			],
			"seed summary",
		);

		const result = await rebuildMemoryBank(repo);
		expect(result.ok).toBe(true);
		// Pin the COUNT so a regression that silently migrates zero entries (which
		// still returns ok + "0 memories migrated", matching /migrated/) is caught.
		expect(result.message).toMatch(/\b1 memories migrated/);
		expect(result.folder).toBeTruthy();
	});
});
