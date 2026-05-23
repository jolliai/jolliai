import { beforeEach, describe, expect, it, vi } from "vitest";

const { item, createStatusBarItem, ThemeColor } = vi.hoisted(() => {
	const item = {
		command: undefined as string | undefined,
		tooltip: undefined as string | undefined,
		text: "",
		backgroundColor: undefined as unknown,
		color: undefined as unknown,
		show: vi.fn(),
		dispose: vi.fn(),
	};
	const createStatusBarItem = vi.fn(() => item);
	class ThemeColor {
		readonly id: string;
		constructor(id: string) {
			this.id = id;
		}
	}
	return { item, createStatusBarItem, ThemeColor };
});

vi.mock("vscode", () => ({
	StatusBarAlignment: { Left: 1 },
	ThemeColor,
	window: {
		createStatusBarItem,
	},
}));

import { StatusBarManager } from "./StatusBarManager.js";

describe("StatusBarManager", () => {
	beforeEach(() => {
		item.command = undefined;
		item.tooltip = undefined;
		item.text = "";
		item.backgroundColor = undefined;
		item.color = undefined;
		item.show.mockClear();
		item.dispose.mockClear();
		createStatusBarItem.mockClear();
	});

	it("creates and shows the status bar item on construction", () => {
		new StatusBarManager();

		expect(createStatusBarItem).toHaveBeenCalledWith(1, 100);
		expect(item.command).toBe("jollimemory.focusSidebar");
		expect(item.tooltip).toBe("Jolli Memory — click to open sidebar");
		expect(item.show).toHaveBeenCalled();
	});

	it("renders disabled and enabled states", () => {
		const manager = new StatusBarManager();

		manager.update(false);
		expect(item.text).toBe("$(circle-outline) Jolli Memory (disabled)");
		expect((item.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);

		manager.update(true);
		expect(item.text).toBe("Jolli Memory");
		expect(item.backgroundColor).toBeUndefined();
		expect(item.color).toBeUndefined();
	});

	it("disposes the underlying item", () => {
		const manager = new StatusBarManager();

		manager.dispose();
		expect(item.dispose).toHaveBeenCalled();
	});

	describe("setSyncState — sync visuals", () => {
		it("synced → check icon, no warning bg", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("synced");
			expect(item.text).toBe("$(check) Jolli Memory");
			expect(item.backgroundColor).toBeUndefined();
		});

		it("syncing → sync-spin icon, no warning bg", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("syncing");
			expect(item.text).toBe("$(sync~spin) Syncing…");
			expect(item.backgroundColor).toBeUndefined();
		});

		it("conflicts with N → 'N conflicts' + warning bg", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("conflicts", { conflictCount: 3 });
			expect(item.text).toBe("$(warning) 3 conflicts");
			expect((item.backgroundColor as { id: string }).id).toBe(
				"statusBarItem.warningBackground",
			);
		});

		it("conflicts with N=1 uses singular form", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("conflicts", { conflictCount: 1 });
			expect(item.text).toBe("$(warning) 1 conflict");
		});

		it("conflicts with no detail or count=0 shows 'Conflicts' without number", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("conflicts");
			expect(item.text).toBe("$(warning) Conflicts");

			manager.setSyncState("conflicts", { conflictCount: 0 });
			expect(item.text).toBe("$(warning) Conflicts");
		});

		it("offline without failed flag falls back to neutral 'Jolli Memory' (transient hiccup, no alarm)", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("offline");
			expect(item.text).toBe("Jolli Memory");
			expect(item.backgroundColor).toBeUndefined();
			expect(item.tooltip).toBe("Jolli Memory — click to open sidebar");
		});

		it("offline + lastError but no failed flag → still neutral (network blip suppressed)", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("offline", { lastError: "ECONNREFUSED" });
			expect(item.text).toBe("Jolli Memory");
			expect(item.backgroundColor).toBeUndefined();
		});

		it("offline + failed + failedCode → 'Sync failed' + errorBackground (terminal failure visual)", () => {
			// `failedCode` is required alongside `failed` — the bar uses the
			// code to pick its specific visual via `terminalCodeVisual`.
			// Without a code the bar safely falls back to the neutral legacy
			// "Jolli Memory" text (see "offline without failedCode" test).
			const manager = new StatusBarManager();
			manager.setSyncState("offline", {
				failed: true,
				failedCode: "sync_failed_after_retries",
				lastError: "push exhausted 3 attempts: remote: Repository not found.",
			});
			expect(item.text).toBe("$(error) Sync failed");
			expect((item.backgroundColor as { id: string }).id).toBe(
				"statusBarItem.errorBackground",
			);
			expect(item.tooltip).toContain("Memory Bank sync failed");
			expect(item.tooltip).toContain("Error: push exhausted");
		});

		it("offline + failedCode=vault_locked → 'Personal Space busy' + warningBackground (recoverable)", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("offline", {
				failed: true,
				failedCode: "vault_locked",
				lastError: "Personal Space is being synced by another device",
			});
			expect(item.text).toBe("$(error) Personal Space busy");
			// warning, not error — user can retry once the other device finishes.
			expect((item.backgroundColor as { id: string }).id).toBe(
				"statusBarItem.warningBackground",
			);
			expect(item.tooltip).toContain(
				"Personal Space is being synced by another device",
			);
		});

		it("offline + failedCode=localfolder_invalid → 'Memory Bank folder invalid'", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("offline", { failed: true, failedCode: "localfolder_invalid" });
			expect(item.text).toBe("$(error) Memory Bank folder invalid");
			expect((item.backgroundColor as { id: string }).id).toBe("statusBarItem.errorBackground");
			expect(item.tooltip).toContain("Update the Memory Bank folder in Settings");
		});

		it("offline + failedCode=push_rejected → 'Push rejected'", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("offline", { failed: true, failedCode: "push_rejected" });
			expect(item.text).toBe("$(error) Push rejected");
			expect((item.backgroundColor as { id: string }).id).toBe("statusBarItem.errorBackground");
			expect(item.tooltip).toContain("Server refused the push");
		});

		it("offline + failedCode=symlink_quarantine_failed → 'Sync paused' with §P2 headline", () => {
			// I6: sweep failure terminates the round; the bar must show a
			// distinct "Sync paused" visual (not generic "Sync failed") so
			// the user understands the failure is recoverable and what
			// needs inspecting.
			const manager = new StatusBarManager();
			manager.setSyncState("offline", { failed: true, failedCode: "symlink_quarantine_failed" });
			expect(item.text).toBe("$(error) Sync paused");
			expect((item.backgroundColor as { id: string }).id).toBe("statusBarItem.errorBackground");
			expect(item.tooltip).toContain("Symlink quarantine failed");
			expect(item.tooltip).toContain("Memory Bank folder");
		});

		it("offline + an unrecognized failedCode falls back to generic 'Sync failed' (exhaustive-never runtime safety)", () => {
			// The terminal-code switch has a compile-time `const _exhaustive:
			// never = code` guard — every documented TerminalSyncErrorCode
			// must have an explicit case. The `default:` exists ONLY as a
			// runtime safety net for the case where types are bypassed at a
			// caller (e.g. a future engine code added without a UI branch,
			// raw JSON deserialization into the type). Exercise it via a
			// cast so the production fallback visual is verified instead of
			// crashing the status bar.
			const manager = new StatusBarManager();
			manager.setSyncState("offline", {
				failed: true,
				failedCode: "future_code_not_yet_in_the_union" as never as
					import("../../../cli/src/sync/SyncTypes.js").TerminalSyncErrorCode,
			});
			expect(item.text).toBe("$(error) Sync failed");
			expect((item.backgroundColor as { id: string }).id).toBe("statusBarItem.errorBackground");
		});

		it("tooltip without detail falls back to plain headline", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("syncing");
			expect(item.tooltip).toBe(
				"Memory Bank sync in progress — click to open sidebar",
			);
		});

		it("synced tooltip includes detail when provided", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("synced", { lastFetchAt: "2026-05-19T00:00:00Z" });
			expect(item.tooltip).toContain("Memory Bank in sync");
			expect(item.tooltip).toContain("Last fetch: 2026-05-19T00:00:00Z");
		});

		it("conflicts tooltip uses singular 'item needs'", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("conflicts", { conflictCount: 1 });
			expect(item.tooltip).toContain("1 item needs your attention");
		});
	});

	describe("legacy ↔ sync transitions — sync wins once it takes over", () => {
		it("update(false) then setSyncState('synced') still shows synced (clears warning bg)", () => {
			const manager = new StatusBarManager();
			manager.update(false);
			manager.setSyncState("synced");
			expect(item.text).toBe("$(check) Jolli Memory");
			expect(item.backgroundColor).toBeUndefined();
		});

		it("update(true) after setSyncState is a no-op (sync owns the bar)", () => {
			// Regression: every commit/push/squash triggers refreshStatusBar →
			// statusBar.update(enabled), which used to wipe "Syncing…" /
			// "Sync failed" / "Conflicts" back to plain "Jolli Memory" until
			// the next poll tick rewrote it. Once sync has driven the bar,
			// the legacy update path must NOT touch it.
			const manager = new StatusBarManager();
			manager.setSyncState("conflicts", { conflictCount: 5 });
			manager.update(true);
			expect(item.text).toBe("$(warning) 5 conflicts");
			expect((item.backgroundColor as { id: string }).id).toBe(
				"statusBarItem.warningBackground",
			);
		});

		it("update(false) after setSyncState is also a no-op", () => {
			const manager = new StatusBarManager();
			manager.setSyncState("offline", { failed: true, failedCode: "sync_failed_after_retries" });
			manager.update(false);
			expect(item.text).toBe("$(error) Sync failed");
		});

		it("subsequent setSyncState calls still update the bar", () => {
			// One-way flag must not block the orchestrator's own state changes.
			const manager = new StatusBarManager();
			manager.setSyncState("syncing");
			manager.setSyncState("synced");
			expect(item.text).toBe("$(check) Jolli Memory");
		});
	});
});
