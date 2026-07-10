import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processPushPending } from "../core/PushExecutor.js";
import { runPushWorker } from "./PrePushWorker.js";

vi.mock("../core/PushExecutor.js", () => ({ processPushPending: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(processPushPending).mockResolvedValue({
		attempted: 0,
		pushed: 0,
		failed: 0,
		skippedNoMemory: 0,
		skippedRetryExhausted: 0,
		deletedChildren: 0,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPushWorker", () => {
	it("drains push-pending with the pre-push source", async () => {
		await runPushWorker("/repo");
		expect(processPushPending).toHaveBeenCalledWith("/repo", { source: "pre-push" });
	});
});
