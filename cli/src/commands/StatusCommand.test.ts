/**
 * Tests for StatusCommand — `jolli status` integration rows.
 *
 * Covers the per-integration breakdown output, focused on the Copilot row.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusInfo } from "../Types.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const {
	mockGetStatus,
	mockLoadConfigFromDir,
	mockLoadAuthToken,
	mockFrontDoor,
	mockClientCtor,
	mockLoadCache,
	mockSaveCache,
	mockClearCache,
	mockTenantOrigin,
} = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	mockLoadConfigFromDir: vi.fn(),
	mockLoadAuthToken: vi.fn(),
	mockFrontDoor: vi.fn(),
	mockClientCtor: vi.fn(),
	mockLoadCache: vi.fn(),
	mockSaveCache: vi.fn(),
	mockClearCache: vi.fn(),
	mockTenantOrigin: vi.fn(),
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

// Keep the real error classes (instanceof checks in the command must see the
// actual constructors); only the client itself is replaced with a stub whose
// frontDoor is controlled per test.
vi.mock("../core/JolliMemoryPushClient.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/JolliMemoryPushClient.js")>();
	// `new JolliMemoryPushClient()` requires the mock implementation to be a real
	// constructible function — an arrow function throws "is not a constructor"
	// when invoked with `new` (same workaround as McpTools.test.ts).
	return {
		...actual,
		JolliMemoryPushClient: mockClientCtor.mockImplementation(function (this: unknown) {
			return { frontDoor: mockFrontDoor };
		}),
	};
});

vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn().mockResolvedValue("https://github.com/acme/widgets"),
	deriveRepoNameFromUrl: vi.fn().mockReturnValue("widgets"),
}));

// The cache module is mocked wholesale: these tests run with the REAL process
// cwd, so letting the command touch the developer's actual
// `.jolli/jollimemory/space-binding.json` would make tests destructive.
// Cache read/write/expiry behavior is covered by SpaceBindingCache.test.ts.
vi.mock("../core/SpaceBindingCache.js", () => ({
	loadSpaceBindingCache: mockLoadCache,
	saveSpaceBindingCache: mockSaveCache,
	clearSpaceBindingCache: mockClearCache,
	tenantOriginForKey: mockTenantOrigin,
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
async function renderStatus(status: StatusInfo, extraArgs: readonly string[] = []): Promise<string> {
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
		await program.parseAsync(["status", ...extraArgs], { from: "user" });
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
		mockFrontDoor.mockResolvedValue({ status: "no_spaces" });
		mockTenantOrigin.mockReturnValue(null);
		mockLoadCache.mockResolvedValue(null);
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

describe("StatusCommand — Cline integration row", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadConfigFromDir.mockResolvedValue({});
		mockLoadAuthToken.mockResolvedValue(null);
		mockFrontDoor.mockResolvedValue({ status: "no_spaces" });
		mockTenantOrigin.mockReturnValue(null);
		mockLoadCache.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not render Cline row when Cline not detected", async () => {
		const out = await renderStatus({
			...baseStatus,
			// clineDetected unset (undefined) -> default state
		});
		expect(out).not.toContain("Cline:");
	});

	it("renders Cline row with merged extension + CLI session count", async () => {
		const out = await renderStatus({
			...baseStatus,
			clineDetected: true,
			clineEnabled: true,
			sessionsBySource: { cline: 2, "cline-cli": 3 },
		});
		expect(out).toContain("Cline");
		expect(out).toMatch(/5\s*sessions/);
	});

	it("renders Cline row as unavailable on scan error", async () => {
		const out = await renderStatus({
			...baseStatus,
			clineDetected: true,
			clineScanError: { kind: "parse", message: "bad task json" },
		});
		expect(out).toContain("Cline");
		expect(out).toContain("unavailable");
		expect(out).toContain("parse");
	});

	it("renders Cline row as disabled when detected but clineEnabled is false", async () => {
		const out = await renderStatus({
			...baseStatus,
			clineDetected: true,
			clineEnabled: false,
		});
		expect(out).toContain("Cline");
		expect(out).toContain("detected but disabled");
	});

	it("Cline row shows CLI/VS Code breakdown when only the CLI is detected", async () => {
		const out = await renderStatus({
			...baseStatus,
			clineDetected: true,
			clineCliDetected: true,
			clineVscodeDetected: false,
			clineEnabled: true,
		});
		expect(out).toContain("CLI: ✓");
		expect(out).toContain("VS Code: ✗");
	});

	it("renders the Copilot CLI/Chat sub-line under Copilot, not under Cline", async () => {
		// Regression: the Copilot sub-line was emitted after the whole integration
		// loop, so it visually attached to the last row (Cline). It must print
		// directly beneath Copilot — i.e. before the Cline row.
		const out = await renderStatus({
			...baseStatus,
			copilotDetected: true,
			copilotChatDetected: true,
			copilotEnabled: true,
			clineDetected: true,
			clineCliDetected: true,
			clineVscodeDetected: true,
			clineEnabled: true,
		});
		const chatIdx = out.indexOf("Chat: ✓");
		const clineRowIdx = out.indexOf("Cline:");
		expect(chatIdx).toBeGreaterThan(-1);
		expect(clineRowIdx).toBeGreaterThan(-1);
		expect(chatIdx).toBeLessThan(clineRowIdx);
	});
});

describe("StatusCommand — Jolli Site display", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: signed in — most tests assert the active "Jolli Site:" label.
		// The signed-out test below overrides this.
		mockLoadAuthToken.mockResolvedValue("tk-active");
		mockFrontDoor.mockResolvedValue({ status: "no_spaces" });
		mockTenantOrigin.mockReturnValue(null);
		mockLoadCache.mockResolvedValue(null);
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

describe("StatusCommand — Jolli Space row", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadAuthToken.mockResolvedValue("tk-active");
		mockLoadConfigFromDir.mockResolvedValue({ jolliApiKey: "sk-jol-key", jolliUrl: "https://acme.jolli.ai" });
		// Default: tenant resolvable, cache miss — every pre-cache test keeps
		// exercising the live probe exactly as before.
		mockTenantOrigin.mockReturnValue("https://acme.jolli.ai");
		mockLoadCache.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders the bound Space name quoted so it cannot read as a product name", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Jolli Memory", canPush: true },
			spaces: [],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain('Jolli Space:      Bound to Space "Jolli Memory"');
	});

	it("renders a healthy bound row when an older server omits canPush (null = unknown)", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Jolli Memory", canPush: null },
			spaces: [],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain('Jolli Space:      Bound to Space "Jolli Memory"');
		expect(out).not.toContain("read-only");
	});

	it("points a rebind-less lost-access binding at restored access, not at a rebind jolli cannot offer", async () => {
		// No bindable pool on the degraded response → the front door would offer
		// no rebind, so the hint must not send the user there.
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: null, spaceName: null, canPush: false },
			spaces: [],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Bound — no access to the Space (memories won't sync; ask for access)");
	});

	it("points a lost-access binding at the jolli rebind when the server attached a bindable pool", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: null, spaceName: null, canPush: false },
			spaces: [{ id: 2, name: "Sandbox", slug: "sandbox" }],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain(
			"Jolli Space:      Bound — no access to the Space (memories won't sync; run jolli to rebind)",
		);
	});

	it("renders a read-only bound row when the caller can view but not push (canPush false)", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Jolli Memory", canPush: false },
			spaces: [{ id: 2, name: "Sandbox", slug: "sandbox" }],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain(
			'Jolli Space:      Bound to Space "Jolli Memory" — read-only (memories won\'t sync; run jolli to rebind)',
		);
	});

	it("points a rebind-less read-only binding at restored access, not at a rebind jolli cannot offer", async () => {
		// Named Space, canPush false, empty bindable pool → canRebind false, so
		// the hint must be "ask for access" (the front door would offer nothing).
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Jolli Memory", canPush: false },
			spaces: [],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain(
			'Jolli Space:      Bound to Space "Jolli Memory" — read-only (memories won\'t sync; ask for access)',
		);
	});

	it("renders the unbound state with the bindable Space count", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "unbound",
			spaces: [
				{ id: 1, name: "Acme Core", slug: "acme-core" },
				{ id: 2, name: "Sandbox", slug: "sandbox" },
			],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Not bound — 2 Spaces available (run jolli to bind)");
	});

	it("uses the singular form when exactly one Space is bindable (contract drift)", async () => {
		// Per contract the server auto-binds the single-Space case, so a
		// one-entry unbound list is drift — render it gracefully anyway.
		mockFrontDoor.mockResolvedValue({
			status: "unbound",
			spaces: [{ id: 1, name: "Acme Core", slug: "acme-core" }],
			defaultSpaceId: 1,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Not bound — 1 Space available (run jolli to bind)");
	});

	it("folds an unbound response with an empty list into no_spaces (contract drift, mirrors SpaceSyncStep)", async () => {
		// The server answers no_spaces when nothing is bindable, so an empty
		// unbound list must not render a "0 Spaces available" bind hint.
		mockFrontDoor.mockResolvedValue({ status: "unbound", spaces: [], defaultSpaceId: null });
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Not bound — no Spaces available to you");
		expect(out).not.toContain("0 Spaces");
	});

	it("renders the no-Spaces state without claiming the tenant has none (permission-relative)", async () => {
		mockFrontDoor.mockResolvedValue({ status: "no_spaces" });
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Not bound — no Spaces available to you");
	});

	it("renders not-connected without any HTTP call when no jolliApiKey is configured", async () => {
		mockLoadConfigFromDir.mockResolvedValue({});
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Not connected — run jolli auth login");
		expect(mockClientCtor).not.toHaveBeenCalled();
		expect(mockFrontDoor).not.toHaveBeenCalled();
	});

	it("renders key-rejected when the server answers 401/403", async () => {
		const { NotAuthenticatedError } = await import("../core/JolliMemoryPushClient.js");
		mockFrontDoor.mockRejectedValue(new NotAuthenticatedError());
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Not connected — key rejected (run jolli auth login)");
	});

	it("renders client-outdated when the server answers 426", async () => {
		const { ClientOutdatedError } = await import("../core/JolliMemoryPushClient.js");
		mockFrontDoor.mockRejectedValue(new ClientOutdatedError());
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Unknown — client outdated, update the CLI");
	});

	it("degrades to unreachable on a network failure instead of breaking status", async () => {
		mockFrontDoor.mockRejectedValue(new Error("fetch failed"));
		const out = await renderStatus(baseStatus);
		expect(out).toContain("Jolli Space:      Unknown — Jolli not reachable (offline?)");
	});

	it("keeps --json output free of the Space probe (no HTTP call, no row)", async () => {
		const out = await renderStatus(baseStatus, ["--json"]);
		expect(out).not.toContain("Jolli Space");
		expect(mockClientCtor).not.toHaveBeenCalled();
		expect(mockFrontDoor).not.toHaveBeenCalled();
	});

	it("serves the row from a fresh cache entry with zero network I/O", async () => {
		mockLoadCache.mockResolvedValue({
			version: 1,
			repoUrl: "https://github.com/acme/widgets",
			origin: "https://acme.jolli.ai",
			jmSpaceId: 7,
			spaceName: "Acme Core",
			canPush: true,
			boundAt: "2026-07-01T00:00:00.000Z",
			checkedAt: "2026-07-15T00:00:00.000Z",
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain('Jolli Space:      Bound to Space "Acme Core"');
		expect(mockClientCtor).not.toHaveBeenCalled();
		expect(mockFrontDoor).not.toHaveBeenCalled();
		expect(mockSaveCache).not.toHaveBeenCalled();
	});

	it("--refresh bypasses the cache and probes the server", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: true },
			spaces: [],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus, ["--refresh"]);
		expect(out).toContain('Jolli Space:      Bound to Space "Acme Core"');
		expect(mockLoadCache).not.toHaveBeenCalled();
		expect(mockFrontDoor).toHaveBeenCalledTimes(1);
	});

	it("writes the cache after a healthy bound probe", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: true },
			spaces: [],
			defaultSpaceId: null,
		});
		await renderStatus(baseStatus);
		expect(mockSaveCache).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				repoUrl: "https://github.com/acme/widgets",
				origin: "https://acme.jolli.ai",
				jmSpaceId: 7,
				spaceName: "Acme Core",
				canPush: true,
			}),
		);
	});

	it("caches a null canPush (older server) as null, never as a guess", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: null },
			spaces: [],
			defaultSpaceId: null,
		});
		await renderStatus(baseStatus);
		expect(mockSaveCache).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ canPush: null }));
	});

	it("clears (and never writes) the cache on a degraded bound answer", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: false },
			spaces: [],
			defaultSpaceId: null,
		});
		await renderStatus(baseStatus);
		expect(mockSaveCache).not.toHaveBeenCalled();
		expect(mockClearCache).toHaveBeenCalled();
	});

	it("clears the cache when the server answers unbound or no_spaces", async () => {
		mockFrontDoor.mockResolvedValue({
			status: "unbound",
			spaces: [{ id: 1, name: "Acme Core", slug: "acme-core" }],
			defaultSpaceId: null,
		});
		await renderStatus(baseStatus);
		expect(mockClearCache).toHaveBeenCalledTimes(1);

		mockClearCache.mockClear();
		mockFrontDoor.mockResolvedValue({ status: "no_spaces" });
		await renderStatus(baseStatus);
		expect(mockClearCache).toHaveBeenCalledTimes(1);
	});

	it("leaves the cache untouched on a network failure", async () => {
		mockFrontDoor.mockRejectedValue(new Error("fetch failed"));
		await renderStatus(baseStatus);
		expect(mockSaveCache).not.toHaveBeenCalled();
		expect(mockClearCache).not.toHaveBeenCalled();
	});

	it("skips the cache read when the key carries no resolvable tenant origin", async () => {
		mockTenantOrigin.mockReturnValue(null);
		mockFrontDoor.mockResolvedValue({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Acme Core", canPush: true },
			spaces: [],
			defaultSpaceId: null,
		});
		const out = await renderStatus(baseStatus);
		expect(out).toContain('Jolli Space:      Bound to Space "Acme Core"');
		expect(mockLoadCache).not.toHaveBeenCalled();
		expect(mockSaveCache).not.toHaveBeenCalled();
	});
});
