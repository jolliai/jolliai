import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hermesAllowlistPath,
	hermesConfigPath,
	hermesHomeDir,
	hermesScriptMtimeIsoFromNs,
	isHermesHookInstalled,
	listHermesHomeDirs,
	preAcceptHermesShellHook,
	revokeHermesShellHook,
} from "./HermesConfigPaths.js";

describe("hermesHomeDir", () => {
	it("defaults to ~/.hermes", () => {
		expect(hermesHomeDir({ HERMES_HOME: "" }, "/home/u", "linux")).toBe(join("/home/u", ".hermes"));
	});

	it("respects $HERMES_HOME when set — a moved state root must not silently skip Jolli", () => {
		expect(hermesHomeDir({ HERMES_HOME: "/opt/hermes-alt" })).toBe("/opt/hermes-alt");
	});

	it("treats an all-whitespace override as unset", () => {
		expect(hermesHomeDir({ HERMES_HOME: "   " }, "/home/u", "darwin")).toBe(join("/home/u", ".hermes"));
	});

	it("uses LOCALAPPDATA on Windows", () => {
		expect(
			hermesHomeDir({ HERMES_HOME: "", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u", "win32"),
		).toBe(join("C:\\Users\\u\\AppData\\Local", "hermes"));
	});

	it("uses the Windows home fallback when LOCALAPPDATA is absent", () => {
		expect(hermesHomeDir({ HERMES_HOME: "" }, "/home/u", "win32")).toBe(
			join("/home/u", "AppData", "Local", "hermes"),
		);
	});

	it("derives config.yaml and shell-hooks-allowlist.json from the same root", () => {
		expect(hermesConfigPath({ HERMES_HOME: "/opt/hermes" })).toBe(join("/opt/hermes", "config.yaml"));
		expect(hermesAllowlistPath({ HERMES_HOME: "/opt/hermes" })).toBe(
			join("/opt/hermes", "shell-hooks-allowlist.json"),
		);
	});
});

describe("listHermesHomeDirs", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hermes-homes-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns the default home when there are no profiles", async () => {
		expect(await listHermesHomeDirs({ HERMES_HOME: dir })).toEqual([dir]);
	});

	it("includes every named profile that has produced any artifact, skipping empty directories and stray files", async () => {
		await mkdir(join(dir, "profiles", "work"), { recursive: true });
		await mkdir(join(dir, "profiles", "personal"), { recursive: true });
		await mkdir(join(dir, "profiles", "never-used"), { recursive: true });
		// A profile is a complete Hermes instance once anything initialized it:
		// its own config from creation, a state.db after the first conversation,
		// or any other artifact. A still-empty directory is not an instance.
		await writeFile(join(dir, "profiles", "work", "config.yaml"), "model: {}\n");
		await writeFile(join(dir, "profiles", "personal", "state.db"), "");
		await writeFile(join(dir, "profiles", "README.txt"), "not a profile");
		expect(await listHermesHomeDirs({ HERMES_HOME: dir })).toEqual([
			dir,
			join(dir, "profiles", "personal"),
			join(dir, "profiles", "work"),
		]);
	});

	it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
		"skips an unreadable profile instead of treating it as a writable Hermes home",
		async () => {
			const profile = join(dir, "profiles", "private");
			await mkdir(profile, { recursive: true });
			await writeFile(join(profile, "user-owned.txt"), "not proof that this is a Hermes home");
			await chmod(profile, 0o000);
			try {
				expect(await listHermesHomeDirs({ HERMES_HOME: dir })).toEqual([dir]);
			} finally {
				await chmod(profile, 0o700);
			}
		},
	);
});

describe("isHermesHookInstalled", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hermes-hook-status-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("is false when no config exists", async () => {
		expect(await isHermesHookInstalled({ HERMES_HOME: dir })).toBe(false);
	});

	it("is false when the config has no hermes-stop command", async () => {
		await writeFile(
			join(dir, "config.yaml"),
			"hooks:\n  on_session_end:\n    - command: /user/other.sh\n",
			"utf-8",
		);
		expect(await isHermesHookInstalled({ HERMES_HOME: dir })).toBe(false);
	});

	it("is true when the hooks block contains hermes-stop", async () => {
		await writeFile(
			join(dir, "config.yaml"),
			"model: {}\nhooks:\n  on_session_end:\n    - command: /jolli/run-hook hermes-stop\n      timeout: 30\n",
			"utf-8",
		);
		expect(await isHermesHookInstalled({ HERMES_HOME: dir })).toBe(true);
	});

	it("checks every active profile and returns true when any has the hook", async () => {
		await mkdir(join(dir, "profiles", "work"), { recursive: true });
		await writeFile(
			join(dir, "profiles", "work", "config.yaml"),
			"hooks:\n  on_session_end:\n    - command: /jolli/run-hook hermes-stop\n",
			"utf-8",
		);
		expect(await isHermesHookInstalled({ HERMES_HOME: dir })).toBe(true);
	});

	it("is false on win32 even when the config exists", async () => {
		await writeFile(
			join(dir, "config.yaml"),
			"hooks:\n  on_session_end:\n    - command: /jolli/run-hook hermes-stop\n",
			"utf-8",
		);
		expect(await isHermesHookInstalled({ HERMES_HOME: dir }, "/home/u", "win32")).toBe(false);
	});
});

describe("preAcceptHermesShellHook", () => {
	let dir: string;
	let path: string;
	let scriptPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hermes-allowlist-"));
		path = join(dir, "shell-hooks-allowlist.json");
		scriptPath = join(dir, "run-hook");
		await writeFile(scriptPath, "#!/bin/bash\necho ok\n");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a new allowlist file when one does not exist", async () => {
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T00:00:00Z",
		});
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		expect(parsed.approvals).toHaveLength(1);
		expect(parsed.approvals[0]).toMatchObject({
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			approved_at: "2026-08-26T00:00:00Z",
		});
		// script_mtime_at_approval is filled in from the real file, not null.
		expect(parsed.approvals[0].script_mtime_at_approval).toMatch(/Z$/);
	});

	it("adds our entry alongside a pre-existing user approval", async () => {
		await writeFile(
			path,
			JSON.stringify({
				approvals: [
					{
						event: "pre_tool_call",
						command: "/user/hook.sh",
						approved_at: "2026-01-01T00:00:00Z",
						script_mtime_at_approval: null,
					},
				],
			}),
		);
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T00:00:00Z",
		});
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		expect(parsed.approvals).toHaveLength(2);
		// User's entry is preserved verbatim.
		expect(parsed.approvals.find((e: { command: string }) => e.command === "/user/hook.sh")).toBeDefined();
		// The array is written in deterministic (event, command) order, so a
		// re-scan of the file compares equal regardless of insertion order.
		expect(parsed.approvals[0].event).toBe("on_session_end");
		expect(parsed.approvals[1].event).toBe("pre_tool_call");
	});

	it("is byte-stable when the pair and script mtime are unchanged", async () => {
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T00:00:00Z",
		});
		const first = await readFile(path, "utf-8");
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-09-01T00:00:00Z", // Different stamp — must NOT be recorded.
		});
		expect(await readFile(path, "utf-8")).toBe(first);
	});

	it("refreshes an existing approval after the dispatcher is atomically replaced", async () => {
		await utimes(scriptPath, new Date("2026-08-26T00:00:00.123Z"), new Date("2026-08-26T00:00:00.123Z"));
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T01:00:00Z",
		});
		const before = JSON.parse(await readFile(path, "utf-8"));

		// Replacing run-hook is what runtime upgrades do: the command pair stays the
		// same, but Hermes requires a fresh approval for the new script mtime.
		await writeFile(scriptPath, "#!/bin/bash\necho upgraded\n");
		await utimes(scriptPath, new Date("2026-09-01T02:03:04.456Z"), new Date("2026-09-01T02:03:04.456Z"));
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-09-01T03:00:00Z",
		});

		const after = JSON.parse(await readFile(path, "utf-8"));
		expect(after.approvals).toHaveLength(1);
		expect(after.approvals[0].approved_at).toBe("2026-09-01T03:00:00Z");
		expect(after.approvals[0].script_mtime_at_approval).not.toBe(before.approvals[0].script_mtime_at_approval);
		expect(after.approvals[0].script_mtime_at_approval).toBe("2026-09-01T02:03:04.456000Z");
	});

	it("matches Hermes' float-seconds and half-even microsecond rounding", () => {
		// Exact half-microsecond ties exercise both half-even directions.
		expect(hermesScriptMtimeIsoFromNs(500n)).toBe("1970-01-01T00:00:00Z");
		expect(hermesScriptMtimeIsoFromNs(1_500n)).toBe("1970-01-01T00:00:00.000002Z");
		// Carry from the rounded fractional part into the next second.
		expect(hermesScriptMtimeIsoFromNs(999_999_999n)).toBe("1970-01-01T00:00:01Z");
		// At today's epoch, binary64 loses enough sub-microsecond precision that
		// direct bigint rounding disagrees with Hermes in BOTH directions.
		expect(hermesScriptMtimeIsoFromNs(1_787_800_699_000_000_500n)).toBe("2026-08-27T03:18:19Z");
		expect(hermesScriptMtimeIsoFromNs(1_787_800_699_000_003_458n)).toBe("2026-08-27T03:18:19.000004Z");
	});

	it("preserves the allowlist mode when refreshing an approval", async () => {
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T00:00:00Z",
		});
		await chmod(path, 0o600);
		await writeFile(scriptPath, "#!/bin/bash\necho upgraded\n");
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-09-01T00:00:00Z",
		});
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("stores null for script_mtime when the referenced script does not exist yet", async () => {
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: "/missing/run-hook hermes-stop",
			scriptPath: "/missing/run-hook",
			nowIso: "2026-08-26T00:00:00Z",
		});
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		expect(parsed.approvals[0].script_mtime_at_approval).toBeNull();
	});

	it("does not corrupt an unparseable allowlist file — it leaves it alone", async () => {
		await writeFile(path, "{not-json");
		await preAcceptHermesShellHook(path, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T00:00:00Z",
		});
		expect(await readFile(path, "utf-8")).toBe("{not-json");
	});

	it("creates parent directory when writing to a nested absent path", async () => {
		const deep = join(dir, "nested", "deep", "shell-hooks-allowlist.json");
		await mkdir(join(dir, "nested", "deep"), { recursive: true });
		await preAcceptHermesShellHook(deep, {
			event: "on_session_end",
			command: `${scriptPath} hermes-stop`,
			scriptPath,
			nowIso: "2026-08-26T00:00:00Z",
		});
		const parsed = JSON.parse(await readFile(deep, "utf-8"));
		expect(parsed.approvals).toHaveLength(1);
	});
});

describe("revokeHermesShellHook", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "hermes-revoke-"));
		path = join(dir, "shell-hooks-allowlist.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("removes only Jolli's entry, leaving other approvals intact", async () => {
		await writeFile(
			path,
			JSON.stringify({
				approvals: [
					{
						event: "pre_tool_call",
						command: "/user/hook.sh",
						approved_at: "2026-01-01T00:00:00Z",
						script_mtime_at_approval: null,
					},
					{
						event: "on_session_end",
						command: "/jolli/run-hook hermes-stop",
						approved_at: "2026-08-26T00:00:00Z",
						script_mtime_at_approval: null,
					},
				],
			}),
		);
		await revokeHermesShellHook(path, { event: "on_session_end", command: "/jolli/run-hook hermes-stop" });
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		expect(parsed.approvals).toHaveLength(1);
		expect(parsed.approvals[0].command).toBe("/user/hook.sh");
	});

	it("sorts the remaining approvals and preserves the file mode", async () => {
		await writeFile(
			path,
			JSON.stringify({
				approvals: [
					{
						event: "pre_tool_call",
						command: "/z",
						approved_at: "2026-01-01T00:00:00Z",
						script_mtime_at_approval: null,
					},
					{
						event: "on_session_end",
						command: "/jolli/run-hook hermes-stop",
						approved_at: "2026-08-26T00:00:00Z",
						script_mtime_at_approval: null,
					},
					{
						event: "on_session_end",
						command: "/a",
						approved_at: "2026-01-01T00:00:00Z",
						script_mtime_at_approval: null,
					},
				],
			}),
		);
		await chmod(path, 0o600);

		await revokeHermesShellHook(path, { event: "on_session_end", command: "/jolli/run-hook hermes-stop" });

		const parsed = JSON.parse(await readFile(path, "utf-8"));
		expect(parsed.approvals.map((entry: { command: string }) => entry.command)).toEqual(["/a", "/z"]);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("is a no-op when the file is absent", async () => {
		await revokeHermesShellHook(path, { event: "on_session_end", command: "/x" });
		// No file created, no throw.
		await expect(readFile(path, "utf-8")).rejects.toThrow(/ENOENT/);
	});

	it("is a no-op when the entry is absent", async () => {
		const initial = JSON.stringify({ approvals: [] }, null, 2);
		await writeFile(path, initial);
		await revokeHermesShellHook(path, { event: "on_session_end", command: "/x" });
		expect(await readFile(path, "utf-8")).toBe(initial);
	});
});
