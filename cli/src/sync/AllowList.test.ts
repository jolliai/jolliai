/**
 * Tests for AllowList — vault content area allow-list rules.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, isAllowedPath, isAllowedPathOnDisk } from "./AllowList.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "allowlist-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("ALLOWED_EXTENSIONS", () => {
	it("contains .md and .json only", () => {
		expect(ALLOWED_EXTENSIONS.has(".md")).toBe(true);
		expect(ALLOWED_EXTENSIONS.has(".json")).toBe(true);
		expect(ALLOWED_EXTENSIONS.size).toBe(2);
	});
});

describe("isAllowedPath — content area", () => {
	const opts = { syncTranscripts: false };

	it("accepts .md files", () => {
		expect(isAllowedPath("notes/foo.md", opts)).toBe(true);
		expect(isAllowedPath("a3f2c1-repo/main/summaries/abc.md", opts)).toBe(true);
	});

	it("accepts .json files", () => {
		expect(isAllowedPath("a3f2c1-repo/main/index.json", opts)).toBe(true);
	});

	it("rejects .txt files in the content area", () => {
		expect(isAllowedPath("notes/foo.txt", opts)).toBe(false);
	});

	it("rejects binaries", () => {
		expect(isAllowedPath("notes/screenshot.png", opts)).toBe(false);
		expect(isAllowedPath("docs/spec.pdf", opts)).toBe(false);
	});

	it("is case-insensitive on the extension", () => {
		expect(isAllowedPath("FOO.MD", opts)).toBe(true);
		expect(isAllowedPath("BAR.JSON", opts)).toBe(true);
	});

	it("rejects empty path", () => {
		expect(isAllowedPath("", opts)).toBe(false);
	});

	it("rejects paths whose only segments are slashes", () => {
		expect(isAllowedPath("///", opts)).toBe(false);
	});
});

describe("isAllowedPath — dot-prefix exclusion", () => {
	const opts = { syncTranscripts: false };

	it("rejects hidden files at the root", () => {
		expect(isAllowedPath(".DS_Store", opts)).toBe(false);
		expect(isAllowedPath(".gitignore", opts)).toBe(false);
	});

	it("rejects paths inside hidden directories", () => {
		expect(isAllowedPath(".jolli/summaries/abc.json", opts)).toBe(false);
		expect(isAllowedPath("a3f2c1-repo/.hidden/foo.md", opts)).toBe(false);
	});

	it("rejects hidden files in deep paths", () => {
		expect(isAllowedPath("a3f2c1-repo/main/notes/.draft.md", opts)).toBe(false);
	});
});

describe("isAllowedPath — .jolli/transcripts/ opt-in", () => {
	const HASH = "abc1234"; // 7-char lowercase hex — minimum SUMMARY_HASH_REGEX accepts

	it("rejects .jolli/transcripts/<hash>.json when syncTranscripts is false", () => {
		expect(isAllowedPath(`.jolli/transcripts/${HASH}.json`, { syncTranscripts: false })).toBe(false);
	});

	it("accepts .jolli/transcripts/<hash>.json when syncTranscripts is true", () => {
		expect(isAllowedPath(`.jolli/transcripts/${HASH}.json`, { syncTranscripts: true })).toBe(true);
	});

	it("rejects non-hex names inside .jolli/transcripts/ even when opted in", () => {
		expect(isAllowedPath(".jolli/transcripts/foo.json", { syncTranscripts: true })).toBe(false);
		expect(isAllowedPath(".jolli/transcripts/foo.txt", { syncTranscripts: true })).toBe(false);
	});

	it("rejects the bare .jolli/transcripts directory", () => {
		expect(isAllowedPath(".jolli/transcripts", { syncTranscripts: true })).toBe(false);
		expect(isAllowedPath(".jolli/transcripts/", { syncTranscripts: true })).toBe(false);
	});

	it("rejects the legacy top-level .transcripts/ path (allow-list ⟂ gitignore drift)", () => {
		// Pre-fix the allow-list took `.transcripts/*.txt` but bootstrap's
		// `.gitignore` only allowed `.jolli/transcripts/*.json` — files that
		// satisfied one but not the other never made it through sync.
		expect(isAllowedPath(".transcripts/foo.txt", { syncTranscripts: true })).toBe(false);
	});
});

describe("isAllowedPath — .jolli/ aggregate files (JOLLI-1316)", () => {
	const opts = { syncTranscripts: false };

	it("accepts the four canonical aggregate files at .jolli/<name>.json", () => {
		expect(isAllowedPath(".jolli/manifest.json", opts)).toBe(true);
		expect(isAllowedPath(".jolli/index.json", opts)).toBe(true);
		expect(isAllowedPath(".jolli/branches.json", opts)).toBe(true);
		expect(isAllowedPath(".jolli/catalog.json", opts)).toBe(true);
	});

	it("accepts .jolli/config.json (carries cross-device repo identity)", () => {
		// Was previously rejected as a per-device file. That caused phantom
		// `<repo>-N` folders on receiving devices because identity never
		// crossed the wire. config.json is now an aggregate file like the
		// other four.
		expect(isAllowedPath(".jolli/config.json", opts)).toBe(true);
	});

	it("rejects arbitrary other JSON files under .jolli/", () => {
		expect(isAllowedPath(".jolli/random.json", opts)).toBe(false);
		expect(isAllowedPath(".jolli/sync-state.json", opts)).toBe(false);
	});

	it("rejects the bare .jolli/ directory", () => {
		expect(isAllowedPath(".jolli", opts)).toBe(false);
	});

	it("rejects .jolli files of unsupported extensions", () => {
		expect(isAllowedPath(".jolli/manifest.txt", opts)).toBe(false);
		expect(isAllowedPath(".jolli/index.yml", opts)).toBe(false);
	});

	it("accepts .jolli/summaries/<hex>.json for 7-64 lowercase hex", () => {
		expect(isAllowedPath(".jolli/summaries/abcdef0.json", opts)).toBe(true);
		expect(isAllowedPath(".jolli/summaries/abcdef0123456789abcdef0123456789.json", opts)).toBe(true);
		expect(
			isAllowedPath(
				".jolli/summaries/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
				opts,
			),
		).toBe(true);
	});

	it("rejects .jolli/summaries/<hash>.json for non-hex / too short / too long", () => {
		expect(isAllowedPath(".jolli/summaries/abcdef.json", opts)).toBe(false); // 6 chars
		expect(isAllowedPath(".jolli/summaries/ABCDEF0.json", opts)).toBe(false); // uppercase
		expect(isAllowedPath(".jolli/summaries/abcdef0.txt", opts)).toBe(false); // wrong ext
		expect(isAllowedPath(".jolli/summaries/abcdef0g.json", opts)).toBe(false); // non-hex
	});

	it("rejects deep paths inside .jolli/ other than summaries/", () => {
		expect(isAllowedPath(".jolli/foo/bar.json", opts)).toBe(false);
		expect(isAllowedPath(".jolli/summaries/abcdef0/nested.json", opts)).toBe(false);
	});
});

// User-authored cross-device artifacts. Pre-fix these were rejected
// here despite FolderStorage writing them on disk — peers never saw
// them, so the planning / notes UX silently degraded to per-device.
describe("isAllowedPath — .jolli/plans / plan-progress / notes", () => {
	const opts = { syncTranscripts: false };

	it("accepts a normal plan slug (alpha-num + dash + dot middle, .md)", () => {
		expect(isAllowedPath(".jolli/plans/JOLLI-1326-044d9ae5.md", opts)).toBe(true);
		// Locale suffix style — `.en-` in the middle.
		expect(isAllowedPath(".jolli/plans/MemoryBankSyncSetup.en-455dcbda.md", opts)).toBe(true);
		// Very long real-world slug (URL-flattened).
		const longSlug = "c-users-foste-claude-plans-https-linear-floating-donut-0f141543.md";
		expect(isAllowedPath(`.jolli/plans/${longSlug}`, opts)).toBe(true);
	});

	it("accepts a normal plan-progress JSON", () => {
		expect(isAllowedPath(".jolli/plan-progress/JOLLI-1326-044d9ae5.json", opts)).toBe(true);
		expect(isAllowedPath(".jolli/plan-progress/vscode-plugin-memory-bank-sync-flow-en-d60fa902.json", opts)).toBe(
			true,
		);
	});

	it("accepts a normal note slug", () => {
		expect(isAllowedPath(".jolli/notes/note-d28e-b7070569.md", opts)).toBe(true);
	});

	it("rejects wrong extension for the directory", () => {
		// Plans are markdown only; a JSON file in plans/ might be the
		// progress companion file but it belongs in plan-progress/.
		expect(isAllowedPath(".jolli/plans/foo.json", opts)).toBe(false);
		expect(isAllowedPath(".jolli/plan-progress/foo.md", opts)).toBe(false);
		expect(isAllowedPath(".jolli/notes/foo.json", opts)).toBe(false);
		// Random extension always rejected.
		expect(isAllowedPath(".jolli/plans/foo.txt", opts)).toBe(false);
		expect(isAllowedPath(".jolli/plans/foo.exe", opts)).toBe(false);
	});

	it("rejects a leading-dot slug (hidden-file injection via the dir negation)", () => {
		// The plan regex requires the first char be alpha-num precisely
		// to block this. Without the constraint, a peer pushing
		// `.jolli/plans/.bashrc.md` would slip past the gitignore's dir
		// negation since `**\/.*` is overridden by `!**/.jolli/plans/`
		// at the directory level. The regex closes that escape hatch.
		expect(isAllowedPath(".jolli/plans/.bashrc.md", opts)).toBe(false);
		expect(isAllowedPath(".jolli/notes/.hidden.md", opts)).toBe(false);
		expect(isAllowedPath(".jolli/plan-progress/.evil.json", opts)).toBe(false);
	});

	it("rejects a leading-dash slug (could parse as a CLI flag downstream)", () => {
		expect(isAllowedPath(".jolli/plans/-rm-rf.md", opts)).toBe(false);
	});

	it("rejects path traversal via additional segments", () => {
		// 4+ segments → no branch in `isAllowedPath` matches → rejected.
		expect(isAllowedPath(".jolli/plans/../escape.md", opts)).toBe(false);
		expect(isAllowedPath(".jolli/plans/sub/nested.md", opts)).toBe(false);
		expect(isAllowedPath(".jolli/notes/sub/nested.md", opts)).toBe(false);
	});

	it("rejects the bare plans / plan-progress / notes directories", () => {
		expect(isAllowedPath(".jolli/plans", opts)).toBe(false);
		expect(isAllowedPath(".jolli/plans/", opts)).toBe(false);
		expect(isAllowedPath(".jolli/plan-progress", opts)).toBe(false);
		expect(isAllowedPath(".jolli/notes", opts)).toBe(false);
	});

	it("accepts plans / notes regardless of the syncTranscripts toggle", () => {
		// Plans are not the transcripts toggle's concern.
		expect(isAllowedPath(".jolli/plans/foo-abc12345.md", { syncTranscripts: false })).toBe(true);
		expect(isAllowedPath(".jolli/plans/foo-abc12345.md", { syncTranscripts: true })).toBe(true);
		expect(isAllowedPath(".jolli/notes/note-1-abc.md", { syncTranscripts: false })).toBe(true);
		expect(isAllowedPath(".jolli/plan-progress/foo-abc12345.json", { syncTranscripts: false })).toBe(true);
	});

	it("caps slug length at 255 chars + extension (filesystem-friendly bound)", () => {
		const within = "a".repeat(252); // 252 + ".md" = 255
		const tooLong = "a".repeat(256);
		expect(isAllowedPath(`.jolli/plans/${within}.md`, opts)).toBe(true);
		expect(isAllowedPath(`.jolli/plans/${tooLong}.md`, opts)).toBe(false);
	});
});

describe("isAllowedPath — .jolli/graph/", () => {
	const opts = { syncTranscripts: false };

	it("accepts the exact graph/graph.json leaf", () => {
		expect(isAllowedPath(".jolli/graph/graph.json", opts)).toBe(true);
		// Graph is not the transcripts toggle's concern.
		expect(isAllowedPath(".jolli/graph/graph.json", { syncTranscripts: true })).toBe(true);
	});

	it("rejects any other name / extension under graph/", () => {
		expect(isAllowedPath(".jolli/graph/foo.json", opts)).toBe(false);
		expect(isAllowedPath(".jolli/graph/graph.txt", opts)).toBe(false);
		expect(isAllowedPath(".jolli/graph/graph.md", opts)).toBe(false);
	});

	it("rejects the bare graph directory and deeper nesting", () => {
		expect(isAllowedPath(".jolli/graph", opts)).toBe(false);
		expect(isAllowedPath(".jolli/graph/sub/graph.json", opts)).toBe(false);
	});
});

describe("isAllowedPath — windows-style separators", () => {
	const opts = { syncTranscripts: true };

	it("accepts backslash separators", () => {
		expect(isAllowedPath("a3f2c1-repo\\main\\summaries\\abc.md", opts)).toBe(true);
	});

	it("rejects hidden segments split by backslash", () => {
		expect(isAllowedPath("a3f2c1-repo\\.hidden\\foo.md", opts)).toBe(false);
	});
});

describe("isAllowedPathOnDisk", () => {
	const opts = { syncTranscripts: false };

	it("accepts a regular allowed file on disk", async () => {
		const abs = join(tempDir, "foo.md");
		await writeFile(abs, "hello");
		expect(await isAllowedPathOnDisk(abs, "foo.md", opts)).toBe(true);
	});

	it("rejects symlinks regardless of extension", async () => {
		const target = join(tempDir, "target.md");
		const link = join(tempDir, "link.md");
		await writeFile(target, "hi");
		try {
			await symlink(target, link);
		} catch {
			// Windows test runner without SeCreateSymbolicLink — skip the assertion.
			return;
		}
		expect(await isAllowedPathOnDisk(link, "link.md", opts)).toBe(false);
	});

	it("rejects when the path doesn't exist", async () => {
		expect(await isAllowedPathOnDisk(join(tempDir, "missing.md"), "missing.md", opts)).toBe(false);
	});

	it("short-circuits on path-shape rejection without touching the filesystem", async () => {
		// Pass a non-existent path with a rejected extension — should still
		// return false (not crash on the missing file).
		expect(await isAllowedPathOnDisk("/nonexistent/foo.exe", "foo.exe", opts)).toBe(false);
	});

	it("rejects directories", async () => {
		const dir = join(tempDir, "sub");
		await mkdir(dir);
		expect(await isAllowedPathOnDisk(dir, "sub", opts)).toBe(false);
	});
});
