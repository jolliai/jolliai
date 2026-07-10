import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeEntries } from "../core/PushPendingStore.js";
import { loadConfig } from "../core/SessionTracker.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import { parsePushRefs, prePushEntry } from "./PrePushHook.js";
import { launchPrePushWorker } from "./PrePushWorker.js";

vi.mock("../core/SessionTracker.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../core/PushPendingStore.js", () => ({ mergeEntries: vi.fn() }));
vi.mock("./PrePushWorker.js", () => ({ launchPrePushWorker: vi.fn() }));
vi.mock("../util/Subprocess.js", () => ({ execFileAsyncHidden: vi.fn() }));

const CWD = "/repo";
const ZERO = "0".repeat(40);
const LOCAL = "1".repeat(40);
const REMOTE = "2".repeat(40);
const REMOTE_NAME = "origin";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x" });
	vi.mocked(mergeEntries).mockResolvedValue(undefined);
	vi.mocked(execFileAsyncHidden).mockResolvedValue({ stdout: "c1\nc2\n", stderr: "" });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parsePushRefs", () => {
	it("parses well-formed lines and skips blanks/short lines", () => {
		const stdin = `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n\nbad line\n`;
		const refs = parsePushRefs(stdin);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ localRef: "refs/heads/x", localSha: LOCAL, remoteSha: REMOTE });
	});
});

describe("prePushEntry", () => {
	it("no-ops entirely when syncOnPush is false (no file write, no worker)", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x", syncOnPush: false });
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
		expect(launchPrePushWorker).not.toHaveBeenCalled();
	});

	it("records commits but does NOT spawn the worker when not signed in", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).toHaveBeenCalledWith(CWD, ["c1", "c2"], "x", {
			remote: REMOTE_NAME,
			remoteRef: "refs/heads/x",
			localSha: LOCAL,
		});
		expect(launchPrePushWorker).not.toHaveBeenCalled();
	});

	it("records commits and spawns the worker when signed in", async () => {
		await prePushEntry(CWD, `refs/heads/feature/y ${LOCAL} refs/heads/feature/y ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).toHaveBeenCalledWith(CWD, ["c1", "c2"], "feature/y", {
			remote: REMOTE_NAME,
			remoteRef: "refs/heads/feature/y",
			localSha: LOCAL,
		});
		expect(launchPrePushWorker).toHaveBeenCalledWith(CWD);
	});

	it("skips delete pushes (all-zero local sha)", async () => {
		await prePushEntry(CWD, `(delete) ${ZERO} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
		expect(launchPrePushWorker).not.toHaveBeenCalled();
	});

	it("uses --not --remotes for a brand-new remote branch (zero remote sha)", async () => {
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${ZERO}\n`, REMOTE_NAME);
		const args = vi.mocked(execFileAsyncHidden).mock.calls[0][1];
		expect(args).toEqual(["rev-list", "--reverse", LOCAL, "--not", "--remotes"]);
	});

	it("uses the remote..local range for an existing remote branch", async () => {
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		const args = vi.mocked(execFileAsyncHidden).mock.calls[0][1];
		expect(args).toEqual(["rev-list", "--reverse", `${REMOTE}..${LOCAL}`]);
	});

	it("no-ops when rev-list yields no commits", async () => {
		vi.mocked(execFileAsyncHidden).mockResolvedValue({ stdout: "\n", stderr: "" });
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
		expect(launchPrePushWorker).not.toHaveBeenCalled();
	});

	it("tolerates a git rev-list failure (logs, skips that ref)", async () => {
		vi.mocked(execFileAsyncHidden).mockRejectedValue(new Error("git boom"));
		await prePushEntry(CWD, `refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).not.toHaveBeenCalled();
	});

	it("keeps a non-heads ref name as-is (e.g. a tag push)", async () => {
		await prePushEntry(CWD, `refs/tags/v1 ${LOCAL} refs/tags/v1 ${REMOTE}\n`, REMOTE_NAME);
		expect(mergeEntries).toHaveBeenCalledWith(CWD, ["c1", "c2"], "refs/tags/v1", {
			remote: REMOTE_NAME,
			remoteRef: "refs/tags/v1",
			localSha: LOCAL,
		});
	});

	it("records a separate confirmation target for each pushed ref update", async () => {
		const other = "3".repeat(40);
		await prePushEntry(
			CWD,
			`refs/heads/x ${LOCAL} refs/heads/x ${REMOTE}\nrefs/heads/x ${other} refs/heads/x ${REMOTE}\n`,
			REMOTE_NAME,
		);
		const branchCalls = vi.mocked(mergeEntries).mock.calls.filter((c) => c[2] === "x");
		expect(branchCalls).toHaveLength(2);
		expect(branchCalls.map((call) => call[3]?.localSha)).toEqual([LOCAL, other]);
	});
});
