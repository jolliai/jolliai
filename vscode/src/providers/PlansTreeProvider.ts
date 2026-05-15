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
		// editCount intentionally omitted from the hover card — the count
		// isn't trustworthy in practice (it's incremented by the transcript
		// scanner which doesn't see every plan touch), so surfacing "edited
		// 0 times" gave users a wrong impression. The field still lives on
		// PlanInfo / plans.json for now in case a future detection pass
		// rebuilds it correctly.
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

export class LinearIssueItem extends vscode.TreeItem {
	readonly issue: LinearIssueInfo;
	/**
	 * Structured hover data forwarded to the webview's hover-card renderer.
	 * Activity-bar TreeView ignores this — it reads `tooltip` (a plain string)
	 * instead. The webview's SidebarSerialize picks this field up off the
	 * TreeItem instance and copies it onto the serialized payload as
	 * `linearHover`, so the panel can render the same codicon-rich popover
	 * the Memories section uses (see SidebarScriptBuilder.renderLinearHoverCard).
	 */
	readonly linearHover: {
		readonly title: string;
		readonly status?: string;
		readonly priority?: string;
		readonly labels?: string;
		readonly url: string;
	};

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
		// Description preview was dropped to keep the hover card concise.
		// Linear descriptions can be long and noisy (multi-paragraph context,
		// cross-issue HTML refs, markdown formatting). Users who want the
		// full text can click "Open in Linear" — surface the high-density
		// fields (status / priority / labels / link) and stop there.
		this.linearHover = {
			title: buildLinearIssueLabel(issue),
			...(issue.status ? { status: issue.status } : {}),
			...(issue.priority ? { priority: issue.priority } : {}),
			...(issue.labels && issue.labels.length > 0
				? { labels: issue.labels.join(", ") }
				: {}),
			url: issue.url,
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

function buildLinearIssueTooltip(issue: LinearIssueInfo): string {
	// Plain text, not MarkdownString. The panel webview renders TreeItem
	// tooltips via `textContent` on a shared <div> (see SidebarScriptBuilder's
	// attachTextTip helper — native HTML title= is unreliable inside the
	// webview iframe). textContent doesn't interpret markdown, so a
	// MarkdownString here would render its escaped source verbatim:
	// `**JOLLI\-1528**` instead of bold `JOLLI-1528`, `\#\# Problem` instead
	// of a heading, `[$(link-external) ...](url)` instead of a link, etc.
	// Plain text round-trips identically through both surfaces.
	const lines: Array<string> = [];
	lines.push(`${issue.ticketId} — ${issue.title}`);
	if (
		issue.status ||
		issue.priority ||
		(issue.labels && issue.labels.length > 0)
	) {
		lines.push("");
	}
	if (issue.status) lines.push(`Status: ${issue.status}`);
	if (issue.priority) lines.push(`Priority: ${issue.priority}`);
	if (issue.labels && issue.labels.length > 0) {
		lines.push(`Labels: ${issue.labels.join(", ")}`);
	}
	lines.push("");
	lines.push(issue.url);
	if (issue.description) {
		const preview = issue.description.slice(0, 200);
		lines.push("");
		lines.push(preview + (issue.description.length > 200 ? "…" : ""));
	}
	return lines.join("\n");
}
