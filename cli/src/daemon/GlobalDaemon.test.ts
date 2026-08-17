import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHandshakeLine, readHandshakeLine } from "../core/DaemonHandshake.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { defaultTasks, runGlobalDaemon } from "./GlobalDaemon.js";
import { parseGlobalDaemonHello } from "./GlobalDaemonProtocol.js";
import { SESSION_RESCAN_TASK_NAME, SESSION_RESCAN_TICK_MS } from "./SessionRescanTask.js";
import type { DaemonTask } from "./TaskScheduler.js";

// `defaultTasks`' backup task calls the real snapshot engine, which touches
// the machine's actual jollimemory.db — mocked so exercising both of its
// result branches never writes outside this test's control.
vi.mock("../dashboard/Backup.js", () => ({
	opportunisticSnapshot: vi.fn(),
}));

// The other default task re-scans agent conversations, and its first act is to read
// this machine's repo registry — after which it would open the real dashboard
// database. An empty registry makes it a no-op that still exercises the wiring under
// test (the scheduler really does tick it), which mocking the task away would not.
// Only this one export is replaced; `existingWorktrees` and the rest stay real.
vi.mock("../dashboard/RepoRegistry.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../dashboard/RepoRegistry.js")>()),
	listActiveRepos: vi.fn(async () => []),
}));

// Only the ownership gate is faked; every other handshake helper stays real —
// same technique `McpDaemon.test.ts` uses for the sibling daemon's identical
// safety gate. Defaults to "safe" so none of the scratch-path tests below (all
// outside the managed directory, so `isInSocketDir` alone already short-circuits
// this) are affected.
const isSocketDirSafeMock = vi.fn(() => true);
vi.mock("../core/DaemonHandshake.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/DaemonHandshake.js")>()),
	isSocketDirSafe: () => isSocketDirSafeMock(),
}));

/**
 * Every test below that reaches `startDaemon` binds a real listener at a
 * FILESYSTEM path, which Windows cannot do — and because `startDaemon` awaits
 * `onListening`, which the `listen` error path never fires, a win32 run presents
 * as a HANG rather than a red test. Same guard, same reason, as the sibling
 * daemon's `McpDaemon.test.ts` / `McpProxy.test.ts`.
 *
 * A stopgap, not the end state: real Windows coverage needs the harness to bind
 * `\\.\pipe\<unique>` instead, which additionally has to account for the two
 * tests below that are unix-only by subject (a socket directory's mode bits, and
 * a stale socket FILE left on disk — a named pipe has neither).
 */
const describeUnixSocket = describe.skipIf(process.platform === "win32");

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "jolli-globald-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

/** Connects and reads the daemon's hello line. */
async function connectAndRead(socketPath: string): Promise<{ socket: Socket; hello: string | undefined }> {
	const socket = await new Promise<Socket>((resolve, reject) => {
		const s = connect(socketPath);
		s.once("connect", () => resolve(s));
		s.once("error", reject);
	});
	const read = await readHandshakeLine(socket, 5_000);
	return { socket, hello: read?.line };
}

/** Starts a daemon on a scratch socket and resolves once it is bound. */
function startDaemon(
	socketPath: string,
	tasks: ReadonlyArray<DaemonTask> = [],
): { exit: Promise<string>; listening: Promise<void> } {
	let signalListening: () => void = () => {};
	const listening = new Promise<void>((resolve) => {
		signalListening = resolve;
	});
	const exit = runGlobalDaemon({ socketPath, tasks, onListening: () => signalListening() });
	return { exit, listening };
}

describeUnixSocket("runGlobalDaemon", () => {
	it("greets a connecting client with a hello carrying its version and pid", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const { socket, hello } = await connectAndRead(socketPath);
		const parsed = parseGlobalDaemonHello(hello ?? "");

		expect(parsed?.pid).toBe(process.pid);
		expect(typeof parsed?.version).toBe("string");
		expect(parsed?.startedAt).toBeGreaterThan(0);

		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("exits with 'retired' when a client asks it to stand down", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));

		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("keeps running when a client attaches and disconnects", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const first = await connectAndRead(socketPath);
		first.socket.write(encodeHandshakeLine({ t: "attach" }));
		first.socket.destroy();

		// Still serving: a second client gets a hello too.
		const second = await connectAndRead(socketPath);
		expect(parseGlobalDaemonHello(second.hello ?? "")).toBeDefined();

		second.socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		second.socket.destroy();
	});

	it("keeps running when a client connects and says nothing", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const probe = await connectAndRead(socketPath);
		probe.socket.destroy(); // the trigger's "I only wanted to know you exist" path

		const second = await connectAndRead(socketPath);
		expect(parseGlobalDaemonHello(second.hello ?? "")).toBeDefined();

		second.socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		second.socket.destroy();
	});

	it("answers 'address-in-use' rather than throwing when another daemon holds the socket", async () => {
		const socketPath = join(scratch, "d.sock");
		const first = startDaemon(socketPath);
		await first.listening;

		// Losing the bind race is the SUCCESS case from the caller's viewpoint:
		// a daemon for this user exists, which is all anyone wanted.
		await expect(runGlobalDaemon({ socketPath, tasks: [] })).resolves.toBe("address-in-use");

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(first.exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("runs its registered tasks once at startup", async () => {
		const socketPath = join(scratch, "d.sock");
		const run = vi.fn(async () => "snapshot skipped");
		const { exit, listening } = startDaemon(socketPath, [{ name: "backup", tickIntervalMs: 3_600_000, run }]);
		await listening;

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("answers 'listen-failed' when the socket directory refuses the bind, not just EADDRINUSE", async () => {
		// Distinct from the address-in-use case above: this is a listen() error
		// with a code other than EADDRINUSE, which must resolve "listen-failed"
		// rather than being mistaken for a live sibling daemon.
		const unwritable = join(scratch, "unwritable");
		await mkdir(unwritable);
		await chmod(unwritable, 0o500);
		const socketPath = join(unwritable, "d.sock");

		try {
			await expect(runGlobalDaemon({ socketPath, tasks: [] })).resolves.toBe("listen-failed");
		} finally {
			await chmod(unwritable, 0o700);
		}
	});

	it("runs defaultTasks() when no tasks are supplied", async () => {
		// Omits `tasks` entirely (not `[]`) so the `options.tasks ?? defaultTasks()`
		// fallback itself is exercised, not just `defaultTasks()`'s own body.
		const socketPath = join(scratch, "d.sock");
		const mockedSnapshot = vi.mocked(opportunisticSnapshot);
		mockedSnapshot.mockResolvedValue({ status: "skipped", reason: "not due" });

		let signalListening: () => void = () => {};
		const listening = new Promise<void>((resolve) => {
			signalListening = resolve;
		});
		const exit = runGlobalDaemon({ socketPath, onListening: () => signalListening() });
		await listening;

		await vi.waitFor(() => expect(mockedSnapshot).toHaveBeenCalled());

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("guards finish() against a second retire racing the first", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const first = await connectAndRead(socketPath);
		const second = await connectAndRead(socketPath);

		// Both clients ask to retire. Whichever's greeting is processed second
		// must hit finish()'s already-settled guard rather than resolving or
		// logging the exit a second time.
		first.socket.write(encodeHandshakeLine({ t: "retire" }));
		second.socket.write(encodeHandshakeLine({ t: "retire" }));

		await expect(exit).resolves.toBe("retired");
		first.socket.destroy();
		second.socket.destroy();
	});
});

/**
 * Deliberately NOT under `describeUnixSocket`: this reaches no socket at all, so
 * it is real coverage on every platform. Keeping it outside the guard is the
 * same split `McpProxy.test.ts` makes — a whole-file skip would silently stop
 * testing the task wiring on Windows.
 */
describe("runGlobalDaemon — decisions taken before any bind", () => {
	it("defaultTasks' backup task reports the snapshot outcome for both branches", async () => {
		const mockedSnapshot = vi.mocked(opportunisticSnapshot);
		const [task] = defaultTasks();

		mockedSnapshot.mockResolvedValueOnce({ status: "created", path: "/tmp/memory-x.db" });
		await expect(task.run()).resolves.toBe("created /tmp/memory-x.db");

		mockedSnapshot.mockResolvedValueOnce({ status: "skipped", reason: "too soon" });
		await expect(task.run()).resolves.toBe("skipped: too soon");
	});

	it("carries the session re-scan at its declared interval", async () => {
		// A unit test cannot see a task that was never registered, so the presence of this
		// entry — and that its period is the constant rather than a literal — is pinned
		// here rather than inferred from the re-scan's own tests.
		const rescan = defaultTasks().find((task) => task.name === SESSION_RESCAN_TASK_NAME);

		expect(rescan).toBeDefined();
		expect(rescan?.tickIntervalMs).toBe(SESSION_RESCAN_TICK_MS);
	});

	it("the session re-scan reports an idle tick when no repo is registered", async () => {
		// The whole point of the empty-registry mock above: the task runs for real, takes
		// its earliest exit, and never reaches the dashboard database.
		const rescan = defaultTasks().find((task) => task.name === SESSION_RESCAN_TASK_NAME);

		await expect(rescan?.run()).resolves.toBe("no registered repos");
	});
});

/**
 * The ownership gate is `isInSocketDir(path, dir) && !isSocketDirSafe(dir, uid)`,
 * and `isInSocketDir` returns false on win32 unconditionally — a named pipe has
 * no directory to police — so the gate CANNOT fire there and this test cannot be
 * platform-neutral however carefully it is written. Left outside the guard it
 * does not merely fail on Windows: `runGlobalDaemon` falls through to bind the
 * machine's REAL default pipe and then waits for a retire nobody sends, so the
 * run HANGS to the suite timeout rather than going red.
 */
describeUnixSocket("runGlobalDaemon — the socket-directory ownership gate", () => {
	it("refuses to bind the derived socket when its directory is not exclusively this user's", async () => {
		// Omitting `socketPath` forces the real `globalSocketPath()` fallback, and
		// forcing `isSocketDirSafe` false makes that real derived path land inside
		// its own managed directory while failing the ownership check — the
		// combined guard the production gate exists to run. `globalSocketPath` is
		// deliberately NOT redirected to a scratch path here (the technique
		// `EnsureGlobalDaemon.test.ts` uses): the gate is `isInSocketDir(path) &&
		// !isSocketDirSafe(...)`, so a scratch path fails the first half and the
		// branch under test never runs.
		const onListening = vi.fn();
		isSocketDirSafeMock.mockReturnValueOnce(false);

		await expect(runGlobalDaemon({ tasks: [], onListening })).resolves.toBe("unsafe-socket-dir");
		// "Returned before `server.listen()` was ever reached" asserted through the
		// daemon's OWN signal, not through `existsSync(globalSocketPath())`. That
		// path is this machine's real global socket, and a developer dogfooding the
		// CLI has a live daemon bound on it — the trigger fires from the CLI tail —
		// so the file-existence form failed on every such machine while staying
		// green in CI, which has no daemon. It could also never distinguish "we did
		// not bind" from "someone else already had".
		expect(onListening).not.toHaveBeenCalled();
	});
});
