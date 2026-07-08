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
import type { ReferenceField, SourceId } from "../../../cli/src/Types.js";
import type { PlansStore } from "../stores/PlansStore.js";
import type { NoteInfo, PlanInfo, ReferenceInfo } from "../Types.js";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "../util/FormatUtils.js";
import type { SerializedTreeItem } from "../views/SidebarMessages.js";
import { treeItemToSerialized } from "../views/SidebarSerialize.js";
import { getSourceMeta } from "../views/SourceLabels.js";

// ─── Tree item types ────────────────────────────────────────────────────────

type TreeItem = PlanItem | NoteItem | ReferenceItem;

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
		super(buildReferenceLabel(reference), vscode.TreeItemCollapsibleState.None);
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
			title: buildReferenceLabel(reference),
			source: reference.source,
			...(reference.fields && reference.fields.length > 0 ? { fields: reference.fields } : {}),
			url: reference.url,
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
		return snap.merged.map((entry) => {
			if (entry.kind === "plan") return new PlanItem(entry.plan) as TreeItem;
			if (entry.kind === "note") return new NoteItem(entry.note) as TreeItem;
			return new ReferenceItem(entry.reference) as TreeItem;
		});
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
			} else {
				idHint = it.reference.mapKey;
				isSelected = !this.exclusions.references.has(idHint);
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

/**
 * Reference row label. Linear / Jira / GitHub issues all carry a stable native id
 * (PROJ-1234, KAN-5, owner/repo#42) that users recognize at a glance, so the
 * label leads with it. Notion pages are nameless beyond their title (the 32-hex
 * page id is meaningless to the user), so the label drops the prefix and just
 * shows the title.
 */
function buildReferenceLabel(reference: ReferenceInfo): string {
	if (reference.source === "notion") return reference.title;
	return `${reference.nativeId} — ${reference.title}`;
}

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
	return formatShortRelativeDate(reference.lastModified);
}

function buildReferenceTooltip(reference: ReferenceInfo): string {
	// Plain text, not MarkdownString. The panel webview renders TreeItem
	// tooltips via `textContent` on a shared <div> (see SidebarScriptBuilder's
	// attachTextTip helper — native HTML title= is unreliable inside the
	// webview iframe). textContent doesn't interpret markdown, so a
	// MarkdownString here would render its escaped source verbatim.
	// Plain text round-trips identically through both surfaces.
	const lines: Array<string> = [];
	if (reference.source === "notion") {
		lines.push(reference.title);
	} else {
		lines.push(`${reference.nativeId} — ${reference.title}`);
	}
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

