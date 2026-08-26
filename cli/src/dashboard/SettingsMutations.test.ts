import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeManualDisableFlag } from "../core/RepoProfile.js";
import type { JolliMemoryConfig } from "../Types.js";
import {
	applySettings,
	checkLocalFolder,
	countMissingForCwd,
	parseSettingsApplyInput,
	type SettingsApplyInput,
	SettingsValidationError,
	setSyncSessions,
	syncAllReposHooks,
} from "./SettingsMutations.js";
import { maskApiKey } from "./SettingsPageQuery.js";

let dir: string;

function configDirWith(config: JolliMemoryConfig): string {
	const d = mkdtempSync(join(dir, "cfg-"));
	writeFileSync(join(d, "config.json"), JSON.stringify(config));
	return d;
}

function readConfig(d: string): JolliMemoryConfig {
	return JSON.parse(readFileSync(join(d, "config.json"), "utf-8"));
}

/** A minimal valid submission — every agent on, gi untouched, no keys. */
function baseInput(over: Partial<SettingsApplyInput> = {}): SettingsApplyInput {
	return {
		claudeEnabled: true,
		codexEnabled: true,
		geminiEnabled: true,
		openCodeEnabled: true,
		cursorEnabled: true,
		devinEnabled: true,
		copilotEnabled: true,
		clineEnabled: true,
		antigravityEnabled: true,
		kimiEnabled: true,
		hermesEnabled: true,
		globalInstructions: "default",
		aiProvider: "anthropic",
		model: "sonnet",
		apiKey: "",
		jolliApiKey: "",
		localAgentTool: "claude-code",
		localAgentModel: "",
		localFolder: "",
		compileExcludeFolders: "",
		syncTranscripts: false,
		dcoSignoff: false,
		excludePatterns: "",
		dashboardKnowledgeMenuEnabled: false,
		dashboardGraphMenuEnabled: false,
		...over,
	};
}

/** A decodable, allowlisted Jolli key (tenant acme.jolli.ai). */
function validJolliKey(): string {
	const payload = Buffer.from(JSON.stringify({ t: "acme", u: "https://acme.jolli.ai" })).toString("base64url");
	// JWT-shaped: parseJolliApiKey rejects a dot-less key, so carry a dummy header segment.
	return `sk-jol-${payload}.sig`;
}

let home: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-setmut-"));
	// Isolate HOME so the one test that flips globalInstructions (triggering the
	// real syncGlobalInstructions, which writes ~/.claude/CLAUDE.md etc.) can never
	// touch the developer's real global instruction files.
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	home = mkdtempSync(join(dir, "home-"));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = savedUserProfile;
	rmSync(dir, { recursive: true, force: true });
});

describe("parseSettingsApplyInput", () => {
	function rawBody(over: Record<string, unknown> = {}): Record<string, unknown> {
		return { ...baseInput(), ...over };
	}

	it("coerces a valid body", () => {
		const parsed = parseSettingsApplyInput(rawBody({ maxTokens: 2048, model: "opus" }));
		expect(parsed.aiProvider).toBe("anthropic");
		expect(parsed.maxTokens).toBe(2048);
		expect(parsed.model).toBe("opus");
		expect(parsed.claudeEnabled).toBe(true);
	});

	it("defaults an empty model to sonnet and a bad maxTokens to unset", () => {
		const parsed = parseSettingsApplyInput(rawBody({ model: "", maxTokens: -5 }));
		expect(parsed.model).toBe("sonnet");
		expect(parsed.maxTokens).toBeUndefined();
	});

	it("rejects an unknown provider", () => {
		expect(() => parseSettingsApplyInput(rawBody({ aiProvider: "openai" }))).toThrow(SettingsValidationError);
	});

	it("rejects an unknown globalInstructions value", () => {
		expect(() => parseSettingsApplyInput(rawBody({ globalInstructions: "maybe" }))).toThrow(
			SettingsValidationError,
		);
	});

	it("rejects an unknown localAgentTool", () => {
		expect(() => parseSettingsApplyInput(rawBody({ localAgentTool: "not-a-real-tool" }))).toThrow(
			SettingsValidationError,
		);
	});

	it("defaults an empty localAgentTool to claude-code", () => {
		expect(parseSettingsApplyInput(rawBody({ localAgentTool: "" })).localAgentTool).toBe("claude-code");
	});

	it("carries localAgentModel through without rejecting an unrecognised id", () => {
		// Deliberately NOT the localAgentTool treatment. A tool id decides which
		// binary runs, so a bad one must stop the save; a model id is a dropdown
		// value the runtime clamps at read time anyway, and refusing the whole
		// submission over one would block a user whose stored value came from a
		// newer build from saving anything at all — including the setting that
		// would fix it. Normalisation happens on the way to disk instead.
		expect(parseSettingsApplyInput(rawBody({ localAgentModel: "claude-opus-5[1m]" })).localAgentModel).toBe(
			"claude-opus-5[1m]",
		);
		expect(parseSettingsApplyInput(rawBody({ localAgentModel: "" })).localAgentModel).toBe("");
		expect(parseSettingsApplyInput(rawBody({ localAgentModel: "haiku" })).localAgentModel).toBe("haiku");
	});

	// The two sidebar flags are the only TRI-STATE booleans here: an absent field
	// must stay absent, so `applySettings` leaves the stored row alone. Reading it
	// as `false` — which every other boolean here does — let a page that predates
	// the fields switch both rows off on a save that touched neither.
	it("leaves an absent sidebar-menu flag undefined rather than reading it as off", () => {
		const body = rawBody();
		delete body.dashboardKnowledgeMenuEnabled;
		delete body.dashboardGraphMenuEnabled;
		const parsed = parseSettingsApplyInput(body);
		expect(parsed.dashboardKnowledgeMenuEnabled).toBeUndefined();
		expect(parsed.dashboardGraphMenuEnabled).toBeUndefined();
	});

	// A submitted `false` is a real answer and must survive as one, or unticking a
	// row would be indistinguishable from not mentioning it.
	it("carries each sidebar-menu flag independently, false included", () => {
		const parsed = parseSettingsApplyInput(
			rawBody({ dashboardKnowledgeMenuEnabled: true, dashboardGraphMenuEnabled: false }),
		);
		expect(parsed.dashboardKnowledgeMenuEnabled).toBe(true);
		expect(parsed.dashboardGraphMenuEnabled).toBe(false);
	});

	// A non-boolean is a submission we cannot read, so it is treated as absent (keep
	// the stored value) rather than as the `false` a truthy/`=== true` test would
	// give it. `"on"` is the string an HTML form would send.
	it("treats a non-boolean sidebar-menu flag as absent, not as off", () => {
		expect(
			parseSettingsApplyInput(rawBody({ dashboardGraphMenuEnabled: "on" })).dashboardGraphMenuEnabled,
		).toBeUndefined();
	});

	// `syncSessions` is tri-state for the same reason, and absent from every
	// submission the current page makes: it is an immediate switch now, so a
	// batched save must not speak for it.
	it("leaves an absent syncSessions undefined rather than reading it as off", () => {
		expect(parseSettingsApplyInput(rawBody()).syncSessions).toBeUndefined();
	});

	// An older page still submits it, and that answer is honoured either way.
	it("carries a submitted syncSessions through, false included", () => {
		expect(parseSettingsApplyInput(rawBody({ syncSessions: true })).syncSessions).toBe(true);
		expect(parseSettingsApplyInput(rawBody({ syncSessions: false })).syncSessions).toBe(false);
		expect(parseSettingsApplyInput(rawBody({ syncSessions: "on" })).syncSessions).toBeUndefined();
	});

	it("rejects a submission with every agent disabled", () => {
		const allOff = Object.fromEntries(
			[
				"claudeEnabled",
				"codexEnabled",
				"geminiEnabled",
				"openCodeEnabled",
				"cursorEnabled",
				"devinEnabled",
				"copilotEnabled",
				"clineEnabled",
				"antigravityEnabled",
				"kimiEnabled",
				"hermesEnabled",
			].map((f) => [f, false]),
		);
		expect(() => parseSettingsApplyInput(rawBody(allOff))).toThrow(/At least one AI agent/);
	});
});

describe("applySettings", () => {
	it("persists agent toggles and list fields, dropping the sonnet default", async () => {
		const d = configDirWith({});
		const result = await applySettings(
			baseInput({
				codexEnabled: false,
				model: "sonnet",
				compileExcludeFolders: "archive, tmp-*",
				excludePatterns: "*.lock",
				dcoSignoff: true,
			}),
			d,
		);
		expect(result.ok).toBe(true);
		const config = readConfig(d);
		expect(config.codexEnabled).toBe(false);
		expect(config.claudeEnabled).toBe(true);
		expect(config.model).toBeUndefined(); // sonnet default → unset
		expect(config.compileExcludeFolders).toEqual(["archive", "tmp-*"]);
		expect(config.excludePatterns).toEqual(["*.lock"]);
		expect(config.dcoSignoff).toBe(true);
	});

	// An explicit `false` must reach disk, or unticking a row would silently keep
	// the row — the cost of making these two fields conditional.
	it("persists both sidebar-menu flags, including a switch back off", async () => {
		const d = configDirWith({});
		await applySettings(baseInput({ dashboardKnowledgeMenuEnabled: true, dashboardGraphMenuEnabled: true }), d);
		expect(readConfig(d).dashboardKnowledgeMenuEnabled).toBe(true);
		expect(readConfig(d).dashboardGraphMenuEnabled).toBe(true);

		await applySettings(baseInput({ dashboardKnowledgeMenuEnabled: false, dashboardGraphMenuEnabled: true }), d);
		expect(readConfig(d).dashboardKnowledgeMenuEnabled).toBe(false);
		expect(readConfig(d).dashboardGraphMenuEnabled).toBe(true);
	});

	// The whole point of the tri-state. A submission with neither field — what a tab
	// left open across a CLI upgrade sends, since `settings.js` is inlined into the
	// page at load — must leave both stored rows exactly as they were. Reading them
	// as `false` switched both off on a save the user made about something else.
	it("leaves stored sidebar-menu flags untouched when the submission omits them", async () => {
		const d = configDirWith({ dashboardKnowledgeMenuEnabled: true, dashboardGraphMenuEnabled: true });
		const input = baseInput({ dcoSignoff: true });
		delete (input as { dashboardKnowledgeMenuEnabled?: boolean }).dashboardKnowledgeMenuEnabled;
		delete (input as { dashboardGraphMenuEnabled?: boolean }).dashboardGraphMenuEnabled;
		await applySettings(input, d);
		const config = readConfig(d);
		expect(config.dcoSignoff).toBe(true);
		expect(config.dashboardKnowledgeMenuEnabled).toBe(true);
		expect(config.dashboardGraphMenuEnabled).toBe(true);
	});

	// The failure this closes: the switch writes immediately, so a form saved
	// afterwards must not carry a stale copy of it back to disk.
	it("leaves a stored syncSessions untouched when the submission omits it", async () => {
		const d = configDirWith({ syncSessions: false });
		await applySettings(baseInput({ dcoSignoff: true }), d);
		expect(readConfig(d).dcoSignoff).toBe(true);
		expect(readConfig(d).syncSessions).toBe(false);
	});

	it("still honours a syncSessions an older page submits", async () => {
		const d = configDirWith({ syncSessions: false });
		await applySettings(baseInput({ syncSessions: true }), d);
		expect(readConfig(d).syncSessions).toBe(true);
	});

	it("stores localAgentModel only when it differs from the default", async () => {
		// The page always submits the EFFECTIVE value, so a default install would
		// otherwise write "sonnet" into config.json on the first save that touched
		// any unrelated setting.
		const d = configDirWith({});
		await applySettings(baseInput({ localAgentModel: "sonnet" }), d);
		expect(readConfig(d).localAgentModel).toBeUndefined();

		await applySettings(baseInput({ localAgentModel: "" }), d);
		expect(readConfig(d).localAgentModel).toBeUndefined();

		await applySettings(baseInput({ localAgentModel: "haiku" }), d);
		expect(readConfig(d).localAgentModel).toBe("haiku");

		// And switching back to the default CLEARS it rather than leaving the old
		// pick in place — the field is written unconditionally for this reason.
		await applySettings(baseInput({ localAgentModel: "sonnet" }), d);
		expect(readConfig(d).localAgentModel).toBeUndefined();

		// An id no pinned tool offers is dropped to the default on the way to disk
		// rather than persisted — the save succeeds, and the stale value is gone.
		await applySettings(baseInput({ localAgentModel: "claude-opus-5[1m]" }), d);
		expect(readConfig(d).localAgentModel).toBeUndefined();
	});

	it("keeps a stored key when the submission equals its mask", async () => {
		const stored = "sk-ant-abcdefghijklmnop";
		const d = configDirWith({ apiKey: stored });
		await applySettings(baseInput({ apiKey: "sk-ant-abcde****mnop" }), d);
		expect(readConfig(d).apiKey).toBe(stored);
	});

	it("rejects a folder that does not exist and never auto-creates it", async () => {
		const d = configDirWith({});
		const target = join(dir, "typo-not-created");
		expect(existsSync(target)).toBe(false);
		await expect(applySettings(baseInput({ localFolder: target }), d)).rejects.toBeInstanceOf(
			SettingsValidationError,
		);
		// The mistyped path must NOT have been silently created.
		expect(existsSync(target)).toBe(false);
	});

	it("accepts an existing folder and stores the trimmed path", async () => {
		const d = configDirWith({});
		const target = mkdtempSync(join(dir, "existing-"));
		await applySettings(baseInput({ localFolder: `  ${target}  ` }), d);
		expect(readConfig(d).localFolder).toBe(target);
	});

	it("rejects a relative folder path and writes nothing", async () => {
		const d = configDirWith({ codexEnabled: false });
		await expect(applySettings(baseInput({ localFolder: "relative/bank" }), d)).rejects.toBeInstanceOf(
			SettingsValidationError,
		);
		// The rejected save never reached the config write.
		expect(readConfig(d).codexEnabled).toBe(false);
	});

	it("rejects a path that already exists as a file", async () => {
		const d = configDirWith({});
		const filePath = join(dir, "not-a-folder.txt");
		writeFileSync(filePath, "x");
		await expect(applySettings(baseInput({ localFolder: filePath }), d)).rejects.toBeInstanceOf(
			SettingsValidationError,
		);
	});

	it("writes a genuinely new anthropic key", async () => {
		const d = configDirWith({ apiKey: "sk-ant-old0000000000" });
		await applySettings(baseInput({ apiKey: "sk-ant-brandnewvalue1" }), d);
		expect(readConfig(d).apiKey).toBe("sk-ant-brandnewvalue1");
	});

	it("co-persists jolliUrl from a valid jolli key", async () => {
		const d = configDirWith({});
		await applySettings(baseInput({ jolliApiKey: validJolliKey() }), d);
		const config = readConfig(d);
		expect(config.jolliApiKey).toBe(validJolliKey());
		expect(config.jolliUrl).toBe("https://acme.jolli.ai");
	});

	it("keeps a stored jolli key when the submission equals its mask", async () => {
		const stored = validJolliKey();
		const d = configDirWith({ jolliApiKey: stored, jolliUrl: "https://acme.jolli.ai" });
		await applySettings(baseInput({ jolliApiKey: maskApiKey(stored) }), d);
		// The masked submission round-trips to "keep the stored full key".
		expect(readConfig(d).jolliApiKey).toBe(stored);
	});

	it("clears the anthropic key when an empty value is submitted", async () => {
		const d = configDirWith({ apiKey: "sk-ant-old0000000000" });
		await applySettings(baseInput({ apiKey: "" }), d);
		expect(readConfig(d).apiKey).toBeUndefined();
	});

	it("rejects a decodable jolli key whose origin is not allowlisted (as a 400, not a 500)", async () => {
		const payload = Buffer.from(JSON.stringify({ t: "acme", u: "https://evil.com" })).toString("base64url");
		const d = configDirWith({});
		await expect(applySettings(baseInput({ jolliApiKey: `sk-jol-${payload}.sig` }), d)).rejects.toBeInstanceOf(
			SettingsValidationError,
		);
	});

	it("rejects an undecodable jolli key without writing", async () => {
		const d = configDirWith({ codexEnabled: false });
		await expect(applySettings(baseInput({ jolliApiKey: "sk-jol-not-decodable" }), d)).rejects.toBeInstanceOf(
			SettingsValidationError,
		);
		// The rejection happened inside the transaction, so nothing was written.
		expect(readConfig(d).codexEnabled).toBe(false); // unchanged from the seed
	});

	it("leaves globalInstructions unset when the submission is 'default'", async () => {
		const d = configDirWith({});
		await applySettings(baseInput({ globalInstructions: "default" }), d);
		expect(readConfig(d).globalInstructions).toBeUndefined();
	});

	it("does not clobber a decided globalInstructions with 'default'", async () => {
		const d = configDirWith({ globalInstructions: "disabled" });
		await applySettings(baseInput({ globalInstructions: "default" }), d);
		// "default" means leave the field alone — the stored value survives.
		expect(readConfig(d).globalInstructions).toBe("disabled");
	});

	it("writes 'enabled' and runs the global-instructions sync on a real change", async () => {
		const d = configDirWith({});
		// giChanged (unset → enabled) drives the syncGlobalInstructions branch, which
		// runs against the isolated HOME (beforeEach) so it cannot touch real files.
		await applySettings(baseInput({ globalInstructions: "enabled" }), d);
		expect(readConfig(d).globalInstructions).toBe("enabled");
	});

	it("reports no hook failures when the registry is empty (flip triggers a no-op sweep)", async () => {
		const d = configDirWith({});
		// claudeEnabled flips true→false; the sweep runs but there are no repos.
		const result = await applySettings(baseInput({ claudeEnabled: false }), d);
		expect(result.hookFailures).toEqual([]);
	});
});

describe("syncAllReposHooks", () => {
	it("is a no-op with an empty registry", async () => {
		const d = configDirWith({});
		const failures = await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: true }, d);
		expect(failures).toEqual([]);
	});

	it("installs the Claude hook across a registered repo's worktree", async () => {
		const configDir = mkdtempSync(join(dir, "cfg-"));
		writeFileSync(join(configDir, "config.json"), "{}");
		const repo = mkdtempSync(join(dir, "repo-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(
			join(configDir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "id-1",
						repoName: "repo",
						worktreeRoot: repo,
						enabledAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const failures = await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: false }, configDir);
		expect(failures).toEqual([]);
		// The Claude hook landed in the registered repo's worktree AND is a real
		// hook (references the run-hook dispatcher), not an empty/garbage file.
		const settingsPath = join(repo, ".claude", "settings.local.json");
		expect(existsSync(settingsPath)).toBe(true);
		expect(readFileSync(settingsPath, "utf-8")).toMatch(/run-hook/);
		// ...and the disabled Gemini hook was not written.
		expect(existsSync(join(repo, ".gemini", "settings.json"))).toBe(false);
	});

	it("removes the Claude hook when the agent is toggled off", async () => {
		const configDir = mkdtempSync(join(dir, "cfg-"));
		writeFileSync(join(configDir, "config.json"), "{}");
		const repo = mkdtempSync(join(dir, "repo-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(
			join(configDir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "id-1",
						repoName: "repo",
						worktreeRoot: repo,
						enabledAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: false }, configDir);
		expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
		// Toggle Claude off → the hook is reconciled away without error.
		const failures = await syncAllReposHooks({ claudeEnabled: false, geminiEnabled: false }, configDir);
		expect(failures).toEqual([]);
		const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf-8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(JSON.stringify(settings.hooks ?? {})).not.toMatch(/run-hook/);
	});

	it("collects a failure (never throws) when a hook cannot be written", async () => {
		const configDir = mkdtempSync(join(dir, "cfg-"));
		writeFileSync(join(configDir, "config.json"), "{}");
		const repo = mkdtempSync(join(dir, "repo-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		// Block both agent-config dirs with a regular FILE so the installers' mkdir
		// fails — exercising the collect-failures-not-throw contract.
		writeFileSync(join(repo, ".claude"), "not a dir");
		writeFileSync(join(repo, ".gemini"), "not a dir");
		writeFileSync(
			join(configDir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "id-1",
						repoName: "repo",
						worktreeRoot: repo,
						enabledAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const failures = await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: true }, configDir);
		// The sweep completes and reports the failures rather than aborting.
		expect(failures.length).toBeGreaterThan(0);
		expect(failures.some((f) => f.integration === "Claude")).toBe(true);
		expect(failures.every((f) => typeof f.cause === "string")).toBe(true);
	});

	it("falls back to the clone root when listWorktrees fails (non-git dir)", async () => {
		const configDir = mkdtempSync(join(dir, "cfg-"));
		writeFileSync(join(configDir, "config.json"), "{}");
		// A real, existing directory that is NOT a git repo → listWorktrees throws,
		// and the sweep falls back to treating the clone root as its own worktree.
		const plain = mkdtempSync(join(dir, "plain-"));
		writeFileSync(
			join(configDir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "id-1",
						repoName: "repo",
						worktreeRoot: plain,
						enabledAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const failures = await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: false }, configDir);
		expect(failures).toEqual([]);
		expect(existsSync(join(plain, ".claude", "settings.local.json"))).toBe(true);
	});

	it("skips only the switched-off clone of a row that is still active", async () => {
		// The complement of the case below, and the reason BOTH filters exist. One row
		// per identity, one profile per clone: the row survives `listActiveRepos`
		// because clone B is on, so the per-clone check is the only thing that can keep
		// clone A's hooks from being reinstalled under the user.
		const configDir = mkdtempSync(join(dir, "cfg-"));
		writeFileSync(join(configDir, "config.json"), "{}");
		const off = mkdtempSync(join(dir, "clone-off-"));
		const on = mkdtempSync(join(dir, "clone-on-"));
		execFileSync("git", ["init", "-q"], { cwd: off });
		execFileSync("git", ["init", "-q"], { cwd: on });
		await writeManualDisableFlag(off, true);
		writeFileSync(
			join(configDir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "id-1",
						repoName: "repo",
						worktreeRoot: on,
						worktrees: [off, on],
						enabledAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const failures = await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: true }, configDir);
		expect(failures).toEqual([]);
		expect(existsSync(join(off, ".claude", "settings.local.json"))).toBe(false);
		expect(existsSync(join(on, ".claude", "settings.local.json"))).toBe(true);
	});

	it("skips a repo whose only clone the user has switched off", async () => {
		const configDir = mkdtempSync(join(dir, "cfg-"));
		writeFileSync(join(configDir, "config.json"), "{}");
		const repo = mkdtempSync(join(dir, "repo-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		await writeManualDisableFlag(repo, true);
		writeFileSync(
			join(configDir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "id-1",
						repoName: "repo",
						worktreeRoot: repo,
						enabledAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const failures = await syncAllReposHooks({ claudeEnabled: true, geminiEnabled: true }, configDir);
		expect(failures).toEqual([]);
		// Skipped — no hook was written into a manually-disabled clone.
		expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
	});
});

describe("countMissingForCwd", () => {
	it("returns null when the cwd is not a git repository", async () => {
		const notARepo = mkdtempSync(join(dir, "plain-"));
		expect(await countMissingForCwd(notARepo)).toBeNull();
	});
});

describe("checkLocalFolder", () => {
	it("classifies empty, relative, missing, file and existing-dir paths", async () => {
		expect(await checkLocalFolder("")).toBe("empty");
		expect(await checkLocalFolder("   ")).toBe("empty");
		expect(await checkLocalFolder("relative/bank")).toBe("relative");
		expect(await checkLocalFolder(join(dir, "does-not-exist"))).toBe("missing");
		const existing = mkdtempSync(join(dir, "exists-"));
		expect(await checkLocalFolder(existing)).toBe("ok");
		expect(await checkLocalFolder(`  ${existing}  `)).toBe("ok"); // trims before checking
		const filePath = join(dir, "a-file.txt");
		writeFileSync(filePath, "x");
		expect(await checkLocalFolder(filePath)).toBe("not-a-dir");
	});
});

describe("setSyncSessions", () => {
	// The immediate switch behind /api/settings/set-sync-sessions. A one-field
	// merge, so it cannot clobber the rest of a config a batched save is editing.
	it("writes the switch and leaves every other field alone", async () => {
		const d = configDirWith({ syncSessions: true, dcoSignoff: true, model: "opus" });
		expect(await setSyncSessions(false, d)).toEqual({ syncSessions: false });
		let config = readConfig(d);
		expect(config.syncSessions).toBe(false);
		expect(config.dcoSignoff).toBe(true);
		expect(config.model).toBe("opus");

		expect(await setSyncSessions(true, d)).toEqual({ syncSessions: true });
		config = readConfig(d);
		expect(config.syncSessions).toBe(true);
		expect(config.model).toBe("opus");
	});
});
