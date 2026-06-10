/**
 * Mock-isolated tests for the non-ENOENT lstat-error rethrow in both
 * `assertNoSymlinksInPath` (async) and `assertNoSymlinksInPathSync`. A real
 * filesystem can't reliably produce a non-ENOENT lstat failure (EACCES needs
 * a 0-perm parent dir, which CI-as-root bypasses), so we mock the lstat calls
 * to throw EACCES and assert the guard surfaces it rather than swallowing it.
 *
 * Separate from `VaultSymlinkGuard.test.ts`, which exercises the real fs.
 */

import { describe, expect, it, vi } from "vitest";

const { mockLstat, mockLstatSync } = vi.hoisted(() => ({
	mockLstat: vi.fn(),
	mockLstatSync: vi.fn(),
}));

vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	return { ...actual, lstat: mockLstat };
});

vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return { ...actual, lstatSync: mockLstatSync };
});

import { assertNoSymlinksInPath, assertNoSymlinksInPathSync } from "./VaultSymlinkGuard.js";

const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

describe("VaultSymlinkGuard rethrows non-ENOENT lstat errors", () => {
	it("async: surfaces a non-ENOENT lstat error instead of treating it as a clean chain", async () => {
		mockLstat.mockRejectedValue(eacces());
		await expect(assertNoSymlinksInPath("/vault", "/vault/repo/.jolli/x.json")).rejects.toThrow(/EACCES/);
	});

	it("sync: surfaces a non-ENOENT lstatSync error instead of treating it as a clean chain", () => {
		mockLstatSync.mockImplementation(() => {
			throw eacces();
		});
		expect(() => assertNoSymlinksInPathSync("/vault", "/vault/repo/.jolli/x.json")).toThrow(/EACCES/);
	});
});
