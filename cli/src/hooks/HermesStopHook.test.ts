import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isLocalAgentChild: vi.fn().mockReturnValue(false),
	resolveStateRoot: vi.fn((dir: string) => dir),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	saveSession: vi.fn().mockResolvedValue(undefined),
	recordSessionFromHook: vi.fn().mockResolvedValue(true),
	isGitHookInstalled: vi.fn().mockResolvedValue(true),
	isHermesInstalled: vi.fn().mockResolvedValue(true),
	discoverHermesSessions: vi.fn().mockResolvedValue([]),
	workerExists: vi.fn().mockReturnValue(true),
	spawnHidden: vi.fn(),
	childOnce: vi.fn(),
	childUnref: vi.fn(),
	readStdin: vi.fn().mockResolvedValue("{}"),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	setLogDir: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: Parameters<typeof actual.existsSync>[0]): boolean =>
			String(path).endsWith("HermesDiscoveryWorker.js") ? mocks.workerExists(path) : actual.existsSync(path),
	};
});
vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: mocks.isLocalAgentChild }));
vi.mock("../core/GitOps.js", () => ({ resolveStateRoot: mocks.resolveStateRoot }));
vi.mock("../core/HermesSessionDiscoverer.js", () => ({
	discoverHermesSessions: mocks.discoverHermesSessions,
	isHermesInstalled: mocks.isHermesInstalled,
}));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: mocks.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: mocks.loadConfig,
	saveSession: mocks.saveSession,
}));
vi.mock("../dashboard/ProducerHooks.js", () => ({ recordSessionFromHook: mocks.recordSessionFromHook }));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitHookInstalled: mocks.isGitHookInstalled }));
vi.mock("../util/Subprocess.js", () => ({ spawnHidden: mocks.spawnHidden }));
vi.mock("./HookUtils.js", () => ({ readStdin: mocks.readStdin }));
vi.mock("../Logger.js", () => ({
	createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error, debug: mocks.debug }),
	setLogDir: mocks.setLogDir,
}));

const { extractStopIdentity, main } = await import("./HermesStopHook.js");

const REPO = "/repo";
const SESSION_ID = "sess_abc123";
const DB_PATH = "/Users/me/.hermes/state.db";
const SYNTHETIC_PATH = `${DB_PATH}#${SESSION_ID}`;

/** A minimal on_session_end payload — the fields this hook reads plus the extras Hermes always sets. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		hook_event_name: "on_session_end",
		tool_name: "",
		tool_input: {},
		session_id: SESSION_ID,
		cwd: REPO,
		extra: { task_id: "t1", turn_id: 7, completed: true, interrupted: false },
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isLocalAgentChild.mockReturnValue(false);
	mocks.resolveStateRoot.mockImplementation((dir: string) => dir);
	mocks.readManualDisableFlag.mockResolvedValue(false);
	mocks.loadConfig.mockResolvedValue({});
	mocks.saveSession.mockResolvedValue(undefined);
	mocks.recordSessionFromHook.mockResolvedValue(true);
	mocks.isGitHookInstalled.mockResolvedValue(true);
	mocks.isHermesInstalled.mockResolvedValue(true);
	mocks.discoverHermesSessions.mockResolvedValue([]);
	mocks.workerExists.mockReturnValue(true);
	mocks.spawnHidden.mockReturnValue({ once: mocks.childOnce, unref: mocks.childUnref, pid: 1234 });
	mocks.readStdin.mockResolvedValue(JSON.stringify(payload()));
});

describe("extractStopIdentity", () => {
	it("reads session_id and cwd from a real on_session_end payload", () => {
		expect(extractStopIdentity(payload())).toEqual({ sessionId: SESSION_ID, cwd: REPO });
	});

	it("returns null when session_id is missing — this is the routing key", () => {
		const p = payload();
		delete p.session_id;
		expect(extractStopIdentity(p)).toBeNull();
	});

	it("returns null when cwd is missing — we cannot pick a repository without it", () => {
		const p = payload();
		delete p.cwd;
		expect(extractStopIdentity(p)).toBeNull();
	});

	it("rejects blank strings — an all-whitespace field is the same as missing", () => {
		expect(extractStopIdentity(payload({ session_id: "  " }))).toBeNull();
		expect(extractStopIdentity(payload({ cwd: "" }))).toBeNull();
	});

	it("rejects a non-object payload — Hermes' envelope is always a JSON object", () => {
		expect(extractStopIdentity(null)).toBeNull();
		expect(extractStopIdentity("string")).toBeNull();
		expect(extractStopIdentity(["array"])).toBeNull();
	});

	it("ignores non-string type coercions of the two fields", () => {
		expect(extractStopIdentity({ session_id: 42, cwd: REPO })).toBeNull();
		expect(extractStopIdentity({ session_id: SESSION_ID, cwd: { toString: () => REPO } })).toBeNull();
	});
});

describe("main()", () => {
	it("stores the session, records the dashboard row, and spawns the discovery worker", async () => {
		mocks.discoverHermesSessions.mockResolvedValue([
			{
				sessionId: SESSION_ID,
				transcriptPath: SYNTHETIC_PATH,
				source: "hermes",
				updatedAt: "2026-08-26T00:00:00.000Z",
			},
		]);

		await main();

		expect(mocks.saveSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: SESSION_ID,
				source: "hermes",
				transcriptPath: SYNTHETIC_PATH,
			}),
			REPO,
		);
		expect(mocks.recordSessionFromHook).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ sessionId: SESSION_ID }),
		);
		expect(mocks.spawnHidden).toHaveBeenCalledOnce();
	});

	it("records a metadata-only row when the discoverer cannot resolve the DB path", async () => {
		mocks.discoverHermesSessions.mockResolvedValue([]); // Row not visible to discoverer.

		await main();

		// saveSession requires a resumable path, so it is skipped, but the dashboard row lands.
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ sessionId: SESSION_ID, source: "hermes" }),
		);
		expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("transcript unresolved"));
	});

	it("no-ops on a jollimemory-spawned local-agent run — that is our own machinery", async () => {
		mocks.isLocalAgentChild.mockReturnValue(true);
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).not.toHaveBeenCalled();
		expect(mocks.spawnHidden).not.toHaveBeenCalled();
	});

	it("skips a repo the user has not enabled — Hermes' hook is global, so opt-in is the gate", async () => {
		mocks.isGitHookInstalled.mockResolvedValue(false);
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).not.toHaveBeenCalled();
	});

	it("skips a repo the user has manually disabled", async () => {
		mocks.readManualDisableFlag.mockResolvedValue(true);
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).not.toHaveBeenCalled();
	});

	it("skips when Hermes integration is off via config", async () => {
		mocks.loadConfig.mockResolvedValue({ hermesEnabled: false });
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).not.toHaveBeenCalled();
	});

	it("skips when Hermes' state.db is not present — nothing to read even if config allows it", async () => {
		mocks.isHermesInstalled.mockResolvedValue(false);
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
	});

	it("skips a payload with no session_id — nothing routable to record", async () => {
		mocks.readStdin.mockResolvedValue(JSON.stringify(payload({ session_id: "" })));
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.info.mock.calls.some((c) => String(c[0]).includes("payload named no session_id"))).toBe(true);
	});

	it("tolerates an unparseable stdin — logs and returns rather than throwing", async () => {
		mocks.readStdin.mockResolvedValue("{not-json");
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining("unparseable payload"), expect.anything());
	});

	it("degrades gracefully when the worker script is missing", async () => {
		mocks.workerExists.mockReturnValue(false);
		mocks.discoverHermesSessions.mockResolvedValue([
			{
				sessionId: SESSION_ID,
				transcriptPath: SYNTHETIC_PATH,
				source: "hermes",
				updatedAt: "2026-08-26T00:00:00.000Z",
			},
		]);
		await main();
		// The session still lands — only the async discovery pass is skipped.
		expect(mocks.saveSession).toHaveBeenCalled();
		expect(mocks.spawnHidden).not.toHaveBeenCalled();
		expect(mocks.error.mock.calls.some((c) => String(c[0]).includes("Hermes discovery worker not found"))).toBe(
			true,
		);
	});
});

/*
 * Source-shape guard for the basename-entry check.
 *
 * The failure only reproduces inside a BUNDLE — see SessionStartHook.test.ts's identical
 * guard for the full rationale. Neither vitest nor a unit test can reach it, so pin the
 * literal form of the check instead.
 */
describe("entry-point guard shape", () => {
	it("gates auto-run on the entry file's basename, not just its path", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./HermesStopHook.ts", import.meta.url), "utf-8");
		expect(source).toMatch(/entryName === "hermesstophook\.js"/);
		expect(source).toMatch(/entryName === "hermesstophook\.ts"/);
		expect(source).not.toMatch(/import\.meta\.url\.endsWith\(process\.argv\[1\]/);
	});

	it("does the same for HermesDiscoveryWorker", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./HermesDiscoveryWorker.ts", import.meta.url), "utf-8");
		expect(source).toMatch(/entryName === "hermesdiscoveryworker\.js"/);
		expect(source).toMatch(/entryName === "hermesdiscoveryworker\.ts"/);
	});
});
