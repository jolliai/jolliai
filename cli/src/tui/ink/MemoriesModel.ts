/**
 * MemoriesModel — PURE view-model for the Memories detail pane. Folds a full
 * CommitSummary into the fields the right column renders (title, subtitle,
 * decisions, files). No Ink, no I/O.
 */
import type { CommitSummary } from "../../Types.js";

export interface MemoryDetailView {
	readonly title: string;
	readonly subtitle: string;
	readonly decisions: string[];
	readonly files: string[];
}

/** First 8 chars of a commit hash — the display form across the Memories views. */
export const short = (hash: string): string => hash.slice(0, 8);

/** Local-timezone YYYY-MM-DD — a raw UTC `slice(0, 10)` shifts evening commits east of UTC to the wrong day. */
export function localDay(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Flattens a detail view into scrollable lines for the expanded (focused) pane
 *  — title, subtitle, then every decision and every file (no truncation). Fed to
 *  `<ScrollView>` so the "N more" the collapsed pane hints at is actually
 *  reachable. Pure, so the flattening is unit-tested directly. */
export function memoryDetailLines(v: MemoryDetailView): string[] {
	const lines: string[] = [v.title];
	if (v.subtitle) lines.push(v.subtitle);
	if (v.decisions.length > 0) {
		lines.push("", "Decisions");
		for (const d of v.decisions) {
			// The expanded pane is the "see everything" view — keep ALL lines of a
			// multi-line decision (or recap), not just the first: bullet the first
			// line, indent continuations.
			const dl = d.split("\n");
			lines.push(`· ${dl[0].replace(/^[-*]\s*/, "").trim()}`);
			for (const cont of dl.slice(1)) lines.push(`  ${cont.trimEnd()}`);
		}
	}
	if (v.files.length > 0) {
		lines.push("", `Files (${v.files.length})`);
		for (const f of v.files) lines.push(f);
	}
	return lines;
}

/** Flattens timeline entries into scrollable lines for the expanded pane —
 *  `YYYY-MM-DD sourceType · branch`, latest-payload order preserved. Pure. */
export function timelineEntryLines(
	entries: ReadonlyArray<{ timestamp: string; sourceType: string; branch: string }>,
): string[] {
	return entries.map((e) => `${localDay(e.timestamp)} ${e.sourceType} · ${e.branch}`);
}

/** A topic's readable detail flattened for the Memory Bank content pane: the
 *  page's markdown `content` (the substance the timeline-refs view was missing),
 *  then a compact `Sources` footer with the chronological refs. Pure. */
export function topicDetailLines(detail: {
	content: string;
	relatedBranches: string[];
	timeline: ReadonlyArray<{ timestamp: string; sourceType: string; branch: string }>;
}): string[] {
	const lines: string[] = [];
	const body = (detail.content ?? "").trimEnd();
	if (body) lines.push(...body.split("\n"));
	else lines.push("(no content yet — this topic has sources but no compiled page)");
	if (detail.relatedBranches.length > 0) {
		lines.push("", `Branches: ${detail.relatedBranches.join(", ")}`);
	}
	if (detail.timeline.length > 0) {
		lines.push("", `Sources (${detail.timeline.length})`, ...timelineEntryLines(detail.timeline));
	}
	return lines;
}

export function buildMemoryDetail(s: CommitSummary): MemoryDetailView {
	const topics = s.topics ?? [];
	const decisions = topics.map((t) => t.decisions).filter((d): d is string => Boolean(d));
	const files = Array.from(new Set(topics.flatMap((t) => t.filesAffected ?? [])));
	return {
		title: s.commitMessage || short(s.commitHash),
		subtitle: [short(s.commitHash), localDay(s.commitDate ?? ""), s.commitAuthor]
			.filter((x) => x !== "")
			.join(" · "),
		decisions: decisions.length > 0 ? decisions : s.recap ? [s.recap] : [],
		files,
	};
}
