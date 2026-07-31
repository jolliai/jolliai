import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only `vscode` is stubbed — the Logger this module imports needs an output
// channel. The registry read/write stays REAL against a temp directory, so these
// tests exercise the actual plans.json shape rather than a mocked projection of it.
vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "test",
		})),
	},
	workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })) },
}));
import { savePlansRegistry } from "../../../cli/src/core/SessionTracker.js";
import type { SkillEntry } from "../../../cli/src/Types.js";
import { detectSkills } from "./SkillService.js";

describe("detectSkills", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "skill-service-test-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	const entry = (over: Partial<SkillEntry> = {}): SkillEntry => ({
		source: "claude",
		skill: "superpowers:brainstorming",
		plugin: "superpowers",
		entryPaths: ["tool"],
		invocations: [{ at: "2026-07-30T07:00:00.000Z", ok: true }],
		invocationCount: 2,
		firstUsedAt: "2026-07-30T06:00:00.000Z",
		lastUsedAt: "2026-07-30T07:00:00.000Z",
		usage: { input: 79, cached: 59796, output: 33944, confidence: "attributed" },
		sourcePath: join(cwd, ".jolli", "jollimemory", "skills", "claude", "x.md"),
		commitHash: null,
		...over,
	});

	async function seed(skills: Record<string, SkillEntry>): Promise<void> {
		await savePlansRegistry({ version: 1, plans: {}, skills }, cwd);
	}

	it("returns a skill re-entered after being archived", async () => {
		// A skill archived onto commit A and used again before commit B is live working
		// state. Gating on the guard alone dropped it from the panel permanently.
		await seed({
			"claude:superpowers:brainstorming": entry({
				invocationCount: 5,
				commitHash: "abc12345",
				contentHashAtCommit: "deadbeef",
				archivedTotals: { invocationCount: 2 },
			}),
		});
		expect(await detectSkills(cwd)).toHaveLength(1);
	});

	it("projects an active row for the panel", async () => {
		await seed({ "claude:superpowers:brainstorming": entry() });
		const [info] = await detectSkills(cwd);
		expect(info.skill).toBe("superpowers:brainstorming");
		expect(info.invocationCount).toBe(2);
		expect(info.mapKey).toBe("claude:superpowers:brainstorming");
		// lastModified mirrors lastUsedAt so it sorts against the other kinds.
		expect(info.lastModified).toBe("2026-07-30T07:00:00.000Z");
	});

	it("projects the uncommitted delta, not the row's lifetime total", async () => {
		// Regression: the delta decided VISIBILITY but the row supplied the FIGURES, so a
		// re-used skill was previewed with everything already frozen onto earlier commits
		// included. `storeSkills` archives the delta, so the panel overstated what the
		// pending commit would actually carry.
		await seed({
			"claude:superpowers:brainstorming": entry({
				invocationCount: 5,
				usage: { input: 100, cached: 1000, output: 500, confidence: "attributed" },
				commitHash: "abc12345",
				contentHashAtCommit: "deadbeef",
				archivedTotals: {
					invocationCount: 3,
					usage: { input: 60, cached: 600, output: 300, confidence: "attributed" },
				},
			}),
		});
		const [info] = await detectSkills(cwd);
		expect(info.invocationCount).toBe(2);
		expect(info.usage).toEqual({ input: 40, cached: 400, output: 200, confidence: "attributed" });
		// The timestamps deliberately stay the row's: SkillArchivedTotals has no time
		// fields and storeSkills stamps its ref from the row too, so reading them here
		// is what keeps the preview in parity with the committed record.
		expect(info.firstUsedAt).toBe("2026-07-30T06:00:00.000Z");
		expect(info.lastUsedAt).toBe("2026-07-30T07:00:00.000Z");
	});

	it("excludes a row already archived onto a commit", async () => {
		// The critical difference from references: a reference row is DELETED on
		// commit, so detectReferences returns everything it finds. A skill row is
		// guarded and stays, so returning everything would put every skill ever used
		// back on the panel as fresh working state.
		await seed({
			live: entry(),
			archived: entry({ commitHash: "abc12345", contentHashAtCommit: "deadbeef" }),
		});
		const result = await detectSkills(cwd);
		expect(result).toHaveLength(1);
		expect(result[0].mapKey).toBe("live");
	});

	it("excludes a half-archived row that carries only a content hash", async () => {
		await seed({ odd: entry({ contentHashAtCommit: "deadbeef" }) });
		expect(await detectSkills(cwd)).toEqual([]);
	});

	it("returns newest first", async () => {
		await seed({
			older: entry({ lastUsedAt: "2026-07-30T01:00:00.000Z" }),
			newer: entry({ lastUsedAt: "2026-07-30T20:00:00.000Z" }),
		});
		expect((await detectSkills(cwd)).map((s) => s.mapKey)).toEqual(["newer", "older"]);
	});

	it("keeps usage absent when the row had none", async () => {
		await seed({ heuristic: entry({ usage: undefined }) });
		expect((await detectSkills(cwd))[0].usage).toBeUndefined();
	});

	it("returns empty when no skills were ever captured", async () => {
		await savePlansRegistry({ version: 1, plans: {} }, cwd);
		expect(await detectSkills(cwd)).toEqual([]);
	});

	it("returns empty for a project with no registry at all", async () => {
		expect(await detectSkills(cwd)).toEqual([]);
	});
});
