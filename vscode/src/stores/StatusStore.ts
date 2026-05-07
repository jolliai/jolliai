/**
 * StatusStore — host-side state controller for the "Status" panel.
 *
 * Owns: StatusInfo + JolliMemoryConfig, workerBusy / extensionOutdated /
 * migrating flags. Sessions/HEAD/lock watchers are cross-panel and invoke
 * `refresh()` / `setWorkerBusy()` from Extension.ts.
 */

import {
	getGlobalConfigDir,
	loadConfigFromDir,
} from "../../../cli/src/core/SessionTracker.js";
import type { JolliMemoryConfig, StatusInfo } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { AuthService } from "../services/AuthService.js";
import {
	StatusDataService,
	type StatusDerived,
} from "../services/data/StatusDataService.js";
import { BaseStore, type Snapshot } from "./BaseStore.js";

export type StatusChangeReason =
	| "init"
	| "refresh"
	| "setStatus"
	| "workerBusy"
	| "extensionOutdated"
	| "migrating";

export interface StatusSnapshot extends Snapshot<StatusChangeReason> {
	readonly status: StatusInfo | null;
	readonly config: JolliMemoryConfig | null;
	readonly derived: StatusDerived;
	readonly workerBusy: boolean;
	readonly extensionOutdated: boolean;
	readonly migrating: boolean;
}

const INITIAL_DERIVED: StatusDerived = {
	hasApiKey: false,
	signedIn: false,
	allHooksInstalled: false,
	hooksDescription: "none installed",
};

const EMPTY: StatusSnapshot = {
	status: null,
	config: null,
	derived: INITIAL_DERIVED,
	workerBusy: false,
	extensionOutdated: false,
	migrating: false,
	changeReason: "init",
};

export class StatusStore extends BaseStore<StatusChangeReason, StatusSnapshot> {
	private snapshot: StatusSnapshot = EMPTY;
	private status: StatusInfo | null = null;
	private config: JolliMemoryConfig | null = null;
	private workerBusy = false;
	private extensionOutdated = false;
	private migrating = false;

	constructor(
		private readonly bridge: JolliMemoryBridge,
		private readonly authService?: AuthService,
	) {
		super();
	}

	protected getCurrentSnapshot(): StatusSnapshot {
		return this.snapshot;
	}

	async refresh(): Promise<void> {
		// Config (authToken / apiKey) lives on disk independently of whether
		// the git hook is installed; load it unconditionally so the Sidebar's
		// `configured = signedIn || hasApiKey` gate keeps reflecting the
		// user's credentials even when hooks are uninstalled. Otherwise
		// disabling Jolli Memory would flip `configured` to false, swap the
		// disabled-banner (which carries the Enable button) for the
		// onboarding panel, and trap the user with no way to re-enable.
		this.status = await this.bridge.getStatus();
		this.config = await loadConfigFromDir(getGlobalConfigDir());
		this.authService?.refreshContextKey(this.config);
		this.rebuildSnapshot("refresh");
	}

	setStatus(status: StatusInfo): void {
		this.status = status;
		this.rebuildSnapshot("setStatus");
	}

	setWorkerBusy(busy: boolean): void {
		if (this.workerBusy === busy) {
			return;
		}
		this.workerBusy = busy;
		this.rebuildSnapshot("workerBusy");
	}

	setExtensionOutdated(outdated: boolean): void {
		if (this.extensionOutdated === outdated) {
			return;
		}
		this.extensionOutdated = outdated;
		this.rebuildSnapshot("extensionOutdated");
	}

	setMigrating(m: boolean): void {
		if (this.migrating === m) {
			return;
		}
		this.migrating = m;
		this.rebuildSnapshot("migrating");
	}

	private rebuildSnapshot(reason: StatusChangeReason): void {
		this.snapshot = {
			status: this.status,
			config: this.config,
			derived: StatusDataService.derive(this.status, this.config),
			workerBusy: this.workerBusy,
			extensionOutdated: this.extensionOutdated,
			migrating: this.migrating,
			changeReason: reason,
		};
		this.emit();
	}
}
