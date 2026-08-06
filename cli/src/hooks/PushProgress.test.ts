import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitPushOutcome } from "../core/PushExecutor.js";
import { captureProgressDir } from "./CaptureProgress.js";
import {
	acquirePushLock,
	isPushWorkerDead,
	type PushWorkerResult,
	pushLockPath,
	pushRequestPath,
	pushResultPath,
	readPushRequest,
	readPushResult,
	reasonFromNote,
	releasePushLock,
	watchPushResult,
	writePushRequest,
	writePushResult,
} from "./PushProgress.js";

const PUSH_ID = "trace-1";
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

let cwd: string;

beforeEach(async () => {
	cwd = join(
		tmpdir(),
		`pushprog-${process.pid}-${Math.floor(Date.now() % 1e9)}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(cwd, { recursive: true, force: true });
});

function outcome(hash: string, over: Partial<CommitPushOutcome> = {}): CommitPushOutcome {
	return { hash, status: "pushed", ...over };
}

function result(over: Partial<PushWorkerResult> = {}): PushWorkerResult {
	return { pushId: PUSH_ID, commits: [], complete: true, ...over };
}

describe("request hand-off", () => {
	it("round-trips the work list", () => {
		writePushRequest(cwd, { pushId: PUSH_ID, hashes: [HASH_A, HASH_B] });
		expect(readPushRequest(cwd, PUSH_ID)).toEqual({ pushId: PUSH_ID, hashes: [HASH_A, HASH_B] });
	});

	it("returns undefined when the worker has no request file", () => {
		expect(readPushRequest(cwd, PUSH_ID)).toBeUndefined();
	});

	it("rejects a request whose pushId does not match the one being read", () => {
		// A stale file from an earlier push must not be mistaken for this push's
		// work list — that would drain the wrong commits.
		writePushRequest(cwd, { pushId: "other-push", hashes: [HASH_A] });
		writeFileSync(pushRequestPath(cwd, PUSH_ID), JSON.stringify({ pushId: "other-push", hashes: [HASH_A] }));
		expect(readPushRequest(cwd, PUSH_ID)).toBeUndefined();
	});

	it("rejects malformed hash lists rather than degrading to an empty drain", () => {
		// Silently reading these as "no work" is indistinguishable from a
		// legitimately empty push, so the worker could never report the difference.
		const write = (body: unknown) => {
			mkdirSync(captureProgressDir(cwd), { recursive: true });
			writeFileSync(pushRequestPath(cwd, PUSH_ID), JSON.stringify(body));
		};
		write({ pushId: PUSH_ID, hashes: "not-an-array" });
		expect(readPushRequest(cwd, PUSH_ID)).toBeUndefined();
		write({ pushId: PUSH_ID, hashes: [HASH_A, 42] });
		expect(readPushRequest(cwd, PUSH_ID)).toBeUndefined();
		write({ pushId: PUSH_ID, hashes: [""] });
		expect(readPushRequest(cwd, PUSH_ID)).toBeUndefined();
	});

	it("returns undefined for a torn or corrupt file", () => {
		mkdirSync(captureProgressDir(cwd), { recursive: true });
		writeFileSync(pushRequestPath(cwd, PUSH_ID), "{ not json");
		expect(readPushRequest(cwd, PUSH_ID)).toBeUndefined();
	});

	it("clears the previous run's result and lock when the same pushId comes back", () => {
		// A pushId is the ambient trace id whenever one is set, so uniqueness is not
		// something this protocol enforces. Left in place, the old `complete: true`
		// result would be read as THIS push's outcome (announcing commits it never
		// sent) and the old dead-pid lock would report its worker as interrupted
		// before it even started.
		writePushResult(cwd, result({ commits: [outcome(HASH_A)] }));
		writeFileSync(pushLockPath(cwd, PUSH_ID), "999999");

		writePushRequest(cwd, { pushId: PUSH_ID, hashes: [HASH_B] });

		expect(readPushResult(cwd, PUSH_ID)).toBeUndefined();
		expect(existsSync(pushLockPath(cwd, PUSH_ID))).toBe(false);
		expect(readPushRequest(cwd, PUSH_ID)).toEqual({ pushId: PUSH_ID, hashes: [HASH_B] });
	});

	it("throws when the work list cannot be written", () => {
		// The hook relies on this throwing to skip the spawn entirely instead of
		// waiting out its budget for a result that can never arrive. Rooting the
		// path at a FILE makes the directory creation fail for real.
		const blocked = join(cwd, "not-a-dir");
		writeFileSync(blocked, "x");
		expect(() => writePushRequest(blocked, { pushId: PUSH_ID, hashes: [HASH_A] })).toThrow();
	});
});

describe("result hand-off", () => {
	it("round-trips a published result", () => {
		writePushResult(cwd, result({ commits: [outcome(HASH_A, { url: "https://jolli.ai/a" })] }));
		const read = readPushResult(cwd, PUSH_ID);
		expect(read?.complete).toBe(true);
		expect(read?.commits).toEqual([{ hash: HASH_A, status: "pushed", url: "https://jolli.ai/a" }]);
	});

	it("returns undefined before the worker's first publish", () => {
		expect(readPushResult(cwd, PUSH_ID)).toBeUndefined();
	});

	it("rejects a result belonging to a different push", () => {
		writePushResult(cwd, result({ pushId: "other-push" }));
		writeFileSync(
			pushResultPath(cwd, PUSH_ID),
			JSON.stringify({ pushId: "other-push", commits: [], complete: true }),
		);
		expect(readPushResult(cwd, PUSH_ID)).toBeUndefined();
	});

	it("publishes atomically so a reader never sees a partial file", () => {
		writePushResult(cwd, result({ commits: [outcome(HASH_A)] }));
		// temp + rename: the scratch file must not survive a successful write.
		expect(existsSync(`${pushResultPath(cwd, PUSH_ID)}.tmp`)).toBe(false);
		expect(JSON.parse(readFileSync(pushResultPath(cwd, PUSH_ID), "utf-8")).commits).toHaveLength(1);
	});

	it("swallows publish failures — a result nobody reads must not break the drain", () => {
		// Same unwritable-root trick as above; here the failure must be absorbed,
		// because the push it describes has already happened.
		const blocked = join(cwd, "also-not-a-dir");
		writeFileSync(blocked, "x");
		expect(() => writePushResult(blocked, result())).not.toThrow();
	});
});

describe("worker liveness", () => {
	it("treats an absent lock as alive, not dead", async () => {
		// The worker may simply not have started yet; reporting "dead" here would
		// make the hook announce an interruption that never happened.
		await expect(isPushWorkerDead(cwd, PUSH_ID)).resolves.toBe(false);
	});

	it("treats a lock owned by a running process as alive", async () => {
		acquirePushLock(cwd, PUSH_ID);
		expect(readFileSync(pushLockPath(cwd, PUSH_ID), "utf-8")).toBe(String(process.pid));
		await expect(isPushWorkerDead(cwd, PUSH_ID)).resolves.toBe(false);
	});

	it("reports a lock whose owner is gone as dead", async () => {
		mkdirSync(captureProgressDir(cwd), { recursive: true });
		// A PID far outside any plausible live range stands in for a killed worker.
		writeFileSync(pushLockPath(cwd, PUSH_ID), "999999");
		await expect(isPushWorkerDead(cwd, PUSH_ID)).resolves.toBe(true);
	});

	it("releases only a lock this process owns", async () => {
		mkdirSync(captureProgressDir(cwd), { recursive: true });
		writeFileSync(pushLockPath(cwd, PUSH_ID), "999999");
		await releasePushLock(cwd, PUSH_ID);
		// A successor's lock must survive a stale release from a previous run.
		expect(existsSync(pushLockPath(cwd, PUSH_ID))).toBe(true);

		acquirePushLock(cwd, PUSH_ID);
		await releasePushLock(cwd, PUSH_ID);
		expect(existsSync(pushLockPath(cwd, PUSH_ID))).toBe(false);
	});
});

describe("reasonFromNote", () => {
	it("translates every short-circuit note into user-facing wording", () => {
		expect(reasonFromNote("not signed in")).toBe("not signed in to Jolli");
		expect(reasonFromNote("push disabled for this repo")).toBe("outbound push disabled for this repo");
		expect(reasonFromNote("syncOnPush disabled")).toBe("push sync is turned off");
		expect(reasonFromNote("all entries claimed by another process")).toBe(
			"another sync is already handling this commit",
		);
		expect(reasonFromNote("push not confirmed")).toBe("push not confirmed on the remote");
		expect(reasonFromNote("no pending entries")).toBe("nothing left to sync");
		expect(reasonFromNote("no eligible entries")).toBe("nothing left to sync");
	});

	it("points at the log when there is no note at all", () => {
		// Every known short-circuit sets a note, so an unreported hash without one
		// is a genuine anomaly rather than an expected outcome.
		expect(reasonFromNote(undefined)).toContain("debug.log");
	});

	it("passes an unrecognised note through verbatim", () => {
		expect(reasonFromNote("ECONNRESET")).toBe("ECONNRESET");
	});
});

describe("watchPushResult", () => {
	const noSleep = async () => {};

	it("returns as soon as the worker reports completion", async () => {
		const watch = await watchPushResult(cwd, PUSH_ID, {
			deadlineAt: Date.now() + 60_000,
			sleep: noSleep,
			readResult: () => result({ commits: [outcome(HASH_A)] }),
		});
		expect(watch.ended).toBe("complete");
		expect(watch.result?.commits).toHaveLength(1);
	});

	it("keeps polling while the result is still incomplete", async () => {
		let reads = 0;
		const watch = await watchPushResult(cwd, PUSH_ID, {
			deadlineAt: Date.now() + 60_000,
			sleep: noSleep,
			readResult: () => {
				reads++;
				return reads < 3 ? result({ complete: false, commits: [outcome(HASH_A)] }) : result({ complete: true });
			},
		});
		expect(reads).toBe(3);
		expect(watch.ended).toBe("complete");
	});

	it("returns the last partial result it saw when the deadline passes", async () => {
		// The hook prints these: giving up must never discard commits that landed.
		let now = 0;
		const watch = await watchPushResult(cwd, PUSH_ID, {
			deadlineAt: 100,
			sleep: noSleep,
			now: () => {
				now += 60;
				return now;
			},
			readResult: () => result({ complete: false, commits: [outcome(HASH_A)] }),
		});
		expect(watch.ended).toBe("timeout");
		expect(watch.result?.commits).toEqual([{ hash: HASH_A, status: "pushed" }]);
	});

	it("reports a timeout with no result when the worker never published", async () => {
		const watch = await watchPushResult(cwd, PUSH_ID, {
			deadlineAt: Date.now() - 1,
			sleep: noSleep,
			readResult: () => undefined,
		});
		expect(watch.ended).toBe("timeout");
		expect(watch.result).toBeUndefined();
	});

	it("stops early on a dead worker and still returns what it saw", async () => {
		const watch = await watchPushResult(cwd, PUSH_ID, {
			deadlineAt: Date.now() + 60_000,
			sleep: noSleep,
			readResult: () => result({ complete: false, commits: [outcome(HASH_A)] }),
			workerDead: async () => true,
		});
		expect(watch.ended).toBe("worker-dead");
		expect(watch.result?.commits).toHaveLength(1);
	});

	it("prefers a final result over a dead worker seen in the same tick", async () => {
		// The worker publishes then exits; probing liveness first would report an
		// interruption for a run that actually finished.
		const watch = await watchPushResult(cwd, PUSH_ID, {
			deadlineAt: Date.now() + 60_000,
			sleep: noSleep,
			readResult: () => result({ complete: true, commits: [outcome(HASH_A)] }),
			workerDead: async () => true,
		});
		expect(watch.ended).toBe("complete");
	});

	it("reads through the real files when no seams are injected", async () => {
		writePushResult(cwd, result({ commits: [outcome(HASH_B)] }));
		const watch = await watchPushResult(cwd, PUSH_ID, { deadlineAt: Date.now() + 60_000, sleep: noSleep });
		expect(watch.ended).toBe("complete");
		expect(watch.result?.commits[0].hash).toBe(HASH_B);
	});
});
