/**
 * Tests for SkillProjection — the shared IDE read path.
 *
 * It moved out of the VS Code extension so BOTH hosts consume one copy of the
 * uncommitted-delta rule, which means the CLI suite is now the only place that
 * covers it: the VS Code tests reach it through `detectSkills`, and IntelliJ
 * reaches it over the `skills-active` ide-bridge operation with no Kotlin
 * counterpart at all.
 *
 * The registry is REAL against a temp directory rather than a mocked
 * `loadPlansRegistry`, so these exercise the actual `plans.json` shape — a
 * projection that agreed with a mock but not with what `savePlansRegistry` writes
 * would pass while shipping empty panels.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlansRegistry, SkillEntry, SkillUsage } from "../../Types.js";
import { savePlansRegistry } from "../SessionTracker.js";
import { projectActiveSkills } from "./SkillProjection.js";

const usage = (input: number, cached: number, output: number, confidence: SkillUsage["confidence"]): SkillUsage => ({
	input,
	cached,
	output,
	confidence,
});

const entry = (over: Partial<SkillEntry> = {}): SkillEntry => ({
	source: "claude",
	skill: "superpowers:brainstorming",
	entryPaths: ["tool"],
	invocations: [],
	invocationCount: 2,
	firstUsedAt: "2026-07-30T06:00:00.000Z",
	lastUsedAt: "2026-07-30T07:00:00.000Z",
	sourcePath: "/tmp/brainstorming.md",
	commitHash: null,
	...over,
});

describe("projectActiveSkills", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "skill-projection-test-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	const save = async (skills: Record<string, SkillEntry>): Promise<void> => {
		await savePlansRegistry({ plans: {}, skills } as unknown as PlansRegistry, cwd);
	};

	it("returns nothing when the registry has no skills map at all", async () => {
		await savePlansRegistry({ plans: {} } as unknown as PlansRegistry, cwd);
		expect(await projectActiveSkills(cwd)).toEqual([]);
	});

	it("projects a never-archived row in full, carrying the map key and timestamps", async () => {
		await save({ "claude:superpowers:brainstorming": entry({ usage: usage(5, 10, 2, "attributed") }) });

		expect(await projectActiveSkills(cwd)).toEqual([
			{
				kind: "skill",
				mapKey: "claude:superpowers:brainstorming",
				source: "claude",
				skill: "superpowers:brainstorming",
				entryPaths: ["tool"],
				invocationCount: 2,
				firstUsedAt: "2026-07-30T06:00:00.000Z",
				lastUsedAt: "2026-07-30T07:00:00.000Z",
				usage: usage(5, 10, 2, "attributed"),
				sourcePath: "/tmp/brainstorming.md",
				lastModified: "2026-07-30T07:00:00.000Z",
			},
		]);
	});

	// The filter that makes this different from `detectReferences`: a skill row is
	// GUARDED on archive rather than deleted, so returning the raw map would put
	// every skill ever used back on the panel as fresh working state.
	it("hides a row whose counters have not moved past the archived baseline", async () => {
		await save({
			"claude:done": entry({
				skill: "done",
				commitHash: "abc1234",
				archivedTotals: { invocationCount: 2 },
			}),
		});
		expect(await projectActiveSkills(cwd)).toEqual([]);
	});

	it("hides a legacy row archived before archivedTotals existed", async () => {
		await save({ "claude:legacy": entry({ skill: "legacy", commitHash: "abc1234" }) });
		expect(await projectActiveSkills(cwd)).toEqual([]);
	});

	// The reason the delta is PROJECTED and not just used as a visibility test: the
	// row accumulates for the skill's whole life, and `storeSkills` archives the
	// delta's figures — so reporting the running total would overstate the pending
	// commit by everything already frozen onto earlier ones.
	it("reports the delta's counters, not the row's running total, for a re-entered skill", async () => {
		await save({
			"claude:reused": entry({
				skill: "reused",
				invocationCount: 5,
				usage: usage(100, 200, 50, "attributed"),
				commitHash: "abc1234",
				archivedTotals: { invocationCount: 3, usage: usage(60, 150, 20, "attributed") },
			}),
		});

		const [row] = await projectActiveSkills(cwd);
		expect(row?.invocationCount).toBe(2);
		expect(row?.usage).toEqual(usage(40, 50, 30, "attributed"));
		// Timestamps still come from the ROW — `SkillArchivedTotals` carries none, and
		// `storeSkills` stamps its ref from the row too, so this is parity, not a leak.
		expect(row?.firstUsedAt).toBe("2026-07-30T06:00:00.000Z");
		expect(row?.lastModified).toBe("2026-07-30T07:00:00.000Z");
	});

	it("leaves usage absent rather than rendering a zero when the source attributed nothing", async () => {
		await save({ "codex:heuristic": entry({ source: "codex", skill: "heuristic", detection: "heuristic" }) });

		const [row] = await projectActiveSkills(cwd);
		expect(row).not.toHaveProperty("usage");
		expect(row?.detection).toBe("heuristic");
	});

	it("omits plugin and detection when the row does not carry them", async () => {
		await save({ "claude:bare": entry({ skill: "bare" }) });

		const [row] = await projectActiveSkills(cwd);
		expect(row).not.toHaveProperty("plugin");
		expect(row).not.toHaveProperty("detection");
	});

	it("carries the plugin through when present", async () => {
		await save({ "claude:p": entry({ skill: "p:x", plugin: "p" }) });
		expect((await projectActiveSkills(cwd))[0]?.plugin).toBe("p");
	});

	it("sorts newest-first by lastModified so skills interleave with the other kinds", async () => {
		await save({
			"claude:old": entry({ skill: "old", lastUsedAt: "2026-07-30T01:00:00.000Z" }),
			"claude:new": entry({ skill: "new", lastUsedAt: "2026-07-30T09:00:00.000Z" }),
			"claude:mid": entry({ skill: "mid", lastUsedAt: "2026-07-30T05:00:00.000Z" }),
		});

		expect((await projectActiveSkills(cwd)).map((s) => s.skill)).toEqual(["new", "mid", "old"]);
	});
});
