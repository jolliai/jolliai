/**
 * Tests for SyncBootstrap — DI wiring from config → SyncEngine.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir, launchWorkerMock } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
	launchWorkerMock: vi.fn<(cwd: string) => void>(),
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => mockHomeDir.value };
});

vi.mock("../hooks/QueueWorker.js", () => ({
	launchWorker: (cwd: string) => launchWorkerMock(cwd),
}));

import { buildSyncEngine, narrowConflictPolicy } from "./SyncBootstrap.js";

let tempDir: string;

async function writeConfig(config: Record<string, unknown>): Promise<void> {
	const dir = join(tempDir, ".jolli", "jollimemory");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), JSON.stringify(config));
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "syncbootstrap-"));
	mockHomeDir.value = tempDir;
	launchWorkerMock.mockReset();
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const STUB_UI = { promptBinaryPick: async () => "skip" as const };

describe("buildSyncEngine returns null when prerequisites are missing", () => {
	// Plan §0.7: the engine builds whenever `jolliApiKey` is set. `autoSyncEnabled`
	// only gates the polling tick (in `VsCodeSyncBootstrap.ts`); manual sync
	// must work without the auto-sync toggle.

	it("returns null when jolliApiKey is missing", async () => {
		await writeConfig({ autoSyncEnabled: true });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).toBeNull();
	});

	it("returns null when config.json is unreadable", async () => {
		// No config written at all.
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).toBeNull();
	});

	it("returns an engine when jolliApiKey is set even if autoSyncEnabled is absent", async () => {
		// Manual sync path — clicking "Sync to Personal Space" with auto-sync off.
		await writeConfig({ jolliApiKey: "sk-jol-test" });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).not.toBeNull();
	});

	it("returns an engine when jolliApiKey is set and autoSyncEnabled is false", async () => {
		// Same path, explicit `false`.
		await writeConfig({ autoSyncEnabled: false, jolliApiKey: "sk-jol-test" });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).not.toBeNull();
	});
});

describe("defaultResolveContext / deriveMemoryBankRoot", () => {
	it("computes a deterministic vault context from cwd + localFolder", async () => {
		const { defaultResolveContext, deriveMemoryBankRoot } = await import("./SyncBootstrap.js");
		const localFolder = join(tempDir, "vault-root");
		const ctx = await defaultResolveContext({ cwd: tempDir, reason: "manual", transcripts: false }, localFolder);
		// `repoFolderName` agrees with FolderStorage's on-disk pick. Path
		// case is preserved (POSIX filesystems are case-sensitive); we
		// only constrain the shape, not letter case.
		expect(ctx.repoFolderName).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(ctx.repoIdentity).toBeTypeOf("string");
		expect(ctx.memoryBankRoot).toBe(localFolder);

		expect(deriveMemoryBankRoot("/a/b")).toBe("/a/b");
		// Default lives at `<homedir>/Documents/jolli`; use `path.join` for
		// the suffix so the separator matches the host (`\` on Windows).
		const defaultSuffix = join("Documents", "jolli");
		expect(deriveMemoryBankRoot(undefined).endsWith(defaultSuffix)).toBe(true);
		// Invalid paths fall back to the default `~/Documents/jolli` (with a
		// WARN log) so every write path in the system agrees on the same
		// target — preventing the split-brain where git init aimed at a
		// bogus path while FolderStorage wrote to the default. Input-
		// boundary validation (rejecting bad values at `jolli configure` /
		// Settings UI) is handled in a separate PR.
		expect(deriveMemoryBankRoot("relative/path").endsWith(defaultSuffix)).toBe(true);
		expect(deriveMemoryBankRoot("/abs/with/../traversal").endsWith(defaultSuffix)).toBe(true);
	});

	it("defaultAiFactory returns null when apiKey missing and a provider when present", async () => {
		const { defaultAiFactory } = await import("./SyncBootstrap.js");

		const noKey = await defaultAiFactory();
		expect(noKey).toBeNull();

		await writeConfig({ apiKey: "sk-ant-test", model: "claude-opus-4-7" });
		const withKey = await defaultAiFactory();
		expect(withKey).not.toBeNull();
	});

	it("does not create the per-repo folder as a side effect (preserves cold-start clone path)", async () => {
		// Regression: `resolveKBPath` writes `.jolli/config.json` and creates
		// the directory; using it from `defaultResolveContext` made
		// `fetchOrCloneWithRetry` see a pre-existing folder and skip the real
		// `git clone` on first-time sync — falling through to `git init` +
		// fetch + rebase against an auto-initialized remote with no common
		// ancestor. `peekKBPath` is the pure-read variant for this case.
		const { defaultResolveContext } = await import("./SyncBootstrap.js");
		const { existsSync } = await import("node:fs");
		const localFolder = join(tempDir, "fresh-vault-root");
		const ctx = await defaultResolveContext({ cwd: tempDir, reason: "manual", transcripts: false }, localFolder);
		const perRepoFolder = join(localFolder, ctx.repoFolderName);
		expect(existsSync(perRepoFolder)).toBe(false);
		expect(existsSync(join(perRepoFolder, ".jolli", "config.json"))).toBe(false);
	});
});

describe("buildSyncEngine returns a configured engine when prerequisites are met", () => {
	it("returns an engine when autoSyncEnabled + jolliApiKey are set", async () => {
		await writeConfig({ autoSyncEnabled: true, jolliApiKey: "sk-jol-test" });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).not.toBeNull();
		// Exposed as a class instance — confirm via method presence.
		expect(typeof engine?.runRound).toBe("function");
	});

	it("wires the AI provider when config.apiKey is present", async () => {
		// We can't peek into the engine instance directly without exposing its
		// internals, but we can use the override to assert wiring by spying on
		// the resolveContext seam — if the engine is built, the prerequisites
		// pass.
		await writeConfig({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
			apiKey: "sk-anth-test",
			model: "claude-sonnet-4-6",
		});
		const engine = await buildSyncEngine({
			cwd: tempDir,
			ui: STUB_UI,
			resolveContextOverride: vi.fn(async () => ({
				memoryBankRoot: "/tmp/vault",
				repoFolderName: "a-x",
				repoIdentity: "https://github.com/x/a-x",
				author: { name: "x", email: "x@x" },
			})),
		});
		expect(engine).not.toBeNull();
	});

	it("uses the supplied test seams (backend + makeGitClient + resolveContext)", async () => {
		await writeConfig({ autoSyncEnabled: true, jolliApiKey: "sk-jol-test" });
		const backend = {
			mintGitCredentials: vi.fn(),
			notifyPush: vi.fn(),
		} as unknown as import("./BackendClient.js").BackendClient;
		const engine = await buildSyncEngine({
			cwd: tempDir,
			ui: STUB_UI,
			backend,
			resolveContextOverride: vi.fn(async () => ({
				memoryBankRoot: "/tmp/vault",
				repoFolderName: "a-x",
				repoIdentity: "https://github.com/x/a-x",
				author: { name: "x", email: "x@x" },
			})),
			makeVaultClientOverride: () => ({}) as import("./GitClient.js").GitClient,
		});
		expect(engine).not.toBeNull();
	});

	it("relays onStateChange to the engine", async () => {
		await writeConfig({ autoSyncEnabled: true, jolliApiKey: "sk-jol-test" });
		const onState = vi.fn();
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI, onStateChange: onState });
		expect(engine).not.toBeNull();
		// We don't trigger the callback here — just confirm the wiring builds.
	});

	it("re-reads localFolder from config on every round (not captured at build time)", async () => {
		// Reviewer-reported bug: previously the default resolveContext
		// closed over `config.localFolder` at build time, so changing
		// "Local Folder" in Settings while the orchestrator was kept alive
		// would keep sync'ing the OLD vault even though the UI had moved
		// to the new one. Engine instance is reused across rounds (VS Code
		// keeps one for the workspace lifetime), so the fix must read
		// config per round.
		const folderA = join(tempDir, "vault-a");
		const folderB = join(tempDir, "vault-b");
		await mkdir(folderA, { recursive: true });
		await mkdir(folderB, { recursive: true });
		await writeConfig({ jolliApiKey: "sk-jol-test", localFolder: folderA });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).not.toBeNull();
		// Tap into the resolver via the engine's private opts. We can't
		// invoke `runRound` here without a full mock stack, so reach into
		// the wired resolver directly — same shape that runRound uses.
		const resolver = (
			engine as unknown as { opts: { resolveContext: (r: unknown) => Promise<{ memoryBankRoot: string }> } }
		).opts.resolveContext;
		const ctxBefore = await resolver({ cwd: tempDir, reason: "manual", transcripts: false });
		expect(ctxBefore.memoryBankRoot).toBe(folderA);

		// Settings change → user re-points localFolder. Engine stays alive.
		await writeConfig({ jolliApiKey: "sk-jol-test", localFolder: folderB });
		const ctxAfter = await resolver({ cwd: tempDir, reason: "manual", transcripts: false });
		expect(ctxAfter.memoryBankRoot).toBe(folderB);
	});
});

describe("onRoundComplete wiring (cross-repo pending-worker wakeup)", () => {
	async function getWiredOnRoundComplete(localFolder: string): Promise<(cwd: string) => void> {
		await writeConfig({ jolliApiKey: "sk-jol-test", localFolder });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).not.toBeNull();
		const cb = (engine as unknown as { opts: { onRoundComplete: (cwd: string) => void } }).opts.onRoundComplete;
		expect(cb).toBeTypeOf("function");
		return cb;
	}

	it("spawns a worker for the round's own cwd synchronously", async () => {
		const localFolder = join(tempDir, "vault");
		const cb = await getWiredOnRoundComplete(localFolder);
		cb("/repo/a");
		expect(launchWorkerMock).toHaveBeenCalledWith("/repo/a");
	});

	it("drains the pending-worker registry and spawns workers for OTHER cwds", async () => {
		const localFolder = join(tempDir, "vault");
		const { recordPendingWorker } = await import("./PendingWorkers.js");
		const { deriveMemoryBankRoot } = await import("./SyncBootstrap.js");
		// Producer + consumer must agree on the registry key — both go
		// through `deriveMemoryBankRoot` now (covers the default-config
		// case where `localFolder` is undefined → falls back to
		// `~/Documents/jolli/`). Passing raw `localFolder` here would
		// hash to a different bucket than the onRoundComplete consumer,
		// and the drain would see an empty registry.
		const memoryBankRoot = deriveMemoryBankRoot(localFolder);
		// Two timeout victims from a previous round; one is the round's own
		// cwd (should not be double-spawned), one is a sibling repo.
		await recordPendingWorker(memoryBankRoot, "/repo/a");
		await recordPendingWorker(memoryBankRoot, "/repo/b");

		const cb = await getWiredOnRoundComplete(localFolder);
		cb("/repo/a");

		// The drain runs in a void-async block off the synchronous callback;
		// give libuv enough turns for loadConfig + readdir + per-entry
		// readFile/rm to resolve before assertions.
		await new Promise((r) => setTimeout(r, 100));

		// /repo/a spawned synchronously; /repo/b spawned from the drain.
		// /repo/a from the registry was filtered out by the `!== cwd` guard.
		const calls = launchWorkerMock.mock.calls.map((c) => c[0]).sort();
		expect(calls).toEqual(["/repo/a", "/repo/b"]);
	});

	it("swallows pending-worker drain errors (non-fatal)", async () => {
		const localFolder = join(tempDir, "vault");
		const cb = await getWiredOnRoundComplete(localFolder);
		// Point the override at a regular file so consumePendingWorkers's
		// readdir branch silently returns []; meanwhile recording into that
		// path also fails. Drain still completes without throwing.
		process.env.JOLLI_VAULT_LOCK_DIR = join(tempDir, "syncbootstrap-config.json"); // a file
		try {
			cb("/repo/a");
			await new Promise((r) => setTimeout(r, 100));
			expect(launchWorkerMock).toHaveBeenCalledWith("/repo/a");
		} finally {
			delete process.env.JOLLI_VAULT_LOCK_DIR;
		}
	});
});

describe("narrowConflictPolicy", () => {
	it("passes through recognized union members", () => {
		expect(narrowConflictPolicy("prompt")).toBe("prompt");
		expect(narrowConflictPolicy("mine")).toBe("mine");
		expect(narrowConflictPolicy("theirs")).toBe("theirs");
	});

	it("returns 'prompt' silently when the value is undefined (no config saved)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(narrowConflictPolicy(undefined)).toBe("prompt");
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("returns 'prompt' and warns when the value is a legacy / unknown string", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(narrowConflictPolicy("newest")).toBe("prompt");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
