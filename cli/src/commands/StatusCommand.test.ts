/**
 * Tests for StatusCommand — `jolli status` integration rows.
 *
 * Covers the per-integration breakdown output, focused on the Copilot row.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusInfo } from "../Types.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const { mockGetStatus, mockLoadConfigFromDir, mockLoadAuthToken } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	mockLoadConfigFromDir: vi.fn(),
	mockLoadAuthToken: vi.fn(),
}));

vi.mock("../install/Installer.js", () => ({
	getStatus: mockGetStatus,
}));

vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: vi.fn().mockReturnValue("/mock/global/config"),
	loadConfigFromDir: mockLoadConfigFromDir,
}));

vi.mock("../auth/AuthConfig.js", () => ({
	loadAuthToken: mockLoadAuthToken,
}));

vi.mock("../core/JolliApiUtils.js", () => ({
	parseJolliApiKey: vi.fn().mockReturnValue(null),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal StatusInfo satisfying the required fields — used as the spread base
 * in individual test cases.
 */
const baseStatus: StatusInfo = {
	enabled: true,
	claudeHookInstalled: false,
	gitHookInstalled: false,
	geminiHookInstalled: false,
	activeSessions: 0,
	mostRecentSession: null,
	summaryCount: 0,
	orphanBranch: "jollimemory/summaries/v3",
	sessionsBySource: {},
};

/**
 * Renders `jolli status` output to a string by capturing console.log calls.
 * Configures mockGetStatus with the given status before parsing.
 */
async function renderStatus(status: StatusInfo): Promise<string> {
	mockGetStatus.mockResolvedValueOnce(status);

	const { registerStatusCommand } = await import("./StatusCommand.js");
	const program = new Command();
	program.exitOverride();
	registerStatusCommand(program);

	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	try {
		await program.parseAsync(["status"], { from: "user" });
	} finally {
		spy.mockRestore();
	}
	return lines.join("\n");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StatusCommand — Copilot integration row", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadConfigFromDir.mockResolvedValue({});
		mockLoadAuthToken.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not render Copilot row when copilot not detected", async () => {
		const out = await renderStatus({
			...baseStatus,
			// copilotDetected unset (undefined) -> default state
		});
		expect(out).not.toContain("Copilot:");
	});

	it("renders Copilot Integration row when detected", async () => {
		const out = await renderStatus({
			...baseStatus,
			copilotDetected: true,
			copilotEnabled: true,
			sessionsBySource: { copilot: 3 },
		});
		expect(out).toContain("Copilot");
		expect(out).toContain("3");
	});

	it("renders Copilot row as unavailable on scan error", async () => {
		const out = await renderStatus({
			...baseStatus,
			copilotDetected: true,
			copilotScanError: { kind: "locked", message: "database is locked" },
		});
		expect(out).toContain("Copilot");
		expect(out).toContain("unavailable");
		expect(out).toContain("locked");
	});

	it("renders Copilot row as disabled when detected but copilotEnabled is false", async () => {
		const out = await renderStatus({
			...baseStatus,
			copilotDetected: true,
			copilotEnabled: false,
		});
		expect(out).toContain("Copilot");
		expect(out).toContain("detected but disabled");
	});

	it("Copilot row shows CLI/Chat breakdown when only chat is detected", async () => {
		const out = await renderStatus({
			...baseStatus,
			copilotDetected: false,
			copilotChatDetected: true,
			copilotEnabled: true,
			sessionsBySource: { "copilot-chat": 2 },
		});
		expect(out).toContain("CLI: ✗");
		expect(out).toContain("Chat: ✓");
		expect(out).toMatch(/2\s*sessions/);
	});

	it("emits a Chat scan-failed sub-line when copilotChatScanError is set", async () => {
		// CLI scan error renders on the main row; Chat error is structurally
		// different — it surfaces as an indented "↳ Chat scan failed" sub-line
		// underneath the CLI/Chat breakdown so users can tell which form failed.
		const out = await renderStatus({
			...baseStatus,
			copilotDetected: true,
			copilotChatDetected: true,
			copilotEnabled: true,
			copilotChatScanError: { kind: "parse", message: "bad jsonl event at line 7" },
		});
		expect(out).toContain("Chat scan failed (parse)");
		expect(out).toContain("bad jsonl event at line 7");
	});
});
