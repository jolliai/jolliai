import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { isSourceEnabled, listActiveConversationsWithDiagnostics } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { loadConfig } from "../../../cli/src/core/SessionTracker.js";
import { recordSessionsFromTick } from "../../../cli/src/dashboard/ProducerHooks.js";
import { errMsg } from "../../../cli/src/Logger.js";
import {
	TRANSCRIPT_SOURCES,
	type TranscriptSource,
} from "../../../cli/src/Types.js";
import { log } from "../util/Logger.js";

export interface ActiveSessionsDeps {
	/** Returns the absolute path of the current workspace root, or undefined. */
	readonly getWorkspaceCwd: () => string | undefined;
	/**
	 * Dashboard write seam (JOLLI-2069). Defaults to the CLI's
	 * `recordSessionsFromTick`; tests inject a spy. The provider rides the
	 * sidebar's 60 s tick, so the dashboard needs no timer of its own.
	 */
	readonly recordDashboardSessions?: typeof recordSessionsFromTick;
}

const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48h, per spec §3

/**
 * Thin VS Code-side wrapper around the CLI aggregator. Exists so
 * SidebarWebviewProvider has a single typed dependency to mock in
 * tests and a single seam to swap implementations.
 */
export class ActiveSessionsProvider {
	private lastAggregatorFailure: string | undefined;

	constructor(private readonly deps: ActiveSessionsDeps) {}

	async list(): Promise<readonly ActiveConversationItem[]> {
		return (await this.listWithDiagnostics()).items;
	}

	/**
	 * Same as `list()` but also exposes which AI tool sources failed to load
	 * (rather than simply returning zero rows for them). The webview side can
	 * use `failedSources` to render a "2 of N sources unavailable" hint
	 * instead of silently presenting an incomplete list (N = the size of
	 * `TRANSCRIPT_SOURCES`, currently twelve).
	 */
	async listWithDiagnostics(): Promise<{
		readonly items: readonly ActiveConversationItem[];
		readonly failedSources: readonly TranscriptSource[];
	}> {
		const cwd = this.deps.getWorkspaceCwd();
		if (!cwd) return { items: [], failedSources: [] };
		try {
			const [result, config] = await Promise.all([
				listActiveConversationsWithDiagnostics({ cwd, windowMs: WINDOW_MS }),
				loadConfig(),
			]);
			// Belt-and-suspenders: the aggregator already gates each source by
			// config, so this filter is expected to be a no-op. It guards
			// against config drift between the two loads (a save landing
			// between them) and any future path that bypasses the aggregator's
			// own gate. `failedSources` gets the SAME gate so a source the
			// user just disabled cannot spike the "N sources unavailable"
			// banner mid-render — the aggregator's per-source loader for a
			// disabled source no-ops without touching disk, so a stale entry
			// there is possible only under the same drift window.
			const items = result.items.filter((item) => isSourceEnabled(item.source, config));
			const failedSources = result.failedSources.filter((source) => isSourceEnabled(source, config));
			this.lastAggregatorFailure = undefined;
			this.pushToDashboard(cwd, items);
			return { items, failedSources };
		} catch (err) {
			// Aggregator itself threw (not just one source) — every source is
			// effectively unavailable. Reporting `failedSources: []` would
			// tell the webview "0 of N failed", which is indistinguishable
			// from a healthy-but-empty list and suppresses the partial-data
			// banner. Flag the full TRANSCRIPT_SOURCES set instead so the
			// user sees the broken state surfaced in the UI.
			const message = errMsg(err);
			if (this.lastAggregatorFailure !== message) {
				log.warn(
					"ActiveSessionsProvider",
					"listActiveConversations threw",
					message,
				);
				this.lastAggregatorFailure = message;
			}
			return { items: [], failedSources: [...TRANSCRIPT_SOURCES] };
		}
	}

	/**
	 * Fire-and-forget dashboard write (JOLLI-2069): project the sessions this
	 * tick surfaced into the local stats DB, in the extension host process.
	 *
	 * `recordSessionsFromTick` does its own gating (skips on Node without
	 * flag-free node:sqlite), its own change-filtering (only sessions whose
	 * `updatedAt` moved since the last write cost a transcript read), and never
	 * throws — so the sidebar render this piggybacks on can never be delayed or
	 * broken by it.
	 */
	private pushToDashboard(cwd: string, items: readonly ActiveConversationItem[]): void {
		const record = this.deps.recordDashboardSessions ?? recordSessionsFromTick;
		void record(
			cwd,
			items.map((item) => ({
				sessionId: item.sessionId,
				transcriptPath: item.transcriptPath,
				updatedAt: item.updatedAt,
				source: item.source,
				...(item.title ? { title: item.title } : {}),
			})),
		).catch(() => {
			// recordSessionsFromTick already swallows and logs its own failures;
			// this catch only guards against a defect in the seam itself.
		});
	}
}
