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

describe("StatusCommand — Jolli Site display", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: signed in — most tests assert the active "Jolli Site:" label.
		// The signed-out test below overrides this.
		mockLoadAuthToken.mockResolvedValue("tk-active");
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders Jolli Site from persisted config.jolliUrl", async () => {
		mockLoadConfigFromDir.mockResolvedValue({
			jolliApiKey: "sk-jol-decodable",
			jolliUrl: "https://embedded.jolli.ai",
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Site:       embedded.jolli.ai");
	});

	it("renders Jolli Site from config.jolliUrl even when the key is legacy/hand-typed", async () => {
		mockLoadConfigFromDir.mockResolvedValue({ jolliApiKey: "sk-jol-legacy", jolliUrl: "https://tenant.jolli.ai" });
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Site:       tenant.jolli.ai");
	});

	it("falls back to config.jolliUrl when jolliApiKey is absent (post-cross-tenant clear)", async () => {
		// The real post-clear state keeps the on-disk `authToken` (sign-in
		// persists it; only the stale key is cleared), so the row is still the
		// live "Jolli Site".
		mockLoadConfigFromDir.mockResolvedValue({
			authToken: "tk-disk",
			jolliUrl: "https://only-url.jolli.ai",
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Site:       only-url.jolli.ai");
	});

	it("relabels as 'Last signed-in site' for an env-only token over a stale on-disk jolliUrl", async () => {
		// P2: `loadAuthToken()` is env-first, so a `JOLLI_AUTH_TOKEN` injected
		// purely via the environment reports "Signed in" — but it carries no
		// tenant of its own. The on-disk `jolliUrl` here is from a prior web
		// login to a different tenant, so labeling it the live "Jolli Site"
		// would pair "Signed in" with an unrelated tenant. Gate on the DISK
		// credential instead: no on-disk authToken/key → "Last signed-in site".
		mockLoadAuthToken.mockResolvedValue("tk-from-env");
		mockLoadConfigFromDir.mockResolvedValue({ jolliUrl: "https://stale-tenant.jolli.ai" });
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Last signed-in site: stale-tenant.jolli.ai");
		expect(out).not.toContain("Jolli Site:");
	});

	it("omits the Jolli Site row when only jolliApiKey is persisted (pre-0.99.2 install, no jolliUrl)", async () => {
		// We intentionally do NOT decode the tenant URL embedded in the key.
		// Even though `meta.u` is a public origin, deriving a logged value from
		// `jolliApiKey` trips CodeQL's clear-text-logging taint analysis, so a
		// pre-0.99.2 install carrying only `jolliApiKey` omits the row until the
		// next sign-in persists `jolliUrl`.
		const meta = { t: "tenant-a", u: "https://embedded.jolli.ai" };
		const key = `sk-jol-${Buffer.from(JSON.stringify(meta)).toString("base64url")}.secret`;
		mockLoadConfigFromDir.mockResolvedValue({ jolliApiKey: key });
		const out = await renderStatus(baseStatus);
		expect(out).not.toContain("Jolli Site:");
		expect(out).not.toContain("embedded.jolli.ai");
	});

	it("omits the Jolli Site row when neither jolliApiKey nor jolliUrl is configured", async () => {
		mockLoadConfigFromDir.mockResolvedValue({});
		const out = await renderStatus(baseStatus);
		expect(out).not.toContain("Jolli Site:");
		expect(out).not.toContain("Last signed-in site:");
	});

	it("relabels the row as 'Last signed-in site' when the user is signed out but jolliUrl was retained", async () => {
		// `clearAuthCredentials` intentionally keeps `jolliUrl` so space-cli can
		// still resolve the tenant after logout. Without the relabel, the row
		// reads identically to an active session and a user looking at it
		// could think they're still connected to the tenant.
		mockLoadAuthToken.mockResolvedValue(null);
		mockLoadConfigFromDir.mockResolvedValue({ jolliUrl: "https://tenant.jolli.ai" });
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Last signed-in site: tenant.jolli.ai");
		expect(out).not.toContain("Jolli Site:");
	});

	it("keeps the active 'Jolli Site' label when a manual API key is configured without an auth token", async () => {
		mockLoadAuthToken.mockResolvedValue(null);
		mockLoadConfigFromDir.mockResolvedValue({
			jolliApiKey: "sk-jol-manual",
			jolliUrl: "https://manual.jolli.ai",
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Site:       manual.jolli.ai");
		expect(out).not.toContain("Last signed-in site:");
	});
});
