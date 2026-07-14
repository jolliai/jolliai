import { describe, expect, it, vi } from "vitest";
import { type ProcessPushPendingResult, processPushPending } from "../core/PushExecutor.js";
import { runPushWorker } from "./PrePushWorker.js";

vi.mock("../core/PushExecutor.js", () => ({ processPushPending: vi.fn() }));

const EMPTY_RESULT: ProcessPushPendingResult = {
	attempted: 0,
	pushed: 0,
	failed: 0,
	skippedNoMemory: 0,
	skippedRetryExhausted: 0,
	deletedChildren: 0,
};

describe("runPushWorker", () => {
	it("drains push-pending.json via the activation compensation path", async () => {
		vi.mocked(processPushPending).mockResolvedValue(EMPTY_RESULT);
		await runPushWorker("/repo", "cli-auth-login");
		expect(processPushPending).toHaveBeenCalledWith("/repo", { source: "activation" });
	});
});
