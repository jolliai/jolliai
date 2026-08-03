import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillEntry } from "../../Types.js";
import { loadPlansRegistry, savePlansRegistry, upsertSkillEntry } from "../SessionTracker.js";
import { associateSkillsWithCommit, skillOrphanPath } from "./SkillArchive.js";

describe("skillOrphanPath", () => {
	it("namespaces by source so one skill id cannot collide across hosts", () => {
		// The registry key is `<source>:<skill>`, so two hosts can legitimately hold
		// the same skill id. A flat `skills/<stem>.md` layout would archive one over
		// the other.
		const claude = skillOrphanPath("claude", "superpowers:brainstorming", "abc12345");
		const opencode = skillOrphanPath("opencode", "superpowers:brainstorming", "abc12345");
		expect(claude).not.toBe(opencode);
		expect(claude.startsWith("skills/claude/")).toBe(true);
		expect(opencode.startsWith("skills/opencode/")).toBe(true);
	});

	it("carries the commit short hash so re-archiving one skill does not overwrite history", () => {
		const first = skillOrphanPath("claude", "superpowers:brainstorming", "abc12345");
		const second = skillOrphanPath("claude", "superpowers:brainstorming", "def67890");
		expect(first).not.toBe(second);
		expect(first.endsWith("-abc12345.md")).toBe(true);
	});

	it("produces a path with no host-supplied unsafe bytes", () => {
		const path = skillOrphanPath("claude", "plugin:../escape", "abc12345");
		expect(path.split("/")).toHaveLength(3);
		expect(path).not.toContain("..");
	});
});

describe("associateSkillsWithCommit", () => {
	let tempDir: string;
	const COMMIT = "abc12345deadbeef";
	const SHORT = "abc12345";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "skill-archive-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function seedCapturedSkill(skill = "superpowers:brainstorming"): Promise<void> {
		await upsertSkillEntry(
			{
				source: "claude",
				skill,
				plugin: "superpowers",
				entryPaths: ["tool"],
				invocations: [{ at: "2026-07-30T06:01:57.000Z", ok: true, bodyChars: 10280 }],
				usage: { input: 1, cached: 4162, output: 797, confidence: "attributed" },
				sessionKey: "claude:sess-a",
			},
			tempDir,
		);
	}

	it("returns a commit ref carrying the archived key and the usage snapshot", async () => {
		await seedCapturedSkill();
		const { refs } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs).toHaveLength(1);
		expect(refs[0].archivedKey).toBe(`claude:superpowers:brainstorming-${SHORT}`);
		expect(refs[0].invocationCount).toBe(1);
		expect(refs[0].usage).toEqual({ input: 1, cached: 4162, output: 797, confidence: "attributed" });
	});

	it("snapshots the per-session split onto the commit ref", async () => {
		// Detach runs after the commit, so the split has to be reachable from the
		// summary — leaving it only in the working registry would strand it.
		await seedCapturedSkill();
		const { refs } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs[0].usageBySession).toEqual({
			"claude:sess-a": { input: 1, cached: 4162, output: 797, confidence: "attributed" },
		});
	});

	// A heuristically-detected skill must keep reading as inferred once archived.
	// Dropping `detection` here would silently promote a guess to an observation
	// the moment the commit landed.
	it("carries the heuristic detection marker onto the commit ref", async () => {
		await upsertSkillEntry(
			{
				source: "codex",
				skill: "inferred-skill",
				entryPaths: ["tool"],
				invocations: [{ at: "2026-07-30T06:01:57.000Z", ok: true, bodyChars: 100 }],
				detection: "heuristic",
				sessionKey: "codex:sess-h",
			},
			tempDir,
		);
		const { refs } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs).toHaveLength(1);
		expect(refs[0].detection).toBe("heuristic");
	});

	it("hands the caller the raw working-file bytes to store, not a re-render", async () => {
		// Archival is a COPY. Rendering markdown again at archive time would put the
		// display format in a second place and let the two drift.
		await seedCapturedSkill();
		const registry = await loadPlansRegistry(tempDir);
		const onDisk = await readFile(registry.skills?.["claude:superpowers:brainstorming"]?.sourcePath ?? "", "utf-8");

		const { filesToStore } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(filesToStore).toHaveLength(1);
		expect(filesToStore[0].content).toBe(onDisk);
	});

	it("guards the working row instead of deleting it", async () => {
		// Plan/note lifecycle, not the reference one: the row survives with
		// commitHash + contentHashAtCommit so a later re-entry reads as changed.
		await seedCapturedSkill();
		await associateSkillsWithCommit(COMMIT, tempDir, "main");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry).toBeDefined();
		expect(entry?.commitHash).toBe(COMMIT);
		expect(entry?.contentHashAtCommit).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes the guard over the bytes actually archived", async () => {
		await seedCapturedSkill();
		const { filesToStore } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		const { createHash } = await import("node:crypto");
		expect(entry?.contentHashAtCommit).toBe(createHash("sha256").update(filesToStore[0].content).digest("hex"));
	});

	it("skips a row already archived onto a commit", async () => {
		await seedCapturedSkill();
		await associateSkillsWithCommit(COMMIT, tempDir, "main");
		const second = await associateSkillsWithCommit("ffffffffffffffff", tempDir, "main");
		expect(second.refs).toEqual([]);
		// The original guard is untouched, so the first commit keeps its record.
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry?.commitHash).toBe(COMMIT);
	});

	it("does not re-archive on a cleared guard alone when no new usage landed", async () => {
		// The signal is the COUNTERS moving past `archivedTotals`, not the guard being
		// absent. Re-archiving on a bare cleared guard would copy the same invocations
		// onto a second commit, and the PR-wide aggregate sums commits.
		await seedCapturedSkill();
		await associateSkillsWithCommit(COMMIT, tempDir, "main");

		const registry = await loadPlansRegistry(tempDir);
		const archived = registry.skills?.["claude:superpowers:brainstorming"] as SkillEntry;
		await savePlansRegistry(
			{
				...registry,
				skills: {
					"claude:superpowers:brainstorming": {
						...archived,
						commitHash: null,
						contentHashAtCommit: undefined,
					},
				},
			},
			tempDir,
		);

		const second = await associateSkillsWithCommit("ffffffffffffffff", tempDir, "main");
		expect(second.refs).toEqual([]);
	});

	it("carries only the increment when a skill is archived onto a second commit", async () => {
		// Each commit holds its own share, so the PR-wide aggregate stays a plain sum.
		// A running total here would re-count the first commit's spend.
		await seedCapturedSkill();
		const first = await associateSkillsWithCommit(COMMIT, tempDir, "main");

		await upsertSkillEntry(
			{
				source: "claude",
				skill: "superpowers:brainstorming",
				plugin: "superpowers",
				entryPaths: ["tool"],
				invocations: [{ at: "2026-07-30T08:14:03.000Z", ok: true, bodyChars: 4410 }],
				usage: { input: 2, cached: 900, output: 310, confidence: "attributed" },
				sessionKey: "claude:sess-b",
			},
			tempDir,
		);
		const second = await associateSkillsWithCommit("ffffffffffffffff", tempDir, "main");

		expect(first.refs[0].invocationCount).toBe(1);
		expect(second.refs[0].invocationCount).toBe(1);
		expect(first.refs[0].usage).toEqual({ input: 1, cached: 4162, output: 797, confidence: "attributed" });
		expect(second.refs[0].usage).toEqual({ input: 2, cached: 900, output: 310, confidence: "attributed" });
		// Only the session that ran since the first commit — sess-a is already accounted for.
		expect(Object.keys(second.refs[0].usageBySession ?? {})).toEqual(["claude:sess-b"]);
	});

	it("re-archives a skill re-entered through the real capture path", async () => {
		// The test above clears the guard by hand. This one drives the path that
		// actually runs between two commits — a second invocation folded in by
		// upsertSkillEntry — because that is the only way to prove the guard
		// clears itself in production rather than only in a test fixture.
		await seedCapturedSkill();
		await associateSkillsWithCommit(COMMIT, tempDir, "main");

		await upsertSkillEntry(
			{
				source: "claude",
				skill: "superpowers:brainstorming",
				plugin: "superpowers",
				entryPaths: ["tool"],
				invocations: [{ at: "2026-07-30T08:14:03.000Z", ok: true, bodyChars: 4410 }],
				usage: { input: 2, cached: 900, output: 310, confidence: "attributed" },
				sessionKey: "claude:sess-b",
			},
			tempDir,
		);

		const second = await associateSkillsWithCommit("ffffffffffffffff", tempDir, "main");
		expect(second.refs).toHaveLength(1);
		expect(second.refs[0].archivedKey).toBe("claude:superpowers:brainstorming-ffffffff");
	});

	it("archives every captured skill", async () => {
		await seedCapturedSkill("superpowers:brainstorming");
		await seedCapturedSkill("j:specs-pr-review");
		const { refs, filesToStore } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs).toHaveLength(2);
		expect(filesToStore).toHaveLength(2);
		expect(new Set(filesToStore.map((f) => f.path)).size).toBe(2);
	});

	it("skips an excluded skill entirely — no ref, no file, no guard", async () => {
		// Exclusion must be applied INSIDE the association, not to its result: this
		// function guards rows and emits bytes to store, so a post-filter would leave
		// the excluded skill archived on the orphan branch anyway.
		await seedCapturedSkill("superpowers:brainstorming");
		await seedCapturedSkill("j:specs-pr-review");

		const { refs, filesToStore } = await associateSkillsWithCommit(
			COMMIT,
			tempDir,
			"main",
			new Set(["claude:superpowers:brainstorming"]),
		);
		expect(refs.map((r) => r.skill)).toEqual(["j:specs-pr-review"]);
		expect(filesToStore).toHaveLength(1);
	});

	it("leaves an excluded skill on the panel for the next commit", async () => {
		// "Leave out of this memory" is a one-commit skip, not a delete: the row keeps
		// commitHash null so detectActiveSkillsForBranch surfaces it again.
		await seedCapturedSkill();
		await associateSkillsWithCommit(COMMIT, tempDir, "main", new Set(["claude:superpowers:brainstorming"]));
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry?.commitHash).toBeNull();
		expect(entry?.contentHashAtCommit).toBeUndefined();
	});

	it("is a no-op when nothing was captured", async () => {
		const { refs, filesToStore } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs).toEqual([]);
		expect(filesToStore).toEqual([]);
	});

	it("drops a row whose working file has gone missing", async () => {
		// Nothing to copy means nothing to archive; inventing a ref would point the
		// commit summary at a file that was never written.
		await seedCapturedSkill();
		const registry = await loadPlansRegistry(tempDir);
		await rm(registry.skills?.["claude:superpowers:brainstorming"]?.sourcePath ?? "", { force: true });

		const { refs, filesToStore } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs).toEqual([]);
		expect(filesToStore).toEqual([]);
	});

	it("omits usage from the ref when the working row had none", async () => {
		await upsertSkillEntry(
			{
				source: "claude",
				skill: "codex-only:thing",
				entryPaths: ["tool"],
				invocations: [{ at: "2026-07-30T06:01:57.000Z", ok: true }],
			},
			tempDir,
		);
		const { refs } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs[0].usage).toBeUndefined();
	});

	it("tolerates an unreadable working file without failing the whole archive", async () => {
		await seedCapturedSkill("superpowers:brainstorming");
		await seedCapturedSkill("j:specs-pr-review");
		const registry = await loadPlansRegistry(tempDir);
		const victim = registry.skills?.["claude:superpowers:brainstorming"]?.sourcePath ?? "";
		await rm(victim, { force: true });
		await writeFile(`${victim}.decoy`, "x", "utf-8");

		const { refs } = await associateSkillsWithCommit(COMMIT, tempDir, "main");
		expect(refs.map((r) => r.skill)).toEqual(["j:specs-pr-review"]);
	});
});
