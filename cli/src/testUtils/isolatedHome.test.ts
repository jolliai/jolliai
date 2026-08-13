import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { setIsolatedHome, withIsolatedHome } from "./isolatedHome.js";

describe("setIsolatedHome", () => {
	it("redirects os.homedir() on this platform and restores the previous value", () => {
		const before = homedir();
		const restore = setIsolatedHome("/tmp/jolli-isolated-home");
		try {
			// The whole point: `HOME` alone is a no-op on Windows, so the assertion is
			// on `os.homedir()` — what `getGlobalConfigDir()` actually calls — rather
			// than on either environment variable.
			expect(homedir()).toBe("/tmp/jolli-isolated-home");
		} finally {
			restore();
		}
		expect(homedir()).toBe(before);
	});

	it("sets both HOME and USERPROFILE, since which one is read depends on the platform", () => {
		const restore = setIsolatedHome("/tmp/jolli-both");
		try {
			expect(process.env.HOME).toBe("/tmp/jolli-both");
			expect(process.env.USERPROFILE).toBe("/tmp/jolli-both");
		} finally {
			restore();
		}
	});

	it("deletes a variable that was absent rather than restoring the string 'undefined'", () => {
		const previous = process.env.USERPROFILE;
		delete process.env.USERPROFILE;
		try {
			setIsolatedHome("/tmp/jolli-absent")();
			expect("USERPROFILE" in process.env).toBe(false);
		} finally {
			if (previous !== undefined) process.env.USERPROFILE = previous;
		}
	});

	it("restores twice without reviving the isolated value", () => {
		const before = homedir();
		const restore = setIsolatedHome("/tmp/jolli-twice");
		restore();
		restore();
		expect(homedir()).toBe(before);
	});
});

/**
 * Pins the SUITE-WIDE guarantee, not the helper: `test/gitEnv.ts` applies an
 * isolated home to every test file in the monorepo, so no test can reach the
 * developer's real `~/.jolli/`, `~/.codex/config.toml`, `~/.gemini/`, … by
 * default. Without something asserting it, deleting that line from the setup
 * file breaks nothing visible — every test keeps passing, against the real home,
 * exactly as before the guard existed. That is how it got paid for twice.
 */
describe("suite-wide home isolation (test/gitEnv.ts)", () => {
	it("has redirected os.homedir() away from the real home for this test file", () => {
		expect(process.env.JOLLI_TEST_HOME).toBeTruthy();
		expect(homedir()).toBe(process.env.JOLLI_TEST_HOME);
	});

	it("resolves the machine-global config dir inside the scratch home", async () => {
		const { getGlobalConfigDir } = await import("../core/SessionTracker.js");
		expect(getGlobalConfigDir().startsWith(process.env.JOLLI_TEST_HOME as string)).toBe(true);
	});
});

describe("withIsolatedHome", () => {
	it("restores after the block resolves", async () => {
		const before = homedir();
		const seen = await withIsolatedHome("/tmp/jolli-scoped", () => homedir());
		expect(seen).toBe("/tmp/jolli-scoped");
		expect(homedir()).toBe(before);
	});

	it("restores after the block throws", async () => {
		const before = homedir();
		await expect(
			withIsolatedHome("/tmp/jolli-throws", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(homedir()).toBe(before);
	});
});
