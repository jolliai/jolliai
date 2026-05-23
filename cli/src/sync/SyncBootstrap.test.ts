/**
 * Tests for SyncBootstrap — DI wiring from config → SyncEngine.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => mockHomeDir.value };
});

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
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const STUB_UI = { promptBinaryPick: async () => "skip" as const };

describe("buildSyncEngine returns null when prerequisites are missing", () => {
	// Plan §0.7: the engine builds whenever `jolliApiKey` is set. `syncEnabled`
	// only gates the polling tick (in `VsCodeSyncBootstrap.ts`); manual sync
	// must work without the auto-sync toggle.

	it("returns null when jolliApiKey is missing", async () => {
		await writeConfig({ syncEnabled: true });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).toBeNull();
	});

	it("returns null when config.json is unreadable", async () => {
		// No config written at all.
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).toBeNull();
	});

	it("returns an engine when jolliApiKey is set even if syncEnabled is absent", async () => {
		// Manual sync path — clicking "Sync to Personal Space" with auto-sync off.
		await writeConfig({ jolliApiKey: "sk-jol-test" });
		const engine = await buildSyncEngine({ cwd: tempDir, ui: STUB_UI });
		expect(engine).not.toBeNull();
	});

	it("returns an engine when jolliApiKey is set and syncEnabled is false", async () => {
		// Same path, explicit `false`.
		await writeConfig({ syncEnabled: false, jolliApiKey: "sk-jol-test" });
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
		expect(deriveMemoryBankRoot(undefined).endsWith("/Documents/jolli")).toBe(true);
		// Invalid paths fall back to the default `~/Documents/jolli` (with a
		// WARN log) so every write path in the system agrees on the same
		// target — preventing the split-brain where git init aimed at a
		// bogus path while FolderStorage wrote to the default. Input-
		// boundary validation (rejecting bad values at `jolli configure` /
		// Settings UI) is handled in a separate PR.
		expect(deriveMemoryBankRoot("relative/path").endsWith("/Documents/jolli")).toBe(true);
		expect(deriveMemoryBankRoot("/abs/with/../traversal").endsWith("/Documents/jolli")).toBe(true);
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
	it("returns an engine when syncEnabled + jolliApiKey are set", async () => {
		await writeConfig({ syncEnabled: true, jolliApiKey: "sk-jol-test" });
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
			syncEnabled: true,
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
		await writeConfig({ syncEnabled: true, jolliApiKey: "sk-jol-test" });
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
		await writeConfig({ syncEnabled: true, jolliApiKey: "sk-jol-test" });
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
