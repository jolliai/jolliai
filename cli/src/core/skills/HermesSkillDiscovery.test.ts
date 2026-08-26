import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const upsertSkillEntry = vi.fn(async () => {});
const loadConfig = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock("../SessionTracker.js", () => ({
	upsertSkillEntry: (...args: unknown[]) => upsertSkillEntry(...(args as [])),
	loadConfig: () => loadConfig(),
}));

const isManuallyDisabled = vi.fn(() => false);
vi.mock("../../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../Logger.js")>();
	return { ...actual, isManuallyDisabled: () => isManuallyDisabled() };
});

import type { SkillUse } from "../../Types.js";
import { createHermesDb, type HermesSessionInput } from "../../testUtils/hermesDbFixture.js";
import { discoverHermesSkills } from "./HermesSkillDiscovery.js";

const HOUR = 60 * 60 * 1000;
const secondsAgo = (ms: number): number => (Date.now() - ms) / 1000;

/** The repo every fixture session is scoped to. */
const projectDir = "/tmp/proj";

function skillTurn(id: string, skill: string, timestamp: number): HermesSessionInput["messages"] {
	return [
		{
			role: "assistant",
			content: "",
			timestamp,
			toolCalls: [{ id, name: "skill_view", args: { name: skill } }],
		},
		{
			role: "tool",
			toolName: "skill_view",
			toolCallId: id,
			content: '{"success": true}',
			timestamp: timestamp + 1,
		},
	];
}

describe("discoverHermesSkills", () => {
	let home: string;
	const savedHermesHome = process.env.HERMES_HOME;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "hermes-skills-"));
		process.env.HERMES_HOME = home;
		upsertSkillEntry.mockClear();
		loadConfig.mockResolvedValue({});
		isManuallyDisabled.mockReturnValue(false);
	});

	afterEach(async () => {
		if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
		else process.env.HERMES_HOME = savedHermesHome;
		await rm(home, { recursive: true, force: true });
	});

	it("persists a skill entered in a session belonging to this repo", async () => {
		await createHermesDb(home, [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				cwd: projectDir,
				messages: skillTurn("c1", "hermes-agent", secondsAgo(HOUR)),
			},
		]);
		expect(await discoverHermesSkills(projectDir)).toBe(1);
		const [use] = upsertSkillEntry.mock.calls[0] as unknown as [SkillUse, string];
		expect(use).toMatchObject({ source: "hermes", skill: "hermes-agent", sessionKey: "hermes:s1" });
	});

	it("ignores a session that belongs to another repo", async () => {
		await createHermesDb(home, [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				cwd: "/tmp/other",
				messages: skillTurn("c1", "hermes-agent", secondsAgo(HOUR)),
			},
		]);
		expect(await discoverHermesSkills(projectDir)).toBe(0);
		expect(upsertSkillEntry).not.toHaveBeenCalled();
	});

	it("claims a session by git_repo_root when its cwd is elsewhere", async () => {
		await createHermesDb(home, [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				gitRepoRoot: projectDir,
				cwd: "/tmp/other",
				messages: skillTurn("c1", "hermes-agent", secondsAgo(HOUR)),
			},
		]);
		expect(await discoverHermesSkills(projectDir)).toBe(1);
	});

	it("finds a skill held in a named profile", async () => {
		// A profile-only user's default state.db is empty; reading only that one
		// would report "this agent used no skills".
		await createHermesDb(join(home, "profiles", "work"), [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				cwd: projectDir,
				messages: skillTurn("c1", "devops", secondsAgo(HOUR)),
			},
		]);
		expect(await discoverHermesSkills(projectDir)).toBe(1);
	});

	it("skips sessions outside the 7-day lookback", async () => {
		await createHermesDb(home, [
			{
				id: "old",
				startedAt: secondsAgo(30 * 24 * HOUR),
				lastActivityAt: secondsAgo(30 * 24 * HOUR),
				cwd: projectDir,
				messages: skillTurn("c1", "hermes-agent", secondsAgo(30 * 24 * HOUR)),
			},
		]);
		expect(await discoverHermesSkills(projectDir)).toBe(0);
	});

	it("skips hidden sessions and sessions with no recorded directory", async () => {
		await createHermesDb(home, [
			{
				id: "hidden",
				startedAt: secondsAgo(HOUR),
				cwd: projectDir,
				hidden: 1,
				messages: skillTurn("c1", "a", secondsAgo(HOUR)),
			},
			{
				id: "nodir",
				startedAt: secondsAgo(HOUR),
				cwd: null,
				gitRepoRoot: "  ",
				messages: skillTurn("c2", "b", secondsAgo(HOUR)),
			},
		]);
		expect(await discoverHermesSkills(projectDir)).toBe(0);
	});

	it("does nothing when the Hermes toggle is off", async () => {
		await createHermesDb(home, [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				cwd: projectDir,
				messages: skillTurn("c1", "hermes-agent", secondsAgo(HOUR)),
			},
		]);
		loadConfig.mockResolvedValue({ hermesEnabled: false });
		expect(await discoverHermesSkills(projectDir)).toBe(0);
		expect(upsertSkillEntry).not.toHaveBeenCalled();
	});

	it("writes nothing into a manually disabled project", async () => {
		await createHermesDb(home, [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				cwd: projectDir,
				messages: skillTurn("c1", "hermes-agent", secondsAgo(HOUR)),
			},
		]);
		isManuallyDisabled.mockReturnValue(true);
		expect(await discoverHermesSkills(projectDir)).toBe(0);
	});

	it("returns 0 rather than throwing when no database exists", async () => {
		expect(await discoverHermesSkills(projectDir)).toBe(0);
	});

	it("single-flights concurrent callers per cwd", async () => {
		await createHermesDb(home, [
			{
				id: "s1",
				startedAt: secondsAgo(HOUR),
				cwd: projectDir,
				messages: skillTurn("c1", "hermes-agent", secondsAgo(HOUR)),
			},
		]);
		const [a, b] = await Promise.all([discoverHermesSkills(projectDir), discoverHermesSkills(projectDir)]);
		expect([a, b]).toEqual([1, 1]);
		// One pass, not two: the second caller joined the in-flight run rather than
		// re-deriving the same answer under the plans lock.
		expect(upsertSkillEntry).toHaveBeenCalledTimes(1);
	});
});
