import { mkdir } from "node:fs/promises";
import { acquireWithPoll, refreshLockMtime, releaseIfOwned } from "../core/LockPrimitives.js";
import { captureLockPath, captureProgressDir } from "./CaptureProgress.js";

const CAPTURE_LOCK_POLL_MS = 100;
const CAPTURE_LOCK_REFRESH_MS = 60_000;

/**
 * Default wait window for contending on one commit's capture lock. Sized to
 * outlast a slow in-flight LLM summary so a loser blocks until the winner's
 * summary lands (then re-checks and skips) rather than racing it. Shared by the
 * detached {@link QueueWorker} drain and the in-process `CommitSummarizer` path.
 */
export const COMMIT_CAPTURE_LOCK_WAIT_MS = 15 * 60 * 1000;

export type CommitCaptureLockMode = "fail-fast" | { readonly wait: number };

/** Serializes live capture and back-fill generation for one commit hash. */
export async function withCommitCaptureLock<T>(
	cwd: string,
	hash: string,
	mode: CommitCaptureLockMode,
	body: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
	await mkdir(captureProgressDir(cwd), { recursive: true });
	const path = captureLockPath(cwd, hash);
	const acquired = await acquireWithPoll(path, {
		timeoutMs: mode === "fail-fast" ? 0 : mode.wait,
		pollMs: CAPTURE_LOCK_POLL_MS,
	});
	if (!acquired) return { ran: false };

	const refreshTimer = setInterval(() => {
		void refreshLockMtime(path);
	}, CAPTURE_LOCK_REFRESH_MS);
	refreshTimer.unref?.();
	try {
		return { ran: true, value: await body() };
	} finally {
		clearInterval(refreshTimer);
		await releaseIfOwned(path, "commit-capture.lock");
	}
}
