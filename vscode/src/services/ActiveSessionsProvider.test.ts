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

vi.mock("../../../cli/src/core/ActiveSessionAggregator.js", () => ({
	listActiveConversationsWithDiagnostics: vi.fn(),
}));

vi.mock("../util/Logger.js", () => ({
	log: {
		warn: vi.fn(),
	},
}));

import { listActiveConversationsWithDiagnostics } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { log } from "../util/Logger.js";
import { ActiveSessionsProvider } from "./ActiveSessionsProvider.js";

describe("ActiveSessionsProvider", () => {
	beforeEach(() => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockReset();
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

	it("listWithDiagnostics on aggregator-throw flags every known source as failed", async () => {
		// When the aggregator itself throws (not just one source loader),
		// every source is effectively unavailable. Returning failedSources:
		// [] would tell the webview "0 of 7 failed" — indistinguishable from
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
			"claude",
			"cline",
			"cline-cli",
			"codex",
			"copilot",
			"copilot-chat",
			"cursor",
			"devin",
			"gemini",
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
