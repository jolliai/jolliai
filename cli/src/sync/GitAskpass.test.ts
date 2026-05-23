/**
 * Tests for GitAskpass — POSIX/Windows askpass shim with env-based token.
 *
 * Verifies:
 *  - script written to disk on first call, idempotent on second
 *  - mode 0700 on POSIX
 *  - env contains GIT_ASKPASS, GIT_TERMINAL_PROMPT=0, JOLLI_SYNC_GIT_TOKEN
 *  - argv would NOT contain the token (we don't construct argv here — just
 *    assert that the env-based contract is the only carrier of the secret)
 *  - drift detection: a mismatched script is overwritten
 */

import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir, mockPlatform } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
	mockPlatform: { value: "linux" as NodeJS.Platform },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: () => mockHomeDir.value,
		platform: () => mockPlatform.value,
	};
});

import { ASKPASS_ENV_VAR, getAskpassScriptPath, prepareAskpass } from "./GitAskpass.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "askpass-"));
	mockHomeDir.value = tempDir;
	mockPlatform.value = "linux";
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("getAskpassScriptPath", () => {
	it("returns the .sh path on POSIX", () => {
		mockPlatform.value = "linux";
		expect(getAskpassScriptPath()).toBe(join(tempDir, ".jolli", "jollimemory", "askpass", "git-askpass.sh"));
	});

	it("returns the .cmd path on Windows", () => {
		mockPlatform.value = "win32";
		expect(getAskpassScriptPath()).toBe(join(tempDir, ".jolli", "jollimemory", "askpass", "git-askpass.cmd"));
	});
});

describe("prepareAskpass — POSIX", () => {
	beforeEach(() => {
		mockPlatform.value = "linux";
	});

	it("writes the script and sets mode 0700 on first call", async () => {
		const handle = await prepareAskpass("ghs_abc");
		const fileStat = await stat(handle.scriptPath);
		expect(fileStat.isFile()).toBe(true);
		expect(fileStat.mode & 0o777).toBe(0o700);
	});

	it("body uses the JOLLI_SYNC_GIT_TOKEN env var, not stdin", async () => {
		const handle = await prepareAskpass("ghs_abc");
		const body = await readFile(handle.scriptPath, "utf-8");
		// Expect a shebang and a printf reading from the env var.
		expect(body).toMatch(/^#!\/usr\/bin\/env sh/);
		expect(body).toContain(`$${ASKPASS_ENV_VAR}`);
		// Must not read from stdin (no `read` builtin).
		expect(body).not.toMatch(/\bread\b/);
	});

	it("returns env with GIT_ASKPASS, GIT_TERMINAL_PROMPT=0, and the token", async () => {
		const handle = await prepareAskpass("ghs_abc");
		expect(handle.env.GIT_ASKPASS).toBe(handle.scriptPath);
		expect(handle.env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(handle.env[ASKPASS_ENV_VAR]).toBe("ghs_abc");
	});

	it("passes through allowlisted env vars (PATH, HOME, locale) so git can find ssh/config/helpers", async () => {
		const handle = await prepareAskpass("ghs_abc");
		expect(handle.env.PATH).toBe(process.env.PATH);
		if (process.env.HOME !== undefined) expect(handle.env.HOME).toBe(process.env.HOME);
	});

	it("drops host secrets — ANTHROPIC_API_KEY / JOLLI_API_KEY / GITHUB_TOKEN never reach git children", async () => {
		const saved = {
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
			JOLLI_API_KEY: process.env.JOLLI_API_KEY,
			GITHUB_TOKEN: process.env.GITHUB_TOKEN,
			AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
		};
		process.env.ANTHROPIC_API_KEY = "sk-ant-leak-me";
		process.env.JOLLI_API_KEY = "sk-jol-leak-me";
		process.env.GITHUB_TOKEN = "ghp_leak_me";
		process.env.AWS_SECRET_ACCESS_KEY = "aws-leak-me";
		try {
			const handle = await prepareAskpass("ghs_abc");
			expect(handle.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(handle.env.JOLLI_API_KEY).toBeUndefined();
			expect(handle.env.GITHUB_TOKEN).toBeUndefined();
			expect(handle.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
			// The token we explicitly want git to see is still present.
			expect(handle.env[ASKPASS_ENV_VAR]).toBe("ghs_abc");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("passes through GIT_* prefixed vars so user-set git env keeps working", async () => {
		const saved = process.env.GIT_SSL_NO_VERIFY;
		process.env.GIT_SSL_NO_VERIFY = "true";
		try {
			const handle = await prepareAskpass("ghs_abc");
			expect(handle.env.GIT_SSL_NO_VERIFY).toBe("true");
		} finally {
			if (saved === undefined) delete process.env.GIT_SSL_NO_VERIFY;
			else process.env.GIT_SSL_NO_VERIFY = saved;
		}
	});

	it("drops GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE — they would silently retarget the sync at the wrong repo", async () => {
		const saved = {
			GIT_DIR: process.env.GIT_DIR,
			GIT_WORK_TREE: process.env.GIT_WORK_TREE,
			GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
		};
		process.env.GIT_DIR = "/tmp/some-other-repo/.git";
		process.env.GIT_WORK_TREE = "/tmp/some-other-repo";
		process.env.GIT_INDEX_FILE = "/tmp/some-other-repo/.git/index";
		try {
			const handle = await prepareAskpass("ghs_abc");
			expect(handle.env.GIT_DIR).toBeUndefined();
			expect(handle.env.GIT_WORK_TREE).toBeUndefined();
			expect(handle.env.GIT_INDEX_FILE).toBeUndefined();
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("passes through proxy + TLS CA env vars so corporate-proxy users keep working", async () => {
		const saved = {
			HTTPS_PROXY: process.env.HTTPS_PROXY,
			NO_PROXY: process.env.NO_PROXY,
			NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
		};
		process.env.HTTPS_PROXY = "http://proxy.corp:8080";
		process.env.NO_PROXY = "localhost,127.0.0.1";
		process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/corp-ca.pem";
		try {
			const handle = await prepareAskpass("ghs_abc");
			expect(handle.env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
			expect(handle.env.NO_PROXY).toBe("localhost,127.0.0.1");
			expect(handle.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("token never appears in scriptPath (no argv contamination)", async () => {
		const handle = await prepareAskpass("ghs_secret-1234567890");
		expect(handle.scriptPath).not.toContain("ghs_secret");
	});

	it("is idempotent — second call with matching content does not rewrite", async () => {
		const first = await prepareAskpass("ghs_abc");
		const firstMtime = (await stat(first.scriptPath)).mtimeMs;

		// Wait a beat so a rewrite would produce a different mtime.
		await new Promise((r) => setTimeout(r, 20));

		const second = await prepareAskpass("ghs_xyz");
		const secondMtime = (await stat(second.scriptPath)).mtimeMs;

		expect(secondMtime).toBe(firstMtime);
		// Even though the script wasn't rewritten, the env carries the new token.
		expect(second.env[ASKPASS_ENV_VAR]).toBe("ghs_xyz");
	});

	it("rewrites the script when on-disk content drifts from expected", async () => {
		const handle = await prepareAskpass("ghs_abc");
		await writeFile(handle.scriptPath, "#!/bin/sh\necho stale\n");

		await prepareAskpass("ghs_xyz");

		const body = await readFile(handle.scriptPath, "utf-8");
		expect(body).toContain(`$${ASKPASS_ENV_VAR}`);
		expect(body).not.toContain("echo stale");
	});

	it("created script is executable by the running process", async () => {
		// Linux only — we shell out to sh and check that the script actually
		// emits the token from env. Skipped on Windows.
		if (process.platform === "win32") return;
		const handle = await prepareAskpass("ghs_verify-12345");
		const out = execSync(handle.scriptPath, {
			env: { ...handle.env },
			encoding: "utf-8",
		}).trim();
		expect(out).toBe("ghs_verify-12345");
	});
});

describe("prepareAskpass — Windows", () => {
	beforeEach(() => {
		mockPlatform.value = "win32";
	});

	it("writes a .cmd shim using @echo off + env var", async () => {
		const handle = await prepareAskpass("ghs_abc");
		expect(handle.scriptPath).toMatch(/git-askpass\.cmd$/);
		const body = await readFile(handle.scriptPath, "utf-8");
		expect(body).toMatch(/^@echo off/);
		expect(body).toContain(`%${ASKPASS_ENV_VAR}%`);
	});

	it("does not call chmod on Windows (no throw on missing chmod support)", async () => {
		// Just assert the function completes — chmod is a no-op on Windows
		// and we don't want the production code to crash if it ever ran on
		// a Windows runner.
		const handle = await prepareAskpass("ghs_abc");
		expect(handle.env[ASKPASS_ENV_VAR]).toBe("ghs_abc");
	});
});
