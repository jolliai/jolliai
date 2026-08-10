import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSshAliasCacheForTests, __setSshRunnerForTests, resolveHostAlias } from "./SshAliasResolver.js";

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
