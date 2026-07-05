import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommandResult } from "../Types.js";

vi.mock("./GitOps.js", () => ({ execGit: vi.fn() }));

import { execGit } from "./GitOps.js";
import {
	buildBranchRelativePath,
	deriveOwnerRepoFromUrl,
	deriveRepoNameFromUrl,
	getCanonicalRepoUrl,
	normalizeRemoteUrl,
	sanitizeBranchSlug,
} from "./GitRemoteUtils.js";

const gitResult = (stdout: string, exitCode = 0): GitCommandResult => ({ stdout, stderr: "", exitCode });

describe("getCanonicalRepoUrl", () => {
	beforeEach(() => vi.mocked(execGit).mockReset());

	it("normalizes the configured remote when git returns one", async () => {
		vi.mocked(execGit).mockResolvedValue(gitResult("git@github.com:Owner/Repo.git"));
		expect(await getCanonicalRepoUrl("/ws")).toBe("https://github.com/owner/repo");
	});
	it("falls back to file:// when git exits non-zero", async () => {
		vi.mocked(execGit).mockResolvedValue(gitResult("fatal: not a git repo", 128));
		expect(await getCanonicalRepoUrl("/ws/proj")).toBe("file:///ws/proj");
	});
	it("falls back to file:// when the remote is blank", async () => {
		vi.mocked(execGit).mockResolvedValue(gitResult("   "));
		expect(await getCanonicalRepoUrl("/ws/proj")).toBe("file:///ws/proj");
	});
});

describe("normalizeRemoteUrl", () => {
	it("folds SSH scp form to https and strips .git", () => {
		expect(normalizeRemoteUrl("git@github.com:Owner/Repo.git", "/ws")).toBe("https://github.com/owner/repo");
	});
	it("lower-cases path only for case-insensitive hosts", () => {
		expect(normalizeRemoteUrl("https://example.com/Owner/Repo", "/ws")).toBe("https://example.com/Owner/Repo");
	});
	it("falls back to file:// on no remote", () => {
		expect(normalizeRemoteUrl("", "/ws/proj")).toBe("file:///ws/proj");
	});
	it("falls back to file:// when the URL is unparseable and not scp form", () => {
		expect(normalizeRemoteUrl("not-a-valid-url", "/ws/proj")).toBe("file:///ws/proj");
	});
	it("does NOT fold a userless scp remote (host:path with no user@) — deliberate file:// fallback", () => {
		// A bare `host:owner/repo.git` (valid only with an ~/.ssh/config Host alias
		// supplying the user) is intentionally NOT canonicalized: the scp regex
		// requires `user@` so a Windows drive path (`C:/repos/foo`) or a colon-bearing
		// local path is never mangled into a fake https URL. This matches the
		// KBPathResolver folding rule. Pinned so the deliberate gap is explicit and
		// isn't "fixed" without also revisiting that constraint.
		expect(normalizeRemoteUrl("github.com:owner/repo.git", "/ws/proj")).toBe("file:///ws/proj");
	});
	it("drops the default ssh port but keeps a non-default one", () => {
		expect(normalizeRemoteUrl("ssh://git@host/owner/repo.git", "/ws")).toBe("https://host/owner/repo");
		expect(normalizeRemoteUrl("ssh://git@host:22/owner/repo", "/ws")).toBe("https://host/owner/repo");
		expect(normalizeRemoteUrl("ssh://git@host:2222/owner/repo", "/ws")).toBe("https://host:2222/owner/repo");
	});
	it("drops the default git port but keeps a non-default one", () => {
		expect(normalizeRemoteUrl("git://host:9418/owner/repo", "/ws")).toBe("https://host/owner/repo");
		expect(normalizeRemoteUrl("git://host:1234/owner/repo", "/ws")).toBe("https://host:1234/owner/repo");
	});
	it("always preserves an explicit http(s) port", () => {
		expect(normalizeRemoteUrl("https://host:8443/Owner/Repo", "/ws")).toBe("https://host:8443/Owner/Repo");
	});
	it("maps a file:// remote to its path", () => {
		expect(normalizeRemoteUrl("file:///home/x/repo", "/ws")).toBe("file:///home/x/repo");
	});
	it("falls back to file:// for an unknown scheme", () => {
		expect(normalizeRemoteUrl("ftp://host/x", "/ws/proj")).toBe("file:///ws/proj");
	});
	it("emits file:/// for an empty fallback path", () => {
		expect(normalizeRemoteUrl("", "")).toBe("file:///");
	});
	it("normalizes a Windows-style fallback path to forward slashes", () => {
		expect(normalizeRemoteUrl("", "C:\\repo\\")).toBe("file:///C:/repo");
	});
});

describe("deriveRepoNameFromUrl", () => {
	it("takes the last path segment minus .git", () => {
		expect(deriveRepoNameFromUrl("https://github.com/owner/my-repo")).toBe("my-repo");
		expect(deriveRepoNameFromUrl("https://github.com/owner/my-repo.git")).toBe("my-repo");
	});
	it("returns empty for a blank url", () => {
		expect(deriveRepoNameFromUrl("   ")).toBe("");
	});
	it("returns the raw text (truncated) for an unparseable url", () => {
		expect(deriveRepoNameFromUrl("not a url")).toBe("not a url");
	});
	it("falls back to the host when the path is empty", () => {
		expect(deriveRepoNameFromUrl("https://GitHub.com/")).toBe("github.com");
	});
	it("takes the last segment for a file:// url", () => {
		expect(deriveRepoNameFromUrl("file:///home/x/repo")).toBe("repo");
	});
	it("returns the raw text for a file:// url with no path segment", () => {
		expect(deriveRepoNameFromUrl("file:///")).toBe("file:///");
	});
	it("returns the raw text for an unknown scheme", () => {
		expect(deriveRepoNameFromUrl("ftp://host/x")).toBe("ftp://host/x");
	});
});

describe("sanitizeBranchSlug / buildBranchRelativePath", () => {
	it("sanitizes branch to a slug", () => {
		expect(sanitizeBranchSlug("feature/Foo Bar")).toBe("feature/Foo_Bar");
		expect(buildBranchRelativePath("feature/Foo Bar")).toBe(sanitizeBranchSlug("feature/Foo Bar"));
	});
	it("empty branch → _", () => {
		expect(sanitizeBranchSlug(undefined)).toBe("_");
	});
	it("separator-only branch collapses to _", () => {
		expect(sanitizeBranchSlug("///")).toBe("_");
	});
});

describe("deriveOwnerRepoFromUrl", () => {
	it("returns owner/repo for an https remote", () => {
		expect(deriveOwnerRepoFromUrl("https://github.com/jolliai/jolli")).toBe("jolliai/jolli");
	});

	it("strips a .git suffix", () => {
		expect(deriveOwnerRepoFromUrl("https://github.com/jolliai/jolli.git")).toBe("jolliai/jolli");
	});

	it("keeps nested groups (e.g. GitLab subgroups)", () => {
		expect(deriveOwnerRepoFromUrl("https://gitlab.com/group/sub/repo")).toBe("group/sub/repo");
	});

	it("returns '' for a single-segment path (bare repo, no owner)", () => {
		expect(deriveOwnerRepoFromUrl("https://example.com/repo")).toBe("");
	});

	it("returns '' for a file:// local URL (no owner)", () => {
		expect(deriveOwnerRepoFromUrl("file:///tmp/foo/scratch")).toBe("");
	});

	it("returns '' on empty or unparseable input", () => {
		expect(deriveOwnerRepoFromUrl("")).toBe("");
		expect(deriveOwnerRepoFromUrl("not a url")).toBe("");
	});
});
