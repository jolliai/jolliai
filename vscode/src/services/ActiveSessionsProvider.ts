import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { listActiveConversationsWithDiagnostics } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { errMsg } from "../../../cli/src/Logger.js";
import {
	TRANSCRIPT_SOURCES,
	type TranscriptSource,
} from "../../../cli/src/Types.js";
import { log } from "../util/Logger.js";

export interface ActiveSessionsDeps {
	/** Returns the absolute path of the current workspace root, or undefined. */
	readonly getWorkspaceCwd: () => string | undefined;
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
	 * use `failedSources` to render a "2 of 7 sources unavailable" hint
	 * instead of silently presenting an incomplete list.
	 */
	async listWithDiagnostics(): Promise<{
		readonly items: readonly ActiveConversationItem[];
		readonly failedSources: readonly TranscriptSource[];
	}> {
		const cwd = this.deps.getWorkspaceCwd();
		if (!cwd) return { items: [], failedSources: [] };
		try {
			const result = await listActiveConversationsWithDiagnostics({
				cwd,
				windowMs: WINDOW_MS,
			});
			this.lastAggregatorFailure = undefined;
			return result;
		} catch (err) {
			// Aggregator itself threw (not just one source) — every source is
			// effectively unavailable. Reporting `failedSources: []` would
			// tell the webview "0 of 7 failed", which is indistinguishable
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
}
