import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on track() but keep the real bucket() so we assert on real bucket labels.
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../../../cli/src/core/Telemetry.js", async (importActual) => ({
	...(await importActual<typeof import("../../../cli/src/core/Telemetry.js")>()),
	track,
}));

import { trackMemoryCommitted } from "./UiTelemetry.js";

beforeEach(() => vi.clearAllMocks());

describe("trackMemoryCommitted", () => {
	it("emits memory_committed with bucketed counts + has_conversations=true", async () => {
		await trackMemoryCommitted({
			getFilesCount: () => 3,
			getContextCount: () => 0,
			listConversations: async () => [{}, {}],
		});
		expect(track).toHaveBeenCalledWith("memory_committed", {
			files_bucket: "1-5",
			has_conversations: true,
			context_bucket: "0",
		});
	});

	it("reports has_conversations=false when there are none", async () => {
		await trackMemoryCommitted({
			getFilesCount: () => 0,
			getContextCount: () => 25,
			listConversations: async () => [],
		});
		expect(track).toHaveBeenCalledWith("memory_committed", {
			files_bucket: "0",
			has_conversations: false,
			context_bucket: "21-100",
		});
	});

	it("never throws and does not emit when gathering fails", async () => {
		await expect(
			trackMemoryCommitted({
				getFilesCount: () => {
					throw new Error("snapshot unavailable");
				},
				getContextCount: () => 1,
				listConversations: async () => [],
			}),
		).resolves.toBeUndefined();
		expect(track).not.toHaveBeenCalled();
	});
});
