/**
 * CommitsStore — host-side state controller for the "Commits" panel.
 *
 * Owns:
 *  - commit list from `bridge.listBranchCommits(mainBranch)`
 *  - per-commit file cache (Promise-valued so concurrent expands dedupe)
 *  - checked-hashes set (squash selection)
 *  - isMerged, enabled, migrating flags
 *
 * Broadcasts `CommitsSnapshot` via `onChange`. `isMerged` lives on the snapshot
 * so Extension.ts can drive `historyView.title` from a subscription (no
 * Provider → view coupling).
 */

import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { CommitsDataService } from "../services/data/CommitsDataService.js";
import type { BranchCommit, CommitFileInfo } from "../Types.js";
import { BaseStore, type Snapshot } from "./BaseStore.js";

export type CommitsChangeReason =
	| "init"
	| "refresh"
	| "userCheckbox"
	| "selectAll"
	| "enabled"
	| "migrating"
	| "mainBranch";

export interface CommitsSnapshot extends Snapshot<CommitsChangeReason> {
	readonly commits: ReadonlyArray<BranchCommit>;
	readonly selectedCommits: ReadonlyArray<BranchCommit>;
	readonly selectedHashes: ReadonlySet<string>;
	readonly isMerged: boolean;
	readonly singleCommitMode: boolean;
	readonly isEmpty: boolean;
	readonly isEnabled: boolean;
	readonly isMigrating: boolean;
}

const EMPTY: CommitsSnapshot = {
	commits: [],
	selectedCommits: [],
	selectedHashes: new Set(),
	isMerged: false,
	singleCommitMode: false,
	isEmpty: false,
	isEnabled: true,
	isMigrating: false,
	changeReason: "init",
};

export class CommitsStore extends BaseStore<
	CommitsChangeReason,
	CommitsSnapshot
> {
	private snapshot: CommitsSnapshot = EMPTY;
	private commits: Array<BranchCommit> = [];
	private checkedHashes = new Set<string>();
	private fileCache = new Map<string, Promise<Array<CommitFileInfo>>>();
	private enabled = true;
	private migrating = false;
	private isMerged = false;
	private mainBranch = "main";

	constructor(private readonly bridge: JolliMemoryBridge) {
		super();
	}

	protected getCurrentSnapshot(): CommitsSnapshot {
		return this.snapshot;
	}

	// ── Config ────────────────────────────────────────────────────────────────

	setMainBranch(branch: string): void {
		if (this.mainBranch === branch) {
			return;
		}
		this.mainBranch = branch;
		this.rebuildSnapshot("mainBranch");
	}

	// ── Reads ─────────────────────────────────────────────────────────────────

	/** File list for a commit (promise-cached to dedupe concurrent expands). */
	getCommitFiles(hash: string): Promise<Array<CommitFileInfo>> {
		let pending = this.fileCache.get(hash);
		if (!pending) {
			pending = this.bridge.listCommitFiles(hash);
			this.fileCache.set(hash, pending);
			pending.catch(() => this.fileCache.delete(hash));
		}
		return pending;
	}

	getSelectionDebugInfo(): {
		checkedHashes: Array<string>;
		selectedCommits: Array<string>;
		staleCheckedHashes: Array<string>;
		commitCount: number;
		headHash?: string;
		tailHash?: string;
		isMerged: boolean;
	} {
		const selected = CommitsDataService.selectedCommits(
			this.commits,
			this.checkedHashes,
		);
		const stale = CommitsDataService.staleSelection(
			this.commits,
			this.checkedHashes,
		);
		const short = (h: string) => h.substring(0, 8);
		return {
			checkedHashes: [...this.checkedHashes].map(short),
			selectedCommits: selected.map((c) => short(c.hash)),
			staleCheckedHashes: stale.map(short),
			commitCount: this.commits.length,
			headHash: CommitsDataService.shortHash(this.commits[0]?.hash),
			tailHash: CommitsDataService.shortHash(
				this.commits[this.commits.length - 1]?.hash,
			),
			isMerged: this.isMerged,
		};
	}

	// ── Mutations ─────────────────────────────────────────────────────────────

	async refresh(): Promise<void> {
		const previousHashes = this.commits.map((c) => c.hash);
		const result = await this.bridge.listBranchCommits(this.mainBranch);
		this.commits = [...result.commits];
		this.isMerged = result.isMerged;

		const nextHashes = this.commits.map((c) => c.hash);
		const sequenceChanged = CommitsDataService.didSequenceChange(
			previousHashes,
			nextHashes,
		);
		if (sequenceChanged) {
			this.fileCache.clear();
			if (this.checkedHashes.size > 0) {
				this.checkedHashes.clear();
			}
		}
		this.rebuildSnapshot("refresh");
	}

	/**
	 * Checkbox toggle with range semantics: checking N → also check 0..N;
	 * unchecking N → also uncheck N..end.
	 */
	onCheckboxToggle(hash: string, checked: boolean): void {
		const index = this.commits.findIndex((c) => c.hash === hash);
		if (index === -1) {
			return;
		}
		this.checkedHashes = CommitsDataService.applyRangeCheck(
			this.commits,
			this.checkedHashes,
			index,
			checked,
		);
		this.rebuildSnapshot("userCheckbox");
	}

	/** Programmatic select-all toggle. */
	toggleSelectAll(): void {
		if (this.checkedHashes.size > 0) {
			this.checkedHashes.clear();
		} else {
			for (const c of this.commits) {
				this.checkedHashes.add(c.hash);
			}
		}
		this.rebuildSnapshot("selectAll");
	}

	setEnabled(e: boolean): void {
		if (this.enabled === e) {
			return;
		}
		this.enabled = e;
		// Clear cached data on disable so historyView.title does not stick at
		// "COMMITS (merged — read-only history)" while the viewsWelcome
		// placeholder is shown.  Re-enabling triggers a fresh commits load
		// via refreshStatusBar / initialLoad.
		if (!e) {
			this.commits = [];
			this.checkedHashes.clear();
			this.fileCache.clear();
			this.isMerged = false;
		}
		this.rebuildSnapshot("enabled");
	}

	setMigrating(m: boolean): void {
		if (this.migrating === m) {
			return;
		}
		this.migrating = m;
		this.rebuildSnapshot("migrating");
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	private rebuildSnapshot(reason: CommitsChangeReason): void {
		const selected = CommitsDataService.selectedCommits(
			this.commits,
			this.checkedHashes,
		);
		this.snapshot = {
			commits: this.commits,
			selectedCommits: selected,
			selectedHashes: new Set(this.checkedHashes),
			isMerged: this.isMerged,
			singleCommitMode: this.commits.length === 1,
			isEmpty: this.commits.length === 0,
			isEnabled: this.enabled,
			isMigrating: this.migrating,
			changeReason: reason,
		};
		this.emit();
	}
}
