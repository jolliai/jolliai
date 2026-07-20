import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../../Types.js";
import {
	buildMemoryDetail,
	localDay,
	type MemoryDetailView,
	memoryDetailLines,
	timelineEntryLines,
	topicDetailLines,
} from "./MemoriesModel.js";

const base = {
	commitHash: "aee1e84199",
	commitMessage: "Implement Space binding flow",
	commitAuthor: "Flyer Li",
	commitDate: "2026-07-13T09:00:00Z",
} as unknown as CommitSummary;

describe("buildMemoryDetail", () => {
	it("folds topics into decisions + deduped files with a hash·date·author subtitle", () => {
		const s = {
			...base,
			topics: [
				{
					title: "T1",
					trigger: "",
					response: "",
					decisions: "Chose X over Y",
					filesAffected: ["a.ts", "b.ts"],
				},
				{ title: "T2", trigger: "", response: "", decisions: "Kept Z", filesAffected: ["a.ts", "c.ts"] },
			],
		} as unknown as CommitSummary;
		const v = buildMemoryDetail(s);
		expect(v.title).toBe("Implement Space binding flow");
		// Date is the local day (see localDay) — assert against it, not a fixed UTC slice.
		expect(v.subtitle).toBe(`aee1e841 · ${localDay("2026-07-13T09:00:00Z")} · Flyer Li`);
		expect(v.decisions).toEqual(["Chose X over Y", "Kept Z"]);
		expect(v.files).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("falls back to recap when no topic decisions", () => {
		const s = { ...base, recap: "Quick recap here", topics: [] } as unknown as CommitSummary;
		const v = buildMemoryDetail(s);
		expect(v.decisions).toEqual(["Quick recap here"]);
		expect(v.files).toEqual([]);
	});
});

describe("memoryDetailLines", () => {
	it("flattens title, subtitle, and every decision + file (no truncation)", () => {
		const v: MemoryDetailView = {
			title: "Impl X",
			subtitle: "aee1e841 · 2026-07-13 · Flyer Li",
			decisions: ["- Chose A", "Kept B", "Dropped C"],
			files: ["a.ts", "b.ts"],
		};
		const lines = memoryDetailLines(v);
		expect(lines[0]).toBe("Impl X");
		expect(lines[1]).toBe("aee1e841 · 2026-07-13 · Flyer Li");
		expect(lines).toContain("Decisions");
		expect(lines).toContain("· Chose A"); // list marker stripped, re-bulleted
		expect(lines).toContain("· Kept B");
		expect(lines).toContain("Files (2)");
		expect(lines).toContain("a.ts");
		expect(lines).toContain("b.ts");
	});

	it("keeps every line of a multi-line decision (expanded pane shows all)", () => {
		const v: MemoryDetailView = {
			title: "T",
			subtitle: "",
			decisions: ["- First line\nsecond line\nthird line"],
			files: [],
		};
		const lines = memoryDetailLines(v);
		expect(lines).toContain("· First line"); // bullet stripped + re-bulleted
		expect(lines).toContain("  second line"); // continuation indented, NOT dropped
		expect(lines).toContain("  third line");
	});

	it("omits empty sections and a blank subtitle", () => {
		const v: MemoryDetailView = { title: "T", subtitle: "", decisions: [], files: [] };
		expect(memoryDetailLines(v)).toEqual(["T"]);
	});
});

describe("timelineEntryLines", () => {
	it("renders each entry as day · sourceType · branch", () => {
		const lines = timelineEntryLines([
			{ timestamp: "2026-07-13T09:00:00Z", sourceType: "claude", branch: "feat-x" },
			{ timestamp: "2026-07-12T09:00:00Z", sourceType: "codex", branch: "main" },
		]);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(`${localDay("2026-07-13T09:00:00Z")} claude · feat-x`);
		expect(lines[1]).toBe(`${localDay("2026-07-12T09:00:00Z")} codex · main`);
	});
});

describe("topicDetailLines", () => {
	it("renders content, a Branches line, and a Sources footer", () => {
		const lines = topicDetailLines({
			content: "## Problem\nRenamed diff failed.\n",
			relatedBranches: ["bug-rename", "feat-x"],
			timeline: [
				{ timestamp: "2026-07-13T09:00:00Z", sourceType: "summary", branch: "b" },
				{ timestamp: "2026-07-12T09:00:00Z", sourceType: "plan", branch: "b" },
			],
		});
		expect(lines[0]).toBe("## Problem");
		expect(lines[1]).toBe("Renamed diff failed.");
		expect(lines).toContain("Branches: bug-rename, feat-x");
		expect(lines).toContain("Sources (2)");
		expect(lines.some((l) => l.includes("summary · b"))).toBe(true);
	});

	it("falls back to a placeholder when a topic has no compiled content", () => {
		const lines = topicDetailLines({ content: "", relatedBranches: [], timeline: [] });
		expect(lines[0]).toContain("no content yet");
	});
});

describe("localDay", () => {
	it("renders the local-timezone day and falls back to a UTC slice on garbage", () => {
		const d = new Date("2026-07-13T12:00:00Z");
		const pad = (n: number): string => String(n).padStart(2, "0");
		const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		expect(localDay("2026-07-13T12:00:00Z")).toBe(expected);
		expect(localDay("not-a-date")).toBe("not-a-date".slice(0, 10));
	});
});
