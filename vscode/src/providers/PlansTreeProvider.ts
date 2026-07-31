/**
 * PlansTreeProvider
 *
 * TreeDataProvider for the "PLANS & NOTES" panel. Thin subscriber over
 * PlansStore. Plans + notes are merged via PlansDataService; this provider
 * only renders TreeItems and wires the `jollimemory.plans.empty` context key.
 */

import * as vscode from "vscode";
import {
	type CommitExclusions,
	readExclusions,
} from "../../../cli/src/core/CommitSelectionStore.js";
import { referenceDisplayTitle } from "../../../cli/src/core/references/ReferenceDisplay.js";
import { accumulatedQueryOf } from "../../../cli/src/core/references/ReferenceStore.js";
import type { ReferenceField, SourceId } from "../../../cli/src/Types.js";
import type { PlansOrNote } from "../services/data/PlansDataService.js";
import type { PlansStore } from "../stores/PlansStore.js";
import type { NoteInfo, PlanInfo, ReferenceInfo,
	SkillInfo,
} from "../Types.js";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "../util/FormatUtils.js";
import { SKILLS_GROUP_ID, type SerializedTreeItem } from "../views/SidebarMessages.js";
import { treeItemToSerialized } from "../views/SidebarSerialize.js";
import { getSourceMeta } from "../views/SourceLabels.js";

// ─── Tree item types ────────────────────────────────────────────────────────

type TreeItem = PlanItem | NoteItem | ReferenceItem | SkillsGroupItem;

export class PlanItem extends vscode.TreeItem {
	readonly plan: PlanInfo;
	/**
	 * Structured hover-card data picked up by SidebarSerialize and forwarded
	 * to the webview's renderPlanHoverCard. Activity-bar TreeView ignores
	 * this and renders `tooltip` (MarkdownString) natively; the field is
	 * webview-only so the panel can show codicons + clickable actions
	 * instead of the textContent-rendered markdown source.
	 */
	readonly planHover: {
		readonly title: string;
		readonly filename: string;
		readonly relativeDate: string;
		readonly commitHash?: string;
		readonly slug: string;
	};

	constructor(plan: PlanInfo) {
		super(buildPlanLabel(plan), vscode.TreeItemCollapsibleState.None);
		this.plan = plan;
		this.description = formatShortRelativeDate(plan.lastModified);
		this.iconPath = plan.commitHash
			? new vscode.ThemeIcon("lock", new vscode.ThemeColor("charts.green"))
			: new vscode.ThemeIcon("file-text");
		this.contextValue = "plan";
		this.tooltip = buildPlanTooltip(plan);
		this.command = {
			command: "jollimemory.editPlan",
			title: "Edit Plan",
			arguments: [this],
		};
		this.planHover = {
			title: plan.title,
			filename: plan.filename,
			relativeDate: formatRelativeDate(plan.lastModified),
			...(plan.commitHash ? { commitHash: plan.commitHash } : {}),
			slug: plan.slug,
		};
	}
}

export class NoteItem extends vscode.TreeItem {
	readonly note: NoteInfo;
	/**
	 * Structured hover-card data picked up by SidebarSerialize and forwarded
	 * to renderNoteHoverCard. Activity-bar TreeView ignores this in favour of
	 * the MarkdownString tooltip; the webview reads this field so the panel
	 * gets the same codicon-rich popover Linear / memory rows have.
	 */
	readonly noteHover: {
		readonly title: string;
		readonly filename: string;
		readonly relativeDate: string;
		readonly formatLabel: string;
		readonly format: "markdown" | "snippet";
		readonly contentPreview?: string;
		readonly commitHash?: string;
		readonly noteId: string;
	};

	constructor(note: NoteInfo) {
		super(buildNoteLabel(note), vscode.TreeItemCollapsibleState.None);
		this.note = note;
		this.description = formatShortRelativeDate(note.lastModified);
		this.iconPath = buildNoteIcon(note);
		this.contextValue = "note";
		this.tooltip = buildNoteTooltip(note);
		this.command = {
			command: "jollimemory.editNote",
			title: "Edit Note",
			arguments: [this],
		};
		// Snippet content isn't part of NoteInfo (the panel-display projection)
		// — only NoteReference / orphan-branch storage carries it. Matches the
		// legacy MarkdownString tooltip which also showed only filename + format,
		// not the snippet body. If a future change adds content to NoteInfo, the
		// contentPreview field on NoteHover is ready to receive it.
		this.noteHover = {
			title: note.title,
			filename: note.filename ?? `${note.id}.md`,
			relativeDate: formatRelativeDate(note.lastModified),
			formatLabel: note.format === "snippet" ? "Text snippet" : "Markdown file",
			format: note.format,
			...(note.commitHash ? { commitHash: note.commitHash } : {}),
			noteId: note.id,
		};
	}
}

export class ReferenceItem extends vscode.TreeItem {
	readonly reference: ReferenceInfo;
	/**
	 * Structured hover data forwarded to the webview's hover-card renderer.
	 * Activity-bar TreeView ignores this — it reads `tooltip` (a plain string)
	 * instead. The webview's SidebarSerialize picks this field up off the
	 * TreeItem instance and copies it onto the serialized payload as
	 * `referenceHover`, so the panel can render the same codicon-rich popover
	 * the Memories section uses (see SidebarScriptBuilder.renderReferenceHoverCard).
	 *
	 * `source` lets the renderer label / icon-tint per provider (Linear /
	 * Jira / GitHub / Notion). `fields` is the opaque, source-specific display
	 * bag built by the adapter — the renderer iterates it generically, so a new
	 * source needs no change here.
	 */
	readonly referenceHover: {
		readonly title: string;
		readonly source: SourceId;
		readonly fields?: ReadonlyArray<ReferenceField>;
		readonly url: string;
	};

	constructor(reference: ReferenceInfo) {
		super(referenceDisplayTitle(reference), vscode.TreeItemCollapsibleState.None);
		this.reference = reference;
		this.description = buildReferenceDescription(reference);
		this.iconPath = new vscode.ThemeIcon(buildReferenceIconKey(reference.source));
		// Uniform "reference" contextValue. Webview row dispatch reads the wire
		// `source` field (forwarded via SidebarSerialize) for per-source
		// browser-open vs markdown-open variants.
		this.contextValue = "reference";
		this.tooltip = buildReferenceTooltip(reference);
		this.command = {
			command: "jollimemory.openReferenceMarkdown",
			title: "Open Reference Markdown",
			arguments: [this],
		};
		// Description preview was dropped to keep the hover card concise (a
		// holdover from the Linear-only design — descriptions can be long
		// multi-paragraph blobs that bloat the popover). Users who want the
		// full text click "Open in <Source>".
		this.referenceHover = {
			title: referenceDisplayTitle(reference),
			source: reference.source,
			...(reference.fields && reference.fields.length > 0 ? { fields: reference.fields } : {}),
			url: reference.url,
		};
	}
}

/** How many skills the hover card lists before collapsing the tail into a count. */
const SKILLS_HOVER_ROW_CAP = 8;

/**
 * The single Context row standing for EVERY skill captured in this working session.
 *
 * One row, not one per skill — see the collapse rationale on
 * `PlansDataService.mergeByLastModified`. The consequence to be aware of when
 * reading the rest of this file: this row's `id` is {@link SKILLS_GROUP_ID}, a
 * sentinel rather than a `plans.json.skills` map key, so anything that treats a
 * Context row's id as an addressable artifact key must special-case it. The
 * per-skill keys stay reachable through `skillInfos` and `skillMapKeys()`.
 */
export class SkillsGroupItem extends vscode.TreeItem {
	/** Every skill the row stands for, in registry order. */
	readonly skillInfos: ReadonlyArray<SkillInfo>;
	/**
	 * Structured hover data forwarded to the webview's hover-card renderer, the
	 * same mechanism PlanItem / NoteItem / ReferenceItem use. Activity-bar TreeView
	 * ignores it and renders `tooltip` instead.
	 */
	readonly skillsHover: {
		readonly count: number;
		readonly totalTokensLabel?: string;
		/** `input · output · cached` split of the same sum — see `SkillsHover`. */
		readonly totalBreakdownLabel?: string;
		/** True when at least one member was inferred rather than observed. */
		readonly anyInferred: boolean;
		readonly relativeDate: string;
		readonly rows: ReadonlyArray<{
			readonly skill: string;
			readonly invocationCount: number;
			readonly tokensLabel?: string;
			readonly breakdownLabel?: string;
			readonly inferred: boolean;
		}>;
		/** Members beyond {@link SKILLS_HOVER_ROW_CAP}, so the card can say what it hid. */
		readonly overflow: number;
	};

	constructor(skills: ReadonlyArray<SkillInfo>) {
		super("Skills", vscode.TreeItemCollapsibleState.None);
		this.skillInfos = skills;
		this.description = buildSkillsGroupDescription(skills);
		// A skill is an ACT, not a document: `zap` reads as "this ran" where the
		// file/lock icons the other kinds use read as "this is stored".
		this.iconPath = new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.purple"));
		this.contextValue = "skills";
		this.tooltip = buildSkillsGroupTooltip(skills);
		this.command = {
			command: "jollimemory.openSkillsAggregate",
			title: "Open Skills Used",
		};
		// Heaviest first so the capped list keeps what dominated the session — the
		// same ordering the aggregate table uses, so the card and the opened
		// document read in the same order.
		const ordered = [...skills].sort(compareSkillsByWeight);
		const shown = ordered.slice(0, SKILLS_HOVER_ROW_CAP);
		const summed = sumSkillsUsage(skills);
		this.skillsHover = {
			count: skills.length,
			...(summed !== undefined
				? {
						totalTokensLabel: formatCompactTokens(summed.total, summed.marker),
						totalBreakdownLabel: formatBreakdown(summed),
					}
				: {}),
			anyInferred: skills.some((s) => s.detection === "heuristic"),
			relativeDate: formatRelativeDate(newestLastModified(skills)),
			rows: shown.map((s) => {
				const own = sumSkillsUsage([s]);
				return {
					skill: s.skill,
					invocationCount: s.invocationCount,
					...(own !== undefined
						? { tokensLabel: formatCompactTokens(own.total, own.marker), breakdownLabel: formatBreakdown(own) }
						: {}),
					inferred: s.detection === "heuristic",
				};
			}),
			overflow: Math.max(0, ordered.length - shown.length),
		};
	}
}

// ─── PlansTreeProvider ──────────────────────────────────────────────────────

export class PlansTreeProvider
	implements vscode.TreeDataProvider<TreeItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		TreeItem | undefined | null | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly store: PlansStore;
	private readonly unsubscribe: () => void;
	private readonly cwd: string;
	private exclusions: CommitExclusions = {
		conversations: new Set(),
		plans: new Set(),
		notes: new Set(),
		references: new Set(),
		skills: new Set(),
	};

	constructor(store: PlansStore, cwd = "") {
		this.store = store;
		this.cwd = cwd;
		this.unsubscribe = store.onChange((snap) => {
			void vscode.commands.executeCommand(
				"setContext",
				"jollimemory.plans.empty",
				snap.isEmpty,
			);
			this._onDidChangeTreeData.fire(undefined);
		});
		void this.refreshExclusions();
	}

	/**
	 * `plans.json.skills` keys for every captured skill.
	 *
	 * Exists because the Context list collapses skills into ONE row whose `id` is a
	 * sentinel ({@link SKILLS_GROUP_ID}). Callers that need to write per-skill
	 * exclusion keys — Select All, the aggregate checkbox — cannot recover them from
	 * `serialize()` output and have to come back to the store.
	 */
	skillMapKeys(): ReadonlyArray<string> {
		return this.store.getSnapshot().skills.map((s) => s.mapKey);
	}

	async refreshExclusions(): Promise<void> {
		this.exclusions = await readExclusions(this.cwd);
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<TreeItem> {
		const snap = this.store.getSnapshot();
		if (!snap.isEnabled) {
			return [];
		}
		return snap.merged.map(toTreeItem);
	}

	serialize(): ReadonlyArray<SerializedTreeItem> {
		return this.getChildren().map((it) => {
			let idHint: string;
			let isSelected = true;
			if (it instanceof PlanItem) {
				idHint = it.plan.slug;
				isSelected = !this.exclusions.plans.has(idHint);
			} else if (it instanceof NoteItem) {
				idHint = it.note.id;
				isSelected = !this.exclusions.notes.has(idHint);
			} else if (it instanceof ReferenceItem) {
				idHint = it.reference.mapKey;
				isSelected = !this.exclusions.references.has(idHint);
			} else {
				// A sentinel, not a map key: this row stands for N skills, so there is no
				// single artifact id to carry. Consumers that address rows by id (the
				// webview checkbox dispatcher, SelectAll) special-case it and go back to
				// the store for the real keys.
				idHint = SKILLS_GROUP_ID;
				// Checked only when EVERY member is included. `skills` is optional on
				// CommitExclusions — a selection file written before skills were selectable
				// has no such field, and absent means nothing was excluded. `every` also
				// keeps a partially-excluded set (reachable from a file written while
				// skills were individually selectable) from reading as fully kept.
				const excluded = this.exclusions.skills;
				isSelected = it.skillInfos.every((s) => !(excluded?.has(s.mapKey) ?? false));
			}
			const ser = treeItemToSerialized(it, idHint);
			return { ...ser, isSelected };
		});
	}

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
	}
}

/**
 * One merged Context entry to its TreeItem.
 *
 * Extracted from `getChildren` so the switch can be exhaustive: inline in a `map`
 * callback the linter cannot see that every arm returns. Exhaustive matters here —
 * the original fall-through built a ReferenceItem for anything that was not a plan
 * or note, so a newly added kind would have rendered as a reference with the wrong
 * icon and command, and crashed on the first `.reference` access.
 */
function toTreeItem(entry: PlansOrNote): TreeItem {
	switch (entry.kind) {
		case "plan":
			return new PlanItem(entry.plan);
		case "note":
			return new NoteItem(entry.note);
		case "reference":
			return new ReferenceItem(entry.reference);
		case "skills":
			return new SkillsGroupItem(entry.skills);
	}
}

// ─── Plan label / tooltip helpers ───────────────────────────────────────────

function buildPlanLabel(plan: PlanInfo): string {
	if (plan.commitHash) {
		const shortHash = plan.commitHash.substring(0, 8);
		return `${shortHash} · ${plan.title}`;
	}
	return plan.title;
}

function buildPlanTooltip(plan: PlanInfo): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	const relativeDate = formatRelativeDate(plan.lastModified);
	md.appendMarkdown(
		`**${escMd(plan.filename)}**  $(clock) ${escMd(relativeDate)}\n\n`,
	);

	md.appendMarkdown(`${escMd(plan.title)}\n\n`);
	md.appendMarkdown("---\n\n");

	const committed = !!plan.commitHash;
	const planArg = encodeURIComponent(
		JSON.stringify([plan.slug, committed, plan.title]),
	);
	if (committed) {
		const shortHash = plan.commitHash?.substring(0, 8);
		const hashArg = encodeURIComponent(JSON.stringify([plan.commitHash]));
		const copyLink = `[$(git-commit) \`${shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})`;
		const previewLink = `[$(eye) Preview Plan](command:jollimemory.editPlan?${planArg})`;
		md.appendMarkdown(`${copyLink}  |  ${previewLink}`);
	} else {
		md.appendMarkdown(
			`[$(file) Edit Plan](command:jollimemory.editPlan?${planArg})`,
		);
	}

	return md;
}

// ─── Note label / tooltip helpers ───────────────────────────────────────────

function buildNoteLabel(note: NoteInfo): string {
	if (note.commitHash) {
		const shortHash = note.commitHash.substring(0, 8);
		return `${shortHash} · ${note.title}`;
	}
	return note.title;
}

function buildNoteIcon(note: NoteInfo): vscode.ThemeIcon {
	if (note.commitHash) {
		return new vscode.ThemeIcon("lock", new vscode.ThemeColor("charts.green"));
	}
	return note.format === "snippet"
		? new vscode.ThemeIcon("comment")
		: new vscode.ThemeIcon("note");
}

function buildNoteTooltip(note: NoteInfo): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	const relativeDate = formatRelativeDate(note.lastModified);
	const displayName = note.filename ?? note.id;
	md.appendMarkdown(
		`**${escMd(displayName)}**  $(clock) ${escMd(relativeDate)}\n\n`,
	);
	md.appendMarkdown(`${escMd(note.title)}\n\n`);
	md.appendMarkdown("---\n\n");

	const formatLabel =
		note.format === "snippet"
			? "$(comment) Text snippet"
			: "$(note) Markdown file";
	md.appendMarkdown(`${formatLabel}\n\n`);

	if (note.commitHash) {
		const shortHash = note.commitHash.substring(0, 8);
		const hashArg = encodeURIComponent(JSON.stringify([note.commitHash]));
		md.appendMarkdown(
			`[$(git-commit) \`${shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})\n\n`,
		);
	}

	md.appendMarkdown("---\n\n");

	const noteArg = encodeURIComponent(JSON.stringify([note.id]));
	md.appendMarkdown(
		`[$(edit) Edit Note](command:jollimemory.editNote?${noteArg})`,
	);

	return md;
}

// ─── Reference label / tooltip helpers ──────────────────────────────────────

function buildReferenceIconKey(source: SourceId): string {
	// Per-source codicon id, from the single SOURCE_META table (SourceLabels.ts).
	// Notion references are pages, not tickets — `file-text` matches the
	// product mental model. Linear / Jira / GitHub all surface as issues —
	// the `issues` stacked-circles glyph reads as "issue" more clearly than
	// `issue-opened`, which is easily mistaken for an info glyph. A source
	// outside the table (phase-2 config-registered) falls back to `link`.
	return getSourceMeta(source).icon;
}

function buildReferenceDescription(reference: ReferenceInfo): string {
	// Same rationale as the Linear-only ancestor: status drifts post-capture
	// (we don't poll the upstream provider), so the row description sticks
	// to the relative date. Status lives in the tooltip / hover card for
	// users who explicitly inspect captured state.
	const date = formatShortRelativeDate(reference.lastModified);
	// An ACCUMULATING source is the exception, and for the opposite reason: its title
	// is the tool label (`Search`), identical on every row and every commit, so the
	// date alone leaves the row carrying no information about what actually happened.
	// The query does not drift — it is a record of what was asked — so the newest one
	// earns the slot. Every entity-shaped source keeps the bare date.
	//
	// `accumulatedQueryOf` owns both the gate and the derivation so this row and the
	// committed row (SummaryHtmlBuilder, reading the archived `latestQuery` snapshot)
	// cannot disagree about which sources show a query or which one is newest.
	const query = accumulatedQueryOf(reference.source, reference.description);
	return query === undefined ? date : `${query} · ${date}`;
}

function buildReferenceTooltip(reference: ReferenceInfo): string {
	// Plain text, not MarkdownString. The panel webview renders TreeItem
	// tooltips via `textContent` on a shared <div> (see SidebarScriptBuilder's
	// attachTextTip helper — native HTML title= is unreliable inside the
	// webview iframe). textContent doesn't interpret markdown, so a
	// MarkdownString here would render its escaped source verbatim.
	// Plain text round-trips identically through both surfaces.
	const lines: Array<string> = [];
	lines.push(referenceDisplayTitle(reference));
	const refFields = reference.fields ?? [];
	if (refFields.length > 0) {
		lines.push("");
		for (const f of refFields) lines.push(`${f.label}: ${f.value}`);
	}
	lines.push("");
	lines.push(reference.url);
	if (reference.description) {
		const preview = reference.description.slice(0, 200);
		lines.push("");
		lines.push(preview + (reference.description.length > 200 ? "…" : ""));
	}
	return lines.join("\n");
}

// ─── Skill label / tooltip helpers ──────────────────────────────────────────

/** `3 skills · 93.8k †` — member count, summed tokens, dagger when any member is inferred. */
function buildSkillsGroupDescription(skills: ReadonlyArray<SkillInfo>): string {
	const parts = [`${skills.length} skill${skills.length !== 1 ? "s" : ""}`];
	const total = formatSkillsTotalTokens(skills);
	if (total !== undefined) parts.push(total);
	const joined = parts.join(" · ");
	// The dagger rather than the word "inferred": on a group row the flag qualifies
	// SOME members, not the row, and † is exactly what the aggregate table and the
	// hover card use for the same qualification — so the mark the user sees here is
	// the one they can look up one hover away.
	return skills.some((s) => s.detection === "heuristic") ? `${joined} †` : joined;
}

/**
 * Summed usage across every member that could be attributed, or undefined when
 * none could.
 *
 * One accumulator producing all four figures AND the marker, rather than a
 * per-column helper: `anyEstimated` qualifies the whole result, so it has to be
 * decided in the same pass that produced the components. Deriving it per column
 * is how a card ends up marking its total as an estimate while presenting the
 * three parts it was summed from as measurements.
 *
 * Also used for a single skill (`sumSkillsUsage([s])`), which keeps the row and
 * the group summary on literally the same code path.
 */
function sumSkillsUsage(
	skills: ReadonlyArray<SkillInfo>,
): { marker: string; total: number; input: number; output: number; cached: number } | undefined {
	let input = 0;
	let output = 0;
	let cached = 0;
	let anyAttributed = false;
	let anyEstimated = false;
	for (const s of skills) {
		const u = s.usage;
		if (u === undefined) continue;
		anyAttributed = true;
		input += u.input;
		output += u.output;
		cached += u.cached;
		if (u.confidence !== "attributed") anyEstimated = true;
	}
	if (!anyAttributed) return undefined;
	// One estimated member makes the SUM an estimate — the marker qualifies the whole
	// figure, so it cannot be dropped just because the other members were measured.
	return { marker: anyEstimated ? "~" : "", total: input + output + cached, input, output, cached };
}

/** Total tokens across every member that could be attributed, or undefined when none could. */
function formatSkillsTotalTokens(skills: ReadonlyArray<SkillInfo>): string | undefined {
	const summed = sumSkillsUsage(skills);
	return summed === undefined ? undefined : formatCompactTokens(summed.total, summed.marker);
}

/** `79 input · 33.9k output · 59.8k cached` — the three-way split, in the aggregate table's column order. */
function formatBreakdown(summed: { marker: string; input: number; output: number; cached: number }): string {
	const { marker } = summed;
	return [
		`${formatCompactTokens(summed.input, marker)} input`,
		`${formatCompactTokens(summed.output, marker)} output`,
		`${formatCompactTokens(summed.cached, marker)} cached`,
	].join(" · ");
}

/** `93.8k`, `~12.3k` for an estimate. */
function formatCompactTokens(n: number, marker: string): string {
	return n < 1000 ? `${marker}${n}` : `${marker}${(n / 1000).toFixed(1)}k`;
}

/** Newest `lastModified` across members — the group's own timestamp. */
function newestLastModified(skills: ReadonlyArray<SkillInfo>): string {
	return skills.reduce((newest, s) => (s.lastModified > newest ? s.lastModified : newest), "");
}

/** Heaviest first, then by name — the aggregate table's ordering. */
function compareSkillsByWeight(a: SkillInfo, b: SkillInfo): number {
	const byTokens = totalTokensOf(b) - totalTokensOf(a);
	if (byTokens !== 0) return byTokens;
	// Not `localeCompare`: it takes the ambient locale, which would reorder rows for
	// a colleague running a non-English one.
	return a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0;
}

function totalTokensOf(skill: SkillInfo): number {
	const u = skill.usage;
	return u === undefined ? 0 : u.input + u.cached + u.output;
}

/**
 * `93.8k`, `~12.3k` for an estimate, or undefined when nothing was attributed.
 *
 * Undefined rather than "0": Codex and Cursor heuristics attribute no tokens at
 * all, and a rendered zero reads as a measurement of nothing rather than as an
 * absence of measurement.
 */
function formatSkillTokens(skill: SkillInfo): string | undefined {
	return formatSkillsTotalTokens([skill]);
}

/**
 * The group row's native-TreeView tooltip: the same table the hover card and the
 * opened aggregate document show, rendered as Markdown.
 *
 * Uncapped, unlike the hover card's {@link SKILLS_HOVER_ROW_CAP}: a MarkdownString
 * tooltip scrolls, so there is no layout reason to hide the tail here.
 */
function buildSkillsGroupTooltip(skills: ReadonlyArray<SkillInfo>): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	const count = `${skills.length} skill${skills.length !== 1 ? "s" : ""}`;
	md.appendMarkdown(`**Skills used**  $(clock) ${escMd(formatRelativeDate(newestLastModified(skills)))}\n\n`);
	const total = formatSkillsTotalTokens(skills);
	md.appendMarkdown(total === undefined ? `${count}\n\n` : `${count} · ${escMd(total)} tokens\n\n`);

	md.appendMarkdown("| Skill | × | Tokens |\n|---|---|---|\n");
	for (const s of [...skills].sort(compareSkillsByWeight)) {
		const marker = s.detection === "heuristic" ? " †" : "";
		const tokens = formatSkillTokens(s);
		md.appendMarkdown(`| ${escMd(s.skill)}${marker} | ${s.invocationCount} | ${tokens ?? "—"} |\n`);
	}
	md.appendMarkdown("\n");

	if (skills.some((s) => s.detection === "heuristic")) {
		md.appendMarkdown(
			"$(info) † Inferred from a file read — that host has no skill tool, so a human reading the file looks the same and entries cannot be counted.\n\n",
		);
	}

	md.appendMarkdown("---\n\n");
	md.appendMarkdown("[$(file) Open Skills Used](command:jollimemory.openSkillsAggregate)");
	return md;
}
