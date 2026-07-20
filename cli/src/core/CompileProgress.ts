/**
 * CompileProgress — structured progress payload emitted by the compile pipeline
 * alongside the legacy `onProgress(message)` string ticks. Consumers (VS Code
 * notification, desktop cockpit) that want to i18n or color-code the phase
 * don't have to parse the pre-formatted string back apart.
 *
 * Keep the phase set closed and short: every new phase means every UI surface
 * writes new copy in every locale. The initial set matches the top-level
 * `<label> — <repo>` lines the string emitter already produces.
 */

export interface CompileProgressEvent {
	/**
	 * Which top-level phase this tick belongs to. `wiki` covers the whole
	 * ingest + wiki-render arc — the batch counter rides on this same phase
	 * as `detail: 'batch N'`, not a separate phase, so a UI can render it as
	 * an in-place update.
	 */
	readonly phase: "wiki" | "graph" | "search-index";
	/**
	 * The repo the tick is about. For the sweep this is the repo folder under
	 * the Memory Bank; for single-repo compile it's the working directory.
	 * Present on every tick so a multi-repo UI can group by repo without
	 * threading the target through a side channel.
	 */
	readonly repo: string;
	/**
	 * Optional sub-progress detail — e.g. `batch 3` for the wiki phase's
	 * ingest counter, or the graph distiller's per-category progress.
	 * Absent on the initial phase-start tick.
	 */
	readonly detail?: string;
	/**
	 * When the tick came from a batch counter, the 1-based batch index. Split
	 * out so a UI can render "batch 3" as a number without regex-parsing the
	 * `detail` string. Undefined for non-batch ticks.
	 */
	readonly batchIndex?: number;
}

/** Maps a structured phase to its human label. Shared by the single- and
 *  multi-repo compile orchestrators so string- and struct-consuming UIs stay in
 *  lockstep on copy changes. */
export function phaseLabel(phase: CompileProgressEvent["phase"]): string {
	switch (phase) {
		case "wiki":
			return "Building knowledge wiki";
		case "graph":
			return "Building knowledge graph";
		case "search-index":
			return "Warming search index";
	}
}

/** True when `err` is a Web-standard AbortError — a caller cancel surfaced by
 *  `drainIngest`, a signal check, or `LlmClient` (which normalises the SDK's
 *  APIUserAbortError to this shape). `DOMException` is `instanceof Error` on the
 *  supported Node versions. */
export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}
