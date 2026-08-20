import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isLocalAgentChild: vi.fn().mockReturnValue(false),
	resolveStateRoot: vi.fn((dir: string) => dir),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	saveSession: vi.fn().mockResolvedValue(undefined),
	recordSessionFromHook: vi.fn().mockResolvedValue(true),
	isGitHookInstalled: vi.fn().mockResolvedValue(true),
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
			String(path).endsWith("CursorDiscoveryWorker.js") ? mocks.workerExists(path) : actual.existsSync(path),
	};
});
vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: mocks.isLocalAgentChild }));
vi.mock("../core/GitOps.js", () => ({ resolveStateRoot: mocks.resolveStateRoot }));
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

const { extractStopIdentity, main, resolveCursorSource } = await import("./CursorStopHook.js");

const REPO = "/repo";
const UUID = "fa95214e-ab0f-49b8-b5d6-6ef38aeb4c45";
const TRANSCRIPT = `/Users/me/.cursor/projects/Users-me-repo/agent-transcripts/${UUID}/${UUID}.jsonl`;

/** The verbatim shape of a real capture (Cursor 3.16.29), trimmed to the read fields. */
function idePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		conversation_id: UUID,
		generation_id: "d077f6a9-6f5f-4523-905b-9b91651120c8",
		model: "cursor-grok-4.6-medium",
		status: "completed",
		input_tokens: 199933,
		output_tokens: 980,
		cache_read_tokens: 80256,
		session_id: UUID,
		hook_event_name: "stop",
		workspace_roots: [REPO],
		transcript_path: TRANSCRIPT,
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
	mocks.workerExists.mockReturnValue(true);
	mocks.spawnHidden.mockReturnValue({ once: mocks.childOnce, unref: mocks.childUnref, pid: 1234 });
	mocks.readStdin.mockResolvedValue(JSON.stringify(idePayload()));
	delete process.env.CURSOR_INVOKED_AS;
	delete process.env.CURSOR_TRANSCRIPT_PATH;
	delete process.env.CURSOR_PROJECT_DIR;
});

afterEach(() => {
	delete process.env.CURSOR_INVOKED_AS;
	delete process.env.CURSOR_TRANSCRIPT_PATH;
	delete process.env.CURSOR_PROJECT_DIR;
});

describe("extractStopIdentity", () => {
	it("reads conversation_id and transcript_path from a real IDE payload", () => {
		expect(extractStopIdentity(idePayload(), {})).toEqual({ sessionId: UUID, transcriptPath: TRANSCRIPT });
	});

	it("falls back to session_id when conversation_id is absent", () => {
		const payload = idePayload();
		delete payload.conversation_id;
		expect(extractStopIdentity(payload, {})?.sessionId).toBe(UUID);
	});

	it("falls back to CURSOR_TRANSCRIPT_PATH when the payload omits the path", () => {
		const payload = idePayload();
		delete payload.transcript_path;
		const got = extractStopIdentity(payload, { CURSOR_TRANSCRIPT_PATH: TRANSCRIPT } as NodeJS.ProcessEnv);
		expect(got).toEqual({ sessionId: UUID, transcriptPath: TRANSCRIPT });
	});

	it("returns null when no id is present", () => {
		const payload = idePayload();
		delete payload.conversation_id;
		delete payload.session_id;
		expect(extractStopIdentity(payload, {})).toBeNull();
	});

	it("keeps the session id when no transcript is nameable from either channel", () => {
		const payload = idePayload();
		delete payload.transcript_path;
		expect(extractStopIdentity(payload, {})).toEqual({ sessionId: UUID });
	});

	it("ignores blank strings rather than treating them as values", () => {
		expect(extractStopIdentity(idePayload({ conversation_id: "   ", session_id: "  " }), {})).toBeNull();
	});

	it("survives a payload that is not an object", () => {
		expect(extractStopIdentity("nope", {})).toBeNull();
		expect(extractStopIdentity([1, 2], {})).toBeNull();
		expect(extractStopIdentity(null, {})).toBeNull();
	});
});

describe("resolveCursorSource", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "jolli-cursor-src-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("classifies cursor-agent from CURSOR_INVOKED_AS without touching disk", async () => {
		const got = await resolveCursorSource({ CURSOR_INVOKED_AS: "cursor-agent" } as NodeJS.ProcessEnv, UUID, home);
		expect(got).toBe("cursor-cli");
	});

	it("defaults to the IDE source when nothing says otherwise", async () => {
		expect(await resolveCursorSource({}, UUID, home)).toBe("cursor");
	});

	it("falls back to the chats index when the env var is absent", async () => {
		await mkdir(join(home, "chats", "cc710b885c18d40d8c2561f4f8f9be49", UUID), { recursive: true });
		expect(await resolveCursorSource({}, UUID, home)).toBe("cursor-cli");
	});

	it("does not claim cursor-cli for a conversation the chats index does not hold", async () => {
		await mkdir(join(home, "chats", "cc710b885c18d40d8c2561f4f8f9be49", "another-uuid"), { recursive: true });
		expect(await resolveCursorSource({}, UUID, home)).toBe("cursor");
	});

	it("answers cursor when the chats directory is unreadable", async () => {
		expect(await resolveCursorSource({}, UUID, join(home, "absent"))).toBe("cursor");
	});
});

describe("main", () => {
	it("records an IDE conversation as source 'cursor' against the workspace root", async () => {
		await main();
		expect(mocks.saveSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: UUID, transcriptPath: TRANSCRIPT, source: "cursor" }),
			REPO,
		);
		expect(mocks.recordSessionFromHook).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ sessionId: UUID, source: "cursor" }),
		);
		expect(mocks.spawnHidden).toHaveBeenCalledWith(
			process.execPath,
			[expect.stringMatching(/CursorDiscoveryWorker\.js$/u), "--cwd", REPO],
			{ detached: true, stdio: "ignore", cwd: REPO },
		);
		expect(mocks.childUnref).toHaveBeenCalledOnce();
	});

	it("records a cursor-agent conversation as source 'cursor-cli'", async () => {
		process.env.CURSOR_INVOKED_AS = "cursor-agent";
		await main();
		expect(mocks.saveSession).toHaveBeenCalledWith(expect.objectContaining({ source: "cursor-cli" }), REPO);
		expect(mocks.recordSessionFromHook).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ source: "cursor-cli" }),
		);
	});

	it("writes nothing for a repository that has not been set up", async () => {
		mocks.isGitHookInstalled.mockResolvedValue(false);
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).not.toHaveBeenCalled();
		expect(mocks.spawnHidden).not.toHaveBeenCalled();
	});

	it("writes nothing for a manually disabled repository", async () => {
		mocks.readManualDisableFlag.mockResolvedValue(true);
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).not.toHaveBeenCalled();
	});

	it("writes nothing when the Cursor integration is switched off", async () => {
		mocks.loadConfig.mockResolvedValue({ cursorEnabled: false });
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
	});

	it("writes nothing when running inside a jollimemory-spawned agent", async () => {
		mocks.isLocalAgentChild.mockReturnValue(true);
		await main();
		expect(mocks.setLogDir).not.toHaveBeenCalled();
		expect(mocks.saveSession).not.toHaveBeenCalled();
	});

	it("falls back to cwd, which for `stop` is the workspace Cursor's own bundle hands it", async () => {
		mocks.readStdin.mockResolvedValue(JSON.stringify(idePayload({ workspace_roots: [] })));
		const cwd = vi.spyOn(process, "cwd").mockReturnValue("/elsewhere");
		try {
			await main();
			expect(mocks.saveSession).toHaveBeenCalledWith(expect.anything(), "/elsewhere");
		} finally {
			cwd.mockRestore();
		}
	});

	it("writes nothing when every candidate is a plugin bundle", async () => {
		// The trap this screening exists for: a marketplace cache served over git is a
		// REAL checkout, so `rev-parse` would accept it and jolli would write into the
		// plugin's own repository. Screened whichever channel supplied it.
		const bundle = "/Users/me/.cursor/plugins/local/jolli";
		mocks.readStdin.mockResolvedValue(JSON.stringify(idePayload({ workspace_roots: [bundle] })));
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(bundle);
		try {
			await main();
			expect(mocks.isGitHookInstalled).not.toHaveBeenCalled();
			expect(mocks.saveSession).not.toHaveBeenCalled();
		} finally {
			cwd.mockRestore();
		}
	});

	it("anchors state to the worktree root when the workspace is a subdirectory", async () => {
		mocks.readStdin.mockResolvedValue(JSON.stringify(idePayload({ workspace_roots: [`${REPO}/packages/web`] })));
		mocks.resolveStateRoot.mockReturnValue(REPO);
		await main();
		expect(mocks.saveSession).toHaveBeenCalledWith(expect.anything(), REPO);
	});

	it("still records the dashboard row when the registry write fails", async () => {
		mocks.saveSession.mockRejectedValue(new Error("EACCES"));
		await main();
		expect(mocks.recordSessionFromHook).toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalled();
	});

	it("leaves discovery to scan paths when the bundled worker is missing", async () => {
		mocks.workerExists.mockReturnValue(false);
		await main();
		expect(mocks.saveSession).toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).toHaveBeenCalled();
		expect(mocks.spawnHidden).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("worker not found"), expect.any(String));
	});

	it("does not fail the captured session when the worker cannot be spawned", async () => {
		mocks.spawnHidden.mockImplementation(() => {
			throw new Error("EMFILE");
		});
		await expect(main()).resolves.toBeUndefined();
		expect(mocks.saveSession).toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Failed to start"), "EMFILE");
	});

	it("does not throw when the payload cannot be parsed", async () => {
		mocks.readStdin.mockResolvedValue("{not json");
		await expect(main()).resolves.toBeUndefined();
		expect(mocks.saveSession).not.toHaveBeenCalled();
	});

	it("does not throw when the payload names no conversation", async () => {
		const payload = idePayload();
		delete payload.conversation_id;
		delete payload.session_id;
		mocks.readStdin.mockResolvedValue(JSON.stringify(payload));
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalled();
	});

	it("records a metadata-only dashboard row when neither channel names a transcript", async () => {
		const payload = idePayload();
		delete payload.transcript_path;
		mocks.readStdin.mockResolvedValue(JSON.stringify(payload));
		await main();
		expect(mocks.saveSession).not.toHaveBeenCalled();
		expect(mocks.recordSessionFromHook).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ sessionId: UUID, source: "cursor" }),
		);
		const dashboardSession = mocks.recordSessionFromHook.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(dashboardSession).not.toHaveProperty("transcriptPath");
		// Discovery does not need the payload path and may still find the just-ended
		// conversation on disk, so the fallback must not suppress that catch-up route.
		expect(mocks.spawnHidden).toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("metadata-only"));
	});

	it("does not throw when stdin cannot be read", async () => {
		mocks.readStdin.mockRejectedValue(new Error("EPIPE"));
		await expect(main()).resolves.toBeUndefined();
	});

	it("never carries the payload's per-generation tokens into the session row", async () => {
		await main();
		const [session] = mocks.saveSession.mock.calls[0] as [Record<string, unknown>, unknown];
		// `sessionEventFromInfo` derives usage from the whole transcript; a turn's own
		// counters are the context size, not an increment. See the header.
		expect(Object.keys(session)).toEqual(["sessionId", "transcriptPath", "updatedAt", "source"]);
	});
});
