/**
 * Mock-isolated tests for the two defensive fallbacks in
 * `canonicaliseLocalFolder` that a real filesystem can't reach:
 *
 *   - The trailing-separator trim (only fires if an upstream step yields a
 *     trailing `sep`; `path.resolve` strips it, so we force it via a mocked
 *     `realpathSync.native` that returns a trailing slash).
 *   - The fs-root fallback in `resolvePartialRealpath` (only fires if even
 *     `/` can't be statted, which never happens on a healthy system).
 *
 * Kept in its own file because it mocks `node:fs` wholesale, whereas the
 * sibling `VaultLockPath.test.ts` deliberately exercises the real filesystem.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// These assert canonical POSIX path strings, but the function emits the host's
// native separator and `path.resolve` prepends a drive letter on Windows — the
// simulated-platform cases can't be faithfully reproduced on a Windows host
// (real `sep`/`resolve` ignore the `process.platform` stub). They are fully
// exercised on POSIX CI, so skip on win32 rather than assert a path shape that
// only holds on POSIX. Mirrors the `skipIfWin32` pattern in other tests.
const itPosix = process.platform === "win32" ? it.skip : it;

const { mockStatSync, mockRealpathNative } = vi.hoisted(() => ({
	mockStatSync: vi.fn(),
	mockRealpathNative: vi.fn(),
}));

vi.mock("node:fs", () => {
	const realpathSync = Object.assign(vi.fn(), { native: mockRealpathNative });
	return { statSync: mockStatSync, realpathSync };
});

import { canonicaliseLocalFolder } from "./VaultLockPath.js";

describe("canonicaliseLocalFolder defensive fallbacks", () => {
	itPosix("trims a trailing separator that survives into the canonical string (step 5)", () => {
		// An existing ancestor that realpaths to a path WITH a trailing slash —
		// the regex collapse preserves the trailing sep, so the explicit trim runs.
		mockStatSync.mockReturnValue(undefined); // input segment "exists"
		mockRealpathNative.mockReturnValue("/var/data/vault/");

		const out = canonicaliseLocalFolder("/var/data/vault");
		expect(out).toBe("/var/data/vault"); // trailing slash stripped
		expect(out.endsWith("/")).toBe(false);
	});

	itPosix("returns the lexical path when no ancestor — not even root — can be statted", () => {
		// statSync throws for every segment → resolvePartialRealpath walks to the
		// filesystem root, hits parent === cur, and returns the resolved input.
		mockStatSync.mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});

		const out = canonicaliseLocalFolder("/totally/nonexistent/tree");
		expect(out).toBe("/totally/nonexistent/tree");
		expect(mockRealpathNative).not.toHaveBeenCalled(); // never found an ancestor to realpath
	});
});

describe("canonicaliseLocalFolder case-folding by platform (step 4)", () => {
	const realPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	});

	function stubPlatform(p: NodeJS.Platform): void {
		Object.defineProperty(process, "platform", { value: p, configurable: true });
		mockStatSync.mockReturnValue(undefined); // segment "exists"
		mockRealpathNative.mockImplementation((s: string) => s); // identity realpath
	}

	itPosix("preserves case on a case-sensitive filesystem (linux — neither branch of the platform check)", () => {
		stubPlatform("linux");
		expect(canonicaliseLocalFolder("/Var/Data/Vault")).toBe("/Var/Data/Vault");
	});

	itPosix("lower-cases on win32 (the first operand of the platform check)", () => {
		stubPlatform("win32");
		expect(canonicaliseLocalFolder("/Var/Data/Vault")).toBe("/var/data/vault");
	});
});
