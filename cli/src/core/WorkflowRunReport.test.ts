import { describe, expect, it } from "vitest";
import {
	isTerminalStatus,
	type JobStatus,
	shapeRunHistoryEntry,
	shapeRunReport,
	toReportStatus,
	type WorkflowRunPayload,
} from "./WorkflowRunReport.js";

/** A minimal valid run; spread over per-case overrides. */
function run(overrides: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload {
	return { id: "run-1", status: "completed", ...overrides };
}

describe("isTerminalStatus", () => {
	it.each<[JobStatus, boolean]>([
		["completed", true],
		["failed", true],
		["cancelled", true],
		["queued", false],
		["active", false],
	])("%s → %s", (status, terminal) => {
		expect(isTerminalStatus(status)).toBe(terminal);
	});
});

describe("toReportStatus", () => {
	it.each<[JobStatus, string]>([
		["completed", "succeeded"],
		["failed", "failed"],
		["cancelled", "cancelled"],
		["queued", "running"],
		["active", "running"],
	])("%s → %s", (wire, report) => {
		expect(toReportStatus(wire)).toBe(report);
	});
});

describe("shapeRunReport", () => {
	it("succeeded: 2 active + 1 created(url:null) + 1 deleted article ⇒ 2 article URLs + workflow/run URLs", () => {
		const report = shapeRunReport(
			run({
				status: "completed",
				workflowUrl: "https://jolli.ai/w/7",
				runUrl: "https://jolli.ai/w/7/r/run-1",
				writtenArticles: [
					{ operation: "edited", path: "a.md", title: "Alpha", url: "https://jolli.ai/a", active: true },
					{ operation: "edited", path: "b.md", url: "https://jolli.ai/b", active: true },
					{ operation: "created", path: "c.md", url: null, active: false }, // freshly created, not yet reindexed
					{ operation: "deleted", path: "d.md", url: null, active: false },
				],
			}),
		);
		expect(report.status).toBe("succeeded");
		expect(report.openableUrls).toEqual([
			{ kind: "workflow", url: "https://jolli.ai/w/7" },
			{ kind: "run", url: "https://jolli.ai/w/7/r/run-1" },
			{ kind: "article", url: "https://jolli.ai/a", label: "Alpha" }, // label from title
			{ kind: "article", url: "https://jolli.ai/b", label: "b.md" }, // label falls back to path
		]);
		expect(report.cancel).toBeUndefined();
		expect(report.troubleshooting).toBeUndefined();
	});

	it("excludes an article that is active but has a null url", () => {
		const report = shapeRunReport(
			run({ writtenArticles: [{ operation: "created", path: "x.md", url: null, active: true }] }),
		);
		expect(report.openableUrls).toEqual([]);
	});

	it("git-backed succeeded with a pullRequest ⇒ PR URL included", () => {
		const report = shapeRunReport(
			run({
				workflowUrl: "https://jolli.ai/w/7",
				pullRequest: { number: 5, url: "https://gh/pr/5", state: "open" },
			}),
		);
		expect(report.openableUrls).toEqual([
			{ kind: "workflow", url: "https://jolli.ai/w/7" },
			{ kind: "pr", url: "https://gh/pr/5" },
		]);
	});

	it("private jolli-git withheld (no pullRequest) ⇒ article URLs only, never a PR", () => {
		const report = shapeRunReport(
			run({
				workflowUrl: "https://jolli.ai/w/7",
				writtenArticles: [{ operation: "edited", path: "a.md", url: "https://jolli.ai/a", active: true }],
			}),
		);
		expect(report.openableUrls.some((u) => u.kind === "pr")).toBe(false);
		expect(report.openableUrls).toEqual([
			{ kind: "workflow", url: "https://jolli.ai/w/7" },
			{ kind: "article", url: "https://jolli.ai/a", label: "a.md" },
		]);
	});

	it("failed ⇒ troubleshooting from error + workflow URL, no run/article/pr", () => {
		const report = shapeRunReport(
			run({ status: "failed", error: "code=TIMEOUT: run exceeded budget", workflowUrl: "https://jolli.ai/w/7" }),
		);
		expect(report.status).toBe("failed");
		expect(report.troubleshooting).toBe("code=TIMEOUT: run exceeded budget");
		expect(report.openableUrls).toEqual([{ kind: "workflow", url: "https://jolli.ai/w/7" }]);
	});

	it("failed without an error string ⇒ no troubleshooting field", () => {
		const report = shapeRunReport(run({ status: "failed" }));
		expect(report.status).toBe("failed");
		expect(report.troubleshooting).toBeUndefined();
	});

	it("does not surface troubleshooting for a non-failed run even if error is present", () => {
		const report = shapeRunReport(run({ status: "completed", error: "stray error" }));
		expect(report.status).toBe("succeeded");
		expect(report.troubleshooting).toBeUndefined();
	});

	it("cancelled ⇒ cancel { by, at } + workflow URL", () => {
		const report = shapeRunReport(
			run({
				status: "cancelled",
				canceledBy: "Dev",
				canceledAt: "2026-07-16T00:00:05Z",
				workflowUrl: "https://jolli.ai/w/7",
			}),
		);
		expect(report.status).toBe("cancelled");
		expect(report.cancel).toEqual({ by: "Dev", at: "2026-07-16T00:00:05Z" });
	});

	it("cancel is populated from canceledBy alone", () => {
		expect(shapeRunReport(run({ status: "cancelled", canceledBy: "Dev" })).cancel).toEqual({ by: "Dev" });
	});

	it("cancel is populated from canceledAt alone", () => {
		expect(shapeRunReport(run({ status: "cancelled", canceledAt: "2026-07-16T00:00:05Z" })).cancel).toEqual({
			at: "2026-07-16T00:00:05Z",
		});
	});

	it("running ⇒ status running; a sparse payload yields no openable URLs and never throws", () => {
		const report = shapeRunReport(run({ status: "active" }));
		expect(report.status).toBe("running");
		expect(report.openableUrls).toEqual([]);
		expect(report.cancel).toBeUndefined();
		expect(report.troubleshooting).toBeUndefined();
	});

	it("emits a run URL without a workflow URL when only runUrl is present", () => {
		const report = shapeRunReport(run({ status: "queued", runUrl: "https://jolli.ai/w/7/r/run-1" }));
		expect(report.openableUrls).toEqual([{ kind: "run", url: "https://jolli.ai/w/7/r/run-1" }]);
	});
});

describe("shapeRunHistoryEntry", () => {
	it("succeeded git-backed run ⇒ status, timestamp, workflow/run/PR URLs, and active article URLs", () => {
		const entry = shapeRunHistoryEntry(
			run({
				id: "r7",
				status: "completed",
				createdAt: "2026-07-17T10:00:00Z",
				workflowUrl: "https://jolli.ai/w/7",
				runUrl: "https://jolli.ai/w/7/r/r7",
				pullRequest: { number: 5, url: "https://gh/pr/5", state: "open" },
				writtenArticles: [
					{ operation: "edited", path: "a.md", title: "Alpha", url: "https://jolli.ai/a", active: true },
					{ operation: "created", path: "b.md", url: null, active: false }, // not yet reindexed
				],
			}),
		);
		expect(entry).toEqual({
			runId: "r7",
			status: "succeeded",
			timestamp: "2026-07-17T10:00:00Z",
			workflowUrl: "https://jolli.ai/w/7",
			runUrl: "https://jolli.ai/w/7/r/r7",
			prUrl: "https://gh/pr/5",
			articleUrls: ["https://jolli.ai/a"],
		});
	});

	it("private jolli-git withheld run ⇒ article URLs only, never a prUrl", () => {
		const entry = shapeRunHistoryEntry(
			run({
				id: "r8",
				status: "completed",
				createdAt: "2026-07-17T11:00:00Z",
				workflowUrl: "https://jolli.ai/w/7",
				writtenArticles: [{ operation: "edited", path: "a.md", url: "https://jolli.ai/a", active: true }],
			}),
		);
		expect(entry.prUrl).toBeUndefined();
		expect(entry).toEqual({
			runId: "r8",
			status: "succeeded",
			timestamp: "2026-07-17T11:00:00Z",
			workflowUrl: "https://jolli.ai/w/7",
			articleUrls: ["https://jolli.ai/a"],
		});
	});

	it("failed run ⇒ failed status with no article/PR URLs", () => {
		const entry = shapeRunHistoryEntry(
			run({ id: "r9", status: "failed", createdAt: "2026-07-17T12:00:00Z", error: "code=TIMEOUT: x" }),
		);
		expect(entry).toEqual({ runId: "r9", status: "failed", timestamp: "2026-07-17T12:00:00Z", articleUrls: [] });
	});

	it("cancelled run ⇒ cancelled status (cancel attribution is not part of the history row)", () => {
		const entry = shapeRunHistoryEntry(
			run({ id: "r10", status: "cancelled", createdAt: "2026-07-17T13:00:00Z", canceledBy: "Dev" }),
		);
		expect(entry).toEqual({
			runId: "r10",
			status: "cancelled",
			timestamp: "2026-07-17T13:00:00Z",
			articleUrls: [],
		});
	});

	it("omits timestamp when the payload lacked createdAt; sparse running row has an empty articleUrls", () => {
		const entry = shapeRunHistoryEntry(run({ id: "r11", status: "active" }));
		expect(entry).toEqual({ runId: "r11", status: "running", articleUrls: [] });
		expect(entry.timestamp).toBeUndefined();
	});
});
