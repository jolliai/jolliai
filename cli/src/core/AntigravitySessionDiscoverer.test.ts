import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMetadataBlob, createAntigravityConvo, REAL_TRANSCRIPT_FULL } from "../testUtils/antigravityFixture.js";
import {
	discoverAntigravitySessions,
	extractWorkspacePath,
	scanAntigravitySessions,
} from "./AntigravitySessionDiscoverer.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

const sqliteOnly = hasNodeSqliteSupport() ? describe : describe.skip;

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("extractWorkspacePath", () => {
	it("reads the first file:// uri from a real-shaped blob", () => {
		const blob = buildMetadataBlob("/Users/x/repo", "gh/x", "main");
		expect(extractWorkspacePath(blob)).toBe("/Users/x/repo");
	});

	it("returns undefined when no file:// present", () => {
		expect(extractWorkspacePath(new Uint8Array([0x08, 0x01]))).toBeUndefined();
	});

	it("percent-decodes spaced / non-ASCII path segments", () => {
		// Antigravity is VS Code-based; Uri.toString() percent-encodes the path,
		// so a repo path with a space or CJK char arrives as %XX in the blob.
		const blob = buildMetadataBlob("/Users/x/my%20repo%E6%9F%A5");
		expect(extractWorkspacePath(blob)).toBe("/Users/x/my repo查");
	});

	it("strips the leading slash before a Windows drive letter", () => {
		// VS Code's Uri.file("e:\\jollimemory").toString() === "file:///e%3A/jollimemory";
		// the extra slash must be dropped or the path never matches native "e:/jollimemory".
		const blob = buildMetadataBlob("/e%3A/jollimemory");
		expect(extractWorkspacePath(blob)).toBe("e:/jollimemory");
	});
});

sqliteOnly("AntigravitySessionDiscoverer", () => {
	it("discovers a conversation scoped to projectDir", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "1bbaa61e",
			workspacePath: ws,
			gitRemote: "https://github.com/jolliai/jolliai.git",
			branch: "feature/x",
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("1bbaa61e");
		expect(sessions[0].source).toBe("antigravity");
		expect(sessions[0].transcriptPath.endsWith("transcript_full.jsonl")).toBe(true);
		expect(sessions[0].title).toContain("查看当前分支");
	});

	it("skips conversations for other workspaces", async () => {
		const home = freshDir("agy-home-");
		createAntigravityConvo(home, {
			convId: "other",
			workspacePath: "/some/other/repo",
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		expect(await discoverAntigravitySessions(freshDir("repo-"), home)).toHaveLength(0);
	});

	it("skips a matching conversation whose transcript is not materialized yet", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "pending",
			workspacePath: ws,
			transcriptLines: [],
			writeTranscript: false,
		});
		expect(await discoverAntigravitySessions(ws, home)).toHaveLength(0);
	});

	it("scans all variants and returns sessions across them", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "a",
			variant: "antigravity",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		createAntigravityConvo(home, {
			convId: "b",
			variant: "antigravity-ide",
			workspacePath: ws,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const { sessions } = await scanAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
	});

	it("matches a conversation recorded against a sibling worktree of the same repo", async () => {
		// Real Antigravity setups open the IDE on one checkout (often the main
		// worktree) while commits happen from a linked worktree. Exact-match on
		// projectDir would drop the conversation; worktree-aware matching keeps it.
		const home = freshDir("agy-home-");
		const mainRepo = realpathSync(freshDir("repo-main-"));
		const git = (args: string[]) => execFileSync("git", args, { cwd: mainRepo, stdio: "pipe" });
		git(["init", "-q", "-b", "main"]);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
		const wt = join(realpathSync(freshDir("repo-wt-")), "wt");
		git(["worktree", "add", "-q", wt, "-b", "feature"]);

		// Conversation opened in the MAIN checkout...
		createAntigravityConvo(home, {
			convId: "cross-wt",
			workspacePath: mainRepo,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});

		// ...discovered while running from the sibling WORKTREE.
		const sessions = await discoverAntigravitySessions(wt, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["cross-wt"]);
	});

	// JOLLI-2015: a conversation recorded in a subdirectory of the project (the IDE
	// opened on a subpackage, or a CLI variant run from `cd packages/foo`) IS
	// attributed to the repo via prefix/containment matching — shared with the other
	// hookless sources.
	it("discovers a conversation recorded in a subdirectory of the project (prefix match)", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		createAntigravityConvo(home, {
			convId: "in-subdir",
			workspacePath: join(ws, "packages", "foo"),
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions.map((s) => s.sessionId)).toEqual(["in-subdir"]);
	});

	// A conversation living in a NESTED git repo / submodule inside the worktree
	// belongs to the inner repo, not this one — an intervening `.git` excludes it.
	it("skips a conversation inside a nested git repo under the project", async () => {
		const home = freshDir("agy-home-");
		const ws = realpathSync(freshDir("repo-"));
		const nested = join(ws, "vendor", "lib");
		mkdirSync(join(nested, ".git"), { recursive: true });
		createAntigravityConvo(home, {
			convId: "nested",
			workspacePath: nested,
			transcriptLines: REAL_TRANSCRIPT_FULL,
		});
		expect(await discoverAntigravitySessions(ws, home)).toHaveLength(0);
	});

	it("de-duplicates a conversation present under multiple variants, keeping the newest", async () => {
		const home = freshDir("agy-home-");
		const ws = freshDir("repo-");
		const mk = (variant: string) =>
			createAntigravityConvo(home, {
				convId: "dup",
				variant,
				workspacePath: ws,
				transcriptLines: REAL_TRANSCRIPT_FULL,
			});
		// Relative to now so the conversations stay inside the 48h window whenever
		// the suite runs. antigravity-ide is newest → kept; -cli is oldest → the
		// `>=` guard skips its SQLite open; antigravity is replaced when -ide wins.
		const now = Date.now();
		const at = (hoursAgo: number) => {
			const d = new Date(now - hoursAgo * 3600_000);
			return [d, d] as const;
		};
		utimesSync(mk("antigravity").dbPath, ...at(2));
		utimesSync(mk("antigravity-ide").dbPath, ...at(1));
		utimesSync(mk("antigravity-cli").dbPath, ...at(3));

		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].transcriptPath).toContain("antigravity-ide");
	});
});
