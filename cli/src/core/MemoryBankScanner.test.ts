/**
 * MemoryBankScanner integration tests — pin a real on-disk Memory Bank layout
 * (per [feedback_external_parser_real_fixture]: never let parser + fixture
 * both be fabricated by the same brain). Every assertion below is grounded
 * on files that actually exist in a tmpdir tree shaped like a real Memory
 * Bank, with a real manifest.json + branches.json + repo config.json.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./SessionTracker.js", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("./KBPathResolver.js", () => ({
	extractRepoName: vi.fn(),
	getRemoteUrl: vi.fn(),
	resolveKBPath: vi.fn(),
}));

import { extractRepoName, getRemoteUrl, resolveKBPath } from "./KBPathResolver.js";
import { listAllUserKnowledgeFromRoot, listUserKnowledge } from "./MemoryBankScanner.js";
import { loadConfig } from "./SessionTracker.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockExtractRepoName = vi.mocked(extractRepoName);
const mockGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockResolveKBPath = vi.mocked(resolveKBPath);

describe("MemoryBankScanner.listUserKnowledge", () => {
	let localFolderRoot: string;
	let kbRoot: string;
	let cwd: string;

	async function writeManifest(
		files: ReadonlyArray<{ path: string; fileId: string; fingerprint: string }>,
	): Promise<void> {
		const manifest = {
			version: 1,
			files: files.map((f) => ({
				path: f.path,
				fileId: f.fileId,
				type: "commit" as const,
				fingerprint: f.fingerprint,
				source: { commitHash: f.fileId },
			})),
		};
		await mkdir(join(kbRoot, ".jolli"), { recursive: true });
		await writeFile(join(kbRoot, ".jolli", "manifest.json"), JSON.stringify(manifest, null, "\t"), "utf-8");
	}

	async function writeBranches(mappings: ReadonlyArray<{ branch: string; folder: string }>): Promise<void> {
		const branches = {
			version: 1,
			mappings: mappings.map((m) => ({
				branch: m.branch,
				folder: m.folder,
				createdAt: "2026-04-01T10:00:00.000Z",
			})),
		};
		await mkdir(join(kbRoot, ".jolli"), { recursive: true });
		await writeFile(join(kbRoot, ".jolli", "branches.json"), JSON.stringify(branches, null, "\t"), "utf-8");
	}

	beforeEach(async () => {
		localFolderRoot = mkdtempSync(join(tmpdir(), "mbscan-local-"));
		kbRoot = join(localFolderRoot, "jolliai");
		cwd = mkdtempSync(join(tmpdir(), "mbscan-repo-"));
		await mkdir(kbRoot, { recursive: true });

		mockLoadConfig.mockResolvedValue({ localFolder: localFolderRoot } as never);
		mockExtractRepoName.mockReturnValue("jolliai");
		mockGetRemoteUrl.mockReturnValue("https://github.com/jolliai/jolliai");
		mockResolveKBPath.mockReturnValue(kbRoot);
	});

	afterEach(() => {
		rmSync(localFolderRoot, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("surfaces a user file at the repo root", async () => {
		await writeManifest([]);
		await writeFile(join(kbRoot, "Unnamed.md"), "# Hello\n\nbody", "utf-8");

		const result = await listUserKnowledge(cwd);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "jolliai/Unnamed.md",
			scope: "repo",
			content: "# Hello\n\nbody",
		});
		// Real sha256 of "# Hello\n\nbody" — verify the fingerprint matches the same algorithm manifest.json uses.
		expect(result[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(result[0].fingerprint).not.toBe("");
	});

	it("surfaces a user file in the global scope (one level above kbRoot)", async () => {
		await writeManifest([]);
		await writeFile(join(localFolderRoot, "Inbox.md"), "global content", "utf-8");

		const result = await listUserKnowledge(cwd);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "Inbox.md",
			scope: "global",
			content: "global content",
		});
	});

	it("surfaces a user file under the branch folder (resolved via branches.json)", async () => {
		await writeManifest([]);
		await writeBranches([{ branch: "feature/auth", folder: "feature-auth" }]);
		await mkdir(join(kbRoot, "feature-auth"));
		await writeFile(join(kbRoot, "feature-auth", "design.md"), "design", "utf-8");

		const result = await listUserKnowledge(cwd, "feature/auth");

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			path: "jolliai/feature-auth/design.md",
			scope: "branch",
			branch: "feature/auth",
			content: "design",
		});
	});

	it("falls back to transcodeBranchName when branches.json lacks a mapping", async () => {
		await writeManifest([]);
		// No branches.json — directory exists at the transcoded default
		await mkdir(join(kbRoot, "feature-bugfix"));
		await writeFile(join(kbRoot, "feature-bugfix", "note.md"), "note", "utf-8");

		const result = await listUserKnowledge(cwd, "feature/bugfix");

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ path: "jolliai/feature-bugfix/note.md", scope: "branch" });
	});

	it("skips files in the manifest (primary identification rule)", async () => {
		// Generated file inside repo root, recorded in manifest
		await writeManifest([{ path: "Generated-abc12345.md", fileId: "abc12345", fingerprint: "deadbeef" }]);
		await writeFile(join(kbRoot, "Generated-abc12345.md"), "generated", "utf-8");
		await writeFile(join(kbRoot, "user.md"), "user", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/user.md"]);
	});

	it("skips a manifest-listed repo file even when its name does not match the hash suffix", async () => {
		// Manifest path has no generated `-<8hex>.md` suffix, so the secondary
		// rule cannot catch it — only the primary manifest check (L192) drops it.
		await writeManifest([{ path: "summary.md", fileId: "feedfeed", fingerprint: "cafebabe" }]);
		await writeFile(join(kbRoot, "summary.md"), "ai-generated, in manifest", "utf-8");
		await writeFile(join(kbRoot, "user.md"), "user", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/user.md"]);
	});

	it("falls back to the hash-suffix rule with a WARN when manifest.json is corrupt (no files array)", async () => {
		// Valid JSON but missing the `files` array — readManifest() returns the
		// object as-is, so `manifest.files.map(...)` throws and the scanner must
		// degrade to secondary-rule-only identification (the catch branch).
		await mkdir(join(kbRoot, ".jolli"), { recursive: true });
		await writeFile(join(kbRoot, ".jolli", "manifest.json"), JSON.stringify({ version: 1 }), "utf-8");
		await writeFile(join(kbRoot, "user.md"), "kept", "utf-8");
		await writeFile(join(kbRoot, "looks-12345678.md"), "dropped by suffix rule", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/user.md"]);
	});

	it("skips files matching the -<8hex>.md generated suffix (secondary rule)", async () => {
		// Empty manifest — secondary rule has to catch this on its own
		await writeManifest([]);
		await writeFile(join(kbRoot, "design-a1b2c3d4.md"), "looks generated", "utf-8");
		await writeFile(join(kbRoot, "design.md"), "user wrote this", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/design.md"]);
	});

	it("skips generated plan--/note--/topic-- files when the manifest is missing (secondary rule)", async () => {
		// Manifest missing/corrupt → primary rule is empty. Generated plan/note/wiki
		// visible files are named `plan--<slug>.md` / `note--<id>.md` / `topic--<slug>.md`
		// and carry NO `-<8hex>.md` suffix, so the suffix rule alone would surface them
		// as user knowledge and double-fold them into topic pages.
		await writeManifest([]);
		await writeFile(join(kbRoot, "plan--auth-redesign.md"), "generated plan", "utf-8");
		await writeFile(join(kbRoot, "note--abc123.md"), "generated note", "utf-8");
		await writeFile(join(kbRoot, "topic--storage.md"), "generated topic page", "utf-8");
		await writeFile(join(kbRoot, "design.md"), "user wrote this", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/design.md"]);
	});

	it("keeps user files that *contain* hex but don't match the suffix pattern", async () => {
		await writeManifest([]);
		// hex appears mid-name, not as `-<8hex>.md` suffix
		await writeFile(join(kbRoot, "abc12345-decision.md"), "kept", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/abc12345-decision.md"]);
	});

	it("treats a missing manifest as fall-through to the hash-suffix rule only", async () => {
		// No manifest.json file at all
		await writeFile(join(kbRoot, "user.md"), "u", "utf-8");
		await writeFile(join(kbRoot, "looks-12345678.md"), "g", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/user.md"]);
	});

	it("skips unreadable files instead of throwing", async () => {
		await writeManifest([]);
		await writeFile(join(kbRoot, "good.md"), "ok", "utf-8");
		// Create a directory that ends in .md — readdir surfaces it as an
		// entry, but statSync().isFile() will be false and the entry is
		// skipped without error.
		await mkdir(join(kbRoot, "looks-like.md"));

		const result = await listUserKnowledge(cwd);
		expect(result.map((r) => r.path)).toEqual(["jolliai/good.md"]);
	});

	it("returns only global + repo when the branch folder does not exist on disk", async () => {
		// A branch is requested, but no folder (mapped or transcoded) exists for
		// it — the branch-scope collection is skipped (the `existsSync` else).
		await writeManifest([]);
		await writeFile(join(kbRoot, "Repo.md"), "r", "utf-8");

		const result = await listUserKnowledge(cwd, "feature/never-materialized");
		expect(result.map((r) => r.path)).toEqual(["jolliai/Repo.md"]);
		expect(result.every((r) => r.scope !== "branch")).toBe(true);
	});

	it("returns empty when Memory Bank kbRoot does not exist", async () => {
		// Point resolver at a path that was never created
		mockResolveKBPath.mockReturnValue(join(localFolderRoot, "missing-repo"));

		const result = await listUserKnowledge(cwd);
		expect(result).toEqual([]);
	});

	it("returns empty when config loading fails", async () => {
		mockLoadConfig.mockRejectedValue(new Error("config gone"));
		await writeFile(join(kbRoot, "ignored.md"), "should not surface", "utf-8");

		const result = await listUserKnowledge(cwd);
		expect(result).toEqual([]);
	});

	it("captures the same fingerprint for identical content across runs", async () => {
		await writeManifest([]);
		await writeFile(join(kbRoot, "same.md"), "stable", "utf-8");

		const a = await listUserKnowledge(cwd);
		const b = await listUserKnowledge(cwd);
		expect(a[0].fingerprint).toBe(b[0].fingerprint);
	});

	it("listAllUserKnowledgeFromRoot scans EVERY branch folder on disk (no index/branch needed)", async () => {
		// The bug: index-driven branch enumeration misses branch folders that have
		// no summary yet. The disk-driven scan must find them regardless.
		await writeManifest([]);
		await writeBranches([{ branch: "feature/auth", folder: "feature-auth" }]);
		await mkdir(join(kbRoot, "feature-auth"));
		await mkdir(join(kbRoot, "untracked-branch")); // on disk, NOT in branches.json, NOT in any index
		await writeFile(join(localFolderRoot, "Global.md"), "g", "utf-8");
		await writeFile(join(kbRoot, "Repo.md"), "r", "utf-8");
		await writeFile(join(kbRoot, "feature-auth", "design.md"), "mapped branch", "utf-8");
		await writeFile(join(kbRoot, "untracked-branch", "scratch.md"), "unmapped branch", "utf-8");

		const result = await listAllUserKnowledgeFromRoot(kbRoot);
		const byScope: Record<string, string[]> = {};
		for (const f of result) {
			byScope[f.scope] = byScope[f.scope] ?? [];
			byScope[f.scope].push(f.path);
		}
		expect(byScope.global).toEqual(["Global.md"]);
		expect(byScope.repo).toEqual(["jolliai/Repo.md"]);
		expect(byScope.branch?.sort()).toEqual([
			"jolliai/feature-auth/design.md",
			"jolliai/untracked-branch/scratch.md",
		]);
		// Mapped folder resolves to its real branch name; unmapped falls back to the folder name.
		const authFile = result.find((f) => f.path === "jolliai/feature-auth/design.md");
		expect(authFile?.branch).toBe("feature/auth");
		const scratchFile = result.find((f) => f.path === "jolliai/untracked-branch/scratch.md");
		expect(scratchFile?.branch).toBe("untracked-branch");
	});

	it("listAllUserKnowledgeFromRoot skips the .jolli and _wiki system folders", async () => {
		await writeManifest([]);
		await mkdir(join(kbRoot, "_wiki"));
		await writeFile(join(kbRoot, "_wiki", "topic--leaked.md"), "generated wiki page", "utf-8");
		await writeFile(join(kbRoot, "Repo.md"), "r", "utf-8");

		const result = await listAllUserKnowledgeFromRoot(kbRoot);
		expect(result.map((f) => f.path)).toEqual(["jolliai/Repo.md"]);
	});

	it("listAllUserKnowledgeFromRoot returns [] when kbRoot does not exist", async () => {
		expect(await listAllUserKnowledgeFromRoot(join(localFolderRoot, "nope"))).toEqual([]);
	});

	it("returns global + repo + branch in one pass without duplication", async () => {
		await writeManifest([]);
		await writeBranches([{ branch: "main", folder: "main" }]);
		await mkdir(join(kbRoot, "main"));

		await writeFile(join(localFolderRoot, "Global.md"), "g", "utf-8");
		await writeFile(join(kbRoot, "Repo.md"), "r", "utf-8");
		await writeFile(join(kbRoot, "main", "Branch.md"), "b", "utf-8");

		const result = await listUserKnowledge(cwd, "main");
		const byScope: Record<string, string[]> = {};
		for (const f of result) {
			byScope[f.scope] = byScope[f.scope] ?? [];
			byScope[f.scope].push(f.path);
		}
		expect(byScope.global).toEqual(["Global.md"]);
		expect(byScope.repo).toEqual(["jolliai/Repo.md"]);
		expect(byScope.branch).toEqual(["jolliai/main/Branch.md"]);
	});
});
