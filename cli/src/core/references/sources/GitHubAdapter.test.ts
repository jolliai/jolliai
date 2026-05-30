import { describe, expect, it } from "vitest";
import type { Reference } from "../../../Types.js";
import { GitHubAdapter } from "./GitHubAdapter.js";

// Real payload shape patterned after jolliai/jolli#959 (mcp__github__issue_read).
const ISSUE_959_PAYLOAD = {
	number: 959,
	title: "Refactor entity discovery pipeline",
	body: "## Problem\n\nGitHub bodies arrive HTML-entity-encoded: &lt;tag&gt; &amp; entities.",
	html_url: "https://github.com/jolliai/jolli/issues/959",
	state: "open",
	labels: ["bug", "p1"],
	assignees: ["alice", "bob"],
	milestone: { title: "v1.0" },
	issue_type: { name: "Bug" },
};

const ISSUE_960_PAYLOAD = {
	number: 960,
	title: "Second GitHub issue",
	html_url: "https://github.com/jolliai/jolli/issues/960",
	state: "closed",
};

describe("GitHubAdapter.extractRef", () => {
	const ts = "2026-05-27T00:00:00.000Z";
	const toolName = "mcp__github__issue_read";

	it("extracts the real #959 payload to an Reference", () => {
		const ref = GitHubAdapter.extractRef(ISSUE_959_PAYLOAD, toolName, ts);
		expect(ref).toMatchObject({
			mapKey: "github:jolliai/jolli#959",
			source: "github",
			nativeId: "jolliai/jolli#959",
			title: "Refactor entity discovery pipeline",
			url: "https://github.com/jolliai/jolli/issues/959",
			status: "open",
			labels: ["bug", "p1"],
			assignees: ["alice", "bob"],
			milestone: "v1.0",
			entityType: "Bug",
			toolName,
			referencedAt: ts,
		});
	});

	it("decodes HTML entities in the body into description", () => {
		const ref = GitHubAdapter.extractRef(ISSUE_959_PAYLOAD, toolName, ts);
		// &lt; → <, &gt; → >, &amp; → &
		expect(ref?.description).toContain("<tag>");
		expect(ref?.description).toContain("&");
		expect(ref?.description).not.toContain("&lt;");
		expect(ref?.description).not.toContain("&amp;");
	});

	it("does NOT include mapKey hash suffix — mapKey is bare github:owner/repo#n", () => {
		const ref = GitHubAdapter.extractRef(ISSUE_959_PAYLOAD, toolName, ts);
		// The hash suffix is appended only when computing a filesystem-safe filename
		// (sanitizeNativeIdForPath); the registry mapKey stays clean.
		expect(ref?.mapKey).toBe("github:jolliai/jolli#959");
		expect(ref?.mapKey).not.toMatch(/-[0-9a-f]{8}$/);
	});

	it("derives owner/repo from repository.full_name when html_url is non-canonical", () => {
		// Some tools (e.g. search_issues responses) include repository.full_name
		// even though html_url may point to a non-issue page or be elided.
		const payload = {
			number: 1,
			title: "From repository full_name",
			html_url: "https://github.com/some/redirect/path",
			repository: { full_name: "owner-alt/repo-alt" },
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		expect(ref?.nativeId).toBe("owner-alt/repo-alt#1");
	});

	it("falls back to html_url owner/repo when repository.full_name is malformed", () => {
		const payload = {
			number: 2,
			title: "Falls back via html_url",
			html_url: "https://github.com/octo/cat/issues/2",
			repository: { full_name: "missing-slash" }, // bad shape — fallback to html_url
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		expect(ref?.nativeId).toBe("octo/cat#2");
	});

	it("derives owner/repo from a pulls URL too (pull_request_read uses /pull/)", () => {
		const payload = {
			number: 42,
			title: "PR title",
			html_url: "https://github.com/octo/cat/pull/42",
		};
		const ref = GitHubAdapter.extractRef(payload, "mcp__github__pull_request_read", ts);
		expect(ref?.nativeId).toBe("octo/cat#42");
	});

	it("rejects payloads with non-integer / missing number", () => {
		expect(
			GitHubAdapter.extractRef(
				{ number: 1.5, title: "x", html_url: "https://github.com/o/r/issues/1" },
				toolName,
				ts,
			),
		).toBeNull();
		expect(
			GitHubAdapter.extractRef({ title: "x", html_url: "https://github.com/o/r/issues/1" }, toolName, ts),
		).toBeNull();
	});

	it("rejects payloads with missing/empty title", () => {
		expect(
			GitHubAdapter.extractRef(
				{ number: 1, title: "", html_url: "https://github.com/o/r/issues/1" },
				toolName,
				ts,
			),
		).toBeNull();
		expect(
			GitHubAdapter.extractRef({ number: 1, html_url: "https://github.com/o/r/issues/1" }, toolName, ts),
		).toBeNull();
	});

	it("rejects payloads with bad/missing html_url", () => {
		expect(GitHubAdapter.extractRef({ number: 1, title: "x", html_url: "ftp://x" }, toolName, ts)).toBeNull();
		expect(GitHubAdapter.extractRef({ number: 1, title: "x" }, toolName, ts)).toBeNull();
	});

	it("rejects payloads where owner/repo cannot be derived from html_url or repository", () => {
		const payload = {
			number: 1,
			title: "x",
			html_url: "https://github.com/", // missing owner/repo path
		};
		expect(GitHubAdapter.extractRef(payload, toolName, ts)).toBeNull();
	});

	it("ignores repository when full_name is not a string and falls back to html_url", () => {
		// Exercises the typeof-fullName-string false branch in deriveOwnerRepo
		// without rejecting the whole payload.
		const payload = {
			number: 13,
			title: "x",
			html_url: "https://github.com/o/r/issues/13",
			repository: { full_name: 42 },
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		expect(ref?.nativeId).toBe("o/r#13");
	});

	it("returns null for non-object payloads", () => {
		expect(GitHubAdapter.extractRef(null, toolName, ts)).toBeNull();
		expect(GitHubAdapter.extractRef([], toolName, ts)).toBeNull();
		expect(GitHubAdapter.extractRef("string", toolName, ts)).toBeNull();
		expect(GitHubAdapter.extractRef(42, toolName, ts)).toBeNull();
	});

	it("rejects payloads delivered under a non-GitHub tool name (defense-in-depth)", () => {
		expect(GitHubAdapter.extractRef(ISSUE_959_PAYLOAD, "mcp__linear__get_issue", ts)).toBeNull();
	});

	it("accepts milestone as a bare string", () => {
		const payload = {
			number: 5,
			title: "x",
			html_url: "https://github.com/o/r/issues/5",
			milestone: "v2.0",
		};
		expect(GitHubAdapter.extractRef(payload, toolName, ts)?.milestone).toBe("v2.0");
	});

	it("accepts issue_type as a bare string", () => {
		const payload = {
			number: 6,
			title: "x",
			html_url: "https://github.com/o/r/issues/6",
			issue_type: "Feature",
		};
		expect(GitHubAdapter.extractRef(payload, toolName, ts)?.entityType).toBe("Feature");
	});

	it("omits milestone/entityType when present but invalid shape", () => {
		const payload = {
			number: 7,
			title: "x",
			html_url: "https://github.com/o/r/issues/7",
			milestone: { other: "field" },
			issue_type: 42,
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		expect(ref?.milestone).toBeUndefined();
		expect(ref?.entityType).toBeUndefined();
	});

	it("filters non-string labels/assignees and drops the field entirely when empty", () => {
		const payload = {
			number: 8,
			title: "x",
			html_url: "https://github.com/o/r/issues/8",
			labels: ["good", 42, "", null],
			assignees: [null, ""],
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		expect(ref?.labels).toEqual(["good"]);
		expect(ref?.assignees).toBeUndefined();
	});

	it("omits status when state is empty/missing", () => {
		const payload = {
			number: 9,
			title: "x",
			html_url: "https://github.com/o/r/issues/9",
			state: "",
		};
		expect(GitHubAdapter.extractRef(payload, toolName, ts)?.status).toBeUndefined();
	});

	it("omits description when body is empty/missing", () => {
		const payload = {
			number: 10,
			title: "x",
			html_url: "https://github.com/o/r/issues/10",
			body: "",
		};
		expect(GitHubAdapter.extractRef(payload, toolName, ts)?.description).toBeUndefined();
	});
});

describe("GitHubAdapter.renderPromptBlock", () => {
	const ts = "2026-05-27T00:00:00.000Z";
	const toolName = "mcp__github__issue_read";

	it("emits <github-issues> wrapper with attrs", () => {
		const ref = GitHubAdapter.extractRef(ISSUE_959_PAYLOAD, toolName, ts);
		expect(ref).not.toBeNull();
		const out = GitHubAdapter.renderPromptBlock([ref as Reference]);
		expect(out).toContain("<github-issues>");
		expect(out).toContain("</github-issues>");
		expect(out).toContain('id="jolliai/jolli#959"');
		expect(out).toContain('status="open"');
		expect(out).toContain('labels="bug, p1"');
		expect(out).toContain('assignees="alice, bob"');
		expect(out).toContain('milestone="v1.0"');
		expect(out).toContain('entity-type="Bug"');
		expect(out).toContain("<title>Refactor entity discovery pipeline</title>");
	});

	it("returns empty string for empty input", () => {
		expect(GitHubAdapter.renderPromptBlock([])).toBe("");
	});

	it("respects maxCharsPerReference (description truncated)", () => {
		const payload = {
			number: 11,
			title: "x",
			html_url: "https://github.com/o/r/issues/11",
			body: "y".repeat(5000),
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		const out = GitHubAdapter.renderPromptBlock([ref as Reference], { maxCharsPerReference: 1000 });
		expect(out).toContain("…[truncated, ");
	});

	it("returns empty when nothing fits the budget", () => {
		const payload = {
			number: 12,
			title: "x",
			html_url: "https://github.com/o/r/issues/12",
			body: "y".repeat(5000),
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		expect(GitHubAdapter.renderPromptBlock([ref as Reference], { maxTotalChars: 10 })).toBe("");
	});

	it("sorts ascending by referencedAt with both included when total fits", () => {
		const older = GitHubAdapter.extractRef(ISSUE_959_PAYLOAD, toolName, "2026-01-01T00:00:00Z");
		const newer = GitHubAdapter.extractRef(ISSUE_960_PAYLOAD, toolName, "2026-05-01T00:00:00Z");
		const out = GitHubAdapter.renderPromptBlock([older as Reference, newer as Reference]);
		expect(out.indexOf('id="jolliai/jolli#959"')).toBeLessThan(out.indexOf('id="jolliai/jolli#960"'));
	});

	it("drops the oldest when budget forces a choice", () => {
		const olderPayload = {
			number: 100,
			title: "older",
			html_url: "https://github.com/o/r/issues/100",
			body: "a".repeat(500),
		};
		const newerPayload = {
			number: 101,
			title: "newer",
			html_url: "https://github.com/o/r/issues/101",
			body: "b".repeat(500),
		};
		const older = GitHubAdapter.extractRef(olderPayload, toolName, "2026-01-01T00:00:00Z");
		const newer = GitHubAdapter.extractRef(newerPayload, toolName, "2026-05-01T00:00:00Z");
		const out = GitHubAdapter.renderPromptBlock([older as Reference, newer as Reference], { maxTotalChars: 700 });
		expect(out).toContain('id="o/r#101"');
		expect(out).not.toContain('id="o/r#100"');
	});

	it("skips empty labels/assignees attrs (hand-built ref)", () => {
		const ref: Reference = {
			mapKey: "github:o/r#1",
			source: "github",
			nativeId: "o/r#1",
			title: "x",
			url: "https://github.com/o/r/issues/1",
			labels: [],
			assignees: [],
			toolName,
			referencedAt: ts,
		};
		const out = GitHubAdapter.renderPromptBlock([ref]);
		expect(out).not.toContain("labels=");
		expect(out).not.toContain("assignees=");
	});

	it("renders minimal ref (no optional attrs / no description)", () => {
		const payload = {
			number: 200,
			title: "Minimal",
			html_url: "https://github.com/o/r/issues/200",
		};
		const ref = GitHubAdapter.extractRef(payload, toolName, ts);
		const out = GitHubAdapter.renderPromptBlock([ref as Reference]);
		expect(out).toContain('<issue id="o/r#200">');
		expect(out).not.toContain("status=");
		expect(out).not.toContain("labels=");
		expect(out).not.toContain("assignees=");
		expect(out).not.toContain("milestone=");
		expect(out).not.toContain("entity-type=");
		expect(out).not.toContain("<description>");
	});
});

describe("GitHubAdapter metadata", () => {
	it("exposes id, mcpPrefix, wrapperKeys, maxCharsPerReference", () => {
		expect(GitHubAdapter.id).toBe("github");
		expect(GitHubAdapter.mcpPrefix).toBe("mcp__github__");
		expect(GitHubAdapter.wrapperKeys).toEqual(["items", "issues", "nodes", "results"]);
		expect(GitHubAdapter.maxCharsPerReference).toBe(4000);
	});
});
