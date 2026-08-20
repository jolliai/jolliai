/**
 * SkillsAggregateMarkdown — the per-commit skill-usage table for the Memory Bank
 * visible layer.
 *
 * Kept out of FolderStorage so the rendering can be tested without standing up a
 * storage backend, and so the same table can be reused by any other human-facing
 * surface later without importing a storage class.
 */

import type { CommitSummary, SkillCommitRef, SkillSource, SkillUsage } from "../Types.js";
import { skillSourceLabel } from "./SummaryFormat.js";

/**
 * `skills--<hash8>` — the per-commit skill aggregate's identity.
 *
 * Shared by the Memory Bank file name below and the pushed article's `entryKey`
 * (see the `skill` context kind), so the same aggregate is not named two ways: one
 * commit's skills are ONE artifact locally and ONE article remotely.
 */
export function skillsAggregateKey(hash8: string): string {
	return `skills--${hash8}`;
}

/** `skills--<hash8>.md` — the visible aggregate's file name for one commit. */
export function skillsAggregateFileName(hash8: string): string {
	return `${skillsAggregateKey(hash8)}.md`;
}

/**
 * The five fields the table needs, and nothing else.
 *
 * Deliberately narrower than either concrete type so ONE renderer serves both
 * sides of the commit boundary: `SkillCommitRef` (the archived snapshot behind
 * `skills--<hash8>.md`) and the VS Code panel's `SkillInfo` projection (the live,
 * uncommitted rows) are both structurally assignable to it. The sidebar's
 * aggregate row and the committed file must render identically — a user who sees
 * one table before committing and a different one after has to re-learn the
 * surface for no reason.
 */
export interface SkillTableRow {
	readonly skill: string;
	/**
	 * The AI host that ran the skill — the `Agent` column.
	 *
	 * OPTIONAL even though all three concrete types (`SkillEntry`, `ActiveSkill`,
	 * `SkillCommitRef`) declare it as required, because one table-producing boundary
	 * is not typed: the `skills-committed-markdown` ide-bridge operation casts the
	 * caller's summary JSON to `CommitSummary`. An older IntelliJ can therefore send
	 * archived rows with no `source` at all, and declaring it required would render
	 * the string `undefined` into a cell rather than fail anywhere a test could see.
	 */
	readonly source?: SkillSource;
	readonly invocationCount: number;
	readonly usage?: SkillUsage;
	readonly detection?: "heuristic";
}

/**
 * The table body — header, rows, and the `†` footnote when any row is inferred.
 *
 * Returned as lines rather than a string so callers can splice it under their own
 * heading (a commit's frontmatter + hash8 title, or the live view's plain title)
 * without re-splitting.
 *
 * Two display rules, both about not overstating what is known:
 *
 *   - A skill with no `usage` shows an em dash, never `0`. Codex and Cursor
 *     heuristics attribute nothing, and a zero would read as a measurement.
 *   - An estimated figure is marked `~`. The distinction is user-visible in the
 *     data (`SkillUsage.confidence`) precisely so it survives to here.
 *
 * `Tokens` is kept alongside the three-way split rather than replaced by it: the
 * rows are ORDERED by that total and the sidebar's group row summarises by it, so
 * dropping the column would leave both the sort key and the summary figure with no
 * counterpart in the table a reader is looking at.
 *
 * `Agent` sits second — beside the skill id and ahead of every figure — because it
 * is identity, not measurement: the row reads "this skill, run by that host, N
 * times, for this much". It also disambiguates a genuine duplicate the table could
 * not previously explain. The registry keys a row `<source>:<skill>`, so one skill
 * entered from two hosts is legitimately TWO rows; without this column they render
 * as the same skill listed twice.
 */
export function buildSkillsTable(skills: ReadonlyArray<SkillTableRow>): string[] {
	const lines: string[] = [
		"| Skill | Agent | × | Tokens | Input | Output | Cached |",
		"|---|---|---|---|---|---|---|",
	];

	// Heaviest first, then by name and source, so the table reads as "what dominated
	// this work" while still giving the same skill used by two hosts a total order.
	// `localeCompare` is deliberately avoided: it takes the ambient locale, and this
	// file is regenerated on every write — under a different locale the rows would
	// reorder and show up as a spurious diff for a colleague.
	const ordered = [...skills].sort((a, b) => {
		const byTokens = totalOf(b) - totalOf(a);
		if (byTokens !== 0) return byTokens;
		const bySkill = a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0;
		if (bySkill !== 0) return bySkill;
		const aSource = a.source ?? "";
		const bSource = b.source ?? "";
		return aSource < bSource ? -1 : aSource > bSource ? 1 : 0;
	});

	let anyInferred = false;
	for (const ref of ordered) {
		const marker = ref.detection === "heuristic" ? " †" : "";
		if (marker !== "") anyInferred = true;
		lines.push(
			`| ${escapeCell(ref.skill)}${marker} | ${agentCell(ref)} | ${ref.invocationCount} | ${tokenCells(ref).join(" | ")} |`,
		);
	}
	if (anyInferred) {
		// Spelled out rather than left as a bare dagger. A host with no skill tool
		// leaves only a file read behind, which cannot tell an agent using a skill from
		// a human reading it, and cannot count entries — so the row must not be read as
		// an observation.
		lines.push(
			"",
			"† Inferred from a file read rather than an observed invocation: the count is per session, and a human reading the skill file looks the same.",
		);
	}
	return lines;
}

/**
 * `3 skills · 93.8k tokens`, or just `1 skill` when nothing could be attributed.
 *
 * The label on the single aggregate "Skills used" row that EVERY Context surface
 * shows — the sidebar's live list, a committed memory's evidence group, the memory
 * detail panel, the Next Memory panel, and the exported Markdown. One row rather
 * than one per skill: a session routinely enters a dozen skills, and none of those
 * surfaces can absorb a dozen affordance-free rows. The per-skill figures live one
 * click away in the table {@link buildSkillsTable} renders.
 *
 * Exported from here, next to that table, so the summary and the thing it
 * summarises cannot disagree about how a token count is formatted.
 *
 * The `†` inferred marker is NOT included: each surface spells it differently (a
 * dagger where a footnote is in reach, the word "inferred" where it isn't), so the
 * caller appends its own.
 */
export function buildSkillsSummaryLabel(skills: ReadonlyArray<SkillTableRow>): string {
	const count = `${skills.length} skill${skills.length === 1 ? "" : "s"}`;
	let total = 0;
	let anyAttributed = false;
	let anyEstimated = false;
	for (const s of skills) {
		if (s.usage === undefined) continue;
		anyAttributed = true;
		total += s.usage.input + s.usage.cached + s.usage.output;
		if (s.usage.confidence !== "attributed") anyEstimated = true;
	}
	// No figure at all when nothing was attributed — a rendered 0 would read as a
	// measurement of nothing rather than as an absence of measurement. One estimated
	// member makes the whole sum an estimate.
	if (!anyAttributed) return count;
	return `${count} · ${formatCompact(total, anyEstimated ? "~" : "")} tokens`;
}

/** Renders the per-commit aggregate written to `<branchFolder>/skills--<hash8>.md`. */
export function buildSkillsAggregateMarkdown(summary: CommitSummary, skills: ReadonlyArray<SkillCommitRef>): string {
	const hash8 = summary.commitHash.substring(0, 8);
	const lines: string[] = [
		"---",
		"type: skill-usage",
		`commitHash: ${summary.commitHash}`,
		`branch: ${summary.branch}`,
		`generatedAt: ${summary.generatedAt}`,
		"---",
		"",
		`# Skills used — ${hash8}`,
		"",
		`_${summary.commitMessage}_`,
		"",
		...buildSkillsTable(skills),
		"",
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Renders the same table for skills that have NOT been committed yet — what the
 * VS Code sidebar's single aggregate Context row opens.
 *
 * No frontmatter and no commit hash, because neither exists yet: this is a view
 * of the working registry, not a stored artifact, and it is rendered into a
 * virtual document rather than written to disk. Once the work is committed the
 * same rows reappear as `skills--<hash8>.md` with the commit's identity attached.
 */
export function buildLiveSkillsMarkdown(skills: ReadonlyArray<SkillTableRow>): string {
	const lines: string[] = [
		"# Skills used — uncommitted",
		"",
		"_Captured in this working session. Archived onto the memory when you commit._",
		"",
		...buildSkillsTable(skills),
		"",
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Escape a skill id for a Markdown table cell.
 *
 * Not defensive padding: a skill id is host-supplied text from another program's
 * transcript (the same untrusted input `sanitizeSkillIdForPath` exists for), and each
 * of these characters breaks the table *silently* — the row still renders, just with
 * its cells misaligned against the header.
 *
 * Three substitutions, and the ORDER of the first two is load-bearing:
 *
 *   1. `\` → `\\` must run FIRST. Escaping only the pipe was incomplete: for an id
 *      containing `\|`, appending a backslash yields `\\|`, which Markdown reads as an
 *      escaped backslash followed by a LIVE pipe — so the "escape" produced exactly
 *      the cell split it was added to prevent. Running it second would instead
 *      double-escape the backslashes this function just introduced.
 *   2. `|` → `\|` is then safe, because every pre-existing backslash is already inert.
 *   3. CR/LF collapse to a space. A newline is worse than a pipe: it terminates the
 *      table row outright, so the remaining rows are parsed as body text.
 */
function escapeCell(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ");
}

function totalOf(ref: SkillTableRow): number {
	const u = ref.usage;
	return u === undefined ? 0 : u.input + u.cached + u.output;
}

/**
 * The `Agent` cell — the host's display label, or an em dash when the row carries
 * no source.
 *
 * Dashed rather than left blank or filled with a guess, for the same reason
 * {@link tokenCells} dashes an unattributed figure: an absent field is honest.
 * The only rows that reach here without a source come through the untyped
 * ide-bridge boundary (see {@link SkillTableRow.source}), and inventing a host would
 * attribute one agent's work to another.
 *
 * Escaped despite {@link skillSourceLabel} normally returning one of five in-repo
 * constants: its fallback branch capitalises the RAW source string, which is
 * host-supplied text from another program's transcript — the same untrusted input
 * {@link escapeCell} exists for.
 */
function agentCell(ref: SkillTableRow): string {
	// Widened to `string` on purpose. `SkillSource` cannot express `""`, but the
	// ide-bridge boundary forwards unvalidated JSON into this table, so an empty string
	// is reachable at runtime — and `skillSourceLabel` takes a bare `string` for exactly
	// the same reason.
	const source: string | undefined = ref.source;
	if (source === undefined || source === "") return "—";
	return escapeCell(skillSourceLabel(source));
}

/**
 * The four token cells for one row — total, input, output, cached — or four em
 * dashes when the source attributed nothing.
 *
 * All four are dashed together, never partially: an unattributed skill has no
 * figure at all, so a row mixing `—` with zeros would read as "measured, and it
 * was nothing" for the zeroed components.
 */
function tokenCells(ref: SkillTableRow): string[] {
	const u = ref.usage;
	if (u === undefined) return ["—", "—", "—", "—"];
	// The marker qualifies the measurement, not the magnitude, so it rides every
	// component of an estimated row rather than the total alone.
	const marker = u.confidence === "attributed" ? "" : "~";
	return [totalOf(ref), u.input, u.output, u.cached].map((n) => formatCompact(n, marker));
}

/** `93.8k`, `~12.3k` for an estimate. */
function formatCompact(n: number, marker: string): string {
	if (n < 1000) return `${marker}${n}`;
	return `${marker}${(n / 1000).toFixed(1)}k`;
}
