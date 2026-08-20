import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommandResult } from "../Types.js";

vi.mock("./GitOps.js", () => ({ execGit: vi.fn() }));

import { execGit } from "./GitOps.js";
import {
	buildBranchRelativePath,
	deriveOwnerRepoFromUrl,
	deriveRepoNameFromUrl,
	getCanonicalRepoUrl,
	normalizeRemoteUrl,
	sameCanonicalRemote,
	sanitizeBranchSlug,
	sharedRepoIdentityMatches,
} from "./GitRemoteUtils.js";
import { __setSshRunnerForTests } from "./SshAliasResolver.js";

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
	it("drops ssh ports (default AND non-default) from a self-hosted identity so ssh folds onto https", () => {
		// The SSH *connection* port is not the repo's HTTPS identity: an ssh clone
		// on :2222 and an https clone of the same self-hosted repo must share one
		// key (JOLLI-2135 follow-up). A non-default ssh port is therefore dropped
		// for a self-hosted host, not just the default :22.
		expect(normalizeRemoteUrl("ssh://git@host/owner/repo.git", "/ws")).toBe("https://host/owner/repo");
		expect(normalizeRemoteUrl("ssh://git@host:22/owner/repo", "/ws")).toBe("https://host/owner/repo");
		expect(normalizeRemoteUrl("ssh://git@host:2222/owner/repo", "/ws")).toBe("https://host/owner/repo");
		// …and so folds onto the https clone's key.
		expect(normalizeRemoteUrl("ssh://git@host:2222/owner/repo", "/ws")).toBe(
			normalizeRemoteUrl("https://host/owner/repo", "/ws"),
		);
	});
	it("accepted trade-off: two self-hosted repos differing ONLY by ssh port now collide", () => {
		// The cost of folding ssh→https: two DISTINCT repos reachable only via
		// different ssh gateway ports on one host collapse to one identity key.
		// The dominant real case (one repo via ssh:2222 AND https:443) wins over
		// this rare one. Pinned so the trade-off is explicit, not accidental.
		expect(normalizeRemoteUrl("ssh://git@host:2222/team/repo", "/ws")).toBe(
			normalizeRemoteUrl("ssh://git@host:2223/team/repo", "/ws"),
		);
		expect(normalizeRemoteUrl("ssh://git@host:2222/team/repo", "/ws")).toBe("https://host/team/repo");
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

describe("normalizeRemoteUrl — ~/.ssh/config Host alias resolution (JOLLI-2135)", () => {
	// Resolve a couple of well-known aliases to their configured HostName; every
	// other host echoes back unchanged, exactly like `ssh -G` on a host with no
	// matching `Host` block.
	const fakeSshConfig: Record<string, string> = {
		"github-jolli": "github.com",
		"work-gitlab": "gitlab.internal.example",
	};
	beforeEach(() => __setSshRunnerForTests((host) => `hostname ${fakeSshConfig[host] ?? host}\n`));
	afterEach(() => __setSshRunnerForTests(null));

	it("folds an scp-form alias clone onto the same key as a direct github.com clone", () => {
		// The whole bug: an alias clone must land on the canonical key, including
		// the case-insensitive path fold that only fires once the host is github.com.
		expect(normalizeRemoteUrl("git@github-jolli:Owner/Repo.git", "/ws")).toBe(
			normalizeRemoteUrl("git@github.com:Owner/Repo.git", "/ws"),
		);
		expect(normalizeRemoteUrl("git@github-jolli:Owner/Repo.git", "/ws")).toBe("https://github.com/owner/repo");
	});

	it("folds an ssh:// URL alias clone onto the canonical host too", () => {
		expect(normalizeRemoteUrl("ssh://git@github-jolli/Owner/Repo.git", "/ws")).toBe(
			"https://github.com/owner/repo",
		);
	});

	it("keeps an alias that resolves to a genuinely different host distinct (no false collapsing)", () => {
		// work-gitlab → gitlab.internal.example: a real, different repo. The host
		// is NOT case-insensitive, so the path case is preserved.
		expect(normalizeRemoteUrl("git@work-gitlab:Owner/Repo.git", "/ws")).toBe(
			"https://gitlab.internal.example/Owner/Repo",
		);
	});

	it("leaves an unknown alias unchanged (fallback: literal host, current behavior)", () => {
		expect(normalizeRemoteUrl("git@unknown-alias:Owner/Repo.git", "/ws")).toBe("https://unknown-alias/Owner/Repo");
	});
});

describe("normalizeRemoteUrl — endpoint & port canonicalization (JOLLI-2135 follow-ups)", () => {
	afterEach(() => __setSshRunnerForTests(null));

	it("Claim 2: an ssh-over-443 github.com clone still folds onto the https key", () => {
		// `Host github.com / HostName ssh.github.com / Port 443` — ssh.github.com is
		// a connection endpoint, NOT the repo's identity host. It must map back to
		// github.com so the SSH clone and an https clone share one key.
		__setSshRunnerForTests((host) =>
			host === "github.com" ? "hostname ssh.github.com\nport 443\n" : `hostname ${host}\n`,
		);
		expect(normalizeRemoteUrl("git@github.com:Owner/Repo.git", "/ws")).toBe("https://github.com/owner/repo");
		expect(normalizeRemoteUrl("ssh://git@github.com/Owner/Repo.git", "/ws")).toBe("https://github.com/owner/repo");
	});

	it("Claim 1 (revised): scp alias Port, direct ssh://:2222, and the https clone all collapse to one portless self-hosted key", () => {
		__setSshRunnerForTests((host) =>
			host === "corp-git" ? "hostname git.example.com\nport 2222\n" : "hostname git.example.com\nport 22\n",
		);
		// An ssh config `Port 2222` is a CONNECTION coordinate, not the repo's
		// HTTPS identity. All three clone shapes of the one self-hosted repo must
		// therefore fold to the same portless key (JOLLI-2135 follow-up — the
		// earlier behaviour carried :2222 into the key and split the https clone).
		const key = "https://git.example.com/team/repo";
		expect(normalizeRemoteUrl("git@corp-git:team/repo.git", "/ws")).toBe(key);
		expect(normalizeRemoteUrl("ssh://git@git.example.com:2222/team/repo.git", "/ws")).toBe(key);
		expect(normalizeRemoteUrl("https://git.example.com/team/repo", "/ws")).toBe(key);
	});

	it("Claim 3: git:// is the Git protocol, never ssh — its host is not resolved through ~/.ssh/config", () => {
		__setSshRunnerForTests((host) =>
			host === "gitproto-host" ? "hostname elsewhere.example\n" : `hostname ${host}\n`,
		);
		expect(normalizeRemoteUrl("git://gitproto-host/owner/repo", "/ws")).toBe("https://gitproto-host/owner/repo");
	});

	it("drops an EXPLICIT alt port on an ssh-over-443 endpoint so it still folds onto the https key", () => {
		// `ssh://git@ssh.github.com:443/…` — ssh.github.com is a connection endpoint,
		// and the :443 is the endpoint's, not the identity's. It must be dropped, or
		// the clone splits from `https://github.com/owner/repo`.
		__setSshRunnerForTests((host) => `hostname ${host}\n`);
		expect(normalizeRemoteUrl("ssh://git@ssh.github.com:443/Owner/Repo.git", "/ws")).toBe(
			"https://github.com/owner/repo",
		);
		expect(normalizeRemoteUrl("ssh://git@ssh.github.com:443/Owner/Repo.git", "/ws")).toBe(
			normalizeRemoteUrl("https://github.com/Owner/Repo.git", "/ws"),
		);
	});

	it("threads the git@ user so a `Match user …` alias folds (scp and ssh:// both)", () => {
		// The alias resolves ONLY when ssh is invoked as `git@github-jolli`.
		__setSshRunnerForTests((host, user) =>
			host === "github-jolli" && user === "git" ? "hostname github.com\n" : `hostname ${host}\n`,
		);
		expect(normalizeRemoteUrl("git@github-jolli:Owner/Repo.git", "/ws")).toBe("https://github.com/owner/repo");
		expect(normalizeRemoteUrl("ssh://git@github-jolli/Owner/Repo.git", "/ws")).toBe(
			"https://github.com/owner/repo",
		);
	});

	it("brackets an IPv6 HostName so the canonical URL is valid (scp and ssh:// both)", () => {
		// `ssh -G` reports an IPv6 HostName without brackets; the output must wrap it.
		__setSshRunnerForTests((host) => (host === "v6-alias" ? "hostname 2001:db8::1\n" : `hostname ${host}\n`));
		expect(normalizeRemoteUrl("git@v6-alias:Owner/Repo.git", "/ws")).toBe("https://[2001:db8::1]/Owner/Repo");
		expect(normalizeRemoteUrl("ssh://git@v6-alias/Owner/Repo.git", "/ws")).toBe("https://[2001:db8::1]/Owner/Repo");
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

describe("sameCanonicalRemote", () => {
	it("matches raw-vs-normalized forms of the same repo (.git suffix, scp form)", () => {
		expect(sameCanonicalRemote("https://github.com/acme/widgets.git", "https://github.com/acme/widgets")).toBe(
			true,
		);
		expect(sameCanonicalRemote("git@github.com:acme/widgets.git", "https://github.com/acme/widgets")).toBe(true);
	});

	it("does not match two distinct repos", () => {
		expect(sameCanonicalRemote("https://github.com/acme/widgets", "https://github.com/acme/gadgets")).toBe(false);
	});

	it("does NOT collapse two distinct unparseable remotes into a match via the file:/// sentinel", () => {
		// Both normalize to the empty-fallback `file:///` sentinel; treating that as equal
		// would ingest a share into the wrong local repo. It must stay a non-match.
		expect(sameCanonicalRemote("not-a-url", "also-not-a-url")).toBe(false);
		expect(sameCanonicalRemote("", "")).toBe(false);
	});

	it("still matches two real file:// remotes with the same path", () => {
		expect(sameCanonicalRemote("file:///home/x/repo", "file:///home/x/repo")).toBe(true);
	});

	it("still matches an IDENTICAL bare local-path remote (preserves pre-canonical === behavior)", () => {
		// A bare path is unparseable → the `file:///` sentinel; identical raw strings must
		// still match so a local-path remote isn't newly dropped by the canonical compare.
		expect(sameCanonicalRemote("/srv/git/foo.git", "/srv/git/foo.git")).toBe(true);
	});

	it("does NOT match two DIFFERENT bare local-path remotes (both hit the sentinel)", () => {
		expect(sameCanonicalRemote("/srv/git/foo.git", "/srv/git/bar.git")).toBe(false);
	});
});

describe("sharedRepoIdentityMatches", () => {
	it("matches by canonical remote when both sides carry a URL (raw .git vs normalized)", () => {
		expect(
			sharedRepoIdentityMatches(
				"acmewidgets",
				"https://github.com/acme/widgets",
				"widgets",
				"https://github.com/acme/widgets.git",
			),
		).toBe(true);
	});

	it("rejects a name match when both sides have a URL but the remotes differ", () => {
		expect(
			sharedRepoIdentityMatches(
				"widgets",
				"https://github.com/acme/widgets",
				"widgets",
				"https://github.com/other/widgets",
			),
		).toBe(false);
	});

	it("reconstructs owner/repo from the candidate remote for a public-tier share (URL withheld)", () => {
		// Public tier: shareRepoUrl is null, but the candidate still knows its own remote.
		// Backend stored sanitize("acme/widgets") = "acmewidgets"; the bank keeps bare "widgets".
		expect(sharedRepoIdentityMatches("acmewidgets", null, "widgets", "https://github.com/acme/widgets.git")).toBe(
			true,
		);
	});

	it("matches a public-tier share case-insensitively (Acme/Widgets vs acme/widgets)", () => {
		// GitHub owner/repo is case-insensitive; the two users' remotes differ only in case.
		expect(sharedRepoIdentityMatches("AcmeWidgets", null, "widgets", "https://github.com/acme/widgets.git")).toBe(
			true,
		);
	});

	it("preserves the owner dimension — a shared basename under a different owner does not match", () => {
		expect(sharedRepoIdentityMatches("acmewidgets", null, "widgets", "https://github.com/other/widgets.git")).toBe(
			false,
		);
	});

	it("falls back to a bare-name compare when neither side has a remote", () => {
		expect(sharedRepoIdentityMatches("widgets", null, "widgets", null)).toBe(true);
		expect(sharedRepoIdentityMatches("widgets", null, "gadgets", null)).toBe(false);
	});

	it("does not match a public-tier share when the candidate has no owner segment and the name differs", () => {
		expect(sharedRepoIdentityMatches("acmewidgets", null, "widgets", "https://example.com/widgets")).toBe(false);
	});
});
