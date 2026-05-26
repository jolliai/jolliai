import { describe, expect, it } from "vitest";
import type { OwnedPathKind } from "./OwnedPathKind.js";
import { classifyVaultPath } from "./VaultPathClassifier.js";

/**
 * Sample paths exercise the EXACT shapes FolderStorage and RepoMapping
 * emit, per Phase 0.1's audit of the production write surface. If you
 * change a write path in code, this test fixture must change in lockstep
 * — that's the load-bearing tie that prevents silent drift.
 */
const HASH40 = "abc1234567890abcdef1234567890abcdef12345"; // valid 40-char hex
const HASH8 = "1a2b3c4d";

describe("classifyVaultPath — positive cases", () => {
	const cases: Array<[string, OwnedPathKind]> = [
		[".gitignore", "root-gitignore"],
		[".jolli/repos.json", "root-repos"],
		["myrepo/.jolli/config.json", "repo-config"],
		["myrepo/.jolli/index.json", "repo-index"],
		["myrepo/.jolli/manifest.json", "repo-manifest"],
		["myrepo/.jolli/branches.json", "repo-branches"],
		["myrepo/.jolli/catalog.json", "repo-catalog"],
		[`myrepo/.jolli/summaries/${HASH40}.json`, "summary"],
		[`myrepo/.jolli/transcripts/${HASH40}.json`, "transcript"],
		["myrepo/.jolli/plans/my-feature.md", "plan"],
		["myrepo/.jolli/plan-progress/my-feature.json", "plan-progress"],
		["myrepo/.jolli/notes/note-xyz.md", "note"],
		[`myrepo/main/fix-auth-${HASH8}.md`, "visible-summary"],
		["myrepo/main/plan--my-feature.md", "visible-plan"],
		["myrepo/main/note--note-xyz.md", "visible-note"],
	];

	for (const [path, expected] of cases) {
		it(`${path} → ${expected}`, () => {
			expect(classifyVaultPath(path)).toBe(expected);
		});
	}

	it("accepts partial-hash summaries (AllowList allows 7–64 hex)", () => {
		// Catalog also stores `<hash>` shorter than 40 (legacy / abbreviated
		// commits). The classifier must accept them to avoid breaking
		// pre-existing data.
		expect(classifyVaultPath("myrepo/.jolli/summaries/abc1234.json")).toBe("summary");
		expect(classifyVaultPath(`myrepo/.jolli/summaries/${"a".repeat(64)}.json`)).toBe("summary");
	});

	it("accepts the `untitled` slug fallback in visible-summary", () => {
		// FolderStorage.slugify returns "untitled" when the input slug would
		// be empty (commit message of just punctuation, etc.). The visible
		// filename `untitled-<hex8>.md` must classify.
		expect(classifyVaultPath(`myrepo/main/untitled-${HASH8}.md`)).toBe("visible-summary");
	});

	it("accepts a transcoded branch with mixed case and underscores (transcoder preserves them)", () => {
		// transcodeBranchName replaces /\:*?~^ with dashes but does NOT
		// lowercase. Underscores are legal. The classifier matches the
		// real transcoder output, not a guessed grammar.
		expect(classifyVaultPath(`myrepo/Feature_Branch_A/work-${HASH8}.md`)).toBe("visible-summary");
	});

	it("accepts repo folder names with case (extractRepoName preserves case)", () => {
		expect(classifyVaultPath("MyRepo/.jolli/index.json")).toBe("repo-index");
	});

	it("accepts ordinary user content under <repo>/ as `user-content`", () => {
		// Acceptance §1 / §8 contract: a working tree where the user (or
		// the engine on their behalf) drops arbitrary markdown / files
		// under `<repo>/...` must be staged. Pre-relaxation these were
		// `null` and silently dropped from the staged set.
		expect(classifyVaultPath("test-repo/hello.md")).toBe("user-content");
		expect(classifyVaultPath("test-repo/notes/a.md")).toBe("user-content");
		expect(classifyVaultPath("MyRepo/docs/setup.md")).toBe("user-content");
	});

	it("accepts root-level user content as `user-content` (legacy DB migration)", () => {
		// Acceptance §11 contract: `LegacyMigration.apply` writes docs at
		// the backend-provided root paths (`notes/hello.md`, `cfg.json`).
		// The strict catalogue only recognises `.gitignore` and
		// `.jolli/repos.json` at root; everything else now falls through
		// to `user-content` so the migrate-commit picks them up.
		expect(classifyVaultPath("notes/hello.md")).toBe("user-content");
		expect(classifyVaultPath("cfg.json")).toBe("user-content");
		expect(classifyVaultPath("Thumbs.db")).toBe("user-content");
		expect(classifyVaultPath("foo.swp")).toBe("user-content");
	});

	it("keeps shadow-status.json rejected even outside `<repo>/.jolli/` placement", () => {
		// Defence-in-depth: per-device state must never sync regardless
		// of where it lands. The strict pass catches `<repo>/.jolli/...`
		// via the leading-dot rule on `.jolli`; the fallthrough's
		// explicit leaf check covers any future placement we missed.
		expect(classifyVaultPath("somewhere/shadow-status.json")).toBeNull();
	});
});

describe("classifyVaultPath — negative cases", () => {
	it("returns null for empty input", () => {
		expect(classifyVaultPath("")).toBeNull();
	});

	it("rejects absolute paths", () => {
		expect(classifyVaultPath("/myrepo/.jolli/index.json")).toBeNull();
	});

	it("rejects leading `./` (caller's responsibility to strip)", () => {
		expect(classifyVaultPath("./myrepo/.jolli/index.json")).toBeNull();
	});

	it("rejects `..` segments anywhere in the path", () => {
		expect(classifyVaultPath("myrepo/../something")).toBeNull();
		expect(classifyVaultPath("../etc/passwd")).toBeNull();
		expect(classifyVaultPath("myrepo/.jolli/..")).toBeNull();
	});

	it("rejects Windows-style backslash separators (POSIX only)", () => {
		expect(classifyVaultPath("myrepo\\.jolli\\index.json")).toBeNull();
	});

	it("rejects the global config path (lives OUTSIDE the vault, AllowList §1 guard subject)", () => {
		// `~/.jolli/jollimemory/config.json` could never appear in `git
		// status` for the vault repo, but defence-in-depth: even if some
		// path-normalisation bug surfaced it, classifier rejects.
		expect(classifyVaultPath(".jolli/jollimemory/config.json")).toBeNull();
	});

	it("rejects vault-root aggregates that DON'T live there (manifest / index / etc. — Phase 0.1 confirmed only repos.json does)", () => {
		// If a future tool mistakenly drops one of these at vault root,
		// we want the canary to fire — not silently stage them.
		expect(classifyVaultPath(".jolli/manifest.json")).toBeNull();
		expect(classifyVaultPath(".jolli/index.json")).toBeNull();
		expect(classifyVaultPath(".jolli/catalog.json")).toBeNull();
		expect(classifyVaultPath(".jolli/branches.json")).toBeNull();
		expect(classifyVaultPath(".jolli/config.json")).toBeNull();
	});

	it("rejects shadow-status.json (per-device dirty-write recovery state — never synced)", () => {
		// Per-device state; classifier and `MemoryBankBootstrap`'s
		// `PER_DEVICE_JSON_GLOBS` cleanup are deliberately redundant —
		// classifier rejects new writes, bootstrap untracks legacy commits.
		expect(classifyVaultPath("myrepo/.jolli/shadow-status.json")).toBeNull();
	});

	it("rejects quarantine paths (engine-internal, must not sync)", () => {
		expect(classifyVaultPath("myrepo/.jolli/quarantine-summaries/leak.json")).toBeNull();
		expect(classifyVaultPath(".jolli-quarantine-corrupt/something.json")).toBeNull();
		expect(classifyVaultPath("myrepo/.jolli/quarantine-symlinks/x")).toBeNull();
	});

	it("rejects hidden-file OS / IDE noise (leading-dot segments)", () => {
		// `SAFE_SEGMENT_RE` rejects any segment starting with `.`, so the
		// classic dotfile garbage stays out of `user-content` without an
		// extension blocklist. Non-hidden noise like `Thumbs.db` or
		// `foo.swp` is allowed through — see the `accepts ordinary user
		// content` block below.
		expect(classifyVaultPath(".DS_Store")).toBeNull();
		expect(classifyVaultPath("myrepo/.DS_Store")).toBeNull();
		expect(classifyVaultPath("myrepo/.vscode/settings.json")).toBeNull();
		expect(classifyVaultPath("myrepo/.idea/workspace.xml")).toBeNull();
	});

	it("rejects summary hash that doesn't match the hex grammar", () => {
		// Too short (<7).
		expect(classifyVaultPath("myrepo/.jolli/summaries/abc123.json")).toBeNull();
		// Too long (>64).
		expect(classifyVaultPath(`myrepo/.jolli/summaries/${"a".repeat(65)}.json`)).toBeNull();
		// Uppercase (production is lowercase).
		expect(classifyVaultPath("myrepo/.jolli/summaries/ABCDEF1.json")).toBeNull();
		// Wrong extension.
		expect(classifyVaultPath(`myrepo/.jolli/summaries/${HASH40}.txt`)).toBeNull();
		// Stray segment.
		expect(classifyVaultPath(`myrepo/.jolli/summaries/sub/${HASH40}.json`)).toBeNull();
	});

	it("falls back to user-content for non-catalogue markdown under <repo>/<branch>/", () => {
		// Pre-relaxation these were `null` because they don't match the
		// strict `<slug>-<hex8>.md` / `plan--<slug>.md` / `note--<id>.md`
		// shapes. Now they ride the `user-content` fallthrough — the
		// vault is a general working tree, not just a FolderStorage drop.
		expect(classifyVaultPath("myrepo/main/no-hex-suffix.md")).toBe("user-content");
		expect(classifyVaultPath("myrepo/main/bad-hex-zzzzzzzz.md")).toBe("user-content");
		expect(classifyVaultPath("myrepo/main/short-1a2b.md")).toBe("user-content");
	});

	it("rejects `..` even inside otherwise safe-looking visible-plan / visible-note slugs", () => {
		// `..` is a hard reject regardless of context — keeps path
		// traversal out even when the surrounding shape looks owned.
		expect(classifyVaultPath("myrepo/main/plan--..evil.md")).toBeNull();
	});

	it("falls back to user-content for note-- with hidden-suffix slug (no traversal token)", () => {
		// `note--.hidden.md` has no `..` and no leading-dot segment (the
		// whole segment starts with `n`), so it survives both safety
		// checks. The strict catalogue rejects it because the slug
		// portion (`.hidden`) leads with a dot — but the permissive
		// fallthrough treats it as user content. This is intentional:
		// if a peer device or external writer commits such a name, we
		// stage rather than silently drop it.
		expect(classifyVaultPath("myrepo/main/note--.hidden.md")).toBe("user-content");
	});

	it("rejects unknown file types under .jolli/", () => {
		expect(classifyVaultPath("myrepo/.jolli/random-file.txt")).toBeNull();
		expect(classifyVaultPath("myrepo/.jolli/secrets.env")).toBeNull();
	});

	it("rejects deep nesting under .jolli (beyond known dirs)", () => {
		expect(classifyVaultPath("myrepo/.jolli/foo/bar/baz.json")).toBeNull();
	});

	it("rejects repo folder names with hostile shapes", () => {
		expect(classifyVaultPath(".hidden-repo/.jolli/index.json")).toBeNull(); // leading dot on first segment
		expect(classifyVaultPath("../escape/.jolli/index.json")).toBeNull(); // ..
	});

	it("accepts generic safe-segmented paths as user-content", () => {
		// Pre-relaxation `a/b/c/d` was rejected as "generic noise". Now
		// it rides the `user-content` fallthrough — safe segments at any
		// depth are stageable.
		expect(classifyVaultPath("a/b/c/d")).toBe("user-content");
	});

	it("rejects branch folder names that violate transcoder output shape", () => {
		expect(classifyVaultPath(`myrepo/.leading-dot/work-${HASH8}.md`)).toBeNull();
		expect(classifyVaultPath(`myrepo/-leading-dash/work-${HASH8}.md`)).toBeNull();
		expect(classifyVaultPath(`myrepo/trailing-dot./work-${HASH8}.md`)).toBeNull();
	});

	// ── Relaxed acceptance: real-world git branch / remote-name shapes ──
	// The classifier's regex used to be `[A-Za-z0-9._-]` only, which fired a
	// false-positive `unowned` canary for any branch / repo name containing
	// space, `+`, `#`, `'`, `(`, unicode, etc. — all of which are legitimate
	// in git remotes (`bar+baz`, `My Project`) and post-`transcodeBranchName`
	// output (`feat: foo` → `feat- foo`, space preserved). False positives in
	// the canary mask real security signals, so the segment regex was relaxed
	// to "any printable non-separator non-control char". The cases below pin
	// that contract — if anyone tightens the segment regex back to the old
	// shape, these fail loudly.

	it("accepts repo / branch names containing spaces (real-world remotes / casual branch names)", () => {
		expect(classifyVaultPath("My Project/.jolli/index.json")).toBe("repo-index");
		expect(classifyVaultPath(`myrepo/feat foo/work-${HASH8}.md`)).toBe("visible-summary");
	});

	it("accepts repo / branch names containing `+`, `#`, `&`, `'`, parens (transcoder preserves these)", () => {
		expect(classifyVaultPath("bar+baz/.jolli/index.json")).toBe("repo-index");
		expect(classifyVaultPath(`myrepo/bug#123/work-${HASH8}.md`)).toBe("visible-summary");
		expect(classifyVaultPath("acme&co/.jolli/manifest.json")).toBe("repo-manifest");
		expect(classifyVaultPath("john's-repo/.jolli/config.json")).toBe("repo-config");
		expect(classifyVaultPath("repo(fork)/.jolli/branches.json")).toBe("repo-branches");
	});

	it("accepts non-ASCII letters in `<repoFolder>` / `<branch>` — international remotes / branches", () => {
		// Filename slug itself is engine-controlled (`FolderStorage.slugify`
		// emits lowercase ASCII), so the unicode lives only in the variable
		// path segments. Using Latin-1 supplements as a representative
		// non-ASCII sample keeps the test ASCII-readable in code review.
		expect(classifyVaultPath("café/.jolli/index.json")).toBe("repo-index");
		expect(classifyVaultPath(`myrepo/naïve-branch/work-${HASH8}.md`)).toBe("visible-summary");
	});

	it("STILL rejects path separators inside a segment (security: `..` and embedded `/` `\\`)", () => {
		expect(classifyVaultPath("../escape/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("repo..with-dotdot/.jolli/index.json")).toBeNull();
		// Embedded backslash (Windows-style separator) rejected at top of
		// classifier; this is the per-segment defence-in-depth.
		expect(classifyVaultPath("repo\\with\\backslash/.jolli/index.json")).toBeNull();
	});

	it("STILL rejects control characters and NUL bytes inside a segment", () => {
		expect(classifyVaultPath("repo\x00null/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("repo\x07bell/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("repo\nnewline/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("repo\ttab/.jolli/index.json")).toBeNull();
		// DEL (0x7F) — `SAFE_SEGMENT_RE` builds its disallowed class from the
		// concatenated 0x00-0x1F range PLUS the single 0x7F endpoint via
		// `String.fromCharCode`. Without an explicit assertion that the
		// concatenation produced a working char-class member (and not, say, a
		// dangling range with garbage RHS), DEL could slip through silently.
		expect(classifyVaultPath("repo\x7fdel/.jolli/index.json")).toBeNull();
	});

	it("STILL rejects leading dot, leading dash, leading whitespace, trailing whitespace", () => {
		expect(classifyVaultPath(".hidden/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("-leading-dash/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath(" leading-space/.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("trailing-space /.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("trailing-dot./.jolli/index.json")).toBeNull();
		expect(classifyVaultPath("trailing-dash-/.jolli/index.json")).toBeNull();
	});
});

describe("classifyVaultPath — drift tripwires (round-trip safety)", () => {
	// These cases pin the contract between FolderStorage's write side and
	// the classifier's read side. If someone changes the path naming
	// scheme (renames `plans/` → `playbooks/`, switches `<slug>-<hex8>` to
	// `<hex8>-<slug>`, etc.) WITHOUT updating the classifier, these tests
	// fail loudly — long before the change reaches production where it
	// would silently drop data.

	it("plans are .md (not .json — early drafts of the plan got this wrong)", () => {
		expect(classifyVaultPath("myrepo/.jolli/plans/x.json")).toBeNull();
		expect(classifyVaultPath("myrepo/.jolli/plans/x.md")).toBe("plan");
	});

	it("plan-progress is .json (not .md)", () => {
		expect(classifyVaultPath("myrepo/.jolli/plan-progress/x.md")).toBeNull();
		expect(classifyVaultPath("myrepo/.jolli/plan-progress/x.json")).toBe("plan-progress");
	});

	it("notes are .md (not .json)", () => {
		expect(classifyVaultPath("myrepo/.jolli/notes/x.json")).toBeNull();
		expect(classifyVaultPath("myrepo/.jolli/notes/x.md")).toBe("note");
	});

	it("repos.json is root-level only (not per-repo)", () => {
		expect(classifyVaultPath(".jolli/repos.json")).toBe("root-repos");
		// A per-repo `repos.json` doesn't exist by design; check classifier
		// doesn't accidentally accept it.
		expect(classifyVaultPath("myrepo/.jolli/repos.json")).toBeNull();
	});
});
