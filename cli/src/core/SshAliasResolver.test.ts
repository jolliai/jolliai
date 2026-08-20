import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__resetSshAliasCacheForTests,
	__setSshRunnerForTests,
	formatHostForUrl,
	resolveHostAlias,
	resolveHostEndpoint,
} from "./SshAliasResolver.js";

describe("SshAliasResolver", () => {
	afterEach(() => {
		// Restore the default (VITEST-guarded, no-op) runner and clear the cache.
		__setSshRunnerForTests(null);
	});

	it("resolves an alias to its configured HostName from `ssh -G` output", () => {
		__setSshRunnerForTests((host) =>
			host === "github-jolli" ? "user git\nhostname github.com\nport 22\nidentityfile ~/.ssh/id_ed25519\n" : null,
		);
		expect(resolveHostAlias("github-jolli")).toBe("github.com");
	});

	it("returns the host unchanged when the runner reports failure (ssh missing / timeout)", () => {
		__setSshRunnerForTests(() => null);
		expect(resolveHostAlias("github.com")).toBe("github.com");
	});

	it("returns the host unchanged when output has no hostname line", () => {
		__setSshRunnerForTests(() => "user git\nport 22\n");
		expect(resolveHostAlias("weird-host")).toBe("weird-host");
	});

	it("is case-insensitive on the `hostname` key and tolerates CRLF", () => {
		__setSshRunnerForTests(() => "User git\r\nHostName internal.example\r\nPort 2222\r\n");
		expect(resolveHostAlias("alias")).toBe("internal.example");
	});

	it("memoizes: the runner is invoked at most once per host", () => {
		const runner = vi.fn((host: string) => `hostname ${host === "a" ? "resolved-a" : host}\n`);
		__setSshRunnerForTests(runner as unknown as (host: string) => string | null);
		expect(resolveHostAlias("a")).toBe("resolved-a");
		expect(resolveHostAlias("a")).toBe("resolved-a");
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("returns an empty host unchanged without invoking the runner", () => {
		const runner = vi.fn(() => "hostname x\n");
		__setSshRunnerForTests(runner as unknown as (host: string) => string | null);
		expect(resolveHostAlias("")).toBe("");
		expect(runner).not.toHaveBeenCalled();
	});

	it("re-queries after the cache is cleared", () => {
		const runner = vi.fn(() => "hostname github.com\n");
		__setSshRunnerForTests(runner as unknown as (host: string) => string | null);
		expect(resolveHostAlias("gh")).toBe("github.com");
		__resetSshAliasCacheForTests();
		expect(resolveHostAlias("gh")).toBe("github.com");
		expect(runner).toHaveBeenCalledTimes(2);
	});

	it("default runner is a no-op under VITEST (hermetic): unset runner returns host unchanged", () => {
		// No runner injected → defaultSshRunner, which short-circuits under VITEST.
		__setSshRunnerForTests(null);
		expect(resolveHostAlias("github-jolli")).toBe("github-jolli");
	});
});

describe("resolveHostEndpoint", () => {
	afterEach(() => __setSshRunnerForTests(null));

	it("returns the configured HostName AND Port (Claim 1: the scp form has no port syntax, so the config Port must survive here)", () => {
		__setSshRunnerForTests((host) => (host === "corp-git" ? "hostname git.example.com\nport 2222\n" : null));
		expect(resolveHostEndpoint("corp-git")).toEqual({
			host: "git.example.com",
			port: "2222",
			endpointRemapped: false,
		});
	});

	it("reports an empty port when `ssh -G` prints no port line", () => {
		__setSshRunnerForTests(() => "hostname github.com\n");
		expect(resolveHostEndpoint("github-jolli")).toEqual({ host: "github.com", port: "", endpointRemapped: false });
	});

	it("maps a known SSH connection endpoint back to its forge host and drops the alt port (Claim 2: ssh-over-443)", () => {
		// GitHub's documented `Host github.com / HostName ssh.github.com / Port 443`.
		__setSshRunnerForTests((host) =>
			host === "github.com" ? "hostname ssh.github.com\nport 443\n" : `hostname ${host}\n`,
		);
		expect(resolveHostEndpoint("github.com")).toEqual({ host: "github.com", port: "", endpointRemapped: true });
	});

	it("maps a directly-typed endpoint host even when ssh -G is unavailable (fail-safe still canonicalizes)", () => {
		__setSshRunnerForTests(() => null);
		expect(resolveHostEndpoint("ssh.github.com")).toEqual({ host: "github.com", port: "", endpointRemapped: true });
	});

	it("leaves a genuine alias to a different host distinct, port and all", () => {
		__setSshRunnerForTests(() => "hostname gitlab.internal.example\nport 22\n");
		expect(resolveHostEndpoint("work-gitlab")).toEqual({
			host: "gitlab.internal.example",
			port: "22",
			endpointRemapped: false,
		});
	});

	it("threads the `git@` user so a `Match user …` alias resolves (bare `ssh -G host` misses it)", () => {
		// A `Match host <alias> user git` block only matches when ssh is invoked as
		// `git@<alias>`; the runner mirrors that by keying on the second `user` arg.
		__setSshRunnerForTests((host, user) =>
			host === "github-jolli" && user === "git" ? "hostname github.com\n" : `hostname ${host}\n`,
		);
		expect(resolveHostEndpoint("github-jolli", "git")).toEqual({
			host: "github.com",
			port: "",
			endpointRemapped: false,
		});
		// Same host, no user → the Match block does not fire, so it stays literal.
		expect(resolveHostEndpoint("github-jolli")).toEqual({
			host: "github-jolli",
			port: "",
			endpointRemapped: false,
		});
	});

	it("caches per user+host so a user-scoped and a bare resolution do not collide", () => {
		const runner = vi.fn((host: string, user?: string) =>
			user === "git" ? "hostname github.com\n" : `hostname ${host}\n`,
		);
		__setSshRunnerForTests(runner as unknown as (host: string, user?: string) => string | null);
		expect(resolveHostEndpoint("h", "git").host).toBe("github.com");
		expect(resolveHostEndpoint("h").host).toBe("h");
		// One call per distinct (user, host); a repeat of either is served from cache.
		expect(resolveHostEndpoint("h", "git").host).toBe("github.com");
		expect(runner).toHaveBeenCalledTimes(2);
	});
});

describe("formatHostForUrl", () => {
	it("brackets a bare IPv6 literal so it forms a valid URL authority", () => {
		expect(formatHostForUrl("2001:db8::1")).toBe("[2001:db8::1]");
		expect(formatHostForUrl("::1")).toBe("[::1]");
	});
	it("is idempotent on an already-bracketed host", () => {
		expect(formatHostForUrl("[2001:db8::1]")).toBe("[2001:db8::1]");
	});
	it("passes a normal DNS host through unchanged", () => {
		expect(formatHostForUrl("github.com")).toBe("github.com");
	});
});
