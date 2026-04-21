/**
 * PlansTreeProvider
 *
 * TreeDataProvider for the "PLANS & NOTES" panel.
 *
 * UX design:
 * - Lists Claude Code plan files and user-created notes.
 * - Plans and notes are merged into a single list, sorted by last modified (newest first).
 * - Uncommitted plans show plain title; committed plans show "shortHash · title".
 * - Notes: committed show "shortHash · title", uncommitted markdown show "note" icon, snippets show "comment" icon.
 * - Clicking a plan opens it for editing; clicking a note opens it for editing.
 * - Rich MarkdownString tooltip matching COMMITS panel style.
 * - No checkboxes.
 * - Inline buttons: Edit/Remove for both plans and notes.
 */

import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { NoteInfo, PlanInfo } from "../Types.js";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "../util/FormatUtils.js";

// ─── Tree item types ────────────────────────────────────────────────────────

type TreeItem = PlanItem | NoteItem;

// ─── PlanItem ───────────────────────────────────────────────────────────────

export class PlanItem extends vscode.TreeItem {
	readonly plan: PlanInfo;

	constructor(plan: PlanInfo) {
		super(buildPlanLabel(plan), vscode.TreeItemCollapsibleState.None);
		this.plan = plan;
		this.description = formatShortRelativeDate(plan.lastModified);
		// Committed plans use a colored "lock" icon to indicate they're bound to a commit
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
	}
}

// ─── NoteItem ───────────────────────────────────────────────────────────────

export class NoteItem extends vscode.TreeItem {
	readonly note: NoteInfo;

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

	private plans: Array<PlanInfo> = [];
	private notes: Array<NoteInfo> = [];
	private enabled = true;

	constructor(private readonly bridge: JolliMemoryBridge) {}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		this._onDidChangeTreeData.fire(undefined);
	}

	async refresh(): Promise<void> {
		if (!this.enabled) {
			this.plans = [];
			this.notes = [];
			this._onDidChangeTreeData.fire(undefined);
			return;
		}
		this.plans = await this.bridge.listPlans();
		this.notes = await this.bridge.listNotes();
		const isEmpty = this.plans.length === 0 && this.notes.length === 0;
		void vscode.commands.executeCommand(
			"setContext",
			"jollimemory.plans.empty",
			isEmpty,
		);
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<TreeItem> {
		if (!this.enabled) {
			return [];
		}
		// Merge plans and notes, sorted by lastModified descending
		const planItems: Array<{ lastModified: string; item: TreeItem }> =
			this.plans.map((p) => ({
				lastModified: p.lastModified,
				item: new PlanItem(p),
			}));
		const noteItems: Array<{ lastModified: string; item: TreeItem }> =
			this.notes.map((n) => ({
				lastModified: n.lastModified,
				item: new NoteItem(n),
			}));
		const merged = [...planItems, ...noteItems];
		merged.sort(
			(a, b) =>
				new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
		);
		return merged.map((m) => m.item);
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}

// ─── Plan label / tooltip helpers ───────────────────────────────────────────

/** Builds the tree item label: "title" or "shortHash · title" for committed plans. */
function buildPlanLabel(plan: PlanInfo): string {
	if (plan.commitHash) {
		const shortHash = plan.commitHash.substring(0, 8);
		return `${shortHash} · ${plan.title}`;
	}
	return plan.title;
}

/**
 * Builds a rich MarkdownString tooltip matching COMMITS panel style:
 *
 *   **filename.md**  $(clock) 2 hours ago (March 19, 2026 at 3:47 PM)
 *
 *   Plan Title
 *
 *   ---
 *
 *   $(edit) Modified 32 times
 *   $(git-commit) cecc9f40        ← only for committed plans
 *
 *   ---
 *
 *   $(file) Edit Plan
 */
function buildPlanTooltip(plan: PlanInfo): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	// Row 1: filename + clock + relative date
	const relativeDate = formatRelativeDate(plan.lastModified);
	md.appendMarkdown(
		`**${escMd(plan.filename)}** \u00a0$(clock) ${escMd(relativeDate)}\n\n`,
	);

	// Row 2: plan title
	md.appendMarkdown(`${escMd(plan.title)}\n\n`);

	// Separator
	md.appendMarkdown("---\n\n");

	// Row 3: edit count
	md.appendMarkdown(
		`$(edit) edited ${plan.editCount} time${plan.editCount !== 1 ? "s" : ""}\n\n`,
	);

	// Separator
	md.appendMarkdown("---\n\n");

	// Bottom row: hash (copyable) | Preview/Edit Plan — matching COMMITS tooltip style
	const committed = !!plan.commitHash;
	const planArg = encodeURIComponent(
		JSON.stringify([plan.slug, committed, plan.title]),
	);
	if (committed) {
		const shortHash = plan.commitHash?.substring(0, 8);
		const hashArg = encodeURIComponent(JSON.stringify([plan.commitHash]));
		const copyLink = `[$(git-commit) \`${shortHash}\` $(copy)](command:jollimemory.copyCommitHash?${hashArg})`;
		const previewLink = `[$(eye) Preview Plan](command:jollimemory.editPlan?${planArg})`;
		md.appendMarkdown(`${copyLink}\u00a0 |\u00a0 ${previewLink}`);
	} else {
		md.appendMarkdown(
			`[$(file) Edit Plan](command:jollimemory.editPlan?${planArg})`,
		);
	}

	return md;
}

// ─── Note label / tooltip helpers ───────────────────────────────────────────

/** Builds the tree item label: "title" or "shortHash · title" for committed notes. */
function buildNoteLabel(note: NoteInfo): string {
	if (note.commitHash) {
		const shortHash = note.commitHash.substring(0, 8);
		return `${shortHash} · ${note.title}`;
	}
	return note.title;
}

/** Returns the appropriate icon for a note based on format and commit state. */
function buildNoteIcon(note: NoteInfo): vscode.ThemeIcon {
	if (note.commitHash) {
		return new vscode.ThemeIcon("lock", new vscode.ThemeColor("charts.green"));
	}
	return note.format === "snippet"
		? new vscode.ThemeIcon("comment")
		: new vscode.ThemeIcon("note");
}

/**
 * Builds a rich MarkdownString tooltip for notes:
 *
 *   **title**  $(clock) 2 hours ago
 *
 *   $(note) Markdown file  OR  $(comment) Text snippet
 *
 *   ---
 *
 *   $(edit) Edit Note
 */
function buildNoteTooltip(note: NoteInfo): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;

	const relativeDate = formatRelativeDate(note.lastModified);
	const displayName = note.filename ?? note.id;
	md.appendMarkdown(
		`**${escMd(displayName)}** \u00a0$(clock) ${escMd(relativeDate)}\n\n`,
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
