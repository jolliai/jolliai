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

import { listActiveConversationsWithDiagnostics } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { ActiveSessionsProvider } from "./ActiveSessionsProvider.js";

describe("ActiveSessionsProvider", () => {
	beforeEach(() => {
		vi.mocked(listActiveConversationsWithDiagnostics).mockReset();
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
			"codex",
			"copilot",
			"copilot-chat",
			"cursor",
			"gemini",
			"opencode",
		]);
	});
});
