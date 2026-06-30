import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	conversationKey,
	readExclusions,
	setAllExcluded,
	setExcluded,
} from "../../../cli/src/core/CommitSelectionStore.js";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../../../cli/src/Logger.js";
import type { SerializedTreeItem } from "../views/SidebarMessages.js";
import {
	type FilesSelectAll,
	type SelectAllCtx,
	type SelectAllCurrentMemoryCtx,
	selectAllConversationsCommand,
	selectAllCurrentMemoryCommand,
	selectAllPlansAndNotesCommand,
} from "./SelectAllSelection.js";

// ── Temp-dir lifecycle ────────────────────────────────────────────────────────

let cwd: string;

beforeEach(async () => {
	cwd = await mkdir(
		join(tmpdir(), `select-all-${Date.now()}-${Math.random()}`),
		{
			recursive: true,
		},
	).then((p) => p ?? "");
	await mkdir(join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

// ── Fixture builders ──────────────────────────────────────────────────────────

/**
 * Builds a SelectAllCtx whose activeSessions stub returns the given items.
 * Each item's `isSelected` is read back from the real CommitSelectionStore
 * on each call so the tests can mutate exclusions between calls and see the
 * updated `isSelected` values.
 */
function makeConversationCtx(
	conversations: Array<{
		source:
			| "claude"
			| "codex"
			| "gemini"
			| "opencode"
			| "cursor"
			| "copilotcli"
			| "copilotchat";
		sessionId: string;
	}>,
	changed: Array<() => void | Promise<void>> = [],
): SelectAllCtx {
	return {
		cwd,
		activeSessions: {
			async listWithDiagnostics() {
				// Re-read exclusions each time so `isSelected` reflects current state.
				const ex = await readExclusions(cwd);
				const items = conversations.map((c) => ({
					sessionId: c.sessionId,
					source: c.source,
					title: c.sessionId,
					messageCount: 0,
					updatedAt: new Date().toISOString(),
					transcriptPath: "/tmp/fake",
					isEdited: false,
					isSelected: !ex.conversations.has(
						conversationKey(c.source, c.sessionId),
					),
				}));
				return { items, failedSources: [] };
			},
		},
		plansProvider: {
			serialize: () => [],
			async refreshExclusions() {},
		},
		onChanged: async () => {
			for (const fn of changed) await fn();
		},
	};
}

/**
 * Builds a SelectAllCtx whose plansProvider.serialize() returns fixed rows
 * derived from the given planIds and noteIds. `isSelected` is re-read from
 * CommitSelectionStore on each serialize() call.
 */
function makePlansCtx(
	planIds: string[],
	noteIds: string[],
	changed: Array<() => void | Promise<void>> = [],
	entityIds: string[] = [],
): SelectAllCtx {
	let cachedExclusions = {
		plans: new Set<string>(),
		notes: new Set<string>(),
		conversations: new Set<string>(),
		references: new Set<string>(),
	};
	return {
		cwd,
		activeSessions: {
			async listWithDiagnostics() {
				return { items: [], failedSources: [] };
			},
		},
		plansProvider: {
			serialize(): ReadonlyArray<SerializedTreeItem> {
				const planRows: SerializedTreeItem[] = planIds.map((id) => ({
					id,
					label: id,
					contextValue: "plan",
					isSelected: !cachedExclusions.plans.has(id),
				}));
				const noteRows: SerializedTreeItem[] = noteIds.map((id) => ({
					id,
					label: id,
					contextValue: "note",
					isSelected: !cachedExclusions.notes.has(id),
				}));
				const entityRows: SerializedTreeItem[] = entityIds.map((id) => ({
					id,
					label: id,
					contextValue: "reference",
					isSelected: !cachedExclusions.references.has(id),
				}));
				return [...planRows, ...noteRows, ...entityRows];
			},
			async refreshExclusions() {
				// Re-read so the next serialize() sees the new state.
				cachedExclusions = await readExclusions(cwd);
			},
		},
		onChanged: async () => {
			for (const fn of changed) await fn();
		},
	};
}

// ── selectAllConversationsCommand ─────────────────────────────────────────────

describe("selectAllConversationsCommand", () => {
	it("excludes everything when nothing is currently excluded", async () => {
		const ctx = makeConversationCtx([
			{ source: "claude", sessionId: "a" },
			{ source: "codex", sessionId: "b" },
		]);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("claude", "a"))).toBe(true);
		expect(ex.conversations.has(conversationKey("codex", "b"))).toBe(true);
	});

	it("clears the visible set when everything is currently excluded", async () => {
		// First, exclude all.
		await setAllExcluded(
			cwd,
			"conversations",
			[conversationKey("claude", "a"), conversationKey("codex", "b")],
			true,
		);

		// Ctx re-reads exclusions on each call — will report isSelected:false for both.
		const ctx = makeConversationCtx([
			{ source: "claude", sessionId: "a" },
			{ source: "codex", sessionId: "b" },
		]);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("with mixed state, switches to all-selected", async () => {
		// Exclude only "a".
		await setExcluded(
			cwd,
			"conversations",
			conversationKey("claude", "a"),
			true,
		);

		// Ctx re-reads exclusions — "a" isSelected:false, "b" isSelected:true → mixed.
		const ctx = makeConversationCtx([
			{ source: "claude", sessionId: "a" },
			{ source: "codex", sessionId: "b" },
		]);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(cwd);
		// Spec: "If every visible item is selected → deselect all. Otherwise
		// (none selected, or mixed) → select all." Mixed → select all,
		// i.e. exclusions cleared for the visible set.
		expect(ex.conversations.has(conversationKey("claude", "a"))).toBe(false);
		expect(ex.conversations.has(conversationKey("codex", "b"))).toBe(false);
	});

	it("does nothing to exclusions when item list is empty", async () => {
		const ctx = makeConversationCtx([]);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("calls onChanged", async () => {
		let called = false;
		const ctx = makeConversationCtx(
			[{ source: "claude", sessionId: "x" }],
			[
				() => {
					called = true;
				},
			],
		);
		await selectAllConversationsCommand(ctx);
		expect(called).toBe(true);
	});
});

// ── selectAllPlansAndNotesCommand ─────────────────────────────────────────────

describe("selectAllPlansAndNotesCommand", () => {
	it("excludes plans and notes together when nothing is excluded", async () => {
		const ctx = makePlansCtx(["plan-1", "plan-2"], ["note-1"]);
		await selectAllPlansAndNotesCommand(ctx);
		const ex = await readExclusions(cwd);
		expect([...ex.plans].sort()).toEqual(["plan-1", "plan-2"]);
		expect([...ex.notes]).toEqual(["note-1"]);
	});

	it("selects all when every plan and note is excluded", async () => {
		await setAllExcluded(cwd, "plans", ["plan-1", "plan-2"], true);
		await setAllExcluded(cwd, "notes", ["note-1"], true);

		const ctx = makePlansCtx(["plan-1", "plan-2"], ["note-1"]);
		// refreshExclusions() is called inside the command — ctx will see current exclusions.
		await ctx.plansProvider.refreshExclusions();
		await selectAllPlansAndNotesCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.plans.size).toBe(0);
		expect(ex.notes.size).toBe(0);
	});

	it("switches to all-selected with mixed state (some plan excluded)", async () => {
		await setExcluded(cwd, "plans", "plan-1", true);

		const ctx = makePlansCtx(["plan-1", "plan-2"], ["note-1"]);
		await ctx.plansProvider.refreshExclusions();
		await selectAllPlansAndNotesCommand(ctx);

		const ex = await readExclusions(cwd);
		// Spec: mixed → select all → exclusions for visible plans/notes cleared.
		expect(ex.plans.has("plan-1")).toBe(false);
		expect(ex.plans.has("plan-2")).toBe(false);
		expect(ex.notes.has("note-1")).toBe(false);
	});

	it("ignores rows with unknown contextValues", async () => {
		// Defence-in-depth: a row with a contextValue that isn't plan / note /
		// entity (e.g. a future row kind, or a legacy 'linearissue' value from a
		// stale SidebarSerialize) must NOT land in any of the three exclusion
		// sets we update.
		const unknownRow: SerializedTreeItem = {
			id: "MYSTERY-1",
			label: "Future row",
			contextValue: "mystery",
			isSelected: true,
		};
		const planRow: SerializedTreeItem = {
			id: "plan-1",
			label: "Plan 1",
			contextValue: "plan",
			isSelected: true,
		};
		const stubCtx: SelectAllCtx = {
			cwd,
			activeSessions: {
				async listWithDiagnostics() {
					return { items: [], failedSources: [] };
				},
			},
			plansProvider: {
				serialize() {
					return [planRow, unknownRow];
				},
				async refreshExclusions() {},
			},
			onChanged: async () => {},
		};
		await selectAllPlansAndNotesCommand(stubCtx);
		const ex = await readExclusions(cwd);
		expect(ex.plans.has("plan-1")).toBe(true);
		expect(ex.plans.has("MYSTERY-1")).toBe(false);
		expect(ex.notes.has("MYSTERY-1")).toBe(false);
		expect(ex.references.has("MYSTERY-1")).toBe(false);
	});

	it("excludes entity rows alongside plans and notes", async () => {
		const ctx = makePlansCtx(["plan-1"], ["note-1"], [], ["jira:KAN-7", "github:owner/repo#1"]);
		await selectAllPlansAndNotesCommand(ctx);
		const ex = await readExclusions(cwd);
		expect(ex.plans.has("plan-1")).toBe(true);
		expect(ex.notes.has("note-1")).toBe(true);
		expect([...ex.references].sort()).toEqual(["github:owner/repo#1", "jira:KAN-7"]);
	});

	it("clears all three groups when every row is excluded", async () => {
		await setAllExcluded(cwd, "plans", ["plan-1"], true);
		await setAllExcluded(cwd, "notes", ["note-1"], true);
		await setAllExcluded(cwd, "references", ["jira:KAN-7"], true);

		const ctx = makePlansCtx(["plan-1"], ["note-1"], [], ["jira:KAN-7"]);
		await ctx.plansProvider.refreshExclusions();
		await selectAllPlansAndNotesCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.plans.size).toBe(0);
		expect(ex.notes.size).toBe(0);
		expect(ex.references.size).toBe(0);
	});

	it("with mixed entity state, switches to all-selected (clears all visible exclusions)", async () => {
		await setExcluded(cwd, "references", "jira:KAN-7", true);

		const ctx = makePlansCtx(["plan-1"], [], [], ["jira:KAN-7", "linear:LIN-1"]);
		await ctx.plansProvider.refreshExclusions();
		await selectAllPlansAndNotesCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.plans.has("plan-1")).toBe(false);
		expect(ex.references.has("jira:KAN-7")).toBe(false);
		expect(ex.references.has("linear:LIN-1")).toBe(false);
	});

	it("calls onChanged", async () => {
		let called = false;
		const ctx = makePlansCtx(
			["plan-1"],
			[],
			[
				() => {
					called = true;
				},
			],
		);
		await selectAllPlansAndNotesCommand(ctx);
		expect(called).toBe(true);
	});
});

// ── selectAllCurrentMemoryCommand ─────────────────────────────────────────────

/**
 * Stateful FilesStore fake: `selectionSummary()` reports the current array
 * state, `selectAll(target)` records the call and flips every entry to the
 * target so a follow-up summary reflects it.
 */
function makeFilesFake(initial: boolean[]): {
	store: FilesSelectAll;
	calls: boolean[];
	current: () => boolean[];
} {
	let selected = [...initial];
	const calls: boolean[] = [];
	return {
		store: {
			selectionSummary: () => ({
				total: selected.length,
				allSelected: selected.length > 0 && selected.every(Boolean),
			}),
			selectAll: (target: boolean) => {
				calls.push(target);
				selected = selected.map(() => target);
			},
		},
		calls,
		current: () => selected,
	};
}

/** Builds a unified ctx spanning conversations + plans/notes + a files fake. */
function makeCurrentMemoryCtx(opts: {
	conversations?: Array<{
		source: "claude" | "codex";
		sessionId: string;
	}>;
	planIds?: string[];
	noteIds?: string[];
	referenceIds?: string[];
	files: ReturnType<typeof makeFilesFake>;
	onChanged?: () => void | Promise<void>;
}): SelectAllCurrentMemoryCtx {
	const conversations = opts.conversations ?? [];
	const planIds = opts.planIds ?? [];
	const noteIds = opts.noteIds ?? [];
	const referenceIds = opts.referenceIds ?? [];
	let lastExclusions = {
		plans: new Set<string>(),
		notes: new Set<string>(),
		conversations: new Set<string>(),
		references: new Set<string>(),
	};
	return {
		cwd,
		activeSessions: {
			async listWithDiagnostics() {
				const ex = await readExclusions(cwd);
				return {
					items: conversations.map((c) => ({
						sessionId: c.sessionId,
						source: c.source,
						title: c.sessionId,
						messageCount: 0,
						updatedAt: new Date().toISOString(),
						transcriptPath: "/tmp/fake",
						isEdited: false,
						isSelected: !ex.conversations.has(
							conversationKey(c.source, c.sessionId),
						),
					})),
					failedSources: [],
				};
			},
		},
		plansProvider: {
			serialize(): ReadonlyArray<SerializedTreeItem> {
				// Synchronous read of the last-known exclusions is good enough for
				// these tests — the command only needs isSelected to compute the
				// combined verdict, and the suite seeds exclusions before calling.
				return [
					...planIds.map((id) => ({
						id,
						label: id,
						contextValue: "plan" as const,
						isSelected: !lastExclusions.plans.has(id),
					})),
					...noteIds.map((id) => ({
						id,
						label: id,
						contextValue: "note" as const,
						isSelected: !lastExclusions.notes.has(id),
					})),
					...referenceIds.map((id) => ({
						id,
						label: id,
						contextValue: "reference" as const,
						isSelected: !lastExclusions.references.has(id),
					})),
				];
			},
			async refreshExclusions() {
				lastExclusions = await readExclusions(cwd);
			},
		},
		filesStore: opts.files.store,
		onChanged: async () => {
			await opts.onChanged?.();
		},
	};
}

describe("selectAllCurrentMemoryCommand", () => {
	it("deselects everything when all three groups are fully selected", async () => {
		const files = makeFilesFake([true, true]);
		const ctx = makeCurrentMemoryCtx({
			conversations: [{ source: "claude", sessionId: "a" }],
			files,
		});
		await selectAllCurrentMemoryCommand(ctx);

		const ex = await readExclusions(cwd);
		// Conversations now excluded (deselected) …
		expect(ex.conversations.has(conversationKey("claude", "a"))).toBe(true);
		// … and files told to deselect (selectAll(false)).
		expect(files.calls).toEqual([false]);
		expect(files.current()).toEqual([false, false]);
	});

	it("selects everything when nothing is selected", async () => {
		await setAllExcluded(cwd, "conversations", [conversationKey("claude", "a")], true);
		const files = makeFilesFake([false, false]);
		const ctx = makeCurrentMemoryCtx({
			conversations: [{ source: "claude", sessionId: "a" }],
			files,
		});
		await selectAllCurrentMemoryCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(files.calls).toEqual([true]);
		expect(files.current()).toEqual([true, true]);
	});

	it("selects everything when only the files group is partially selected", async () => {
		// Conversations all selected (no exclusions), but one file unchecked →
		// the combined verdict is "not all selected" → select all.
		const files = makeFilesFake([true, false]);
		const ctx = makeCurrentMemoryCtx({
			conversations: [{ source: "claude", sessionId: "a" }],
			files,
		});
		await selectAllCurrentMemoryCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(files.calls).toEqual([true]);
	});

	it("deselects across conversations, plans, notes and references together", async () => {
		// Every group populated and fully selected → combined verdict is
		// "all selected" → deselect everything. Exercises the plan / note /
		// reference filter+map splits and the rows.every() verdict on a
		// non-empty Context group (the contextAllSelected branch).
		const files = makeFilesFake([true]);
		const ctx = makeCurrentMemoryCtx({
			conversations: [{ source: "claude", sessionId: "a" }],
			planIds: ["plan-1"],
			noteIds: ["note-1"],
			referenceIds: ["jira:KAN-7"],
			files,
		});
		await selectAllCurrentMemoryCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("claude", "a"))).toBe(true);
		expect(ex.plans.has("plan-1")).toBe(true);
		expect(ex.notes.has("note-1")).toBe(true);
		expect(ex.references.has("jira:KAN-7")).toBe(true);
		expect(files.calls).toEqual([false]);
	});

	it("selects everything when only the Context group is partially selected", async () => {
		// Conversations + files fully selected, but one plan excluded → the
		// combined verdict is "not all selected" → select all. Drives the
		// rows.every() callback to its false outcome (contextAllSelected=false).
		await setExcluded(cwd, "plans", "plan-1", true);
		const files = makeFilesFake([true]);
		const ctx = makeCurrentMemoryCtx({
			conversations: [{ source: "claude", sessionId: "a" }],
			planIds: ["plan-1", "plan-2"],
			files,
		});
		await ctx.plansProvider.refreshExclusions();
		await selectAllCurrentMemoryCommand(ctx);

		const ex = await readExclusions(cwd);
		expect(ex.plans.size).toBe(0);
		expect(files.calls).toEqual([true]);
	});

	it("is a no-op verdict on a fully empty Current Memory (selects, never throws)", async () => {
		const files = makeFilesFake([]);
		let called = false;
		const ctx = makeCurrentMemoryCtx({
			files,
			onChanged: () => {
				called = true;
			},
		});
		await selectAllCurrentMemoryCommand(ctx);
		// total === 0 → allSelected false → target select; no files to flip.
		expect(files.calls).toEqual([true]);
		expect(called).toBe(true);
	});
});
