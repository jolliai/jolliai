/**
 * SiteRunner tests
 *
 * Tests validation logic (package.json and node_modules existence).
 * Process spawning is covered by v8 ignore pragmas in the source.
 */

import { describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	spawn: vi.fn(),
	execFileSync: vi.fn(),
	open: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
	execFileSync: mocks.execFileSync,
}));
vi.mock("open", () => ({ default: mocks.open }));

import { build, dev } from "./SiteRunner.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SiteRunner", () => {
	describe("dev", () => {
		it("throws when package.json is missing", () => {
			mocks.existsSync.mockReturnValue(false);

			expect(() => dev({ targetDir: "/tmp/noproject", port: 3000, open: false })).toThrow(
				"No package.json found",
			);
		});

		it("throws when node_modules is missing", () => {
			// First call: package.json exists. Second call: node_modules does not.
			mocks.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

			expect(() => dev({ targetDir: "/tmp/nomodules", port: 3000, open: false })).toThrow(
				"No node_modules/ found",
			);
		});
	});

	describe("build", () => {
		it("throws when package.json is missing", () => {
			mocks.existsSync.mockReturnValue(false);

			expect(() => build({ targetDir: "/tmp/noproject" })).toThrow("No package.json found");
		});

		it("throws when node_modules is missing", () => {
			mocks.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

			expect(() => build({ targetDir: "/tmp/nomodules" })).toThrow("No node_modules/ found");
		});
	});
});
