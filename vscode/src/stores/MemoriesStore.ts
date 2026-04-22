/**
 * MemoriesStore — host-side state controller for the "Memories" panel.
 *
 * Core contract — **lazy load is sacrosanct**:
 *  - No assembly path (Extension.ts initial bootstrap, cross-panel watchers)
 *    calls `refresh()` directly.
 *  - `ensureFirstLoad()` is idempotent — only the first call triggers a bridge
 *    query. Cross-panel watchers (orphanRef, lock) must gate on
 *    `hasFirstLoaded()` before calling `refresh()`, otherwise Memories silently
 *    wakes up in the background for users who never opened the panel.
 */

import type { SummaryIndexEntry } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { MemoriesDataService } from "../services/data/MemoriesDataService.js";
import { log } from "../util/Logger.js";
import { BaseStore, type Snapshot } from "./BaseStore.js";

/** Number of entries loaded per batch. */
const PAGE_SIZE = 10;
/** Upper bound on entries returned during search (keeps memory bounded). */
const MAX_SEARCH_ENTRIES = 500;

export type MemoriesChangeReason =
	| "init"
	| "refresh"
	| "loadMore"
	| "setFilter"
	| "enabled";

export interface MemoriesSnapshot extends Snapshot<MemoriesChangeReason> {
	readonly entries: ReadonlyArray<SummaryIndexEntry>;
	readonly entriesCount: number;
	readonly totalCount: number;
	readonly filter: string;
	readonly hasFilter: boolean;
	readonly canLoadMore: boolean;
	readonly isEmpty: boolean;
	readonly isEnabled: boolean;
	readonly firstLoadDone: boolean;
}

const EMPTY: MemoriesSnapshot = {
	entries: [],
	entriesCount: 0,
	totalCount: 0,
	filter: "",
	hasFilter: false,
	canLoadMore: false,
	isEmpty: true,
	isEnabled: true,
	firstLoadDone: false,
	changeReason: "init",
};

export class MemoriesStore extends BaseStore<
	MemoriesChangeReason,
	MemoriesSnapshot
> {
	private snapshot: MemoriesSnapshot = EMPTY;
	private entries: Array<SummaryIndexEntry> = [];
	private totalCount = 0;
	private loadedCount = PAGE_SIZE;
	private filter = "";
	private enabled = true;
	private firstLoadDone = false;

	constructor(private readonly bridge: JolliMemoryBridge) {
		super();
	}

	protected getCurrentSnapshot(): MemoriesSnapshot {
		return this.snapshot;
	}

	hasFirstLoaded(): boolean {
		return this.firstLoadDone;
	}

	// Lazy-load contract:
	//   Passive triggers — startup initialLoad and cross-panel watchers
	//   (orphanRef / lock) — MUST NOT fetch listSummaryEntries until the
	//   user first reveals the Memories panel. They call ensureFirstLoad()
	//   (which is idempotent) or gate on hasFirstLoaded().
	//
	//   Active user gestures (enable command, explicit refresh button)
	//   call refresh() directly and bypass this gate — the user has
	//   signalled intent to use the feature.
	async ensureFirstLoad(): Promise<void> {
		if (this.firstLoadDone) {
			return;
		}
		this.firstLoadDone = true;
		await this.refresh();
	}

	async refresh(): Promise<void> {
		await this.fetchAndRebuild("refresh");
	}

	async loadMore(): Promise<void> {
		this.loadedCount += PAGE_SIZE;
		await this.fetchAndRebuild("loadMore");
	}

	async setFilter(text: string): Promise<void> {
		this.filter = text.trim();
		await this.fetchAndRebuild("setFilter");
	}

	/**
	 * Shared path for bridge fetch → snapshot rebuild.  Emits exactly one
	 * change event using the caller-supplied reason (previously `loadMore`
	 * and `setFilter` double-emitted because each awaited `refresh()` first).
	 */
	private async fetchAndRebuild(reason: MemoriesChangeReason): Promise<void> {
		try {
			const count = this.filter ? MAX_SEARCH_ENTRIES : this.loadedCount;
			const result = await this.bridge.listSummaryEntries(
				count,
				0,
				this.filter || undefined,
			);
			this.entries = [...result.entries];
			this.totalCount = result.totalCount;
		} catch (err: unknown) {
			log.warn(
				"MemoriesStore",
				"Failed to load entries: %s",
				err instanceof Error ? err.message : String(err),
			);
			this.entries = [];
			this.totalCount = 0;
		}
		this.firstLoadDone = true;
		this.rebuildSnapshot(reason);
	}

	getFilter(): string {
		return this.filter;
	}

	setEnabled(e: boolean): void {
		if (this.enabled === e) {
			return;
		}
		this.enabled = e;
		// Clear cached data on disable so memoriesView.description does not
		// stick at "N memories" or "foo — M results" while the viewsWelcome
		// placeholder is shown.  `firstLoadDone` is reset so re-enable can
		// lazy-load cleanly again on the next panel visibility event.
		// `loadedCount` is reset to PAGE_SIZE so a prior Load More session
		// does not carry its pagination cursor across a disable/enable cycle
		// (otherwise the next refresh would request 20/30/... instead of 10).
		if (!e) {
			this.entries = [];
			this.totalCount = 0;
			this.filter = "";
			this.firstLoadDone = false;
			this.loadedCount = PAGE_SIZE;
		}
		this.rebuildSnapshot("enabled");
	}

	private rebuildSnapshot(reason: MemoriesChangeReason): void {
		const entriesCount = this.entries.length;
		const hasFilter = this.filter.length > 0;
		this.snapshot = {
			entries: this.entries,
			entriesCount,
			totalCount: this.totalCount,
			filter: this.filter,
			hasFilter,
			canLoadMore: MemoriesDataService.canLoadMore({
				filter: this.filter,
				loadedCount: this.loadedCount,
				totalCount: this.totalCount,
			}),
			isEmpty: MemoriesDataService.isEmpty(this.entries),
			isEnabled: this.enabled,
			firstLoadDone: this.firstLoadDone,
			changeReason: reason,
		};
		this.emit();
	}
}
