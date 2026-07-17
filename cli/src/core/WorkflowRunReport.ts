/**
 * The enriched per-run workflow read model the host consumes off the run tools
 * (`get_run_status` / `list_workflow_runs`), plus a PURE shaper that turns one
 * run payload into a report-ready shape.
 *
 * The host constructs NO URL of its own: every openable URL is read verbatim off
 * the payload and the shaper opens exactly what the backend supplied. The shaper
 * is deliberately I/O-free — a payload in, a report out, no fetching, no spawning
 * — and never throws on a well-formed-but-sparse payload (a missing optional
 * field simply yields fewer openable URLs). The client's loud-fail read-methods
 * (which import these types type-only) own the transport/validation asymmetry.
 *
 * Openability is frozen: an article is openable ONLY when `active === true &&
 * url != null`. A freshly-created article resolves to `active:false, url:null`
 * until the backend reindexes; a deleted article is `active:false, url:null`.
 * The typed pull request is deliberately withheld for private Jolli-managed
 * destinations, so an absent PR is NORMAL — never an error, never fabricated.
 */

/**
 * The run's lifecycle status on the wire. Terminal values are `completed` /
 * `failed` / `cancelled`; `queued` / `active` are in-progress. NB the success
 * value is `completed`, NOT `succeeded` (`succeeded` is the shaper's presentation
 * label — see {@link shapeRunReport}); a terminal check keyed off `succeeded`
 * would silently never terminate.
 */
export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";

/** How a run was initiated. */
export type RunTrigger = "manual" | "schedule" | "event";

/** Where the run executed. An absent legacy value surfaces as `"server"`. */
export type RunExecutionMode = "server" | "local";

/** One entry per file a run wrote — the article-write manifest. */
export interface WorkflowRunWrittenArticle {
	/** The changeset op. */
	readonly operation: "created" | "edited" | "deleted";
	/** The document row id, present only when resolved. */
	readonly docId?: number;
	/** Cosmetic title, used as the openable-URL label when present. */
	readonly title?: string;
	/** Server/repo-relative path; always present. */
	readonly path: string;
	/**
	 * The share URL, populated ONLY for a still-active, docId-bearing article. A
	 * freshly-created (not-yet-reindexed) or deleted article is `null`. The host
	 * treats `null` as "not yet openable" and never fabricates one.
	 */
	readonly url: string | null;
	/** Whether the article currently exists. */
	readonly active: boolean;
}

/**
 * A typed pull-request reference. Present ONLY for a git-backed run that opened a
 * verified PR whose destination is NOT a private Jolli-managed repo — for those,
 * the field is omitted entirely (an absent PR is normal, never an error).
 */
export interface WorkflowRunPullRequest {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "merged" | "closed";
}

/**
 * The enriched per-run read model. `get_run_status` and `list_workflow_runs`
 * return this identical shape (the list is not a reduced subset). Only the fields
 * the host consumes are modeled: the wire additionally carries `outputSummary`
 * (declared but never populated — deliberately NOT modeled) and a `stats` object
 * (whose PR fields are stripped for private destinations — the host reads
 * `pullRequest`, not `stats`, so it is not modeled either).
 */
export interface WorkflowRunPayload {
	/** The run id. */
	readonly id: string;
	/** The parent workflow's numeric id. */
	readonly workflowId?: number;
	/** Run creation time (ISO) — the history timestamp. */
	readonly createdAt?: string;
	/** The lifecycle status. */
	readonly status: JobStatus;
	/** What initiated the run. */
	readonly triggeredBy?: RunTrigger;
	/** Where the run executed. */
	readonly executionMode?: RunExecutionMode;
	/** Lifecycle timestamps (ISO). */
	readonly startedAt?: string;
	readonly completedAt?: string;
	/**
	 * Failure only; format `code=<code>: <detail>` — the troubleshooting narrative
	 * for a failed run. The shaper reads this (NOT `outputSummary`) for a failed
	 * run's `troubleshooting`.
	 */
	readonly error?: string;
	/** Success only; `message` is the success narrative. Not populated on failure. */
	readonly completionInfo?: { readonly message: string };
	/** The article-write manifest. */
	readonly writtenArticles?: WorkflowRunWrittenArticle[];
	/** The typed PR reference (withheld for private Jolli-managed destinations). */
	readonly pullRequest?: WorkflowRunPullRequest;
	/** Absolute per-tenant deep-link to the workflow; omitted when the destination space is unresolvable. */
	readonly workflowUrl?: string;
	/** Absolute per-tenant deep-link to this run; omitted alongside `workflowUrl`. */
	readonly runUrl?: string;
	/** Resolved display name of the canceller; best-effort, absent unless a user cancelled. */
	readonly canceledBy?: string;
	/** When the run was cancelled (ISO). */
	readonly canceledAt?: string;
}

/** The report status presented to the developer (mapped from the wire {@link JobStatus}). */
export type ReportStatus = "succeeded" | "failed" | "cancelled" | "running";

/** One openable URL read verbatim off the payload. */
export interface OpenableUrl {
	readonly kind: "workflow" | "run" | "article" | "pr";
	readonly url: string;
	/** Optional human label (an article's title/path). */
	readonly label?: string;
}

/** The report-ready shape a run payload is projected into. */
export interface RunReport {
	readonly status: ReportStatus;
	readonly openableUrls: OpenableUrl[];
	/** Populated when a cancel attribution (`by` and/or `at`) is present. */
	readonly cancel?: { readonly by?: string; readonly at?: string };
	/** The `error` narrative for a failed run. */
	readonly troubleshooting?: string;
}

/**
 * The per-run history row printed by `jolli workflow-runs` — one flat,
 * agent-friendly projection per run. Derived entirely from {@link shapeRunReport}
 * (no re-derivation of URL selection): the report `status`, the workflow/run/PR
 * URLs re-bucketed by kind, and `articleUrls` = the active article URLs.
 * `prUrl` appears ONLY when the payload carried a `pullRequest` (never fabricated
 * for a withheld private Jolli-managed destination).
 */
export interface RunHistoryEntry {
	readonly runId: string;
	readonly status: ReportStatus;
	/** The run's `createdAt` (ISO) — the history timestamp; omitted when the payload lacked it. */
	readonly timestamp?: string;
	readonly workflowUrl?: string;
	readonly runUrl?: string;
	readonly prUrl?: string;
	readonly articleUrls: string[];
}

/**
 * Projects one enriched run payload into a flat {@link RunHistoryEntry} for the
 * history list. Reuses {@link shapeRunReport} for openable-URL selection (active-
 * only articles, withheld-PR handling) and merely re-buckets the result by `kind`
 * — it never re-implements which URLs are openable. Pure and total.
 */
export function shapeRunHistoryEntry(run: WorkflowRunPayload): RunHistoryEntry {
	const { status, openableUrls } = shapeRunReport(run);
	const urlOfKind = (kind: OpenableUrl["kind"]): string | undefined =>
		openableUrls.find((entry) => entry.kind === kind)?.url;
	const workflowUrl = urlOfKind("workflow");
	const runUrl = urlOfKind("run");
	const prUrl = urlOfKind("pr");
	const articleUrls = openableUrls.filter((entry) => entry.kind === "article").map((entry) => entry.url);
	return {
		runId: run.id,
		status,
		...(run.createdAt !== undefined && { timestamp: run.createdAt }),
		...(workflowUrl !== undefined && { workflowUrl }),
		...(runUrl !== undefined && { runUrl }),
		...(prUrl !== undefined && { prUrl }),
		articleUrls,
	};
}

/** Whether a wire status is terminal (`completed` / `failed` / `cancelled`). */
export function isTerminalStatus(status: JobStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Maps the wire {@link JobStatus} to the presentation {@link ReportStatus}:
 * `completed → succeeded`, `failed → failed`, `cancelled → cancelled`, and both
 * in-progress values (`queued` / `active`) → `running`.
 */
export function toReportStatus(status: JobStatus): ReportStatus {
	switch (status) {
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		default:
			return "running";
	}
}

/**
 * Projects one enriched run payload into a report-ready shape. Pure: no fetching,
 * no spawning, and never throws on a well-formed-but-sparse payload.
 *
 * openableUrls composition (order: workflow, run, articles, pr):
 * - `workflowUrl` / `runUrl` — each only when present.
 * - one `article` URL per manifest entry ONLY when `active === true && url != null`
 *   (labelled by the entry's `title`, falling back to its `path`).
 * - `pullRequest.url` ONLY when `pullRequest` is present (never fabricated).
 *
 * `cancel` is populated when either `canceledBy` or `canceledAt` is present.
 * `troubleshooting` is the `error` string for a `failed` run.
 */
export function shapeRunReport(run: WorkflowRunPayload): RunReport {
	const status = toReportStatus(run.status);
	const openableUrls: OpenableUrl[] = [];
	if (run.workflowUrl !== undefined) {
		openableUrls.push({ kind: "workflow", url: run.workflowUrl });
	}
	if (run.runUrl !== undefined) {
		openableUrls.push({ kind: "run", url: run.runUrl });
	}
	for (const article of run.writtenArticles ?? []) {
		if (article.active && article.url != null) {
			openableUrls.push({ kind: "article", url: article.url, label: article.title ?? article.path });
		}
	}
	if (run.pullRequest !== undefined) {
		openableUrls.push({ kind: "pr", url: run.pullRequest.url });
	}
	const report: RunReport = { status, openableUrls };
	const cancel = shapeCancel(run);
	const troubleshooting = status === "failed" ? run.error : undefined;
	return {
		...report,
		...(cancel !== undefined && { cancel }),
		...(troubleshooting !== undefined && { troubleshooting }),
	};
}

/** The cancel attribution when either `canceledBy` or `canceledAt` is present, else undefined. */
function shapeCancel(run: WorkflowRunPayload): { by?: string; at?: string } | undefined {
	if (run.canceledBy === undefined && run.canceledAt === undefined) {
		return undefined;
	}
	return {
		...(run.canceledBy !== undefined && { by: run.canceledBy }),
		...(run.canceledAt !== undefined && { at: run.canceledAt }),
	};
}
