import { describe, expect, it, vi } from "vitest";
import { monitorRun, realSleep } from "./WorkflowRunMonitor.js";
import { PlatformToolUnavailableError, type WorkflowRunPayload } from "./WorkflowRunReport.js";

/** A minimal running (`active`) payload carrying a workflow deep-link. */
function running(overrides: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload {
	return { id: "run_1", status: "active", workflowUrl: "https://jolli.ai/w/1", ...overrides };
}

/** Fast opts so the timeout/backoff branches run without real waits or 40 iterations. */
const FAST = { maxAttempts: 5, maxTransientRetries: 2, baseDelayMs: 1, maxDelayMs: 4 } as const;

describe("monitorRun", () => {
	it("polls until terminal and returns the succeeded report (no trailing sleep on terminal)", async () => {
		const getRunStatus = vi
			.fn()
			.mockResolvedValueOnce(running())
			.mockResolvedValueOnce(running())
			.mockResolvedValueOnce(
				running({
					status: "completed",
					writtenArticles: [{ operation: "created", path: "a.md", url: "https://jolli.ai/a", active: true }],
				}),
			);
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("succeeded");
		expect(report.timedOut).toBeUndefined();
		expect(report.openableUrls).toEqual([
			{ kind: "workflow", url: "https://jolli.ai/w/1" },
			{ kind: "article", url: "https://jolli.ai/a", label: "a.md" },
		]);
		expect(getRunStatus).toHaveBeenCalledTimes(3);
		// Slept once between each of the two non-terminal polls; not after the terminal poll.
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("returns a failed report with troubleshooting on an immediate failed status", async () => {
		const getRunStatus = vi
			.fn()
			.mockResolvedValue(running({ status: "failed", error: "code=TIMEOUT: agent stalled" }));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("failed");
		expect(report.troubleshooting).toBe("code=TIMEOUT: agent stalled");
		expect(sleep).not.toHaveBeenCalled();
	});

	it("returns cancel attribution on a cancelled status", async () => {
		const getRunStatus = vi
			.fn()
			.mockResolvedValue(
				running({ status: "cancelled", canceledBy: "Doug", canceledAt: "2026-07-17T00:00:00Z" }),
			);
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("cancelled");
		expect(report.cancel).toEqual({ by: "Doug", at: "2026-07-17T00:00:00Z" });
	});

	it("returns a timedOut running report (with the last workflow URL) when the attempt cap is hit", async () => {
		const getRunStatus = vi.fn().mockResolvedValue(running());
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("running");
		expect(report.timedOut).toBe(true);
		expect(report.openableUrls).toEqual([{ kind: "workflow", url: "https://jolli.ai/w/1" }]);
		expect(getRunStatus).toHaveBeenCalledTimes(5);
	});

	it("returns a timedOut report with no openable URLs when no payload carried a workflow URL", async () => {
		const getRunStatus = vi.fn().mockResolvedValue(running({ workflowUrl: undefined }));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("running");
		expect(report.timedOut).toBe(true);
		expect(report.openableUrls).toEqual([]);
	});

	it("includes the run deep-link (not just the workflow URL) in a timedOut report when the payload carried one", async () => {
		const getRunStatus = vi.fn().mockResolvedValue(running({ runUrl: "https://jolli.ai/w/1/r/run_1" }));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("running");
		expect(report.timedOut).toBe(true);
		// The run URL points straight at the still-in-progress run for the user to watch.
		expect(report.openableUrls).toEqual([
			{ kind: "workflow", url: "https://jolli.ai/w/1" },
			{ kind: "run", url: "https://jolli.ai/w/1/r/run_1" },
		]);
	});

	it("does not sleep after the final attempt (the trailing backoff would poll nothing)", async () => {
		const getRunStatus = vi.fn().mockResolvedValue(running());
		const sleep = vi.fn().mockResolvedValue(undefined);

		await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		// maxAttempts=5 non-terminal polls ⇒ a sleep between each of the first four,
		// but NOT after the fifth (the loop exits straight into the timedOut report).
		expect(getRunStatus).toHaveBeenCalledTimes(5);
		expect(sleep).toHaveBeenCalledTimes(4);
	});

	it("re-throws a PlatformToolUnavailableError immediately without retrying or sleeping", async () => {
		const getRunStatus = vi
			.fn()
			.mockRejectedValue(new PlatformToolUnavailableError('Platform tool "get_run_status" is unavailable.'));
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(monitorRun({ getRunStatus, sleep }, "run_1", FAST)).rejects.toBeInstanceOf(
			PlatformToolUnavailableError,
		);
		// Permanent error ⇒ fail fast: one call, no transient retries, no backoff.
		expect(getRunStatus).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("retries a transient throw then succeeds", async () => {
		const getRunStatus = vi
			.fn()
			.mockRejectedValueOnce(new Error("network blip"))
			.mockResolvedValueOnce(running({ status: "completed" }));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1", FAST);

		expect(report.status).toBe("succeeded");
		expect(getRunStatus).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("re-throws a persistent getRunStatus failure past the transient-retry budget", async () => {
		const getRunStatus = vi.fn().mockRejectedValue(new Error("platform tools off"));
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(monitorRun({ getRunStatus, sleep }, "run_1", FAST)).rejects.toThrow("platform tools off");
		// maxTransientRetries=2 ⇒ failures at count 1,2 retried, count 3 (>2) re-throws.
		expect(getRunStatus).toHaveBeenCalledTimes(3);
	});

	it("uses default bounds/backoff (cap applied on later attempts) when no opts are given", async () => {
		// Six non-terminal polls then completed exercises the maxDelayMs cap
		// (base 2000·2^attempt exceeds 15000 by attempt 3) under default options.
		const getRunStatus = vi.fn();
		for (let i = 0; i < 6; i++) {
			getRunStatus.mockResolvedValueOnce(running());
		}
		getRunStatus.mockResolvedValueOnce(running({ status: "completed" }));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const report = await monitorRun({ getRunStatus, sleep }, "run_1");

		expect(report.status).toBe("succeeded");
		expect(getRunStatus).toHaveBeenCalledTimes(7);
		// The delay ceiling (15000) was reached on the later attempts.
		expect(Math.max(...sleep.mock.calls.map((c) => c[0] as number))).toBe(15000);
	});

	it("realSleep resolves after the given delay", async () => {
		await expect(realSleep(0)).resolves.toBeUndefined();
	});
});
