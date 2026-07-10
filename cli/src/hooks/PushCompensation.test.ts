import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processPushPending } from "../core/PushExecutor.js";
import { triggerPendingPushRetry } from "./PushCompensation.js";

vi.mock("../core/PushExecutor.js", () => ({ processPushPending: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("triggerPendingPushRetry", () => {
	it("drains push-pending with the activation source", async () => {
		vi.mocked(processPushPending).mockResolvedValue({
			attempted: 2,
			pushed: 2,
			failed: 0,
			skippedNoMemory: 0,
			skippedRetryExhausted: 0,
			deletedChildren: 0,
		});
		await triggerPendingPushRetry("/repo");
		expect(processPushPending).toHaveBeenCalledWith("/repo", { source: "activation" });
	});

	it("never throws when the drain fails", async () => {
		vi.mocked(processPushPending).mockRejectedValue(new Error("boom"));
		await expect(triggerPendingPushRetry("/repo")).resolves.toBeUndefined();
	});
});
