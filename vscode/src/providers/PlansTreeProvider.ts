/**
 * PlansTreeProvider
 *
 * TreeDataProvider for the "PLANS & NOTES" panel. Thin subscriber over
 * PlansStore. Plans + notes are merged via PlansDataService; this provider
 * only renders TreeItems and wires the `jollimemory.plans.empty` context key.
 */

import * as vscode from "vscode";
import type { PlansStore } from "../stores/PlansStore.js";
import type { LinearIssueInfo, NoteInfo, PlanInfo } from "../Types.js";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "../util/FormatUtils.js";
import type { SerializedTreeItem } from "../views/SidebarMessages.js";
import { treeItemToSerialized } from "../views/SidebarSerialize.js";

// ─── Tree item types ────────────────────────────────────────────────────────

type TreeItem = PlanItem | NoteItem | LinearIssueItem;

export class PlanItem extends vscode.TreeItem {
	readonly plan: PlanInfo;

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
	}
}

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

export class LinearIssueItem extends vscode.TreeItem {
	readonly issue: LinearIssueInfo;

	constructor(issue: LinearIssueInfo) {
		super(buildLinearIssueLabel(issue), vscode.TreeItemCollapsibleState.None);
		this.issue = issue;
		this.description = buildLinearIssueDescription(issue);
		this.iconPath = new vscode.ThemeIcon("issue-opened");
		this.contextValue = "linearissue";
		this.tooltip = buildLinearIssueTooltip(issue);
		this.command = {
			command: "jollimemory.openLinearIssueMarkdown",
			title: "Open Linear Issue Markdown",
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

	private readonly unsubscribe: () => void;

	constructor(private readonly store: PlansStore) {
		this.unsubscribe = store.onChange((snap) => {
			void vscode.commands.executeCommand(
				"setContext",
				"jollimemory.plans.empty",
				snap.isEmpty,
			);
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<TreeItem> {
		const snap = this.store.getSnapshot();
		if (!snap.isEnabled) {
			return [];
		}
		return snap.merged.map((entry) => {
			if (entry.kind === "plan") return new PlanItem(entry.plan) as TreeItem;
			if (entry.kind === "note") return new NoteItem(entry.note) as TreeItem;
			return new LinearIssueItem(entry.linearIssue) as TreeItem;
		});
	}

	serialize(): ReadonlyArray<SerializedTreeItem> {
		return this.getChildren().map((it) => {
			let idHint: string;
			if (it instanceof PlanItem) idHint = it.plan.slug;
			else if (it instanceof NoteItem) idHint = it.note.id;
			else idHint = it.issue.mapKey;
			return treeItemToSerialized(it, idHint);
		});
	}

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
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
	md.appendMarkdown(
		`$(edit) edited ${plan.editCount} time${plan.editCount !== 1 ? "s" : ""}\n\n`,
	);
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

// ─── Linear issue label / tooltip helpers ───────────────────────────────────

function buildLinearIssueLabel(issue: LinearIssueInfo): string {
	return `${issue.ticketId} — ${issue.title}`;
}

function buildLinearIssueDescription(issue: LinearIssueInfo): string {
	// Intentionally omits the issue.status field. The status captured at
	// reference time can drift from the live Linear value (we don't poll), so
	// displaying it in the row description risked misleading users with stale
	// "In Progress" / "Backlog" labels. The status remains in the tooltip's
	// markdown body for users who explicitly hover to inspect captured state.
	return formatShortRelativeDate(issue.lastModified);
}

function buildLinearIssueTooltip(
	issue: LinearIssueInfo,
): vscode.MarkdownString {
	const md = new vscode.MarkdownString("", true);
	md.isTrusted = true;
	md.appendMarkdown(`**${escMd(issue.ticketId)}** — ${escMd(issue.title)}\n\n`);
	if (issue.status) md.appendMarkdown(`Status: ${escMd(issue.status)}  \n`);
	if (issue.priority)
		md.appendMarkdown(`Priority: ${escMd(issue.priority)}  \n`);
	if (issue.labels && issue.labels.length > 0) {
		md.appendMarkdown(`Labels: ${escMd(issue.labels.join(", "))}  \n`);
	}
	md.appendMarkdown(`\n[$(link-external) Open in Linear](${issue.url})`);
	if (issue.description) {
		const preview = issue.description.slice(0, 200);
		md.appendMarkdown(
			`\n\n---\n\n${escMd(preview)}${issue.description.length > 200 ? "…" : ""}`,
		);
	}
	return md;
}
