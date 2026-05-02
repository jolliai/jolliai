import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KbFoldersService, parseMdTitle } from "./KbFoldersService";

describe("KbFoldersService", () => {
	let tmpRoot: string;
	let svc: KbFoldersService;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "kbfolders-"));
		svc = new KbFoldersService(() => tmpRoot);
	});
	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("lists root with empty folder", async () => {
		const node = await svc.listChildren("");
		expect(node.relPath).toBe("");
		expect(node.isDirectory).toBe(true);
		expect(node.children).toEqual([]);
	});

	it("hides all dotfiles/dotdirs at every level", async () => {
		mkdirSync(join(tmpRoot, ".jolli"), { recursive: true });
		mkdirSync(join(tmpRoot, ".git"));
		mkdirSync(join(tmpRoot, ".vscode"));
		mkdirSync(join(tmpRoot, "projects"));
		writeFileSync(join(tmpRoot, "README.md"), "# hi");
		writeFileSync(join(tmpRoot, ".DS_Store"), "");
		writeFileSync(join(tmpRoot, ".gitignore"), "");
		// Nested dotfile too — should also be hidden when listing the parent.
		mkdirSync(join(tmpRoot, "projects", ".cache"));
		writeFileSync(join(tmpRoot, "projects", "visible.md"), "x");

		const root = await svc.listChildren("");
		const rootNames = (root.children ?? []).map((c) => c.name);
		expect(rootNames).toContain("projects");
		expect(rootNames).toContain("README.md");
		expect(rootNames).not.toContain(".jolli");
		expect(rootNames).not.toContain(".git");
		expect(rootNames).not.toContain(".vscode");
		expect(rootNames).not.toContain(".DS_Store");
		expect(rootNames).not.toContain(".gitignore");

		const nested = await svc.listChildren("projects");
		const nestedNames = (nested.children ?? []).map((c) => c.name);
		expect(nestedNames).toContain("visible.md");
		expect(nestedNames).not.toContain(".cache");
	});

	it("lists nested directory contents", async () => {
		mkdirSync(join(tmpRoot, "projects", "repo-a"), { recursive: true });
		writeFileSync(join(tmpRoot, "projects", "repo-a", "summary.md"), "x");
		const node = await svc.listChildren("projects");
		const names = (node.children ?? []).map((c) => c.name);
		expect(names).toContain("repo-a");
	});

	it("returns children:undefined for unloaded subdirs", async () => {
		mkdirSync(join(tmpRoot, "projects", "repo-a"), { recursive: true });
		const node = await svc.listChildren("");
		const projects = (node.children ?? []).find((c) => c.name === "projects");
		expect(projects?.children).toBeUndefined();
	});

	it("returns an empty root node when kbRoot does not exist (post-wipe boot)", async () => {
		// User wipes the entire KB folder on disk, then reloads VSCode. The sidebar
		// webview boots and immediately requests the root listing; if listChildren
		// rejected here, the host's catch would swallow the error and the webview
		// would hang on "Loading…" (it has no retry, only a manual refresh button).
		// Returning an empty root keeps the "fresh KB" UX coherent.
		const fake = new KbFoldersService(() => "/definitely/does/not/exist/xxxx");
		const node = await fake.listChildren("");
		expect(node.relPath).toBe("");
		expect(node.isDirectory).toBe(true);
		expect(node.children).toEqual([]);
	});

	it("still rejects for a missing non-root path", async () => {
		// Subpath misses are real errors (stale request, bad path); only the root
		// gets the fresh-KB pass.
		await expect(svc.listChildren("does/not/exist")).rejects.toThrow();
	});

	it("rejects path traversal attempts", async () => {
		await expect(svc.listChildren("../etc")).rejects.toThrow(
			/invalid|outside/i,
		);
		await expect(svc.listChildren("/absolute")).rejects.toThrow(
			/invalid|absolute/i,
		);
		// Multi-step escape: normalize folds it to ../bar, then validation catches it.
		await expect(svc.listChildren("foo/../../bar")).rejects.toThrow(
			/invalid|outside/i,
		);
		// Trailing escape: normalize folds it to .., then validation catches it.
		await expect(svc.listChildren("foo/../..")).rejects.toThrow(
			/invalid|outside/i,
		);
	});

	it("normalizes safely-cancelling .. to a sub-path inside kbRoot", async () => {
		// foo/../bar resolves to bar after normalize — that's a legitimate sub-path,
		// not an escape. The service should treat it as if the caller asked for "bar".
		mkdirSync(join(tmpRoot, "bar"));
		const node = await svc.listChildren("foo/../bar");
		expect(node.relPath).toBe("bar");
		expect(node.isDirectory).toBe(true);
	});

	it("sorts directories first, then files, alphabetically", async () => {
		mkdirSync(join(tmpRoot, "z-dir"));
		mkdirSync(join(tmpRoot, "a-dir"));
		writeFileSync(join(tmpRoot, "b-file.md"), "x");
		writeFileSync(join(tmpRoot, "z-file.md"), "x");
		const node = await svc.listChildren("");
		const names = (node.children ?? []).map((c) => c.name);
		expect(names).toEqual(["a-dir", "z-dir", "b-file.md", "z-file.md"]);
	});

	it("classifies file nodes via manifest.json (memory/plan/note/other)", async () => {
		mkdirSync(join(tmpRoot, ".jolli"), { recursive: true });
		mkdirSync(join(tmpRoot, "jolli", "main", "commits"), { recursive: true });
		mkdirSync(join(tmpRoot, "jolli", "main", "plans"), { recursive: true });
		mkdirSync(join(tmpRoot, "jolli", "main", "notes"), { recursive: true });
		writeFileSync(
			join(tmpRoot, "jolli", "main", "commits", "abc12345-x.md"),
			"",
		);
		writeFileSync(join(tmpRoot, "jolli", "main", "plans", "oauth.md"), "");
		writeFileSync(join(tmpRoot, "jolli", "main", "notes", "note-1.md"), "");
		writeFileSync(join(tmpRoot, "user-dropped.md"), "");

		writeFileSync(
			join(tmpRoot, ".jolli", "manifest.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-04-28T00:00:00Z",
				files: [
					{
						repo: "jm_x",
						path: "jolli/main/commits/abc12345-x.md",
						type: "commit",
						fileId: "abc12345deadbeef",
						fingerprint: "sha256:aa",
						twinPath: ".jolli/summaries/abc12345deadbeef.json",
						updatedAt: "2026-04-28T00:00:00Z",
					},
					{
						repo: "jm_x",
						path: "jolli/main/plans/oauth.md",
						type: "plan",
						fileId: "oauth",
						fingerprint: "sha256:bb",
						updatedAt: "2026-04-28T00:00:00Z",
					},
					{
						repo: "jm_x",
						path: "jolli/main/notes/note-1.md",
						type: "note",
						fileId: "note-1",
						fingerprint: "sha256:cc",
						updatedAt: "2026-04-28T00:00:00Z",
					},
				],
			}),
		);

		const commits = await svc.listChildren("jolli/main/commits");
		const memMd = (commits.children ?? []).find(
			(c) => c.name === "abc12345-x.md",
		);
		expect(memMd?.fileKind).toBe("memory");
		expect(memMd?.fileKey).toBe("abc12345deadbeef");

		const plans = await svc.listChildren("jolli/main/plans");
		const planMd = (plans.children ?? []).find((c) => c.name === "oauth.md");
		expect(planMd?.fileKind).toBe("plan");
		expect(planMd?.fileKey).toBe("oauth");

		const notes = await svc.listChildren("jolli/main/notes");
		const noteMd = (notes.children ?? []).find((c) => c.name === "note-1.md");
		expect(noteMd?.fileKind).toBe("note");
		expect(noteMd?.fileKey).toBe("note-1");

		const root = await svc.listChildren("");
		const dropped = (root.children ?? []).find(
			(c) => c.name === "user-dropped.md",
		);
		expect(dropped?.fileKind).toBe("other");
		expect(dropped?.fileKey).toBeUndefined();
	});

	it("falls back to fileKind=other when manifest.json is missing or malformed", async () => {
		writeFileSync(join(tmpRoot, "untracked.md"), "");
		const root1 = await svc.listChildren("");
		const f1 = (root1.children ?? []).find((c) => c.name === "untracked.md");
		expect(f1?.fileKind).toBe("other");

		// Malformed manifest must not throw — degrade to "other" silently.
		mkdirSync(join(tmpRoot, ".jolli"), { recursive: true });
		writeFileSync(join(tmpRoot, ".jolli", "manifest.json"), "{not json");
		const root2 = await svc.listChildren("");
		const f2 = (root2.children ?? []).find((c) => c.name === "untracked.md");
		expect(f2?.fileKind).toBe("other");
	});

	it("classifies a single-file relPath via manifest", async () => {
		// Branch: listChildren("foo.md") where foo.md is a file (not a dir).
		// The early-return at L42 must still consult the manifest so callers
		// addressing a leaf path get the same fileKind enrichment as listings.
		mkdirSync(join(tmpRoot, ".jolli"), { recursive: true });
		mkdirSync(join(tmpRoot, "jolli", "main", "commits"), { recursive: true });
		writeFileSync(join(tmpRoot, "jolli", "main", "commits", "abc-x.md"), "");
		writeFileSync(
			join(tmpRoot, ".jolli", "manifest.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-04-28T00:00:00Z",
				files: [
					{
						repo: "jm_x",
						path: "jolli/main/commits/abc-x.md",
						type: "commit",
						fileId: "abc-deadbeef",
						fingerprint: "sha256:a",
						twinPath: ".jolli/summaries/abc-deadbeef.json",
						updatedAt: "2026-04-28T00:00:00Z",
					},
				],
			}),
		);
		const node = await svc.listChildren("jolli/main/commits/abc-x.md");
		expect(node.isDirectory).toBe(false);
		expect(node.fileKind).toBe("memory");
		expect(node.fileKey).toBe("abc-deadbeef");
	});

	it("does not assign fileKind/fileKey to directory nodes", async () => {
		mkdirSync(join(tmpRoot, "subdir"));
		const root = await svc.listChildren("");
		const dir = (root.children ?? []).find((c) => c.name === "subdir");
		expect(dir?.isDirectory).toBe(true);
		expect(dir?.fileKind).toBeUndefined();
		expect(dir?.fileKey).toBeUndefined();
	});

	describe("fileTitle for .md files", () => {
		it("derives fileTitle from H1 when manifest has no title", async () => {
			writeFileSync(
				join(tmpRoot, "user-note.md"),
				"# Notes from yesterday\n\nbody text\n",
			);
			const root = await svc.listChildren("");
			const node = (root.children ?? []).find((c) => c.name === "user-note.md");
			expect(node?.fileKind).toBe("other");
			expect(node?.fileTitle).toBe("Notes from yesterday");
		});

		it("derives fileTitle from YAML frontmatter `title:`", async () => {
			writeFileSync(
				join(tmpRoot, "fm.md"),
				"---\ntitle: Hand-written Title\ndate: 2026-04-29\n---\n\n# Other heading\n",
			);
			const root = await svc.listChildren("");
			const node = (root.children ?? []).find((c) => c.name === "fm.md");
			expect(node?.fileTitle).toBe("Hand-written Title");
		});

		it("strips surrounding quotes from frontmatter title", async () => {
			writeFileSync(join(tmpRoot, "q.md"), '---\ntitle: "Quoted Title"\n---\n');
			const root = await svc.listChildren("");
			const node = (root.children ?? []).find((c) => c.name === "q.md");
			expect(node?.fileTitle).toBe("Quoted Title");
		});

		it("manifest title takes priority over H1", async () => {
			mkdirSync(join(tmpRoot, ".jolli"), { recursive: true });
			mkdirSync(join(tmpRoot, "notes"), { recursive: true });
			writeFileSync(
				join(tmpRoot, "notes", "n1.md"),
				"# H1 from file\n\nbody\n",
			);
			writeFileSync(
				join(tmpRoot, ".jolli", "manifest.json"),
				JSON.stringify({
					version: 1,
					generatedAt: "2026-04-29T00:00:00Z",
					files: [
						{
							repo: "jm_x",
							path: "notes/n1.md",
							type: "note",
							fileId: "n1",
							fingerprint: "sha256:zz",
							title: "Manifest Title",
							updatedAt: "2026-04-29T00:00:00Z",
						},
					],
				}),
			);
			const node = await svc.listChildren("notes/n1.md");
			expect(node.fileTitle).toBe("Manifest Title");
		});

		it("falls back to undefined when first non-blank line is not an H1", async () => {
			// `## subtitle` (H2) and `plain prose` should NOT be treated as titles —
			// the renderer falls back to the bare filename.
			writeFileSync(join(tmpRoot, "h2.md"), "## subtitle\n");
			writeFileSync(
				join(tmpRoot, "prose.md"),
				"Just some prose without a heading.\n",
			);
			writeFileSync(join(tmpRoot, "empty.md"), "");
			const root = await svc.listChildren("");
			const h2 = (root.children ?? []).find((c) => c.name === "h2.md");
			const prose = (root.children ?? []).find((c) => c.name === "prose.md");
			const empty = (root.children ?? []).find((c) => c.name === "empty.md");
			expect(h2?.fileTitle).toBeUndefined();
			expect(prose?.fileTitle).toBeUndefined();
			expect(empty?.fileTitle).toBeUndefined();
		});

		it("does not derive titles from non-.md files", async () => {
			writeFileSync(join(tmpRoot, "readme.txt"), "# Heading\n");
			const root = await svc.listChildren("");
			const node = (root.children ?? []).find((c) => c.name === "readme.txt");
			expect(node?.fileTitle).toBeUndefined();
		});

		it("derives title for the single-file relPath branch", async () => {
			writeFileSync(join(tmpRoot, "solo.md"), "# Solo Title\n");
			const node = await svc.listChildren("solo.md");
			expect(node.isDirectory).toBe(false);
			expect(node.fileTitle).toBe("Solo Title");
		});
	});
});

describe("parseMdTitle", () => {
	it("extracts a basic H1", () => {
		expect(parseMdTitle("# hello\nbody")).toBe("hello");
	});

	it("strips trailing ATX-style hashes", () => {
		expect(parseMdTitle("# hello ###\n")).toBe("hello");
	});

	it("skips leading blank lines before the H1", () => {
		expect(parseMdTitle("\n\n# hello\n")).toBe("hello");
	});

	it("strips a leading UTF-8 BOM", () => {
		expect(parseMdTitle("﻿# bom\n")).toBe("bom");
	});

	it("handles CRLF line endings", () => {
		expect(parseMdTitle("# crlf\r\nbody\r\n")).toBe("crlf");
	});

	it("returns undefined when first non-blank line is not an H1", () => {
		expect(parseMdTitle("plain prose\n# late heading\n")).toBeUndefined();
	});

	it("does not mis-read frontmatter `#` comments as headings", () => {
		// YAML comment inside frontmatter — must not become the title. The
		// frontmatter has no `title:` field, so we strip the block, then look
		// past it for the first H1.
		const text =
			"---\n# this is a yaml comment\nfoo: bar\n---\n\n# Real Title\n";
		expect(parseMdTitle(text)).toBe("Real Title");
	});

	it("frontmatter title with no value falls through to H1", () => {
		const text = "---\ntitle:\n---\n\n# Fallback H1\n";
		expect(parseMdTitle(text)).toBe("Fallback H1");
	});

	it("returns undefined for empty input", () => {
		expect(parseMdTitle("")).toBeUndefined();
	});

	it("ignores `#` without a following space (not a valid ATX heading)", () => {
		expect(parseMdTitle("#hashtag\n")).toBeUndefined();
	});
});
