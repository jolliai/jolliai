/**
 * PlansStore — host-side state controller for the "Plans & Notes" panel.
 *
 * Owns:
 *  - plans + notes arrays, enabled flag
 *  - 3 FileSystemWatchers (panel-owned):
 *     1. `~/.claude/plans/*.md` — detects new/updated plan files
 *     2. `<workspace>/.jolli/jollimemory/plans.json` — detects registry updates
 *     3. `<workspace>/.jolli/jollimemory/notes/*.md` — detects note file changes
 *  - Event-driven plan registration (new .md in plans dir → registerNewPlan
 *    with cross-project attribution guard)
 *
 * Cross-panel watchers (sessionsWatcher / headWatcher / lockWatcher) remain
 * in Extension.ts and invoke `refresh()` here from their callbacks.
 */

import { basename } from "node:path";
import * as vscode from "vscode";
import {
	isPlanFromCurrentProject,
	registerNewPlan,
} from "../core/PlanService.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import {
	PlansDataService,
	type PlansOrNote,
} from "../services/data/PlansDataService.js";
import type { NoteInfo, PlanInfo } from "../Types.js";
import { log } from "../util/Logger.js";
import { BaseStore, type Snapshot } from "./BaseStore.js";

export type PlansChangeReason = "init" | "refresh" | "enabled";

export interface PlansSnapshot extends Snapshot<PlansChangeReason> {
	readonly plans: ReadonlyArray<PlanInfo>;
	readonly notes: ReadonlyArray<NoteInfo>;
	readonly merged: ReadonlyArray<PlansOrNote>;
	readonly isEmpty: boolean;
	readonly isEnabled: boolean;
}

const EMPTY: PlansSnapshot = {
	plans: [],
	notes: [],
	merged: [],
	isEmpty: true,
	isEnabled: true,
	changeReason: "init",
};

const REFRESH_DEBOUNCE_MS = 500;

export interface PlansStoreOptions {
	readonly workspaceRoot: string;
	readonly plansDir: string;
	readonly notesDir: string;
}

export class PlansStore extends BaseStore<PlansChangeReason, PlansSnapshot> {
	private snapshot: PlansSnapshot = EMPTY;
	private plans: Array<PlanInfo> = [];
	private notes: Array<NoteInfo> = [];
	private enabled = true;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly workspaceRoot: string;
	private readonly notesDir: string;

	/**
	 * Serializes back-to-back registrations so concurrent registerNewPlan calls
	 * cannot clobber each other's writes to plans.json (Claude may emit multiple
	 * file creations in one turn).
	 */
	private registerQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly bridge: JolliMemoryBridge,
		options?: PlansStoreOptions,
	) {
		super();
		this.workspaceRoot = options?.workspaceRoot ?? "";
		this.notesDir = options?.notesDir ?? "";

		if (!options) {
			// Test fixtures that don't provide options stay headless (no watchers).
			return;
		}

		// Plans directory watcher: ~/.claude/plans/*.md
		const plansWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(options.plansDir), "*.md"),
		);
		const debouncedPlansRefresh = () => this.scheduleDebouncedRefresh();
		plansWatcher.onDidCreate((uri) => {
			debouncedPlansRefresh();
			this.handleNewPlanFile(uri);
		});
		plansWatcher.onDidChange(debouncedPlansRefresh);
		plansWatcher.onDidDelete(debouncedPlansRefresh);
		this.disposables.push(plansWatcher);

		// plans.json registry watcher — catches out-of-band updates (StopHook
		// writes, registerNewPlan via handleNewPlanFile above, orphan cleanup).
		const plansJsonWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(
				options.workspaceRoot,
				".jolli/jollimemory/plans.json",
			),
		);
		plansJsonWatcher.onDidCreate(debouncedPlansRefresh);
		plansJsonWatcher.onDidChange(debouncedPlansRefresh);
		this.disposables.push(plansJsonWatcher);

		// Notes directory watcher
		const notesWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(options.notesDir), "*.md"),
		);
		notesWatcher.onDidCreate(debouncedPlansRefresh);
		notesWatcher.onDidChange(debouncedPlansRefresh);
		notesWatcher.onDidDelete(debouncedPlansRefresh);
		this.disposables.push(notesWatcher);
	}

	protected getCurrentSnapshot(): PlansSnapshot {
		return this.snapshot;
	}

	/**
	 * Hook for Extension.ts's `onDidSaveTextDocument` handler: external markdown
	 * notes reference their source file (outside notesDir), so notesWatcher does
	 * not fire for them.  Extension.ts listens for text-document saves and calls
	 * this method when it matches a registered note.
	 */
	refreshFromExternalNoteSave(): void {
		this.scheduleDebouncedRefresh();
	}

	async refresh(): Promise<void> {
		if (!this.enabled) {
			this.plans = [];
			this.notes = [];
			this.rebuildSnapshot("refresh");
			return;
		}
		this.plans = await this.bridge.listPlans();
		this.notes = await this.bridge.listNotes();
		this.rebuildSnapshot("refresh");
	}

	setEnabled(e: boolean): void {
		if (this.enabled === e) {
			return;
		}
		this.enabled = e;
		if (!e) {
			this.plans = [];
			this.notes = [];
		}
		this.rebuildSnapshot("enabled");
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	private scheduleDebouncedRefresh(): void {
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.refresh().catch((err) => {
				log.warn(
					"PlansStore",
					"debounced refresh failed: %s",
					err instanceof Error ? err.message : String(err),
				);
			});
		}, REFRESH_DEBOUNCE_MS);
	}

	/**
	 * Event-driven registration: when a new .md file appears in the global
	 * `~/.claude/plans/` directory, register it into THIS project's plans.json
	 * — gated by `isPlanFromCurrentProject` to prevent cross-project leaks
	 * (the plans dir is shared across all VSCode windows).
	 *
	 * Serialized via `registerQueue` so concurrent file-creation bursts don't
	 * interleave load-modify-save on plans.json.
	 */
	private handleNewPlanFile(uri: vscode.Uri): void {
		if (!this.workspaceRoot) {
			return;
		}
		const filename = basename(uri.fsPath);
		if (!filename.endsWith(".md")) {
			return;
		}
		const slug = filename.slice(0, -3);
		this.registerQueue = this.registerQueue
			.then(async () => {
				if (!(await isPlanFromCurrentProject(uri.fsPath, this.workspaceRoot))) {
					return;
				}
				await registerNewPlan(slug, this.workspaceRoot);
			})
			.catch((err) => {
				log.warn(
					"PlansStore",
					"registerNewPlan failed: %s",
					err instanceof Error ? err.message : String(err),
				);
			});
	}

	private rebuildSnapshot(reason: PlansChangeReason): void {
		const merged = PlansDataService.mergeByLastModified(this.plans, this.notes);
		this.snapshot = {
			plans: this.plans,
			notes: this.notes,
			merged,
			isEmpty: PlansDataService.isEmpty(this.plans, this.notes),
			isEnabled: this.enabled,
			changeReason: reason,
		};
		this.emit();
	}

	/** Notes directory path — exposed so Extension.ts can gate note-source saves. */
	getNotesDir(): string {
		return this.notesDir;
	}

	override dispose(): void {
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		super.dispose();
	}
}
