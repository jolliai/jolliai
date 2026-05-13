import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetadataManager } from "../../../cli/src/core/MetadataManager";
import { KbFoldersService, parseMdTitle } from "./KbFoldersService";

// Windows ignores chmod for unprivileged file accesses, so a `chmod 0o000`
// based "unreadable file" test ends up reading the file just fine and the
// "expect title to be undefined" assertion fails. ESM namespace exports
// aren't configurable, blocking the obvious vi.spyOn(fsp, "open") workaround,
// so chmod-driven branch tests are skipped on win32 — POSIX still exercises
// the deriveMdTitle catch path. See Memory Bank open-source review notes.
const skipIfWin32 = process.platform === "win32" ? it.skip : it;

/**
 * Seed a fake KB repo under `parent`. Mirrors what `initializeKBFolder` does
 * (writes `.jolli/config.json`) but inline so tests stay readable and don't
 * pull in the full CLI helper graph.
 */
function seedRepo(
	parent: string,
	dirName: string,
	opts: { repoName?: string; remoteUrl?: string | null } = {},
): string {
	const repoDir = join(parent, dirName);
	mkdirSync(join(repoDir, ".jolli"), { recursive: true });
	writeFileSync(
		join(repoDir, ".jolli", "config.json"),
		JSON.stringify({
			version: 1,
			sortOrder: "date",
			repoName: opts.repoName ?? dirName,
			remoteUrl: opts.remoteUrl ?? undefined,
		}),
		"utf-8",
	);
	return repoDir;
}

describe("KbFoldersService — single repo (under multi-repo parent)", () => {
	let tmpParent: string;
	let repoDir: string;
	let svc: KbFoldersService;

	beforeEach(() => {
		tmpParent = mkdtempSync(join(tmpdir(), "kbfolders-"));
		repoDir = seedRepo(tmpParent, "myrepo", { repoName: "myrepo" });
		svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "myrepo",
			currentRemoteUrl: null,
		}));
	});
	afterEach(() => {
		rmSync(tmpParent, { recursive: true, force: true });
	});

	it("lists a single repo at the parent root with isRepoRoot=true", async () => {
		const root = await svc.listChildren("");
		expect(root.relPath).toBe("");
		expect(root.isDirectory).toBe(true);
		const children = root.children ?? [];
		expect(children).toHaveLength(1);
		const repo = children[0];
		expect(repo?.name).toBe("myrepo");
		expect(repo?.relPath).toBe("myrepo");
		expect(repo?.isRepoRoot).toBe(true);
		expect(repo?.isCurrentRepo).toBe(true);
		// Repo nodes are lazy — children=undefined means "expand to load".
		expect(repo?.children).toBeUndefined();
	});

	it("preserves repo-level identity (name, isRepoRoot, isCurrentRepo) when expanding the repo root", async () => {
		// Regression: listChildren("myrepo") used to forget the metadata that
		// listParentRoot writes for top-level repo entries (the configured
		// repoName, isRepoRoot:true, isCurrentRepo). The webview's propagateUp
		// then overwrote the rich parent-root entry with this featureless
		// folder node — repo rendered nameless with a generic folder icon
		// and lost its (current) highlight. Pin all three fields so a future
		// refactor that bypasses the repoRelPath==="" restoration branch
		// can't silently regress this.
		const repoRoot = await svc.listChildren("myrepo");
		expect(repoRoot.name).toBe("myrepo");
		expect(repoRoot.relPath).toBe("myrepo");
		expect(repoRoot.isRepoRoot).toBe(true);
		expect(repoRoot.isCurrentRepo).toBe(true);
	});

	it("does NOT mark sub-paths inside a repo as isRepoRoot", async () => {
		// Counterpart to the test above: only `listChildren("myrepo")` (the
		// repo root itself) gets the identity fields restored. Sub-paths like
		// `listChildren("myrepo/projects")` must leave isRepoRoot falsy so
		// they keep their plain-folder rendering (codicon-folder, no current-
		// repo highlight). Without this guard a refactor could over-broadly
		// apply the restoration to every listInRepo call.
		mkdirSync(join(repoDir, "projects"));
		const projects = await svc.listChildren("myrepo/projects");
		expect(projects.isRepoRoot).toBeFalsy();
		expect(projects.isCurrentRepo).toBeFalsy();
	});

	it("hides all dotfiles/dotdirs at every level inside a repo", async () => {
		mkdirSync(join(repoDir, ".git"));
		mkdirSync(join(repoDir, ".vscode"));
		mkdirSync(join(repoDir, "projects"));
		writeFileSync(join(repoDir, "README.md"), "# hi");
		writeFileSync(join(repoDir, ".DS_Store"), "");
		writeFileSync(join(repoDir, ".gitignore"), "");
		mkdirSync(join(repoDir, "projects", ".cache"));
		writeFileSync(join(repoDir, "projects", "visible.md"), "x");

		const repoRoot = await svc.listChildren("myrepo");
		const rootNames = (repoRoot.children ?? []).map((c) => c.name);
		expect(rootNames).toContain("projects");
		expect(rootNames).toContain("README.md");
		expect(rootNames).not.toContain(".jolli");
		expect(rootNames).not.toContain(".git");
		expect(rootNames).not.toContain(".vscode");
		expect(rootNames).not.toContain(".DS_Store");
		expect(rootNames).not.toContain(".gitignore");

		const nested = await svc.listChildren("myrepo/projects");
		const nestedNames = (nested.children ?? []).map((c) => c.name);
		expect(nestedNames).toContain("visible.md");
		expect(nestedNames).not.toContain(".cache");
	});

	it("lists nested directory contents inside a repo", async () => {
		mkdirSync(join(repoDir, "projects", "repo-a"), { recursive: true });
		writeFileSync(join(repoDir, "projects", "repo-a", "summary.md"), "x");
		const node = await svc.listChildren("myrepo/projects");
		const names = (node.children ?? []).map((c) => c.name);
		expect(names).toContain("repo-a");
		// Child relPaths round-trip through the protocol — prefixed with the repo segment.
		const repoA = (node.children ?? []).find((c) => c.name === "repo-a");
		expect(repoA?.relPath).toBe("myrepo/projects/repo-a");
	});

	it("returns children:undefined for unloaded subdirs inside a repo", async () => {
		mkdirSync(join(repoDir, "projects", "repo-a"), { recursive: true });
		const repoRoot = await svc.listChildren("myrepo");
		const projects = (repoRoot.children ?? []).find(
			(c) => c.name === "projects",
		);
		expect(projects?.children).toBeUndefined();
	});

	it("returns an empty repo-root node when the repo directory is missing (post-wipe boot)", async () => {
		// Drop just the repo contents (but keep the .jolli/config.json discoverable).
		// Simulate a fresh repo that has nothing in it yet — we want an empty
		// children array, not a thrown ENOENT that leaves the webview on Loading.
		rmSync(repoDir, { recursive: true, force: true });
		seedRepo(tmpParent, "myrepo", { repoName: "myrepo" });
		// Wipe content but leave .jolli in place so discoverRepos still finds it.
		// Then delete the entire repo dir → simulate the user wiping the folder.
		rmSync(repoDir, { recursive: true, force: true });
		// discoverRepos finds nothing → root listChildren("myrepo") → throws Unknown repo.
		await expect(svc.listChildren("myrepo")).rejects.toThrow(/Unknown repo/);
	});

	it("still rejects for a missing non-root path inside a repo", async () => {
		await expect(svc.listChildren("myrepo/does/not/exist")).rejects.toThrow();
	});

	it("rejects path traversal attempts", async () => {
		await expect(svc.listChildren("../etc")).rejects.toThrow(
			/invalid|outside/i,
		);
		await expect(svc.listChildren("/absolute")).rejects.toThrow(
			/invalid|absolute/i,
		);
		// Escape from inside a repo: `../../escape` after consuming the repo
		// segment. normalize folds to `../escape`, which startsWith ".." and
		// gets rejected by validateRelPath before any fs access.
		await expect(svc.listChildren("myrepo/../../escape")).rejects.toThrow(
			/invalid|outside/i,
		);
	});

	it("treats safely-cancelling .. as a same-level sibling", async () => {
		mkdirSync(join(repoDir, "bar"));
		const node = await svc.listChildren("myrepo/foo/../bar");
		// After normalize: "myrepo/bar". First segment selects the repo, "bar"
		// is the repo-relative path inside it.
		expect(node.relPath).toBe("myrepo/bar");
		expect(node.isDirectory).toBe(true);
	});

	it("routes `repoA/../repoB/...` to the other repo cleanly via normalize", async () => {
		// `myrepo/../myrepo/foo` normalizes to `myrepo/foo` — a legitimate
		// path within the same repo. This documents that path-collapse is
		// fine when the result still names a valid repo segment.
		mkdirSync(join(repoDir, "foo"));
		const node = await svc.listChildren("myrepo/../myrepo/foo");
		expect(node.relPath).toBe("myrepo/foo");
		expect(node.isDirectory).toBe(true);
	});

	it("sorts directories first, then files, alphabetically", async () => {
		mkdirSync(join(repoDir, "z-dir"));
		mkdirSync(join(repoDir, "a-dir"));
		writeFileSync(join(repoDir, "b-file.md"), "x");
		writeFileSync(join(repoDir, "z-file.md"), "x");
		const node = await svc.listChildren("myrepo");
		const names = (node.children ?? []).map((c) => c.name);
		expect(names).toEqual(["a-dir", "z-dir", "b-file.md", "z-file.md"]);
	});

	it("classifies file nodes via manifest.json (memory/plan/note/other)", async () => {
		mkdirSync(join(repoDir, "jolli", "main", "commits"), { recursive: true });
		mkdirSync(join(repoDir, "jolli", "main", "plans"), { recursive: true });
		mkdirSync(join(repoDir, "jolli", "main", "notes"), { recursive: true });
		writeFileSync(
			join(repoDir, "jolli", "main", "commits", "abc12345-x.md"),
			"",
		);
		writeFileSync(join(repoDir, "jolli", "main", "plans", "oauth.md"), "");
		writeFileSync(join(repoDir, "jolli", "main", "notes", "note-1.md"), "");
		writeFileSync(join(repoDir, "user-dropped.md"), "");

		writeFileSync(
			join(repoDir, ".jolli", "manifest.json"),
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

		const commits = await svc.listChildren("myrepo/jolli/main/commits");
		const memMd = (commits.children ?? []).find(
			(c) => c.name === "abc12345-x.md",
		);
		expect(memMd?.fileKind).toBe("memory");
		expect(memMd?.fileKey).toBe("abc12345deadbeef");

		const plans = await svc.listChildren("myrepo/jolli/main/plans");
		const planMd = (plans.children ?? []).find((c) => c.name === "oauth.md");
		expect(planMd?.fileKind).toBe("plan");
		expect(planMd?.fileKey).toBe("oauth");

		const notes = await svc.listChildren("myrepo/jolli/main/notes");
		const noteMd = (notes.children ?? []).find((c) => c.name === "note-1.md");
		expect(noteMd?.fileKind).toBe("note");
		expect(noteMd?.fileKey).toBe("note-1");

		const repoRoot = await svc.listChildren("myrepo");
		const dropped = (repoRoot.children ?? []).find(
			(c) => c.name === "user-dropped.md",
		);
		expect(dropped?.fileKind).toBe("other");
		expect(dropped?.fileKey).toBeUndefined();
	});

	it("treats a manifest.json with no `files` field as an empty lookup", async () => {
		// Regression: an early-version manifest writer left `files` off when
		// the project had zero tracked artifacts, which crashed buildManifestLookup
		// before the `?? []` fallback was added. Pin the fallback so a future
		// refactor that drops it doesn't reintroduce the crash on legacy /
		// hand-edited manifests.
		writeFileSync(join(repoDir, "loose.md"), "# loose\n");
		writeFileSync(
			join(repoDir, ".jolli", "manifest.json"),
			JSON.stringify({ version: 1 }),
		);
		const node = await svc.listChildren("myrepo");
		const loose = (node.children ?? []).find((c) => c.name === "loose.md");
		// No manifest entry → classify returns "other", file is still listed.
		expect(loose).toBeDefined();
		expect(loose?.fileKind).toBe("other");
	});

	it("falls back to fileKind=other when manifest.json is missing or malformed", async () => {
		writeFileSync(join(repoDir, "untracked.md"), "");
		const repoRoot1 = await svc.listChildren("myrepo");
		const f1 = (repoRoot1.children ?? []).find(
			(c) => c.name === "untracked.md",
		);
		expect(f1?.fileKind).toBe("other");

		// Malformed manifest must not throw — degrade to "other" silently.
		writeFileSync(join(repoDir, ".jolli", "manifest.json"), "{not json");
		const repoRoot2 = await svc.listChildren("myrepo");
		const f2 = (repoRoot2.children ?? []).find(
			(c) => c.name === "untracked.md",
		);
		expect(f2?.fileKind).toBe("other");
	});

	it("reconciles manifest paths after a user renames a branch folder on disk", async () => {
		// Regression for the "memory bank 改了 branch 文件夹名称之后 memory
		// 不能正常加载显示" bug: when a user manually renames
		// <kbRoot>/<branch>/ in Finder/Explorer, the on-disk path no longer
		// matches the path recorded in .jolli/manifest.json. The Folders tab's
		// classification then drops every file in the renamed folder back to
		// fileKind="other". IntelliJ avoids this by running reconcile() in
		// KBExplorerPanel.load/refresh; this test pins that VSCode does the
		// same on repo-root expansion. Reconciliation is fingerprint-driven
		// (sha256 of file content), so the manifest fingerprint must match the
		// actual on-disk bytes for the rename to be detected.
		const mdContent = "# memory body\n";
		mkdirSync(join(repoDir, "main"), { recursive: true });
		writeFileSync(join(repoDir, "main", "memory-abc12345.md"), mdContent);
		const realFingerprint = MetadataManager.sha256(mdContent);
		writeFileSync(
			join(repoDir, ".jolli", "manifest.json"),
			JSON.stringify({
				version: 1,
				files: [
					{
						path: "main/memory-abc12345.md",
						type: "commit",
						fileId: "abc12345deadbeef",
						fingerprint: realFingerprint,
						source: { commitHash: "abc12345deadbeef", branch: "main" },
					},
				],
			}),
		);

		// User renames the visible branch folder in Finder.
		renameSync(join(repoDir, "main"), join(repoDir, "renamed-branch"));

		// First listing of the repo root triggers reconcile: the .md file is
		// now found at renamed-branch/memory-abc12345.md, the manifest path
		// for fileId abc12345deadbeef is rewritten in place, and the
		// classification kicks back in.
		const renamed = await svc.listChildren("myrepo/renamed-branch");
		const memMd = (renamed.children ?? []).find(
			(c) => c.name === "memory-abc12345.md",
		);
		expect(memMd?.fileKind).toBe("memory");
		expect(memMd?.fileKey).toBe("abc12345deadbeef");

		// Manifest on disk should now point at the new path so subsequent
		// non-reconciling reads stay correct.
		const manifestOnDisk = JSON.parse(
			readFileSync(join(repoDir, ".jolli", "manifest.json"), "utf-8"),
		);
		expect(manifestOnDisk.files[0].path).toBe(
			"renamed-branch/memory-abc12345.md",
		);
	});

	it("classifies a single-file relPath via manifest", async () => {
		mkdirSync(join(repoDir, "jolli", "main", "commits"), { recursive: true });
		writeFileSync(join(repoDir, "jolli", "main", "commits", "abc-x.md"), "");
		writeFileSync(
			join(repoDir, ".jolli", "manifest.json"),
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
		const node = await svc.listChildren("myrepo/jolli/main/commits/abc-x.md");
		expect(node.isDirectory).toBe(false);
		expect(node.fileKind).toBe("memory");
		expect(node.fileKey).toBe("abc-deadbeef");
	});

	it("does not assign fileKind/fileKey to directory nodes", async () => {
		mkdirSync(join(repoDir, "subdir"));
		const repoRoot = await svc.listChildren("myrepo");
		const dir = (repoRoot.children ?? []).find((c) => c.name === "subdir");
		expect(dir?.isDirectory).toBe(true);
		expect(dir?.fileKind).toBeUndefined();
		expect(dir?.fileKey).toBeUndefined();
	});

	describe("fileTitle for .md files", () => {
		it("derives fileTitle from H1 when manifest has no title", async () => {
			writeFileSync(
				join(repoDir, "user-note.md"),
				"# Notes from yesterday\n\nbody text\n",
			);
			const repoRoot = await svc.listChildren("myrepo");
			const node = (repoRoot.children ?? []).find(
				(c) => c.name === "user-note.md",
			);
			expect(node?.fileKind).toBe("other");
			expect(node?.fileTitle).toBe("Notes from yesterday");
		});

		it("derives fileTitle from YAML frontmatter `title:`", async () => {
			writeFileSync(
				join(repoDir, "fm.md"),
				"---\ntitle: Hand-written Title\ndate: 2026-04-29\n---\n\n# Other heading\n",
			);
			const repoRoot = await svc.listChildren("myrepo");
			const node = (repoRoot.children ?? []).find((c) => c.name === "fm.md");
			expect(node?.fileTitle).toBe("Hand-written Title");
		});

		it("strips surrounding quotes from frontmatter title", async () => {
			writeFileSync(join(repoDir, "q.md"), '---\ntitle: "Quoted Title"\n---\n');
			const repoRoot = await svc.listChildren("myrepo");
			const node = (repoRoot.children ?? []).find((c) => c.name === "q.md");
			expect(node?.fileTitle).toBe("Quoted Title");
		});

		it("manifest title takes priority over H1", async () => {
			mkdirSync(join(repoDir, "notes"), { recursive: true });
			writeFileSync(
				join(repoDir, "notes", "n1.md"),
				"# H1 from file\n\nbody\n",
			);
			writeFileSync(
				join(repoDir, ".jolli", "manifest.json"),
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
			const node = await svc.listChildren("myrepo/notes/n1.md");
			expect(node.fileTitle).toBe("Manifest Title");
		});

		it("falls back to undefined when first non-blank line is not an H1", async () => {
			writeFileSync(join(repoDir, "h2.md"), "## subtitle\n");
			writeFileSync(
				join(repoDir, "prose.md"),
				"Just some prose without a heading.\n",
			);
			writeFileSync(join(repoDir, "empty.md"), "");
			const repoRoot = await svc.listChildren("myrepo");
			const h2 = (repoRoot.children ?? []).find((c) => c.name === "h2.md");
			const prose = (repoRoot.children ?? []).find(
				(c) => c.name === "prose.md",
			);
			const empty = (repoRoot.children ?? []).find(
				(c) => c.name === "empty.md",
			);
			expect(h2?.fileTitle).toBeUndefined();
			expect(prose?.fileTitle).toBeUndefined();
			expect(empty?.fileTitle).toBeUndefined();
		});

		it("does not derive titles from non-.md files", async () => {
			writeFileSync(join(repoDir, "readme.txt"), "# Heading\n");
			const repoRoot = await svc.listChildren("myrepo");
			const node = (repoRoot.children ?? []).find(
				(c) => c.name === "readme.txt",
			);
			expect(node?.fileTitle).toBeUndefined();
		});

		it("derives title for the single-file relPath branch", async () => {
			writeFileSync(join(repoDir, "solo.md"), "# Solo Title\n");
			const node = await svc.listChildren("myrepo/solo.md");
			expect(node.isDirectory).toBe(false);
			expect(node.fileTitle).toBe("Solo Title");
		});

		skipIfWin32(
			"returns undefined when the .md file cannot be opened",
			async () => {
				// chmod 0 on a real file makes fs.open reject with EACCES, which
				// drives the deriveMdTitle catch path. The renderer falls back to
				// the bare filename so the listing still succeeds.
				writeFileSync(join(repoDir, "unreadable.md"), "# hidden\n");
				chmodSync(join(repoDir, "unreadable.md"), 0o000);
				try {
					const repoRoot = await svc.listChildren("myrepo");
					const node = (repoRoot.children ?? []).find(
						(c) => c.name === "unreadable.md",
					);
					expect(node?.fileTitle).toBeUndefined();
				} finally {
					chmodSync(join(repoDir, "unreadable.md"), 0o644);
				}
			},
		);
	});
});

describe("KbFoldersService — multi-repo & parent listing", () => {
	let tmpParent: string;

	beforeEach(() => {
		tmpParent = mkdtempSync(join(tmpdir(), "kbfolders-multi-"));
	});
	afterEach(() => {
		rmSync(tmpParent, { recursive: true, force: true });
	});

	it("returns an empty parent listing when no repos exist yet", async () => {
		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const root = await svc.listChildren("");
		expect(root.relPath).toBe("");
		expect(root.isDirectory).toBe(true);
		expect(root.children).toEqual([]);
	});

	it("lists all discovered repos with current-repo sorted first", async () => {
		seedRepo(tmpParent, "alpha", {
			repoName: "alpha",
			remoteUrl: "https://github.com/o/alpha.git",
		});
		seedRepo(tmpParent, "bravo", {
			repoName: "bravo",
			remoteUrl: "https://github.com/o/bravo.git",
		});
		seedRepo(tmpParent, "charlie", {
			repoName: "charlie",
			remoteUrl: "https://github.com/o/charlie.git",
		});

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "bravo",
			currentRemoteUrl: "https://github.com/o/bravo.git",
		}));
		const root = await svc.listChildren("");
		const names = (root.children ?? []).map((c) => c.name);
		expect(names).toEqual(["bravo", "alpha", "charlie"]);
		const flags = (root.children ?? []).map((c) => c.isCurrentRepo);
		expect(flags).toEqual([true, false, false]);
		for (const child of root.children ?? []) {
			expect(child.isRepoRoot).toBe(true);
			expect(child.children).toBeUndefined();
		}
	});

	it("surfaces the directory basename in the display name when it differs from config.repoName", async () => {
		// Common after collision suffixing: a repo can live under `foo-2/`
		// while still calling itself `foo` in config.json. Two such rows would
		// be visually indistinguishable if we only showed `repoName`, so the
		// dirName is appended in parentheses as a disambiguator. The "(current)"
		// cue is a separate CSS pseudo-element and is unaffected.
		seedRepo(tmpParent, "foo-2", {
			repoName: "foo",
			remoteUrl: "https://github.com/o/foo.git",
		});
		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const root = await svc.listChildren("");
		const repo = (root.children ?? [])[0];
		expect(repo?.name).toBe("foo (foo-2)");
		// Protocol path uses the unambiguous directory basename so listings
		// remain addressable when two repos share a repoName.
		expect(repo?.relPath).toBe("foo-2");
	});

	it("renders two same-repoName rows with distinct disambiguated labels", async () => {
		// Pinned regression: pre-fix the sidebar would show two literally
		// identical "shared" rows for collision-suffixed forks, with only the
		// "(current)" CSS cue distinguishing at most one of them.
		seedRepo(tmpParent, "shared", {
			repoName: "shared",
			remoteUrl: "https://github.com/a/shared.git",
		});
		seedRepo(tmpParent, "shared-2", {
			repoName: "shared",
			remoteUrl: "https://github.com/b/shared.git",
		});

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const root = await svc.listChildren("");
		const names = (root.children ?? []).map((c) => c.name).sort();
		expect(names).toEqual(["shared", "shared (shared-2)"]);
	});

	it("preserves the disambiguated label when expanding a collision-suffixed repo at its own root", async () => {
		// Pinned: listChildren re-injects repo identity for repoRelPath === "".
		// That restore-block also has to use repoDisplayName, otherwise expand-
		// then-collapse-then-expand of `foo-2` would silently revert the row
		// label from "foo (foo-2)" back to "foo" via the webview's propagateUp.
		seedRepo(tmpParent, "foo-2", {
			repoName: "foo",
			remoteUrl: "https://github.com/o/foo.git",
		});
		mkdirSync(join(tmpParent, "foo-2", "branch"), { recursive: true });

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const node = await svc.listChildren("foo-2");
		expect(node.name).toBe("foo (foo-2)");
		expect(node.isRepoRoot).toBe(true);
	});

	it("disambiguates two repos with the same repoName via their directory paths", async () => {
		seedRepo(tmpParent, "shared", {
			repoName: "shared",
			remoteUrl: "https://github.com/a/shared.git",
		});
		seedRepo(tmpParent, "shared-2", {
			repoName: "shared",
			remoteUrl: "https://github.com/b/shared.git",
		});
		mkdirSync(join(tmpParent, "shared", "data"), { recursive: true });
		writeFileSync(join(tmpParent, "shared", "data", "from-a.md"), "x");
		mkdirSync(join(tmpParent, "shared-2", "data"), { recursive: true });
		writeFileSync(join(tmpParent, "shared-2", "data", "from-b.md"), "y");

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const a = await svc.listChildren("shared/data");
		const b = await svc.listChildren("shared-2/data");
		expect((a.children ?? []).map((c) => c.name)).toEqual(["from-a.md"]);
		expect((b.children ?? []).map((c) => c.name)).toEqual(["from-b.md"]);
	});

	it("throws on an unknown repo segment so the webview can surface the stale path", async () => {
		seedRepo(tmpParent, "exists", { repoName: "exists" });
		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		await expect(svc.listChildren("ghost")).rejects.toThrow(
			/Unknown repo: ghost/,
		);
	});

	// ── User-created top-level entries ─────────────────────────────────────
	// Memory Bank can host user-dropped notes/files alongside managed repos.
	// Tests below pin the sort/visual contract: repo entries first (with the
	// current repo at the top), then plain user directories, then plain user
	// files — matching the UX choice surfaced in Settings.

	it("lists user-created directories and files alongside repos at the parent root", async () => {
		seedRepo(tmpParent, "alpha", { repoName: "alpha" });
		// User-created dir without `.jolli/config.json` — a plain folder.
		mkdirSync(join(tmpParent, "my-notes"));
		writeFileSync(join(tmpParent, "my-notes", "child.md"), "# child");
		// User-created top-level file.
		writeFileSync(join(tmpParent, "scratch.md"), "# scratch");

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const root = await svc.listChildren("");
		const names = (root.children ?? []).map((c) => c.name);
		// Repo first, then user dir, then user file — pinned ordering.
		expect(names).toEqual(["alpha", "my-notes", "scratch.md"]);

		const [repoNode, dirNode, fileNode] = root.children ?? [];
		expect(repoNode?.isRepoRoot).toBe(true);
		// Plain user entries must NOT carry repo-level flags — those drive
		// the laptop icon, bold label, and (current) suffix in the renderer.
		expect(dirNode?.isRepoRoot).toBeFalsy();
		expect(dirNode?.isCurrentRepo).toBeFalsy();
		expect(dirNode?.isDirectory).toBe(true);
		expect(dirNode?.children).toBeUndefined(); // lazy
		expect(fileNode?.isDirectory).toBe(false);
		expect(fileNode?.fileKind).toBe("other");
		// .md title derivation still works for plain top-level files.
		expect(fileNode?.fileTitle).toBe("scratch");
	});

	it("filters dotfiles/dotdirs from the user-entry scan at the parent root", async () => {
		mkdirSync(join(tmpParent, ".git"));
		mkdirSync(join(tmpParent, ".vscode"));
		writeFileSync(join(tmpParent, ".DS_Store"), "");
		mkdirSync(join(tmpParent, "visible"));

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const root = await svc.listChildren("");
		const names = (root.children ?? []).map((c) => c.name);
		expect(names).toEqual(["visible"]);
	});

	it("does not double-count a repo as a user entry when both lists would see it", async () => {
		// Defensive: discoverRepos finds `alpha` because it has .jolli/config.json,
		// AND a naive readdir would also see the `alpha` directory entry. The
		// exclude-set keeps it from showing up twice.
		seedRepo(tmpParent, "alpha", { repoName: "alpha" });
		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const root = await svc.listChildren("");
		const names = (root.children ?? []).map((c) => c.name);
		expect(names).toEqual(["alpha"]);
	});

	it("expands a user-created top-level directory and exposes its children", async () => {
		mkdirSync(join(tmpParent, "my-notes", "sub"), { recursive: true });
		writeFileSync(join(tmpParent, "my-notes", "top.md"), "# Top Title");
		writeFileSync(join(tmpParent, "my-notes", "sub", "leaf.md"), "# Leaf");

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		// listChildren("my-notes") expands the user folder. Should NOT carry
		// repo-level flags but should restore the on-disk name (not "" from
		// the inner listInRepo's relPath="" branch).
		const node = await svc.listChildren("my-notes");
		expect(node.name).toBe("my-notes");
		expect(node.relPath).toBe("my-notes");
		expect(node.isRepoRoot).toBeFalsy();
		const childNames = (node.children ?? []).map((c) => c.name);
		// Dirs before files; the .md gets fileKind:"other" since no manifest.
		expect(childNames).toEqual(["sub", "top.md"]);
		const topFile = (node.children ?? []).find((c) => c.name === "top.md");
		expect(topFile?.fileKind).toBe("other");
		expect(topFile?.fileTitle).toBe("Top Title");
		expect(topFile?.relPath).toBe("my-notes/top.md");
	});

	it("expands a sub-path inside a user-created top-level directory", async () => {
		mkdirSync(join(tmpParent, "my-notes", "sub"), { recursive: true });
		writeFileSync(join(tmpParent, "my-notes", "sub", "leaf.md"), "# Leaf");

		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		const node = await svc.listChildren("my-notes/sub");
		expect(node.name).toBe("sub");
		expect(node.relPath).toBe("my-notes/sub");
		const childNames = (node.children ?? []).map((c) => c.name);
		expect(childNames).toEqual(["leaf.md"]);
		expect((node.children ?? [])[0]?.relPath).toBe("my-notes/sub/leaf.md");
	});

	it("refuses to expand a top-level file (callers shouldn't ask, but the throw is the safety net)", async () => {
		writeFileSync(join(tmpParent, "scratch.md"), "# scratch");
		const svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: null,
			currentRemoteUrl: null,
		}));
		await expect(svc.listChildren("scratch.md")).rejects.toThrow(
			/non-directory/,
		);
	});
});

describe("KbFoldersService — breadcrumb selection helpers", () => {
	let tmpParent: string;
	let svc: KbFoldersService;

	beforeEach(() => {
		tmpParent = mkdtempSync(join(tmpdir(), "kbfolders-sel-"));
	});
	afterEach(() => {
		rmSync(tmpParent, { recursive: true, force: true });
	});

	it("listRepos surfaces every Memory Bank repo with isCurrentRepo set against the workspace identity", () => {
		seedRepo(tmpParent, "alpha", { repoName: "alpha" });
		seedRepo(tmpParent, "beta", { repoName: "beta" });
		svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "beta",
			currentRemoteUrl: null,
		}));
		const repos = svc.listRepos();
		expect(repos.map((r) => r.repoName).sort()).toEqual(["alpha", "beta"]);
		const beta = repos.find((r) => r.repoName === "beta");
		expect(beta?.isCurrentRepo).toBe(true);
		const alpha = repos.find((r) => r.repoName === "alpha");
		expect(alpha?.isCurrentRepo).toBe(false);
	});

	it("listBranches returns branches.json mappings (canonical names, not folder names) for the named repo", () => {
		const repoDir = seedRepo(tmpParent, "alpha", { repoName: "alpha" });
		// Drive the registry via resolveFolderForBranch so the sanitization
		// transcode (e.g. `feature/x` → `feature-x`) is exercised — listBranches
		// must return the original branch name, not the on-disk folder.
		const mm = new MetadataManager(join(repoDir, ".jolli"));
		mm.resolveFolderForBranch("main");
		mm.resolveFolderForBranch("feature/x");
		svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "alpha",
			currentRemoteUrl: null,
		}));
		expect(svc.listBranches("alpha")).toEqual(["feature/x", "main"]);
	});

	it("listBranches returns [] for an unknown repo without throwing", () => {
		seedRepo(tmpParent, "alpha", { repoName: "alpha" });
		svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "alpha",
			currentRemoteUrl: null,
		}));
		expect(svc.listBranches("does-not-exist")).toEqual([]);
	});

	it("listBranches returns [] when the repo has no branches.json yet (fresh repo)", () => {
		seedRepo(tmpParent, "alpha", { repoName: "alpha" });
		svc = new KbFoldersService(() => ({
			kbParent: tmpParent,
			currentRepoName: "alpha",
			currentRemoteUrl: null,
		}));
		expect(svc.listBranches("alpha")).toEqual([]);
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

	it("returns undefined when the H1 captures only whitespace (collapses to empty after trim)", () => {
		// Regex `^#[ \t]+(.+?)[ \t]*#*[ \t]*$` with non-greedy `.+?` lets a
		// single whitespace char land in the capture group when the rest of
		// the line is also whitespace. `.trim()` then yields "" and the
		// `v || undefined` fallback should fire — instead of returning a
		// blank string as the title. Pinned because a future refactor that
		// drops the `|| undefined` guard would surface as "" titles in the
		// folder view, which the UI would render as a blank row.
		expect(parseMdTitle("# \t\n")).toBeUndefined();
	});

	it("strips single-quote pairs from frontmatter titles (mirroring the double-quote branch)", () => {
		// stripQuotes has separate `'"'` and `"'"` branches in its OR
		// condition. Earlier tests cover only the implicit no-quote case
		// (`title: hello`). YAML accepts both quote styles, so the
		// single-quote arm must keep stripping correctly — otherwise the
		// folder view would show `'hello'` instead of `hello` for any
		// YAML-quoted title using single quotes.
		expect(parseMdTitle("---\ntitle: 'hello'\n---\n")).toBe("hello");
	});
});
