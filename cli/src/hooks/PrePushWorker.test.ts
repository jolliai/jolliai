import { describe, expect, it, vi } from "vitest";
import { type ProcessPushPendingResult, processPushPending } from "../core/PushExecutor.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { runPushWorker } from "./PrePushWorker.js";

vi.mock("../core/PushExecutor.js", () => ({ processPushPending: vi.fn() }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: vi.fn().mockResolvedValue(false) }));

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

	it("does nothing when the repository is manually disabled", async () => {
		vi.mocked(readManualDisableFlag).mockResolvedValueOnce(true);
		await runPushWorker("/repo");
		expect(processPushPending).not.toHaveBeenCalled();
	});
});
