import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueStatus } from "../../core/QueueStatus.js";
import type { PluginDiagnostic } from "../../PluginLoader.js";
import type { StatusInfo } from "../../Types.js";
import { applyLiveStatus, buildHomeModel, renderHomeSnapshot } from "./HomeSnapshot.js";

const IDENTITY = { repo: "jolli-verify", branch: "feat-x" };

// buildHomeModel now derives the onboarding model (via resolveLlmCredentialSource,
// which reads ANTHROPIC_API_KEY) — pin the env off for deterministic assertions.
const ORIGINAL = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = ORIGINAL;
});

function status(over: Partial<StatusInfo> = {}): StatusInfo {
	return {
		enabled: true,
		claudeHookInstalled: true,
		gitHookInstalled: true,
		geminiHookInstalled: false,
		activeSessions: 0,
		mostRecentSession: null,
		summaryCount: 3,
		orphanBranch: "jollimemory/summaries/v3",
		...over,
	};
}

const QUEUE_IDLE: QueueStatus = {
	active: 0,
	ingestActive: 0,
	workerBusy: false,
	workerBlocking: false,
	drained: true,
	stale: 0,
};

describe("buildHomeModel", () => {
	it("maps 6 AI sources, marking detected+not-disabled as on", () => {
		const m = buildHomeModel(
			IDENTITY,
			status({ claudeDetected: true, codexDetected: true, codexEnabled: false, cursorDetected: true }),
			QUEUE_IDLE,
			[],
		);
		expect(m.sources.map((s) => s.name)).toEqual(["Claude", "Codex", "Gemini", "Cursor", "Copilot", "OpenCode"]);
		expect(m.sources.find((s) => s.name === "Claude")?.on).toBe(true);
		// Codex detected but explicitly disabled → off.
		expect(m.sources.find((s) => s.name === "Codex")?.on).toBe(false);
		expect(m.sources.find((s) => s.name === "Cursor")?.on).toBe(true);
		expect(m.sources.find((s) => s.name === "Gemini")?.on).toBe(false);
	});

	it("marks Claude off when installed but explicitly disabled (claudeEnabled: false)", () => {
		const m = buildHomeModel(IDENTITY, status({ claudeDetected: true, claudeEnabled: false }), QUEUE_IDLE, []);
		// Detected on disk but the user disabled it → off, and NOT counted as a host.
		expect(m.sources.find((s) => s.name === "Claude")?.on).toBe(false);
	});

	it("counts detected hosts out of the 6 source rows and reflects enabled/queue", () => {
		const m = buildHomeModel(
			IDENTITY,
			// Copilot Chat detected (no CLI) still counts as the Copilot row detected.
			status({ claudeDetected: true, codexDetected: true, copilotChatDetected: true }),
			{ ...QUEUE_IDLE, workerBusy: true, active: 2 },
			[],
		);
		expect(m.hostsDetected).toBe(3); // claude + codex + copilot(via chat)
		expect(m.hostsTotal).toBe(6); // one per source row (Copilot CLI+Chat share a row)
		// The Copilot ROW must agree with the count: chat-only still reads as on,
		// never a "1/6 detected" that contradicts an off Copilot row.
		expect(m.sources.find((s) => s.name === "Copilot")?.on).toBe(true);
		expect(m.enabled).toBe(true);
		expect(m.summaryLabel).toBe("generating (2 queued)");
	});

	it("formats last-sync relative time, or 'never' when unset", () => {
		const now = Date.parse("2026-07-15T12:00:00Z");
		const synced = buildHomeModel(IDENTITY, status(), QUEUE_IDLE, [], "2026-07-15T11:57:00Z", now);
		expect(synced.lastSyncLabel).toBe("3m ago");
		const never = buildHomeModel(IDENTITY, status(), QUEUE_IDLE, [], null, now);
		expect(never.lastSyncLabel).toBe("never");
	});

	it("falls back repo/branch labels; idle summary + drained queue", () => {
		const m = buildHomeModel({ repo: "", branch: "" }, status({ enabled: false }), QUEUE_IDLE, []);
		expect(m.repo).toBe("(unknown)");
		expect(m.branch).toBe("(detached)");
		expect(m.enabled).toBe(false);
		expect(m.summaryLabel).toBe("idle");
		expect(m.ingestLabel).toBe("idle");
		expect(m.queueLabel).toBe("drained");
	});

	it("reflects an active ingest phase from the ingest arg", () => {
		const m = buildHomeModel(IDENTITY, status(), QUEUE_IDLE, [], null, Date.now(), [], {
			busy: true,
			phase: "graph",
		});
		expect(m.ingestLabel).toBe("building graph…");
	});

	it("derives auth rows and onboarding from authToken + config", () => {
		const ready = buildHomeModel(
			IDENTITY,
			status({ enabled: true, summaryCount: 3 }),
			QUEUE_IDLE,
			[],
			null,
			Date.now(),
			[],
			{ busy: false, phase: null },
			"tok",
			{ jolliApiKey: "sk-jol", jolliUrl: "https://app.jolli.ai" },
		);
		expect(ready.signedIn).toBe(true);
		expect(ready.signInLabel).toBe("signed in · app.jolli.ai");
		expect(ready.credentialLabel).toBe("Jolli API key");
		expect(ready.onboarding.layout).toBe("dashboard");

		const fresh = buildHomeModel(IDENTITY, status({ enabled: false, summaryCount: 0 }), QUEUE_IDLE, []);
		expect(fresh.signedIn).toBe(false);
		expect(fresh.signInLabel).toBe("not signed in");
		expect(fresh.credentialLabel).toBe("none");
		expect(fresh.onboarding.layout).toBe("wizard");
	});

	it("projects plugin diagnostics", () => {
		const plugins: PluginDiagnostic[] = [
			{ id: "x", packageName: "@jolli.ai/site-cli", installHint: "npm i -g @jolli.ai/site-cli", state: "absent" },
			{ id: "y", packageName: "@jolli.ai/space-cli", installHint: "npm i -g @jolli.ai/space-cli", state: "ok" },
		];
		const m = buildHomeModel(IDENTITY, status(), QUEUE_IDLE, plugins);
		expect(m.plugins).toEqual([
			{ name: "@jolli.ai/site-cli", state: "absent", installHint: "npm i -g @jolli.ai/site-cli" },
			{ name: "@jolli.ai/space-cli", state: "ok", installHint: "npm i -g @jolli.ai/space-cli" },
		]);
	});
});

describe("renderHomeSnapshot", () => {
	it("renders a scriptable plain-text snapshot", () => {
		const m = buildHomeModel(IDENTITY, status({ claudeDetected: true }), { ...QUEUE_IDLE, active: 1 }, []);
		const out = renderHomeSnapshot(m);
		expect(out).toContain("jolli-verify · feat-x");
		expect(out).toContain("enabled");
		expect(out).toContain("Claude:on");
		expect(out).toContain("Codex:off");
		expect(out).toContain("Summary queued (1)");
		expect(out).toContain("Queue drained");
	});

	it("lists installed skills by name and shows (none) when nothing is installed", () => {
		// One row per managed skill — only some installed to a target.
		const withSkills = buildHomeModel(IDENTITY, status(), QUEUE_IDLE, [], null, Date.now(), [
			{ name: "jolli-recall", targets: ["claude-code", "agents-std"] },
			{ name: "jolli-pr", targets: [] },
		]);
		expect(renderHomeSnapshot(withSkills)).toContain("Skills    jolli-recall");
		expect(renderHomeSnapshot(withSkills)).not.toContain("jolli-pr");

		const noneInstalled = buildHomeModel(IDENTITY, status(), QUEUE_IDLE, [], null, Date.now(), [
			{ name: "jolli-recall", targets: [] },
		]);
		expect(renderHomeSnapshot(noneInstalled)).toContain("Skills    (none)");
	});

	it("includes the Sign-in and Credential lines", () => {
		const m = buildHomeModel(
			IDENTITY,
			status(),
			QUEUE_IDLE,
			[],
			null,
			Date.now(),
			[],
			{ busy: false, phase: null },
			"tok",
			{
				apiKey: "sk-ant-x",
				aiProvider: "anthropic",
			},
		);
		const out = renderHomeSnapshot(m);
		expect(out).toContain("Sign-in   signed in");
		expect(out).toContain("Credential Anthropic key");
	});
});

describe("applyLiveStatus", () => {
	it("recomputes only the activity fields, preserving everything else", () => {
		const base = buildHomeModel(
			IDENTITY,
			status({ claudeDetected: true }),
			QUEUE_IDLE,
			[],
			null,
			Date.parse("2026-07-15T12:00:00Z"),
		);
		const patched = applyLiveStatus(
			base,
			{ ...QUEUE_IDLE, workerBusy: true, active: 2 },
			{ busy: true, phase: "wiki" },
		);
		expect(patched.summaryLabel).toBe("generating (2 queued)");
		expect(patched.ingestLabel).toBe("building wiki…");
		// lastSyncLabel is NOT refreshed by the live poll — it keeps prev's value.
		expect(patched.lastSyncLabel).toBe(base.lastSyncLabel);
		// Untouched fields are the same references/values as before.
		expect(patched.sources).toBe(base.sources);
		expect(patched.onboarding).toBe(base.onboarding);
		expect(patched.repo).toBe(base.repo);
	});
});
