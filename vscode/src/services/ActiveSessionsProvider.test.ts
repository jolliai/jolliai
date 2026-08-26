import { beforeEach, describe, expect, it, vi } from "vitest";

// ActiveSessionsProvider imports util/Logger.js which in turn imports the
// vscode module to lazily create an OutputChannel. Stub the vscode surface
// the logger touches so the test environment doesn't fail at import time.
vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
			name: "Jolli Memory",
			replace: vi.fn(),
			clear: vi.fn(),
		})),
	},
}));

vi.mock("../../../cli/src/core/ActiveSessionAggregator.js", async (importActual) => ({
	...(await importActual<typeof import("../../../cli/src/core/ActiveSessionAggregator.js")>()),
	listActiveConversationsWithDiagnostics: vi.fn(),
}));

// Hermetic config: default {} means every source is enabled (isSourceEnabled
// treats `undefined` as on), so the belt-and-suspenders filter in
// listWithDiagnostics is a no-op unless a test opts out explicitly.
//
// Partial mock: keep the real `isSourceEnabled` (which ActiveSessionAggregator
// re-exports from SessionTracker for VS Code's belt-and-suspenders filter);
// only `loadConfig` is stubbed so we don't touch the developer's real config
// on disk.
vi.mock("../../../cli/src/core/SessionTracker.js", async (importActual) => ({
	...(await importActual<typeof import("../../../cli/src/core/SessionTracker.js")>()),
	loadConfig: vi.fn().mockResolvedValue({}),
}));

// Dashboard direct write: the provider pushes each tick's
// sessions into the local stats DB. Mocked so tests neither spawn git nor
// touch the machine-level SQLite file; the real behaviour is covered by the
// CLI's dashboard/ProducerHooks.test.ts.
vi.mock("../../../cli/src/dashboard/ProducerHooks.js", () => ({
	recordSessionsFromTick: vi.fn().mockResolvedValue(true),
}));

vi.mock("../util/Logger.js", () => ({
	log: {
		warn: vi.fn(),
	},
}));

import { listActiveConversationsWithDiagnostics } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { recordSessionsFromTick } from "../../../cli/src/dashboard/ProducerHooks.js";
import { log } from "../util/Logger.js";
import { ActiveSessionsProvider } from "./ActiveSessionsProvider.js";

describe("ActiveSessionsProvider", () => {
	beforeEach(() => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockReset();
		vi.mocked(recordSessionsFromTick).mockReset().mockResolvedValue(true);
		vi.mocked(log.warn).mockReset();
	});

	it("returns aggregator items verbatim from list()", async () => {
		const items = [
			{
				sessionId: "x",
				source: "claude" as const,
				title: "T",
				messageCount: 1,
				updatedAt: "2026-05-15T00:00:00Z",
				transcriptPath: "/x",
				isEdited: false,
				isSelected: true,
			},
		];
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items,
			failedSources: [],
		});

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.list();
		expect(result).toEqual(items);
		expect(listActiveConversationsWithDiagnostics).toHaveBeenCalledWith({
			cwd: "/proj",
			windowMs: 2 * 24 * 60 * 60 * 1000,
		});
	});

	it("returns an empty list when there is no workspace", async () => {
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => undefined });
		const result = await p.list();
		expect(result).toEqual([]);
		expect(listActiveConversationsWithDiagnostics).not.toHaveBeenCalled();
	});

	it("listWithDiagnostics surfaces failedSources from the aggregator", async () => {
		// Two of the seven source loaders threw — the webview should be able
		// to render a "partial result" hint rather than silently presenting
		// the items list as complete.
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items: [],
			failedSources: ["cursor", "opencode"],
		});
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.listWithDiagnostics();
		expect(result.failedSources).toEqual(["cursor", "opencode"]);
	});

	it("listWithDiagnostics filters failedSources by the enabled-source config", async () => {
		// Belt-and-suspenders parity with items: a source the user just
		// disabled (or that drifted between the aggregator load and the
		// config load) must not spike the "N sources unavailable" banner.
		// The aggregator wouldn't normally return a disabled source in
		// `failedSources` — its per-source loader short-circuits before
		// touching disk — but under the same drift window that motivates
		// filtering items, a stale entry is possible.
		const { loadConfig } = await import("../../../cli/src/core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValueOnce({ cursorEnabled: false } as never);
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items: [],
			failedSources: ["cursor", "opencode"],
		});
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.listWithDiagnostics();
		expect(result.failedSources).toEqual(["opencode"]);
	});

	it("listWithDiagnostics on aggregator-throw flags every known source as failed", async () => {
		// When the aggregator itself throws (not just one source loader),
		// every source is effectively unavailable. Returning failedSources:
		// [] would tell the webview "0 of N failed" — indistinguishable from
		// a healthy-but-empty list, so the partial-data banner never shows
		// and users can't tell the feature is broken. Returning the full
		// TRANSCRIPT_SOURCES set is honest: webview renders the banner and
		// the user knows something is wrong.
		vi.mocked(listActiveConversationsWithDiagnostics).mockRejectedValueOnce(
			new Error("boom"),
		);
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.listWithDiagnostics();
		expect(result.items).toEqual([]);
		expect([...result.failedSources].sort()).toEqual([
			"antigravity",
			"claude",
			"cline",
			"cline-cli",
			"codex",
			"copilot",
			"copilot-chat",
			"cursor",
			"cursor-cli",
			"devin",
			"gemini",
			"hermes",
			"kimi",
			"opencode",
		]);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("logs a repeated aggregator failure only once until recovery", async () => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockRejectedValue(
			new Error("boom"),
		);
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });

		await p.listWithDiagnostics();
		await p.listWithDiagnostics();

		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("logs the same aggregator failure again after a successful refresh", async () => {
		vi.mocked(listActiveConversationsWithDiagnostics)
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ items: [], failedSources: [] })
			.mockRejectedValueOnce(new Error("boom"));
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });

		await p.listWithDiagnostics();
		await p.listWithDiagnostics();
		await p.listWithDiagnostics();

		expect(log.warn).toHaveBeenCalledTimes(2);
	});

	it("passes isSelected=false through from the aggregator to list()", async () => {
		const items = [
			{
				sessionId: "abc",
				source: "claude" as const,
				title: "Test conversation",
				messageCount: 5,
				updatedAt: "2026-05-18T12:00:00Z",
				transcriptPath: "/tmp/transcript.json",
				isEdited: true,
				isSelected: false,
			},
		];
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items,
			failedSources: [],
		});

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.list();
		expect(result).toHaveLength(1);
		expect(result[0].isSelected).toBe(false);
	});

	it("passes isSelected=true through from the aggregator to list()", async () => {
		const items = [
			{
				sessionId: "xyz",
				source: "cursor" as const,
				title: "Another conversation",
				messageCount: 3,
				updatedAt: "2026-05-19T10:30:00Z",
				transcriptPath: "/tmp/transcript2.json",
				isEdited: false,
				isSelected: true,
			},
		];
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items,
			failedSources: [],
		});

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.list();
		expect(result).toHaveLength(1);
		expect(result[0].isSelected).toBe(true);
	});

	it("pushes each successful tick's sessions to the dashboard writer", async () => {
		const items = [
			{
				sessionId: "dash1",
				source: "claude" as const,
				title: "T",
				messageCount: 2,
				updatedAt: "2026-07-30T08:00:00Z",
				transcriptPath: "/t1.jsonl",
				isEdited: false,
				isSelected: true,
			},
		];
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items,
			failedSources: [],
		});

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		await p.listWithDiagnostics();

		expect(recordSessionsFromTick).toHaveBeenCalledWith("/proj", [
			{
				sessionId: "dash1",
				transcriptPath: "/t1.jsonl",
				updatedAt: "2026-07-30T08:00:00Z",
				source: "claude",
				title: "T",
			},
		]);
	});

	it("omits the title key entirely for a session the aggregator could not name", async () => {
		// The aggregator falls back to an empty title when a transcript carries no
		// usable first message. Forwarding `title: ""` would overwrite a better
		// name a previous tick already stored, so the key is dropped instead of
		// being sent blank.
		const items = [
			{
				sessionId: "untitled1",
				source: "codex" as const,
				title: "",
				messageCount: 1,
				updatedAt: "2026-07-30T09:00:00Z",
				transcriptPath: "/t2.jsonl",
				isEdited: false,
				isSelected: true,
			},
		];
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items,
			failedSources: [],
		});

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		await p.listWithDiagnostics();

		expect(recordSessionsFromTick).toHaveBeenCalledWith("/proj", [
			{
				sessionId: "untitled1",
				transcriptPath: "/t2.jsonl",
				updatedAt: "2026-07-30T09:00:00Z",
				source: "codex",
			},
		]);
	});

	it("prefers an injected dashboard writer seam over the default", async () => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items: [],
			failedSources: [],
		});
		const seam = vi.fn().mockResolvedValue(false);

		const p = new ActiveSessionsProvider({
			getWorkspaceCwd: () => "/proj",
			recordDashboardSessions: seam,
		});
		await p.listWithDiagnostics();

		expect(seam).toHaveBeenCalledWith("/proj", []);
		expect(recordSessionsFromTick).not.toHaveBeenCalled();
	});

	it("does not push to the dashboard when the aggregator throws", async () => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockRejectedValueOnce(
			new Error("boom"),
		);
		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		await p.listWithDiagnostics();

		expect(recordSessionsFromTick).not.toHaveBeenCalled();
	});

	it("survives a rejecting dashboard writer seam", async () => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items: [],
			failedSources: [],
		});
		const seam = vi.fn().mockRejectedValue(new Error("seam defect"));

		const p = new ActiveSessionsProvider({
			getWorkspaceCwd: () => "/proj",
			recordDashboardSessions: seam,
		});
		const result = await p.listWithDiagnostics();

		expect(result.items).toEqual([]);
		// Give the fire-and-forget rejection a microtask to settle; an unhandled
		// rejection here would fail the test run.
		await new Promise((resolve) => setImmediate(resolve));
	});

	it("passes isSelected through from the aggregator to listWithDiagnostics()", async () => {
		const items = [
			{
				sessionId: "mixed1",
				source: "claude" as const,
				title: "Selected item",
				messageCount: 10,
				updatedAt: "2026-05-19T08:00:00Z",
				transcriptPath: "/tmp/t1.json",
				isEdited: true,
				isSelected: true,
			},
			{
				sessionId: "mixed2",
				source: "gemini" as const,
				title: "Deselected item",
				messageCount: 4,
				updatedAt: "2026-05-18T14:00:00Z",
				transcriptPath: "/tmp/t2.json",
				isEdited: false,
				isSelected: false,
			},
		];
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValueOnce({
			items,
			failedSources: [],
		});

		const p = new ActiveSessionsProvider({ getWorkspaceCwd: () => "/proj" });
		const result = await p.listWithDiagnostics();
		expect(result.items).toHaveLength(2);
		expect(result.items[0].isSelected).toBe(true);
		expect(result.items[1].isSelected).toBe(false);
	});
});
