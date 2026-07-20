import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { MemoryListItem } from "../../core/MemoryBankModel.js";
import type { CommitSummary } from "../../Types.js";
import { detailPreviewBudget, MemoriesScreen } from "./MemoriesScreen.js";
import type { TuiDeps } from "./TuiDeps.js";

const tick = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
// A lone ESC is held briefly by ink's parser (it may begin an escape sequence),
// so tests must wait it out rather than a microtask tick.
const escSettle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));
const DOWN = `${String.fromCharCode(27)}[B`;
const ESC = String.fromCharCode(27);
const ENTER = "\r";

const ITEMS: MemoryListItem[] = [
	{ hash: "aee1e84199", title: "Implement Space binding flow", date: "2026-07-13", branch: "b", topicsCount: 3 },
	{ hash: "9e1adf3a00", title: "Fix pre-push worker entrypoint", date: "2026-07-12", branch: "b", topicsCount: 1 },
];

const DETAIL = {
	commitHash: "aee1e84199",
	commitMessage: "Implement Space binding flow",
	commitAuthor: "Flyer Li",
	commitDate: "2026-07-13T00:00:00Z",
	topics: [
		{
			title: "T",
			trigger: "",
			response: "",
			decisions: "Verify against real rollout data",
			filesAffected: ["x.ts"],
		},
	],
} as unknown as CommitSummary;

function fakeDeps(over: Partial<TuiDeps> = {}): TuiDeps {
	return {
		cwd: "/x",
		getIdentity: async () => ({ repo: "r", branch: "b" }),
		getStatus: async () => ({}) as never,
		getQueueStatus: async () => ({}) as never,
		getIngestPhase: async () => ({ busy: false, phase: null }),
		getLastSyncAt: async () => null,
		getSpaceBinding: async () => null,
		getBackfillOffer: async () => null,
		dismissBackfill: async () => {},
		runColdStartBackfill: async () => ({ generated: 0, errors: 0 }),
		getInstalledSkills: async () => [],
		setSkillInstalled: async () => {},
		listMemories: async () => ITEMS,
		getMemoryDetail: async () => DETAIL,
		searchMemories: async () => [],
		listTopics: async () => [],
		getTopicDetail: async () => ({
			slug: "s",
			title: "T",
			content: "",
			relatedBranches: [],
			lastUpdatedAt: "",
			timeline: [],
		}),
		setEnabled: async () => {},
		loadAuthToken: async () => undefined,
		signInWithBrowser: async () => {},
		saveJolliApiKey: async () => {},
		saveAnthropicKey: async () => {},
		setAiProvider: async () => {},
		runCloudSync: async () => ({ kind: "bound", spaceName: "s", canPush: true, rechecked: true }),
		installPlugin: async () => {},
		inspectPlugins: async () => [],
		loadConfig: async () => ({}),
		enableHost: async () => {},
		disableHost: async () => {},
		applySetting: async () => {},
		runCommand: async () => ({ output: "", exitCode: 0 }),
		...over,
	};
}

describe("detailPreviewBudget", () => {
	it("falls back to the fixed 4/6 when the height is unknown", () => {
		const b = detailPreviewBudget(10, 20, undefined);
		expect(b.decShown).toBe(4);
		expect(b.filShown).toBe(6);
		expect(b.overflow).toBe(true); // 10 > 4 and 20 > 6
	});

	it("GROWS both sections to fill a tall pane (no fixed 4/6 cap)", () => {
		// maxRows 36 → budget = 36 - 8 = 28; decCap ≈ round(28*0.4)=11, files take the rest.
		const b = detailPreviewBudget(8, 19, 36);
		expect(b.decShown).toBe(8); // all decisions fit within the 11 cap
		expect(b.filShown).toBe(19); // 28 - 8 = 20 ≥ 19 → all files shown
		expect(b.overflow).toBe(false);
	});

	it("frees an empty section's share for the other", () => {
		// No decisions → files get nearly the whole budget.
		const b = detailPreviewBudget(0, 40, 36);
		expect(b.decShown).toBe(0);
		expect(b.filShown).toBeGreaterThan(6); // far more than the old fixed 6
	});

	it("still flags overflow when content exceeds even the grown budget", () => {
		const b = detailPreviewBudget(50, 50, 20); // budget = max(10, 12) = 12
		expect(b.overflow).toBe(true);
	});
});

describe("MemoriesScreen", () => {
	it("lists memories and shows the selected one's detail", async () => {
		const { lastFrame } = render(<MemoriesScreen deps={fakeDeps()} />);
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("Implement Space binding flow");
		expect(out).toContain("aee1e841 · 2026-07-13 · Flyer Li");
		expect(out).toContain("Decisions");
		expect(out).toContain("Verify against real rollout data");
		expect(out).toContain("Files (1)");
		expect(out).toContain("x.ts");
	});

	it("down moves the selection and loads that memory's detail", async () => {
		const getMemoryDetail = vi.fn(async () => DETAIL);
		const { stdin } = render(<MemoriesScreen deps={fakeDeps({ getMemoryDetail })} />);
		await tick();
		stdin.write(DOWN); // down → 2nd memory
		await tick();
		expect(getMemoryDetail).toHaveBeenCalledWith("9e1adf3a00");
	});

	it("re-reads the selected memory's detail on a reloadKey bump (out-of-queue mutation)", async () => {
		// `/backfill --generate` can rewrite the SAME commit's summary without changing
		// its hash; the detail pane must refresh even though the selection is unchanged.
		const topic = (decisions: string) => ({
			title: "T",
			trigger: "",
			response: "",
			decisions,
			filesAffected: ["x.ts"],
		});
		const stale = { ...DETAIL, topics: [topic("old decision")] } as unknown as CommitSummary;
		const fresh = { ...DETAIL, topics: [topic("new decision")] } as unknown as CommitSummary;
		const getMemoryDetail = vi
			.fn(async () => stale)
			.mockResolvedValueOnce(stale)
			.mockResolvedValue(fresh);
		const { lastFrame, rerender } = render(<MemoriesScreen deps={fakeDeps({ getMemoryDetail })} reloadKey={0} />);
		await tick();
		expect(lastFrame()).toContain("old decision");
		rerender(<MemoriesScreen deps={fakeDeps({ getMemoryDetail })} reloadKey={1} />);
		await tick();
		expect(lastFrame()).toContain("new decision");
	});

	it("windows the browse list and follows the cursor (▲/▼ more)", async () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			hash: `mem${i}`,
			title: `Memory number ${i}`,
			date: "2026-07-01",
			branch: "b",
			topicsCount: 1,
		}));
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ listMemories: async () => many })} />);
		await tick();
		expect(lastFrame()).toContain("Memory number 0");
		expect(lastFrame()).toContain("▼"); // 20 items > window → more below
		expect(lastFrame()).not.toContain("Memory number 19"); // not all shown at once
		for (let i = 0; i < 12; i++) stdin.write(DOWN);
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("Memory number 12"); // window followed the cursor down
		expect(out).toContain("▲"); // and there's now content hidden above
	});

	it("shows an empty state when there are no memories", async () => {
		const { lastFrame } = render(<MemoriesScreen deps={fakeDeps({ listMemories: async () => [] })} />);
		await tick();
		expect(lastFrame()).toContain("No committed memories");
	});

	it("memory-bank lists topics and shows the selected topic's readable content", async () => {
		const getTopicDetail = vi.fn(async (slug: string) => ({
			slug,
			title: `Topic ${slug}`,
			content: "## Problem\nRenamed file diff failed.\n## Fix\nAdd a working-tree branch.",
			relatedBranches: ["bug-rename"],
			lastUpdatedAt: "2026-07-13T00:00:00Z",
			timeline: [{ timestamp: "2026-07-13T00:00:00Z", branch: "b", sourceType: "summary", sourceId: "x" }],
		}));
		const { lastFrame } = render(
			<MemoriesScreen
				deps={fakeDeps({ listTopics: async () => ["space-binding", "pre-push"], getTopicDetail })}
				variant="memory-bank"
			/>,
		);
		await tick();
		expect(lastFrame()).toContain("space-binding"); // topic list
		expect(getTopicDetail).toHaveBeenCalledWith("space-binding"); // first topic loaded
		const out = lastFrame() ?? "";
		expect(out).toContain("Topic space-binding"); // title
		expect(out).toContain("Renamed file diff failed."); // readable content (the fix)
	});

	it("memory-bank ↓ selects another topic and loads its content", async () => {
		const getTopicDetail = vi.fn(async (slug: string) => ({
			slug,
			title: slug,
			content: `content of ${slug}`,
			relatedBranches: [],
			lastUpdatedAt: "",
			timeline: [],
		}));
		const { stdin, lastFrame } = render(
			<MemoriesScreen
				deps={fakeDeps({ listTopics: async () => ["a", "b"], getTopicDetail })}
				variant="memory-bank"
			/>,
		);
		await tick();
		expect(lastFrame()).toContain("content of a");
		stdin.write(DOWN); // → topic b
		await tick();
		expect(getTopicDetail).toHaveBeenCalledWith("b");
		expect(lastFrame()).toContain("content of b");
	});

	it("f opens search, filters via searchMemories, and esc closes it", async () => {
		const searchMemories = vi.fn(async () => [
			{
				id: "h1",
				type: "commit" as const,
				title: "Space binding search hit",
				snippet: "binds the space",
				branch: "b",
				commitDate: "",
				slug: "s",
				hash: "aee1e84199",
				score: 1,
			},
		]);
		const captures: boolean[] = [];
		const { stdin, lastFrame } = render(
			<MemoriesScreen deps={fakeDeps({ searchMemories })} onCapture={(c) => captures.push(c)} />,
		);
		await tick();
		stdin.write("f");
		await tick();
		for (const ch of "space") stdin.write(ch);
		await tick();
		expect(searchMemories).toHaveBeenCalled();
		expect(lastFrame()).toContain("Space binding search hit");
		expect(captures).toContain(true); // reported capture while typing
		stdin.write(ESC); // esc closes search
		await tick();
		expect(lastFrame()).toContain("Implement Space binding flow"); // back to the browse list
	});

	it("Enter expands the detail pane into a scrollable view; ↑↓ scrolls, esc collapses", async () => {
		const bigDetail = {
			...DETAIL,
			topics: [
				{
					title: "T",
					trigger: "",
					response: "",
					decisions: "D",
					filesAffected: Array.from({ length: 10 }, (_, i) => `f${i}.ts`),
				},
			],
		} as unknown as CommitSummary;
		const { stdin, lastFrame } = render(
			<MemoriesScreen deps={fakeDeps({ getMemoryDetail: async () => bigDetail })} />,
		);
		await tick();
		// Collapsed pane offers a reachable expand (10 files > the 6-file cutoff) —
		// no unreachable "▼ N more".
		expect(lastFrame()).toContain("[Enter] expand all");
		expect(lastFrame()).not.toContain("f9.ts"); // last file not shown collapsed
		stdin.write(ENTER);
		await tick();
		expect(lastFrame()).toContain("▾ expanded");
		expect(lastFrame()).toContain("Files (10)");
		// esc collapses back to the list.
		stdin.write(ESC);
		await escSettle();
		expect(lastFrame()).not.toContain("▾ expanded");
		expect(lastFrame()).toContain("[Enter] expand all");
		// Re-expand, then ↑↓ scrolls the flattened detail so the hidden files are reachable.
		stdin.write(ENTER);
		await tick();
		stdin.write(DOWN);
		await tick();
		expect(lastFrame()).toContain("f9.ts"); // now reachable
	});

	it("Enter expands the topic content pane into a scrollable view", async () => {
		const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const getTopicDetail = vi.fn(async (slug: string) => ({
			slug,
			title: `Topic ${slug}`,
			content,
			relatedBranches: [],
			lastUpdatedAt: "",
			timeline: [],
		}));
		const { stdin, lastFrame } = render(
			<MemoriesScreen
				deps={fakeDeps({ listTopics: async () => ["space-binding"], getTopicDetail })}
				variant="memory-bank"
			/>,
		);
		await tick();
		expect(lastFrame()).toContain("[Enter] open"); // collapsed preview + open affordance
		expect(lastFrame()).not.toContain("line 29"); // last line not shown collapsed
		stdin.write(ENTER);
		await tick();
		expect(lastFrame()).toContain("▾ expanded");
		// esc collapses back to the collapsed preview.
		stdin.write(ESC);
		await escSettle();
		expect(lastFrame()).not.toContain("▾ expanded");
		// Re-expand, then ↑↓ scrolls so the last line becomes reachable.
		stdin.write(ENTER);
		await tick();
		for (let i = 0; i < 14; i++) stdin.write(DOWN);
		await tick();
		expect(lastFrame()).toContain("line 29"); // now reachable
	});

	it("shows an error notice (not a stuck 'loading…') when the memory list fails to load", async () => {
		const { lastFrame } = render(
			<MemoriesScreen deps={fakeDeps({ listMemories: async () => Promise.reject(new Error("disk gone")) })} />,
		);
		await tick();
		expect(lastFrame()).toContain("Failed to load memories: disk gone");
		expect(lastFrame()).not.toContain("loading…");
	});

	it("clears the detail pane when a search shrinks to no matches (no stale hit)", async () => {
		// "s" matches one hit; anything longer matches nothing.
		const HIT = {
			id: "h1",
			type: "commit" as const,
			title: "Space binding search hit",
			snippet: "",
			branch: "b",
			commitDate: "",
			slug: "s",
			hash: "hit0000000",
			score: 1,
		};
		const searchMemories = vi.fn(async (q: string) => (q === "s" ? [HIT] : []));
		const getMemoryDetail = vi.fn(async (hash: string) =>
			hash === "hit0000000"
				? ({ ...DETAIL, commitHash: "hit0000000", commitMessage: "SEARCH HIT DETAIL" } as CommitSummary)
				: DETAIL,
		);
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ searchMemories, getMemoryDetail })} />);
		await tick();
		stdin.write("f");
		await tick();
		stdin.write("s"); // one hit → its detail loads
		await tick();
		expect(lastFrame()).toContain("SEARCH HIT DETAIL");
		stdin.write("x"); // "sx" → no matches → selection gone
		await tick();
		expect(lastFrame()).toContain("no matches");
		expect(lastFrame()).not.toContain("SEARCH HIT DETAIL"); // pane cleared, not stale
	});

	it("resets the cursor on backspace so a shrunk hit list selects a valid hit", async () => {
		const mk = (hash: string, title: string) => ({
			id: hash,
			type: "commit" as const,
			title,
			snippet: "",
			branch: "b",
			commitDate: "",
			slug: "s",
			hash,
			score: 1,
		});
		// "sp" → two hits; "s" → only the first.
		const searchMemories = vi.fn(async (q: string) =>
			q === "sp"
				? [mk("hashaaaaaa", "hit A"), mk("hashbbbbbb", "hit B")]
				: q === "s"
					? [mk("hashaaaaaa", "hit A")]
					: [],
		);
		const getMemoryDetail = vi.fn(async (hash: string) =>
			hash === "hashbbbbbb"
				? ({ ...DETAIL, commitHash: "hashbbbbbb", commitMessage: "DETAIL B" } as CommitSummary)
				: ({ ...DETAIL, commitHash: "hashaaaaaa", commitMessage: "DETAIL A" } as CommitSummary),
		);
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ searchMemories, getMemoryDetail })} />);
		await tick();
		stdin.write("f");
		await tick();
		stdin.write("s");
		stdin.write("p"); // "sp" → 2 hits, cursor 0
		await tick();
		stdin.write(DOWN); // cursor 1 → second hit selected
		await tick();
		expect(lastFrame()).toContain("DETAIL B");
		stdin.write("\x7f"); // backspace → "s" → 1 hit; cursor must reset to a valid index
		await tick();
		expect(lastFrame()).toContain("DETAIL A"); // now on the sole remaining hit
		expect(lastFrame()).not.toContain("DETAIL B");
	});

	it("keeps the search selection when the browse list reloads mid-search (clamp is search-gated)", async () => {
		const mk = (hash: string, title: string) => ({
			id: hash,
			type: "commit" as const,
			title,
			snippet: "",
			branch: "b",
			commitDate: "",
			slug: "s",
			hash,
			score: 1,
		});
		// 5 whole-index search hits, but only 2 committed memories on THIS branch —
		// the shared cursor can legitimately exceed the browse list length.
		const hits = Array.from({ length: 5 }, (_, i) => mk(`hit${i}000000`, `HIT ${i}`));
		const searchMemories = vi.fn(async () => hits);
		const shortList: MemoryListItem[] = [
			{ hash: "b0", title: "Branch 0", date: "2026-07-13", branch: "b", topicsCount: 0 },
			{ hash: "b1", title: "Branch 1", date: "2026-07-13", branch: "b", topicsCount: 0 },
		];
		const getMemoryDetail = vi.fn(
			async (hash: string) => ({ ...DETAIL, commitHash: hash, commitMessage: `DETAIL ${hash}` }) as CommitSummary,
		);
		const deps = fakeDeps({ searchMemories, getMemoryDetail, listMemories: async () => shortList });
		const { stdin, lastFrame, rerender } = render(<MemoriesScreen deps={deps} reloadKey={0} />);
		await tick();
		stdin.write("f");
		await tick();
		stdin.write("q"); // any query → 5 hits
		await tick();
		for (let i = 0; i < 4; i++) stdin.write(DOWN); // cursor → 4 (past the 2-item browse list)
		await tick();
		expect(lastFrame()).toContain("DETAIL hit4000000");
		// A /compile-style reload fires while search is open — it must NOT clamp the
		// shared cursor to the short browse list and yank the search selection.
		rerender(<MemoriesScreen deps={deps} reloadKey={1} />);
		await tick();
		expect(lastFrame()).toContain("DETAIL hit4000000"); // still on the 5th hit
		expect(lastFrame()).not.toContain("DETAIL hit1000000"); // NOT clamped to index 1
	});

	it("surfaces a search failure inline (not a full-screen error, not an unhandled rejection)", async () => {
		const searchMemories = vi.fn(async () => Promise.reject(new Error("index missing")));
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ searchMemories })} />);
		await tick();
		stdin.write("f"); // open search
		await tick();
		stdin.write("x"); // type → search runs → rejects
		await tick();
		expect(searchMemories).toHaveBeenCalled();
		const out = lastFrame() ?? "";
		expect(out).toContain("index missing"); // shown inline (⚠)
		expect(out).not.toContain("Failed to load memories"); // NOT the full-screen error
	});

	it("clears the inline search error when the search is dismissed", async () => {
		const searchMemories = vi.fn(async () => Promise.reject(new Error("index missing")));
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ searchMemories })} />);
		await tick();
		stdin.write("f"); // open search
		await tick();
		stdin.write("x"); // type → search rejects → inline ⚠
		await tick();
		expect(lastFrame()).toContain("index missing");
		stdin.write(ESC); // close search → query null → stale banner must clear
		await escSettle();
		expect(lastFrame()).not.toContain("index missing");
	});

	it("does not clear a live detail error when search is opened and dismissed", async () => {
		// Cross-source: a detail failure (browse pane) must survive an unrelated
		// search open/close — search owns a separate error state, so closing it
		// can't wipe the still-relevant detail error.
		const getMemoryDetail = vi.fn(async () => {
			throw new Error("detail boom");
		});
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ getMemoryDetail })} />);
		await tick();
		expect(lastFrame()).toContain("detail boom"); // shown in browse
		stdin.write("f"); // open search → search context, detail error hidden (NOT cleared)
		await tick();
		expect(lastFrame()).not.toContain("detail boom");
		stdin.write(ESC); // dismiss search
		await escSettle();
		expect(lastFrame()).toContain("detail boom"); // reappears → was never cleared
	});
});

describe("MemoriesScreen — expanded detail scroll", () => {
	const wideDetail = {
		commitHash: "aee1e84199",
		commitMessage: "Wide memory",
		commitAuthor: "A",
		commitDate: "2026-07-13T00:00:00Z",
		topics: [{ title: "T", trigger: "", response: "", decisions: `DECISION_${"x".repeat(80)}`, filesAffected: [] }],
	} as unknown as CommitSummary;

	it("wraps the expanded detail (no horizontal pan) so long lines show in full", async () => {
		const { stdin, lastFrame } = render(
			<MemoriesScreen deps={fakeDeps({ getMemoryDetail: async () => wideDetail })} />,
		);
		await tick();
		stdin.write("\r"); // Enter → expand
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("[↑↓] scroll"); // vertical-only banner (no ←→ pan)
		// The long DECISION_xxxx… token wraps instead of being truncated + panned, so
		// there is no horizontal-window affordance.
		expect(out).not.toContain("cols 1–");
		expect(out).not.toContain("▶");
		expect(out).not.toContain("◀");
		// The wrapped body still carries the token's characters across rows.
		expect(out).toContain("DECISION_");
	});
});

describe("MemoriesScreen — reloadKey (memory-mutating palette command)", () => {
	it("re-reads the browse list on a reloadKey bump", async () => {
		// `/backfill --generate` mutates summaries OUTSIDE the queue worker, so the
		// busy→idle poll never sees it — the shell signals via a reloadKey bump.
		let list: MemoryListItem[] = [ITEMS[1]];
		const listMemories = vi.fn(async () => list);
		// Same deps object across rerenders → only reloadKey drives the re-read.
		const deps = fakeDeps({ listMemories, getMemoryDetail: async () => null });
		const { lastFrame, rerender } = render(<MemoriesScreen deps={deps} reloadKey={0} />);
		await tick();
		expect(lastFrame()).toContain("Fix pre-push worker entrypoint");
		expect(lastFrame()).not.toContain("Implement Space binding flow");
		list = ITEMS; // backfill generated a new memory
		rerender(<MemoriesScreen deps={deps} reloadKey={1} />); // shell bump
		await tick();
		expect(lastFrame()).toContain("Implement Space binding flow"); // list re-read
	});

	it("clamps the browse cursor when a reloadKey refresh shrinks the list", async () => {
		// User scrolls deep into a long list; a /compile-style consolidation bumps
		// reloadKey and the list returns shorter. The cursor must clamp to the new
		// last row — not strand past the end, which blanks the detail pane.
		const many: MemoryListItem[] = Array.from({ length: 8 }, (_, i) => ({
			hash: `h${i}`,
			title: `Memory ${i}`,
			date: "2026-07-13",
			branch: "b",
			topicsCount: 0,
		}));
		let list = many;
		const getMemoryDetail = vi.fn(async (_hash: string) => DETAIL);
		const deps = fakeDeps({ listMemories: async () => list, getMemoryDetail });
		const { stdin, rerender } = render(<MemoriesScreen deps={deps} reloadKey={0} />);
		await tick();
		for (let i = 0; i < 7; i++) stdin.write(DOWN); // cursor → 7 (last of 8)
		await tick();
		expect(getMemoryDetail).toHaveBeenLastCalledWith("h7");
		list = many.slice(0, 3); // consolidation shrank the list to 3
		rerender(<MemoriesScreen deps={deps} reloadKey={1} />); // shell bump → re-read
		await tick();
		// Clamped to the new last row (index 2). Pre-fix the cursor stayed at 7, so
		// the selected hash was undefined and getMemoryDetail was never re-called.
		expect(getMemoryDetail).toHaveBeenLastCalledWith("h2");
	});

	it("recovers from a transient load error on the next reloadKey bump", async () => {
		// First listMemories throws → red error page; a later reloadKey bump (from a
		// /backfill or /compile) succeeds and must clear the error, not stay stuck.
		let calls = 0;
		const listMemories = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("index boom");
			return ITEMS;
		});
		const deps = fakeDeps({ listMemories, getMemoryDetail: async () => null });
		const { lastFrame, rerender } = render(<MemoriesScreen deps={deps} reloadKey={0} />);
		await tick();
		expect(lastFrame()).toContain("Failed to load memories: index boom");
		rerender(<MemoriesScreen deps={deps} reloadKey={1} />); // bump → re-read
		await tick();
		expect(lastFrame()).not.toContain("Failed to load memories");
		expect(lastFrame()).toContain("Implement Space binding flow"); // list rendered
	});

	it("shows a detail-load failure inline without blanking the screen, and clears it on the next read", async () => {
		// A per-pane (detail) failure must NOT take over the whole screen — the list
		// stays visible, the error is inline, and a later successful read clears it.
		let calls = 0;
		const getMemoryDetail = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("detail boom");
			return DETAIL;
		});
		const { stdin, lastFrame } = render(<MemoriesScreen deps={fakeDeps({ getMemoryDetail })} />);
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("detail boom"); // inline pane error
		expect(out).not.toContain("Failed to load memories"); // NOT the full-screen error
		expect(out).toContain("Fix pre-push worker entrypoint"); // browse list still visible
		stdin.write(DOWN); // select the 2nd memory → detail re-reads → succeeds
		await tick();
		expect(lastFrame()).not.toContain("detail boom"); // pane error cleared
	});

	it("keeps the topic content scroll across a reloadKey bump (does not jump to top)", async () => {
		// A tall topic body (>16 lines) so it scrolls; `/compile`-style reloadKey bump
		// must re-read WITHOUT resetting the reader's scroll to the top.
		const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const getTopicDetail = async (slug: string) => ({
			slug,
			title: slug,
			content,
			relatedBranches: [],
			lastUpdatedAt: "",
			timeline: [],
		});
		const deps = fakeDeps({ listTopics: async () => ["t0"], getTopicDetail });
		const { stdin, lastFrame, rerender } = render(
			<MemoriesScreen deps={deps} variant="memory-bank" reloadKey={0} />,
		);
		await tick();
		stdin.write(ENTER); // expand the content pane
		await tick();
		for (let i = 0; i < 4; i++) {
			stdin.write(DOWN); // scroll down → content hidden above
			await tick();
		}
		expect(lastFrame()).toContain("▲"); // scrolled
		rerender(<MemoriesScreen deps={deps} variant="memory-bank" reloadKey={1} />); // /compile-style refresh
		await tick();
		expect(lastFrame()).toContain("▲"); // scroll preserved, NOT reset to the top
	});

	it("keeps the selected topic across a reloadKey bump (does not snap to first)", async () => {
		const getTopicDetail = vi.fn(async (slug: string) => ({
			slug,
			title: slug,
			content: `content of ${slug}`,
			relatedBranches: [],
			lastUpdatedAt: "",
			timeline: [],
		}));
		const deps = fakeDeps({ listTopics: async () => ["t0", "t1", "t2"], getTopicDetail });
		const { stdin, rerender } = render(<MemoriesScreen deps={deps} variant="memory-bank" reloadKey={0} />);
		await tick();
		stdin.write(DOWN); // t0 → t1
		await tick();
		expect(getTopicDetail).toHaveBeenLastCalledWith("t1");
		rerender(<MemoriesScreen deps={deps} variant="memory-bank" reloadKey={1} />); // /compile-style refresh
		await tick();
		// Selection preserved: still t1 (a reset-to-0 would re-query "t0").
		expect(getTopicDetail).toHaveBeenLastCalledWith("t1");
	});
});

describe("MemoriesScreen — auto-refresh on generation settle", () => {
	// Fake-timer pump mirrors HomeScreen.test: many tiny cycles flush the multi-
	// await load / poll chains without crossing the 2.5s interval prematurely.
	const pump = async (): Promise<void> => {
		for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(1);
	};
	const busy = { active: 1, ingestActive: 0, workerBusy: true, workerBlocking: false, drained: false, stale: 0 };
	const idle = { active: 0, ingestActive: 0, workerBusy: false, workerBlocking: false, drained: true, stale: 0 };

	it("rereads the browse list on the worker busy→idle edge (a new commit's memory)", async () => {
		vi.useFakeTimers();
		try {
			let queue = busy;
			let list: MemoryListItem[] = [ITEMS[1]]; // start with one memory
			const getQueueStatus = vi.fn(async () => queue as never);
			const listMemories = vi.fn(async () => list);
			// Null detail keeps the fixed-fixture right pane out of the frame, so the
			// assertions target the browse LIST rows, not a selected memory's detail.
			const { lastFrame, unmount } = render(
				<MemoriesScreen deps={fakeDeps({ getQueueStatus, listMemories, getMemoryDetail: async () => null })} />,
			);
			await pump(); // initial list load
			expect(lastFrame()).toContain("Fix pre-push worker entrypoint");
			expect(lastFrame()).not.toContain("Implement Space binding flow");

			await vi.advanceTimersByTimeAsync(2600); // poll #1: worker busy → records "generating"
			// A commit's summary lands and the worker drains.
			list = ITEMS; // now two memories (the new one prepended)
			queue = idle;
			await vi.advanceTimersByTimeAsync(2600); // poll #2: falling edge → reread
			await pump(); // flush the reread promise chain

			expect(lastFrame()).toContain("Implement Space binding flow"); // new memory appeared
			expect(lastFrame()).toContain("Fix pre-push worker entrypoint");
			unmount(); // stop the interval leaking into later fake-timer tests
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT reread while the worker stays idle (no blind interval reload)", async () => {
		vi.useFakeTimers();
		try {
			const getQueueStatus = vi.fn(async () => idle as never);
			const listMemories = vi.fn(async () => ITEMS);
			const { unmount } = render(<MemoriesScreen deps={fakeDeps({ getQueueStatus, listMemories })} />);
			await pump(); // initial load (1 call)
			const afterLoad = listMemories.mock.calls.length;
			await vi.advanceTimersByTimeAsync(2600); // idle poll
			await vi.advanceTimersByTimeAsync(2600); // idle poll
			expect(listMemories).toHaveBeenCalledTimes(afterLoad); // no extra reread
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("recovers from a transient error when the busy→idle reread succeeds", async () => {
		vi.useFakeTimers();
		try {
			let queue = busy;
			let calls = 0;
			const listMemories = vi.fn(async () => {
				calls += 1;
				if (calls === 1) throw new Error("index boom"); // initial mount load fails
				return ITEMS;
			});
			const getQueueStatus = vi.fn(async () => queue as never);
			const deps = fakeDeps({ listMemories, getQueueStatus, getMemoryDetail: async () => null });
			const { lastFrame, unmount } = render(<MemoriesScreen deps={deps} />);
			await pump();
			expect(lastFrame()).toContain("Failed to load memories: index boom"); // red page
			await vi.advanceTimersByTimeAsync(2600); // poll #1: worker busy → records generating
			queue = idle; // worker drains
			await vi.advanceTimersByTimeAsync(2600); // poll #2: falling edge → reread succeeds
			await pump();
			expect(lastFrame()).not.toContain("Failed to load memories"); // error cleared
			expect(lastFrame()).toContain("Implement Space binding flow"); // list rendered
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});
