import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecGit } = vi.hoisted(() => ({
	mockExecGit: vi.fn(),
}));

vi.mock("../../../cli/src/core/GitOps.js", () => ({
	execGit: mockExecGit,
}));

import {
	deriveRepoNameFromUrl,
	getCanonicalRepoUrl,
	normalizeRemoteUrl,
	sanitizeBranchSlug,
} from "./GitRemoteUtils.js";

const FAKE_ROOT = "/tmp/workspace";

describe("normalizeRemoteUrl", () => {
	const vectors: ReadonlyArray<[string, string, string]> = [
		// label, input, expected output
		[
			"scp-style SSH",
			"git@github.com:jolliai/jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"scp-style SSH no .git",
			"git@github.com:jolliai/jolli",
			"https://github.com/jolliai/jolli",
		],
		[
			"ssh:// URL",
			"ssh://git@github.com/jolliai/jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"ssh:// URL with explicit default port (22) — port is dropped",
			"ssh://git@github.com:22/jolliai/jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"git:// URL",
			"git://github.com/jolliai/jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"git:// URL with explicit default port (9418) — port is dropped",
			"git://github.com:9418/jolliai/jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"https URL with .git",
			"https://github.com/jolliai/jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"https URL without .git",
			"https://github.com/jolliai/jolli",
			"https://github.com/jolliai/jolli",
		],
		[
			"http URL gets normalized to https",
			"http://example.com/owner/repo.git",
			"https://example.com/owner/repo",
		],
		[
			"mixed-case GitHub host and path are both lowered",
			"https://GitHub.com/JolliAI/Jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"GitHub SSH with mixed-case owner/repo lowercases path",
			"git@github.com:JolliAI/Jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"GitHub clones with different owner/repo casing collapse to one key",
			"ssh://git@github.com/JolliAI/Jolli.git",
			"https://github.com/jolliai/jolli",
		],
		[
			"GitLab.com path is lowercased (case-insensitive host)",
			"git@gitlab.com:Group/Repo.git",
			"https://gitlab.com/group/repo",
		],
		[
			"Bitbucket path is lowercased (case-insensitive host)",
			"https://bitbucket.org/Owner/Repo.git",
			"https://bitbucket.org/owner/repo",
		],
		[
			"self-hosted Gitea-style host preserves path case (may be case-sensitive)",
			"git@git.internal.company.com:Team/Repo.git",
			"https://git.internal.company.com/Team/Repo",
		],
		[
			"self-hosted https preserves path case",
			"https://git.internal.company.com/Team/Repo.git",
			"https://git.internal.company.com/Team/Repo",
		],
		[
			"trailing slash is stripped",
			"https://github.com/jolliai/jolli/",
			"https://github.com/jolliai/jolli",
		],
		[
			"trailing slash + .git",
			"https://github.com/jolliai/jolli.git/",
			"https://github.com/jolliai/jolli",
		],
		[
			"deep path is preserved",
			"https://gitlab.example.com/group/sub/repo.git",
			"https://gitlab.example.com/group/sub/repo",
		],
		// Non-GitHub hosts — same canonical-form rules.
		[
			"GitLab.com SSH",
			"git@gitlab.com:group/repo.git",
			"https://gitlab.com/group/repo",
		],
		[
			"Bitbucket SSH",
			"git@bitbucket.org:owner/repo.git",
			"https://bitbucket.org/owner/repo",
		],
		[
			"Bitbucket HTTPS with embedded user",
			"https://user@bitbucket.org/owner/repo.git",
			"https://bitbucket.org/owner/repo",
		],
		[
			"self-hosted GitLab over SSH",
			"git@git.internal.company.com:team/repo.git",
			"https://git.internal.company.com/team/repo",
		],
		[
			"self-hosted git on a non-default HTTPS port — port is preserved",
			"https://git.internal.company.com:8443/team/repo.git",
			"https://git.internal.company.com:8443/team/repo",
		],
		[
			"ssh:// URL with non-default port — port is preserved (distinct repo identity)",
			"ssh://git@git.internal.company.com:2222/team/repo.git",
			"https://git.internal.company.com:2222/team/repo",
		],
		[
			"git:// URL with non-default port — port is preserved",
			"git://git.internal.company.com:9419/team/repo.git",
			"https://git.internal.company.com:9419/team/repo",
		],
	];

	for (const [label, input, expected] of vectors) {
		it(`${label}`, () => {
			expect(normalizeRemoteUrl(input, FAKE_ROOT)).toBe(expected);
		});
	}

	it("two repos on different non-default ssh ports do NOT collide", () => {
		// Regression: dropping the port for every ssh:// URL collapsed two
		// distinct self-hosted repos onto the same binding key.
		const a = normalizeRemoteUrl(
			"ssh://git@git.internal.company.com:2222/team/repo.git",
			FAKE_ROOT,
		);
		const b = normalizeRemoteUrl(
			"ssh://git@git.internal.company.com:2223/team/repo.git",
			FAKE_ROOT,
		);
		expect(a).not.toBe(b);
	});

	it("falls back to file:// for empty remote", () => {
		expect(normalizeRemoteUrl("", "/tmp/foo")).toBe("file:///tmp/foo");
	});

	it("falls back to file:// for unparseable remote", () => {
		expect(normalizeRemoteUrl("not a url at all !!", "/tmp/foo")).toBe(
			"file:///tmp/foo",
		);
	});

	it("converts Windows backslashes to forward slashes in fallback", () => {
		const url = normalizeRemoteUrl("", "C:\\Users\\foster\\projects\\scratch");
		expect(url.startsWith("file:///")).toBe(true);
		expect(url).not.toContain("\\");
	});

	it("fallback path with spaces is preserved", () => {
		const url = normalizeRemoteUrl("", "/tmp/with spaces/repo");
		expect(url).toBe("file:///tmp/with spaces/repo");
	});

	it("file:// URLs pass through after normalization", () => {
		expect(normalizeRemoteUrl("file:///tmp/foo", FAKE_ROOT)).toBe(
			"file:///tmp/foo",
		);
	});

	it("falls back to file:// for parseable URLs with an unknown scheme", () => {
		// Parses as a URL (mailto: protocol) but isn't ssh/git/http/https/file,
		// so the canonicalizer must drop back to the workspace-root fallback.
		expect(normalizeRemoteUrl("mailto:foo@bar.com", "/tmp/foo")).toBe(
			"file:///tmp/foo",
		);
	});

	it("returns file:/// when the fallback root collapses to empty", () => {
		// Forces toFileUrl's `forward.length === 0` branch (root is just a slash).
		expect(normalizeRemoteUrl("", "/")).toBe("file:///");
	});
});

describe("getCanonicalRepoUrl", () => {
	beforeEach(() => {
		mockExecGit.mockReset();
	});

	it("normalizes the configured remote.origin.url", async () => {
		mockExecGit.mockResolvedValue({
			exitCode: 0,
			stdout: "git@github.com:jolliai/jolli.git\n",
			stderr: "",
		});
		await expect(getCanonicalRepoUrl(FAKE_ROOT)).resolves.toBe(
			"https://github.com/jolliai/jolli",
		);
		expect(mockExecGit).toHaveBeenCalledWith(
			["config", "--get", "remote.origin.url"],
			FAKE_ROOT,
		);
	});

	it("falls back to file:// when no remote is configured (empty stdout)", async () => {
		mockExecGit.mockResolvedValue({
			exitCode: 0,
			stdout: "",
			stderr: "",
		});
		await expect(getCanonicalRepoUrl("/tmp/foo")).resolves.toBe(
			"file:///tmp/foo",
		);
	});

	it("falls back to file:// when git config exits non-zero", async () => {
		mockExecGit.mockResolvedValue({
			exitCode: 1,
			stdout: "",
			stderr: "fatal: not in a git repo",
		});
		await expect(getCanonicalRepoUrl("/tmp/foo")).resolves.toBe(
			"file:///tmp/foo",
		);
	});
});

describe("deriveRepoNameFromUrl", () => {
	it("returns last path segment for https", () => {
		expect(deriveRepoNameFromUrl("https://github.com/jolliai/jolli")).toBe(
			"jolli",
		);
	});

	it("strips .git from the suggestion", () => {
		expect(deriveRepoNameFromUrl("https://github.com/jolliai/jolli.git")).toBe(
			"jolli",
		);
	});

	it("preserves case in the segment", () => {
		expect(deriveRepoNameFromUrl("https://github.com/JolliAI/Jolli")).toBe(
			"Jolli",
		);
	});

	it("falls back to host when path is empty", () => {
		expect(deriveRepoNameFromUrl("https://github.com/")).toBe("github.com");
	});

	it("returns basename for file:// urls", () => {
		expect(deriveRepoNameFromUrl("file:///tmp/foo/scratch")).toBe("scratch");
	});

	it("falls back to truncated input for file:// urls with no path segment", () => {
		expect(deriveRepoNameFromUrl("file:///")).toBe("file:///");
	});

	it("truncates unparseable input to 120 chars", () => {
		const long = "x".repeat(200);
		expect(deriveRepoNameFromUrl(long)).toHaveLength(120);
	});

	it("returns empty string on empty input", () => {
		expect(deriveRepoNameFromUrl("")).toBe("");
	});

	it("falls back to truncated input for parseable URLs with an unknown scheme", () => {
		expect(deriveRepoNameFromUrl("mailto:foo@bar.com")).toBe(
			"mailto:foo@bar.com",
		);
	});
});

describe("sanitizeBranchSlug", () => {
	it("passes a clean branch through", () => {
		expect(sanitizeBranchSlug("main")).toBe("main");
	});

	it("preserves slashes between segments", () => {
		expect(sanitizeBranchSlug("feature/foo")).toBe("feature/foo");
	});

	it("replaces unsafe characters with _", () => {
		expect(sanitizeBranchSlug("feat: oauth + sso")).toBe("feat_oauth_sso");
	});

	it("collapses runs of _", () => {
		expect(sanitizeBranchSlug("foo!!!bar")).toBe("foo_bar");
	});

	it("trims leading and trailing separators", () => {
		expect(sanitizeBranchSlug("/main/")).toBe("main");
		expect(sanitizeBranchSlug("__main__")).toBe("main");
	});

	it("returns _ for empty / undefined", () => {
		expect(sanitizeBranchSlug(undefined)).toBe("_");
		expect(sanitizeBranchSlug("")).toBe("_");
		expect(sanitizeBranchSlug("///")).toBe("_");
	});
});
