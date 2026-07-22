/**
 * UninstallCommand tests.
 *
 * The scan, hook-strip (`uninstall`), and filesystem `rm` are all mocked so the
 * command's own logic — scope filtering, inventory rendering, interactive
 * selection, confirmation gates, and per-item outcome reporting — is exercised
 * deterministically without touching the real machine.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemovableItem, UninstallInventory } from "../install/UninstallScan.js";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
	mockScan,
	mockPrune,
	mockUninstall,
	mockRm,
	mockIsInteractive,
	mockPromptText,
	mockTrack,
	mockCreateStorage,
	mockSetActiveStorage,
} = vi.hoisted(() => ({
	mockScan: vi.fn(),
	mockPrune: vi.fn(),
	mockUninstall: vi.fn(),
	mockRm: vi.fn(),
	mockIsInteractive: vi.fn(),
	mockPromptText: vi.fn(),
	mockTrack: vi.fn(),
	mockCreateStorage: vi.fn(),
	mockSetActiveStorage: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ rm: mockRm }));

vi.mock("../core/StorageFactory.js", () => ({ createStorage: mockCreateStorage }));

vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: mockSetActiveStorage }));

vi.mock("../install/UninstallScan.js", () => ({
	scanUninstallInventory: mockScan,
	pruneVscodeExtensionManifest: mockPrune,
}));

vi.mock("../install/Installer.js", () => ({ uninstall: mockUninstall }));

vi.mock("../core/Telemetry.js", () => ({ track: mockTrack }));

vi.mock("./CliUtils.js", () => ({
	isInteractive: mockIsInteractive,
	promptText: mockPromptText,
	resolveProjectDir: () => "/repo",
}));

import { parseSelection, registerUninstallCommand } from "./UninstallCommand.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function item(over: Partial<RemovableItem>): RemovableItem {
	return {
		surface: "global-config",
		label: "Item",
		path: "/tmp/item",
		kind: "dir",
		...over,
	};
}

function inventory(items: RemovableItem[]): UninstallInventory {
	return { items, preserved: ["orphan branch", "Memory Bank"] };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

/** Runs `jolli uninstall <args>` and returns captured stdout+stderr. */
async function run(args: string[]): Promise<{ out: string; err: string }> {
	const program = new Command();
	program.exitOverride();
	registerUninstallCommand(program);
	await program.parseAsync(["node", "jolli", "uninstall", ...args]);
	const out = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
	const err = errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
	return { out, err };
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	mockRm.mockResolvedValue(undefined);
	mockPrune.mockResolvedValue(undefined);
	mockUninstall.mockResolvedValue({ success: true, message: "ok", warnings: [] });
	mockIsInteractive.mockReturnValue(true);
	mockCreateStorage.mockResolvedValue({ tag: "fake-storage" });
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
});

// ─── parseSelection ───────────────────────────────────────────────────────────

describe("parseSelection", () => {
	it("returns null for an empty answer", () => {
		expect(parseSelection("", 3)).toBeNull();
		expect(parseSelection("   ", 3)).toBeNull();
	});

	it("selects everything for 'a' or 'all'", () => {
		expect(parseSelection("a", 3)).toEqual(new Set([1, 2, 3]));
		expect(parseSelection("all", 2)).toEqual(new Set([1, 2]));
	});

	it("parses comma- and space-separated indices", () => {
		expect(parseSelection("1, 3", 3)).toEqual(new Set([1, 3]));
		expect(parseSelection("2 3", 3)).toEqual(new Set([2, 3]));
	});

	it("skips empty tokens from a leading separator", () => {
		expect(parseSelection(",1", 3)).toEqual(new Set([1]));
	});

	it("ignores out-of-range and non-numeric tokens", () => {
		expect(parseSelection("0 2 9 foo", 3)).toEqual(new Set([2]));
	});

	it("returns null when no valid index is present", () => {
		expect(parseSelection("0 9 foo", 3)).toBeNull();
	});
});

// ─── storage backend ──────────────────────────────────────────────────────────

describe("uninstall — storage backend", () => {
	it("establishes the configured backend before scanning", async () => {
		mockScan.mockResolvedValue(inventory([]));
		await run(["--yes"]);
		// Backend must be set before the scan reads the summary count, else the read
		// falls through to the orphan-branch fallback and logs a spurious warning.
		expect(mockCreateStorage).toHaveBeenCalledWith("/repo", "/repo");
		expect(mockSetActiveStorage).toHaveBeenCalledWith({ tag: "fake-storage" });
		const setOrder = mockSetActiveStorage.mock.invocationCallOrder[0];
		const scanOrder = mockScan.mock.invocationCallOrder[0];
		expect(setOrder).toBeLessThan(scanOrder);
	});

	it("proceeds when the backend cannot be established (non-fatal)", async () => {
		mockCreateStorage.mockRejectedValue(new Error("no repo"));
		mockScan.mockResolvedValue(inventory([]));
		const { out } = await run(["--yes"]);
		expect(mockSetActiveStorage).not.toHaveBeenCalled();
		expect(out).toContain("No Jolli installation or configuration found");
	});
});

// ─── empty inventory ──────────────────────────────────────────────────────────

describe("uninstall — nothing found", () => {
	it("reports an empty scope and removes nothing", async () => {
		mockScan.mockResolvedValue(inventory([]));
		const { out } = await run(["--yes"]);
		expect(out).toContain("No Jolli installation or configuration found");
		expect(mockRm).not.toHaveBeenCalled();
	});
});

// ─── dry-run ──────────────────────────────────────────────────────────────────

describe("uninstall — dry run", () => {
	it("lists items with and without detail but deletes nothing", async () => {
		mockScan.mockResolvedValue(
			inventory([
				item({ surface: "vscode-extension", label: "Ext", path: "/e", detail: "v1" }),
				item({ surface: "global-config", label: "Cfg", path: "/c" }),
			]),
		);
		const { out } = await run(["--dry-run"]);
		expect(out).toContain("(v1)");
		expect(out).toContain("[dry-run] Would remove 2 items");
		expect(mockRm).not.toHaveBeenCalled();
	});
});

// ─── scope filtering ──────────────────────────────────────────────────────────

describe("uninstall — scope", () => {
	const mixed = () =>
		inventory([
			item({ surface: "vscode-extension", label: "Ext", path: "/e" }),
			item({ surface: "project-config", label: "Proj", path: "/p" }),
		]);

	it("shows only global surfaces with --scope global", async () => {
		mockScan.mockResolvedValue(mixed());
		const { out } = await run(["--scope", "global", "--dry-run"]);
		expect(out).toContain("Ext");
		expect(out).not.toContain("Proj");
		expect(out).toContain("Would remove 1 item");
	});

	it("shows only project surfaces with --scope project", async () => {
		mockScan.mockResolvedValue(mixed());
		const { out } = await run(["--scope", "project", "--dry-run"]);
		expect(out).toContain("Proj");
		expect(out).not.toContain("Ext");
	});

	it("rejects an invalid scope", async () => {
		mockScan.mockResolvedValue(mixed());
		const { err } = await run(["--scope", "bogus"]);
		expect(err).toContain("Invalid --scope");
		expect(process.exitCode).toBe(1);
		expect(mockScan).not.toHaveBeenCalled();
	});
});

// ─── non-interactive guard ────────────────────────────────────────────────────

describe("uninstall — non-interactive", () => {
	it("refuses to delete without --yes when stdin is not a TTY", async () => {
		mockIsInteractive.mockReturnValue(false);
		mockScan.mockResolvedValue(inventory([item({ path: "/x" })]));
		const { err } = await run([]);
		expect(err).toContain("Refusing to delete in non-interactive mode");
		expect(process.exitCode).toBe(1);
		expect(mockRm).not.toHaveBeenCalled();
	});
});

// ─── --yes removes everything ─────────────────────────────────────────────────

describe("uninstall — --yes", () => {
	it("removes all items and dispatches hooks to uninstall()", async () => {
		mockScan.mockResolvedValue(
			inventory([
				item({ surface: "global-config", label: "Cfg", path: "/c", kind: "dir" }),
				item({ surface: "repo-hooks", label: "Hooks", path: "/repo", kind: "hooks" }),
			]),
		);
		const { out } = await run(["--yes"]);
		expect(mockRm).toHaveBeenCalledWith("/c", { recursive: true, force: true });
		expect(mockUninstall).toHaveBeenCalledWith("/repo");
		expect(out).toContain("Removed 2 items");
		expect(mockTrack).toHaveBeenCalledWith("surface_disabled", { reason: "uninstall" });
		// Removing the global config warns that other repos' hooks will break.
		expect(out).toContain("global config was removed");
		// Non-extension items must not trigger manifest reconciliation.
		expect(mockPrune).not.toHaveBeenCalled();
	});

	it("notes Windows self-deletion when the global CLI is removed on win32", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			mockScan.mockResolvedValue(
				inventory([item({ surface: "cli-global", label: "CLI", path: "/cli", kind: "dir" })]),
			);
			const { out } = await run(["--yes"]);
			expect(out).toContain("global CLI removed itself");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("reconciles the VS Code manifest after deleting an extension folder", async () => {
		mockScan.mockResolvedValue(
			inventory([item({ surface: "vscode-extension", label: "Ext", path: "/ext/jolli.x-1.0.0", kind: "dir" })]),
		);
		const { out } = await run(["--yes"]);
		expect(mockRm).toHaveBeenCalledWith("/ext/jolli.x-1.0.0", { recursive: true, force: true });
		expect(mockPrune).toHaveBeenCalledWith("/ext/jolli.x-1.0.0");
		expect(out).toContain("restart any open VS Code");
	});
});

// ─── interactive selection ────────────────────────────────────────────────────

describe("uninstall — interactive", () => {
	beforeEach(() => {
		mockScan.mockResolvedValue(
			inventory([item({ label: "One", path: "/one" }), item({ label: "Two", path: "/two" })]),
		);
	});

	it("removes only the selected item after confirmation", async () => {
		mockPromptText.mockResolvedValueOnce("1").mockResolvedValueOnce("y");
		const { out } = await run([]);
		expect(mockRm).toHaveBeenCalledTimes(1);
		expect(mockRm).toHaveBeenCalledWith("/one", expect.anything());
		expect(out).toContain("Removed 1 item");
	});

	it("cancels when the selection answer is empty", async () => {
		mockPromptText.mockResolvedValueOnce("");
		const { out } = await run([]);
		expect(out).toContain("Cancelled. Nothing was removed");
		expect(mockRm).not.toHaveBeenCalled();
	});

	it("aborts when the confirmation is declined", async () => {
		mockPromptText.mockResolvedValueOnce("a").mockResolvedValueOnce("n");
		const { out } = await run([]);
		expect(out).toContain("Aborted. Nothing was removed");
		expect(mockRm).not.toHaveBeenCalled();
	});
});

// ─── failure reporting ────────────────────────────────────────────────────────

describe("uninstall — failures", () => {
	it("reports a filesystem removal error and sets a non-zero exit code", async () => {
		mockScan.mockResolvedValue(inventory([item({ label: "Bad", path: "/bad" })]));
		mockRm.mockRejectedValueOnce(new Error("EACCES: permission denied"));
		const { err } = await run(["--yes"]);
		expect(err).toContain("could not be removed");
		expect(err).toContain("EACCES");
		expect(process.exitCode).toBe(1);
		// Nothing was actually removed — no disable event should be recorded.
		expect(mockTrack).not.toHaveBeenCalled();
	});

	it("pluralizes when more than one item fails", async () => {
		mockScan.mockResolvedValue(inventory([item({ label: "A", path: "/a" }), item({ label: "B", path: "/b" })]));
		mockRm.mockRejectedValue(new Error("EACCES"));
		const { err } = await run(["--yes"]);
		expect(err).toContain("2 items could not be removed");
		expect(process.exitCode).toBe(1);
	});

	it("reports a failed hook strip via uninstall()", async () => {
		mockScan.mockResolvedValue(
			inventory([item({ surface: "repo-hooks", label: "Hooks", path: "/repo", kind: "hooks" })]),
		);
		mockUninstall.mockResolvedValueOnce({ success: false, message: "hook removal failed", warnings: [] });
		const { err } = await run(["--yes"]);
		expect(err).toContain("hook removal failed");
		expect(process.exitCode).toBe(1);
	});
});
