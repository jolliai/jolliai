/**
 * Tests for RepoIdentity — source-repo identity + vault subdirectory naming.
 *
 * `getRemoteUrl` / `extractRepoName` from KBPathResolver are spied on so we
 * can fully control the fallback chain without touching real git.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kbResolver from "../core/KBPathResolver.js";
import {
	canonicalizeRepoIdentity,
	computeRepoFolderName,
	computeRepoIdentity,
	decodeBranchFolderName,
	encodeBranchFolderName,
	repoIdentityFromConfig,
} from "./RepoIdentity.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "repoidentity-"));
	await writeFile(join(tempDir, "marker"), ""); // give it some content so path exists
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(tempDir, { recursive: true, force: true });
});

describe("computeRepoIdentity", () => {
	it("uses normalized git remote URL when one is configured", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://github.com/foo/bar.git/");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/some/path");
		expect(result.repoIdentity).toBe("https://github.com/foo/bar");
		expect(result.slug).toBe("bar");
	});

	it("falls back to extractRepoName when no remote is configured", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("my-notes");

		const result = computeRepoIdentity("/home/foo/my-notes");
		expect(result.repoIdentity).toBe("my-notes");
		expect(result.slug).toBe("my-notes");
	});

	it("uses extractRepoName (not basename) for remote-less worktrees, matching the persisted repoName", () => {
		// A worktree's basename is the worktree dir name, but extractRepoName
		// resolves to the main repo's name via git-common-dir — the same value
		// `writeKBIdentity` persists, so live and scanned identities agree.
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("main-repo");

		const result = computeRepoIdentity("/home/foo/wt-feature");
		expect(result.repoIdentity).toBe("main-repo");
		expect(result.slug).toBe("main-repo");
	});

	it("strips https user-info from the remote URL", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://user:pass@github.com/foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://github.com/foo/bar");
	});

	it("lowercases scheme and host but preserves path case for self-hosted forges", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("HTTPS://GIT.corp.Example/Foo/Bar");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("Bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://git.corp.example/Foo/Bar");
	});

	it("folds path case on known case-insensitive hosts (same repo, different typed casing)", () => {
		// github.com routes owner/repo case-insensitively, so JolliAI/Jolli
		// and jolliai/jolli are one repo — distinct identities would re-open
		// the duplicate-row hazard on the casing axis. Same rule + host set
		// as the server-facing canonicalizer in GitRemoteUtils.
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("Jolli");
		const getRemoteUrl = vi.spyOn(kbResolver, "getRemoteUrl");

		getRemoteUrl.mockReturnValue("https://github.com/JolliAI/Jolli.git");
		expect(computeRepoIdentity("/x").repoIdentity).toBe("https://github.com/jolliai/jolli");

		getRemoteUrl.mockReturnValue("git@github.com:JolliAI/Jolli.git");
		expect(computeRepoIdentity("/x").repoIdentity).toBe("https://github.com/jolliai/jolli");
	});

	it("folds SCP-style URLs into the https form (same repo via SSH and https → one identity)", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("git@github.com:foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://github.com/foo/bar");
	});

	it("folds ssh:// URLs (user-info + port dropped) into the https form", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("ssh://git@github.com:22/foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://github.com/foo/bar");
	});

	it("folds git:// and git+ssh:// URLs into the https form", () => {
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");
		const getRemoteUrl = vi.spyOn(kbResolver, "getRemoteUrl");

		getRemoteUrl.mockReturnValue("git://github.com/foo/bar.git");
		expect(computeRepoIdentity("/x").repoIdentity).toBe("https://github.com/foo/bar");

		getRemoteUrl.mockReturnValue("git+ssh://git@github.com/foo/bar.git");
		expect(computeRepoIdentity("/x").repoIdentity).toBe("https://github.com/foo/bar");
	});

	it("lowercases the host of a folded SCP URL but preserves path case on self-hosted forges", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("git@GIT.corp.Example:Foo/Bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("Bar");

		const result = computeRepoIdentity("/x");
		expect(result.repoIdentity).toBe("https://git.corp.example/Foo/Bar");
	});

	it("preserves the absolute-path distinction when folding SCP URLs", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("git@host.example:/srv/repo");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("repo");

		expect(computeRepoIdentity("/x").repoIdentity).toBe("https://host.example//srv/repo");
	});

	it("does not fold non-SSH remotes that merely contain a colon", () => {
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("foo");
		const getRemoteUrl = vi.spyOn(kbResolver, "getRemoteUrl");

		// Windows drive path remote — not an SCP URL (no `user@`).
		getRemoteUrl.mockReturnValue("C:/repos/foo.git");
		expect(computeRepoIdentity("/x").repoIdentity).toBe("C:/repos/foo");

		// Bare `host:path` without user-info: earlier releases never folded
		// it either, and folding here but not in stored rows would split
		// identities. Stays opaque.
		getRemoteUrl.mockReturnValue("mygit.local:repos/foo");
		expect(computeRepoIdentity("/x").repoIdentity).toBe("mygit.local:repos/foo");
	});

	it("slugifies the repo name (NFKD + lowercase + non-[a-z0-9-] → -)", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("Foster's Personal!");

		const result = computeRepoIdentity("/x");
		expect(result.slug).toBe("foster-s-personal");
	});

	it("falls back to 'repo' when the slug would be empty after sanitize", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("📝📝📝");

		const result = computeRepoIdentity("/x");
		expect(result.slug).toBe("repo");
	});
});

describe("repoIdentityFromConfig", () => {
	it("normalizes remoteUrl to the same key computeRepoIdentity produces", () => {
		// Same normalization (strip .git, lower host) as the live-checkout path.
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://GitHub.com/jolliai/jolli.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("jolli");
		const live = computeRepoIdentity("/x").repoIdentity;

		expect(repoIdentityFromConfig({ remoteUrl: "https://GitHub.com/jolliai/jolli.git" })).toBe(live);
		expect(repoIdentityFromConfig({ remoteUrl: "https://github.com/jolliai/jolli" })).toBe(live);
	});

	it("folds scp-style URLs to the same https identity as the live-checkout normalizer", () => {
		expect(repoIdentityFromConfig({ remoteUrl: "git@github.com:jolliai/jolli.git" })).toBe(
			"https://github.com/jolliai/jolli",
		);
		// SSH-config and https-config of the same repo agree — the exact
		// duplicate-row trigger in repos.json.
		expect(repoIdentityFromConfig({ remoteUrl: "git@github.com:jolliai/jolli.git" })).toBe(
			repoIdentityFromConfig({ remoteUrl: "https://github.com/jolliai/jolli" }),
		);
	});

	it("falls back to repoName when there is no remoteUrl", () => {
		expect(repoIdentityFromConfig({ repoName: "jolli" })).toBe("jolli");
		expect(repoIdentityFromConfig({ remoteUrl: "   ", repoName: "jolli" })).toBe("jolli");
	});

	it("returns null when neither remoteUrl nor repoName is derivable", () => {
		expect(repoIdentityFromConfig({})).toBeNull();
		expect(repoIdentityFromConfig({ remoteUrl: "  ", repoName: "  " })).toBeNull();
	});
});

describe("canonicalizeRepoIdentity", () => {
	it("folds a persisted SCP-style identity to the https form", () => {
		expect(canonicalizeRepoIdentity("git@github.com:jolliai/jolli")).toBe("https://github.com/jolliai/jolli");
	});

	it("leaves an already-canonical https identity unchanged", () => {
		expect(canonicalizeRepoIdentity("https://github.com/jolliai/jolli")).toBe("https://github.com/jolliai/jolli");
	});

	it("passes bare fallback identities through, even ones containing a colon", () => {
		// Name-fallback identities never went through URL normalization at
		// compute time, so re-normalizing a stored row must not invent a
		// fake https URL out of a folder name.
		expect(canonicalizeRepoIdentity("my-notes")).toBe("my-notes");
		expect(canonicalizeRepoIdentity("notes:personal")).toBe("notes:personal");
	});

	it("does not strip .git from a bare fallback identity (only URL/SCP forms are normalized)", () => {
		// A remote-less repo whose directory is literally named `foo.git`
		// computes identity `foo.git`. An un-gated normalizer would rewrite
		// the stored row to `foo`, desyncing it from the live value AND
		// colliding it with a genuinely distinct repo named `foo`.
		expect(canonicalizeRepoIdentity("foo.git")).toBe("foo.git");
		// URL forms still normalize as before.
		expect(canonicalizeRepoIdentity("https://github.com/a/foo.git")).toBe("https://github.com/a/foo");
	});

	it("preserves a non-default ssh port (self-hosted forges stay distinct)", () => {
		expect(canonicalizeRepoIdentity("ssh://git@host.example:2222/a/b.git")).toBe("https://host.example:2222/a/b");
		expect(canonicalizeRepoIdentity("ssh://git@host.example:22/a/b.git")).toBe("https://host.example/a/b");
	});
});

describe("computeFallbackHashSuffix", () => {
	it("returns a deterministic 6-hex-char digest derived from the input identity", async () => {
		const { computeFallbackHashSuffix } = await import("./RepoIdentity.js");
		const a = computeFallbackHashSuffix("https://github.com/foo/bar");
		const b = computeFallbackHashSuffix("https://github.com/foo/bar");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{6}$/);
		// Different inputs → different suffixes (birthday-collision is
		// negligible at the personal Memory Bank scale this function targets).
		const c = computeFallbackHashSuffix("https://gitlab.com/foo/bar");
		expect(c).not.toBe(a);
	});
});

describe("computeRepoFolderName", () => {
	it("returns the bare slug — collision handling lives in RepoMapping", () => {
		const name = computeRepoFolderName({ repoIdentity: "https://github.com/foo/bar", slug: "bar" });
		expect(name).toBe("bar");
	});

	it("is deterministic for the same identity", () => {
		const id = { repoIdentity: "https://github.com/foo/bar", slug: "bar" };
		expect(computeRepoFolderName(id)).toBe(computeRepoFolderName(id));
	});

	it("returns the same slug for two distinct repoIdentities (collision deferred to RepoMapping)", () => {
		// Two different remote hosts that slug-collapse to the same name —
		// `computeRepoFolderName` proposes `bar` for both; the engine then
		// calls `RepoMapping.resolveOrAssignFolder` which gives the second
		// caller a `bar-<hash6>` suffix.
		const a = computeRepoFolderName({ repoIdentity: "https://github.com/foo/bar", slug: "bar" });
		const b = computeRepoFolderName({ repoIdentity: "https://gitlab.com/foo/bar", slug: "bar" });
		expect(a).toBe("bar");
		expect(b).toBe("bar");
	});
});

describe("encodeBranchFolderName / decodeBranchFolderName", () => {
	it("substitutes `/` → `^`", () => {
		expect(encodeBranchFolderName("feature/JOLLI-1336")).toBe("feature^JOLLI-1336");
	});

	it("round-trips through encode + decode", () => {
		const raw = "feature/foo/bar/baz";
		expect(decodeBranchFolderName(encodeBranchFolderName(raw))).toBe(raw);
	});

	it("leaves branches without `/` unchanged", () => {
		expect(encodeBranchFolderName("main")).toBe("main");
		expect(decodeBranchFolderName("main")).toBe("main");
	});
});
