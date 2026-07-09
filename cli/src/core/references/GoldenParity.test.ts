/**
 * GoldenParity — proves `SourceEngine` + the 4 built-in `SourceDefinition`s
 * reproduce the pre-migration adapters' `extractRef` / `renderPromptBlock`
 * output byte-for-byte.
 *
 * Every `GOLDEN_*` constant below is a plain, hand-computed literal (built
 * from deterministic string ops like `"x".repeat(n)`, never by calling the
 * engine) — the acceptance gate. The `describe` blocks assert `SourceEngine`
 * output against these literals. The literals were originally proven against
 * the pre-migration adapters (Linear/Jira/GitHub/NotionAdapter) in a since-
 * deleted block at the bottom of this file, before those adapters themselves
 * were deleted; the golden values themselves are unchanged.
 *
 * Any mismatch here is a `SourceDefinition` bug: fix the definition, never
 * loosen an assertion.
 */

import { describe, expect, it } from "vitest";
import type { Reference } from "../../Types.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import { extractRef, renderBlock } from "./SourceEngine.js";
import { githubDefinition } from "./sources/definitions/github.js";
import { jiraDefinition } from "./sources/definitions/jira.js";
import { linearDefinition } from "./sources/definitions/linear.js";
import { notionDefinition } from "./sources/definitions/notion.js";
import { slackDefinition } from "./sources/definitions/slack.js";

const ts = "2026-05-27T00:00:00.000Z";
const tsOld = "2026-01-01T00:00:00Z";
const tsNew = "2026-05-01T00:00:00Z";

const A500 = "a".repeat(500);
const B500 = "b".repeat(500);
const X5000 = "x".repeat(5000);
const A35000 = "a".repeat(35000);
const B35000 = "b".repeat(35000);

/** Build a definition variant with different render budgets, for exercising renderBlock's shared truncate/sort algorithm. */
function withBudget(def: SourceDefinition, maxCharsPerReference: number, maxTotalChars: number): SourceDefinition {
	return { ...def, render: { ...def.render, maxCharsPerReference, maxTotalChars } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear
// ─────────────────────────────────────────────────────────────────────────────

describe("GoldenParity: linear", () => {
	const tool = "mcp__linear__get_issue";

	const HAPPY_PAYLOAD = {
		id: "PROJ-1234",
		title: "Sample",
		url: "https://linear.app/x/issue/PROJ-1234",
		status: "In Progress",
		priority: "High",
		labels: ["bug"],
		description: "Body",
	};
	const GOLDEN_HAPPY_REF: Reference = {
		mapKey: "linear:PROJ-1234",
		source: "linear",
		nativeId: "PROJ-1234",
		title: "Sample",
		url: "https://linear.app/x/issue/PROJ-1234",
		fields: [
			{ key: "status", label: "Status", value: "In Progress", icon: "circle-large-filled" },
			{ key: "priority", label: "Priority", value: "High", icon: "flame" },
			{ key: "labels", label: "Labels", value: "bug", icon: "tag" },
		],
		description: "Body",
		toolName: tool,
		referencedAt: ts,
	};
	const GOLDEN_HAPPY_XML =
		'<linear-issues>\n<issue id="PROJ-1234" status="In Progress" priority="High" labels="bug">\n  <title>Sample</title>\n  <url>https://linear.app/x/issue/PROJ-1234</url>\n  <description>\nBody\n  </description>\n</issue>\n</linear-issues>';

	it("extracts and renders the happy path", () => {
		const ref = extractRef(linearDefinition, HAPPY_PAYLOAD, tool, ts);
		expect(ref).toEqual(GOLDEN_HAPPY_REF);
		expect(renderBlock(linearDefinition, [ref as Reference])).toBe(GOLDEN_HAPPY_XML);
	});

	it("voids on a non-ticket-shaped id", () => {
		expect(extractRef(linearDefinition, { id: "not-a-ticket", title: "x", url: "https://x" }, tool, ts)).toBeNull();
	});

	it("voids on missing title", () => {
		expect(extractRef(linearDefinition, { id: "PROJ-1", url: "https://x" }, tool, ts)).toBeNull();
	});

	it("voids on a non-http(s) url", () => {
		expect(extractRef(linearDefinition, { id: "PROJ-1", title: "x", url: "javascript:1" }, tool, ts)).toBeNull();
	});

	it("omits priority when present as a bare number (adapter required string-or-{name})", () => {
		const ref = extractRef(
			linearDefinition,
			{ id: "PROJ-1", title: "x", url: "https://x", priority: 42 },
			tool,
			ts,
		);
		expect(ref?.fields?.find((f) => f.key === "priority")).toBeUndefined();
	});

	it("renders a minimal ref with no fields/description", () => {
		const payload = { id: "PROJ-1", title: "Minimal", url: "https://x.example" };
		const golden: Reference = {
			mapKey: "linear:PROJ-1",
			source: "linear",
			nativeId: "PROJ-1",
			title: "Minimal",
			url: "https://x.example",
			toolName: tool,
			referencedAt: ts,
		};
		const ref = extractRef(linearDefinition, payload, tool, ts);
		expect(ref).toEqual(golden);
		expect(renderBlock(linearDefinition, [ref as Reference])).toBe(
			'<linear-issues>\n<issue id="PROJ-1">\n  <title>Minimal</title>\n  <url>https://x.example</url>\n</issue>\n</linear-issues>',
		);
	});

	it("sorts ascending by referencedAt when both entries fit the budget", () => {
		const olderRef = extractRef(
			linearDefinition,
			{ id: "PROJ-1", title: "older", url: "https://x.example" },
			tool,
			tsOld,
		);
		const newerRef = extractRef(
			linearDefinition,
			{ id: "PROJ-2", title: "newer", url: "https://x.example" },
			tool,
			tsNew,
		);
		expect(renderBlock(linearDefinition, [olderRef as Reference, newerRef as Reference])).toBe(
			'<linear-issues>\n<issue id="PROJ-1">\n  <title>older</title>\n  <url>https://x.example</url>\n</issue>\n<issue id="PROJ-2">\n  <title>newer</title>\n  <url>https://x.example</url>\n</issue>\n</linear-issues>',
		);
	});

	it("drops the oldest entry when the total budget forces a choice", () => {
		const olderRef = extractRef(
			linearDefinition,
			{ id: "PROJ-1", title: "older", url: "https://x.example", description: A500 },
			tool,
			tsOld,
		);
		const newerRef = extractRef(
			linearDefinition,
			{ id: "PROJ-2", title: "newer", url: "https://x.example", description: B500 },
			tool,
			tsNew,
		);
		const variant = withBudget(linearDefinition, 4000, 700);
		expect(renderBlock(variant, [olderRef as Reference, newerRef as Reference])).toBe(
			`<linear-issues>\n<issue id="PROJ-2">\n  <title>newer</title>\n  <url>https://x.example</url>\n  <description>\n${B500}\n  </description>\n</issue>\n</linear-issues>`,
		);
	});

	it("truncates a description longer than maxCharsPerReference", () => {
		const ref = extractRef(
			linearDefinition,
			{ id: "PROJ-9", title: "T", url: "https://x.example", description: X5000 },
			tool,
			ts,
		);
		const variant = withBudget(linearDefinition, 1000, 30000);
		expect(renderBlock(variant, [ref as Reference])).toBe(
			`<linear-issues>\n<issue id="PROJ-9">\n  <title>T</title>\n  <url>https://x.example</url>\n  <description>\n${"x".repeat(1000)}\n…[truncated, 4000 more chars]\n  </description>\n</issue>\n</linear-issues>`,
		);
	});

	it("renders an empty string for no refs", () => {
		expect(renderBlock(linearDefinition, [])).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Jira
// ─────────────────────────────────────────────────────────────────────────────

describe("GoldenParity: jira", () => {
	const tool = "mcp__claude_ai_Atlassian__getJiraIssue";

	const KAN_4_PAYLOAD = {
		id: "10003",
		key: "KAN-4",
		fields: {
			summary: "Wire up Jira auto-discovery",
			status: { name: "To Do" },
			priority: { name: "Medium" },
			labels: ["JolliMemory", "Feature"],
			description: "## Body\n\nJira issues from the Atlassian MCP server.",
		},
		webUrl: "https://example.atlassian.net/browse/KAN-4",
	};
	const GOLDEN_KAN_4_REF: Reference = {
		mapKey: "jira:KAN-4",
		source: "jira",
		nativeId: "KAN-4",
		title: "Wire up Jira auto-discovery",
		url: "https://example.atlassian.net/browse/KAN-4",
		fields: [
			{ key: "status", label: "Status", value: "To Do", icon: "circle-large-filled" },
			{ key: "priority", label: "Priority", value: "Medium", icon: "flame" },
			{ key: "labels", label: "Labels", value: "JolliMemory, Feature", icon: "tag" },
		],
		description: "## Body\n\nJira issues from the Atlassian MCP server.",
		toolName: tool,
		referencedAt: ts,
	};
	const GOLDEN_KAN_4_XML =
		'<jira-issues>\n<issue id="KAN-4" status="To Do" priority="Medium" labels="JolliMemory, Feature">\n  <title>Wire up Jira auto-discovery</title>\n  <url>https://example.atlassian.net/browse/KAN-4</url>\n  <description>\n## Body\n\nJira issues from the Atlassian MCP server.\n  </description>\n</issue>\n</jira-issues>';

	it("extracts and renders the real KAN-4 payload", () => {
		const ref = extractRef(jiraDefinition, KAN_4_PAYLOAD, tool, ts);
		expect(ref).toEqual(GOLDEN_KAN_4_REF);
		expect(renderBlock(jiraDefinition, [ref as Reference])).toBe(GOLDEN_KAN_4_XML);
	});

	it("voids on a non-key-shaped key", () => {
		expect(
			extractRef(
				jiraDefinition,
				{ key: "not-a-key", fields: { summary: "x" }, webUrl: "https://example.atlassian.net/browse/x" },
				tool,
				ts,
			),
		).toBeNull();
	});

	it("voids when the fields object is entirely missing (title path naturally fails)", () => {
		expect(
			extractRef(jiraDefinition, { key: "X-1", webUrl: "https://example.atlassian.net/browse/X-1" }, tool, ts),
		).toBeNull();
	});

	it("voids on missing/empty summary", () => {
		expect(
			extractRef(
				jiraDefinition,
				{ key: "KAN-1", fields: { summary: "" }, webUrl: "https://example.atlassian.net/browse/KAN-1" },
				tool,
				ts,
			),
		).toBeNull();
	});

	it("omits status/priority when present as a bare number (adapter dropped non-string/non-{name})", () => {
		// Ported from the deleted JiraAdapter "omits status/priority when the field has
		// neither object.name nor string value" case (priority: 42).
		const payload = {
			key: "KAN-9",
			fields: { summary: "x", status: 7, priority: 42 },
			webUrl: "https://example.atlassian.net/browse/KAN-9",
		};
		const ref = extractRef(jiraDefinition, payload, tool, ts);
		expect(ref?.fields?.find((f) => f.key === "status")).toBeUndefined();
		expect(ref?.fields?.find((f) => f.key === "priority")).toBeUndefined();
	});

	it("renders a minimal ref with no fields/description", () => {
		const payload = {
			key: "KAN-300",
			fields: { summary: "Minimal" },
			webUrl: "https://example.atlassian.net/browse/KAN-300",
		};
		const ref = extractRef(jiraDefinition, payload, tool, ts);
		expect(ref).toEqual({
			mapKey: "jira:KAN-300",
			source: "jira",
			nativeId: "KAN-300",
			title: "Minimal",
			url: "https://example.atlassian.net/browse/KAN-300",
			toolName: tool,
			referencedAt: ts,
		});
		expect(renderBlock(jiraDefinition, [ref as Reference])).toBe(
			'<jira-issues>\n<issue id="KAN-300">\n  <title>Minimal</title>\n  <url>https://example.atlassian.net/browse/KAN-300</url>\n</issue>\n</jira-issues>',
		);
	});

	it("sorts ascending by referencedAt when both entries fit the budget", () => {
		const olderRef = extractRef(jiraDefinition, KAN_4_PAYLOAD, tool, tsOld);
		const newerRef = extractRef(
			jiraDefinition,
			{
				key: "KAN-5",
				fields: { summary: "Second Jira ticket", status: { name: "In Progress" } },
				webUrl: "https://example.atlassian.net/browse/KAN-5",
			},
			tool,
			tsNew,
		);
		expect(renderBlock(jiraDefinition, [olderRef as Reference, newerRef as Reference])).toBe(
			`${GOLDEN_KAN_4_XML.slice(0, -"</jira-issues>".length)}<issue id="KAN-5" status="In Progress">\n  <title>Second Jira ticket</title>\n  <url>https://example.atlassian.net/browse/KAN-5</url>\n</issue>\n</jira-issues>`,
		);
	});

	it("drops the oldest entry when the total budget forces a choice", () => {
		const olderRef = extractRef(
			jiraDefinition,
			{
				key: "KAN-100",
				fields: { summary: "older", description: A500 },
				webUrl: "https://example.atlassian.net/browse/KAN-100",
			},
			tool,
			tsOld,
		);
		const newerRef = extractRef(
			jiraDefinition,
			{
				key: "KAN-101",
				fields: { summary: "newer", description: B500 },
				webUrl: "https://example.atlassian.net/browse/KAN-101",
			},
			tool,
			tsNew,
		);
		const variant = withBudget(jiraDefinition, 4000, 700);
		expect(renderBlock(variant, [olderRef as Reference, newerRef as Reference])).toBe(
			`<jira-issues>\n<issue id="KAN-101">\n  <title>newer</title>\n  <url>https://example.atlassian.net/browse/KAN-101</url>\n  <description>\n${B500}\n  </description>\n</issue>\n</jira-issues>`,
		);
	});

	it("renders an empty string for no refs", () => {
		expect(renderBlock(jiraDefinition, [])).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GitHub
// ─────────────────────────────────────────────────────────────────────────────

describe("GoldenParity: github", () => {
	const tool = "mcp__github__issue_read";

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
	const GOLDEN_959_REF: Reference = {
		mapKey: "github:jolliai/jolli#959",
		source: "github",
		nativeId: "jolliai/jolli#959",
		title: "Refactor entity discovery pipeline",
		url: "https://github.com/jolliai/jolli/issues/959",
		fields: [
			{ key: "status", label: "Status", value: "open", icon: "circle-large-filled" },
			{ key: "labels", label: "Labels", value: "bug, p1", icon: "tag" },
			{ key: "assignees", label: "Assignees", value: "alice, bob", icon: "account" },
			{ key: "milestone", label: "Milestone", value: "v1.0", icon: "milestone" },
			{ key: "entity-type", label: "Type", value: "Bug", icon: "symbol-class" },
		],
		description: "## Problem\n\nGitHub bodies arrive HTML-entity-encoded: <tag> & entities.",
		toolName: tool,
		referencedAt: ts,
	};
	const GOLDEN_959_XML =
		'<github-issues>\n<issue id="jolliai/jolli#959" status="open" labels="bug, p1" assignees="alice, bob" milestone="v1.0" entity-type="Bug">\n  <title>Refactor entity discovery pipeline</title>\n  <url>https://github.com/jolliai/jolli/issues/959</url>\n  <description>\n## Problem\n\nGitHub bodies arrive HTML-entity-encoded: &lt;tag&gt; &amp; entities.\n  </description>\n</issue>\n</github-issues>';

	it("extracts and renders the real #959 payload, decoding HTML entities in the body", () => {
		const ref = extractRef(githubDefinition, ISSUE_959_PAYLOAD, tool, ts);
		expect(ref).toEqual(GOLDEN_959_REF);
		expect(renderBlock(githubDefinition, [ref as Reference])).toBe(GOLDEN_959_XML);
	});

	it("voids when number is missing, even though html_url carries a numeric path segment", () => {
		// This is the case the design brief's URL-derived `number` fallback would
		// have gotten wrong: the adapter's upfront `typeof number !== "number"`
		// gate never looks at the URL, so a payload with a valid /issues/<n> url
		// but no top-level `number` is void. The definition intentionally omits a
		// URL fallback for `number` (see github.ts) to preserve this.
		expect(
			extractRef(githubDefinition, { title: "x", html_url: "https://github.com/o/r/issues/1" }, tool, ts),
		).toBeNull();
	});

	it("voids on a non-integer number", () => {
		expect(
			extractRef(
				githubDefinition,
				{ number: 1.5, title: "x", html_url: "https://github.com/o/r/issues/1" },
				tool,
				ts,
			),
		).toBeNull();
	});

	it("voids on a bad html_url", () => {
		expect(extractRef(githubDefinition, { number: 1, title: "x", html_url: "ftp://x" }, tool, ts)).toBeNull();
	});

	it("omits milestone/entity-type when present as a bare number (adapter dropped non-string/non-{name})", () => {
		// Ported from the deleted GitHubAdapter "omits … when present but invalid shape"
		// case (issue_type: 42). A numeric field must be dropped, not stringified to "42".
		const payload = {
			number: 5,
			title: "x",
			html_url: "https://github.com/o/r/issues/5",
			milestone: 5,
			issue_type: 42,
		};
		const ref = extractRef(githubDefinition, payload, tool, ts);
		expect(ref?.fields?.find((f) => f.key === "milestone")).toBeUndefined();
		expect(ref?.fields?.find((f) => f.key === "entity-type")).toBeUndefined();
	});

	it("derives owner/repo from repository.full_name when present", () => {
		const payload = {
			number: 1,
			title: "From repository full_name",
			html_url: "https://github.com/some/redirect/path",
			repository: { full_name: "owner-alt/repo-alt" },
		};
		expect(extractRef(githubDefinition, payload, tool, ts)).toEqual({
			mapKey: "github:owner-alt/repo-alt#1",
			source: "github",
			nativeId: "owner-alt/repo-alt#1",
			title: "From repository full_name",
			url: "https://github.com/some/redirect/path",
			toolName: tool,
			referencedAt: ts,
		});
	});

	it("falls back to html_url when repository.full_name is malformed", () => {
		const payload = {
			number: 2,
			title: "Falls back via html_url",
			html_url: "https://github.com/octo/cat/issues/2",
			repository: { full_name: "missing-slash" },
		};
		expect(extractRef(githubDefinition, payload, tool, ts)).toEqual({
			mapKey: "github:octo/cat#2",
			source: "github",
			nativeId: "octo/cat#2",
			title: "Falls back via html_url",
			url: "https://github.com/octo/cat/issues/2",
			toolName: tool,
			referencedAt: ts,
		});
	});

	it("renders a minimal ref with no fields/description", () => {
		const payload = { number: 200, title: "Minimal", html_url: "https://github.com/o/r/issues/200" };
		const ref = extractRef(githubDefinition, payload, tool, ts);
		expect(ref).toEqual({
			mapKey: "github:o/r#200",
			source: "github",
			nativeId: "o/r#200",
			title: "Minimal",
			url: "https://github.com/o/r/issues/200",
			toolName: tool,
			referencedAt: ts,
		});
		expect(renderBlock(githubDefinition, [ref as Reference])).toBe(
			'<github-issues>\n<issue id="o/r#200">\n  <title>Minimal</title>\n  <url>https://github.com/o/r/issues/200</url>\n</issue>\n</github-issues>',
		);
	});

	it("sorts ascending by referencedAt when both entries fit the budget", () => {
		const olderRef = extractRef(githubDefinition, ISSUE_959_PAYLOAD, tool, tsOld);
		const newerRef = extractRef(
			githubDefinition,
			{
				number: 960,
				title: "Second GitHub issue",
				html_url: "https://github.com/jolliai/jolli/issues/960",
				state: "closed",
			},
			tool,
			tsNew,
		);
		expect(renderBlock(githubDefinition, [olderRef as Reference, newerRef as Reference])).toBe(
			`${GOLDEN_959_XML.slice(0, -"</github-issues>".length)}<issue id="jolliai/jolli#960" status="closed">\n  <title>Second GitHub issue</title>\n  <url>https://github.com/jolliai/jolli/issues/960</url>\n</issue>\n</github-issues>`,
		);
	});

	it("drops the oldest entry when the total budget forces a choice", () => {
		const olderRef = extractRef(
			githubDefinition,
			{ number: 100, title: "older", html_url: "https://github.com/o/r/issues/100", body: A500 },
			tool,
			tsOld,
		);
		const newerRef = extractRef(
			githubDefinition,
			{ number: 101, title: "newer", html_url: "https://github.com/o/r/issues/101", body: B500 },
			tool,
			tsNew,
		);
		const variant = withBudget(githubDefinition, 4000, 700);
		expect(renderBlock(variant, [olderRef as Reference, newerRef as Reference])).toBe(
			`<github-issues>\n<issue id="o/r#101">\n  <title>newer</title>\n  <url>https://github.com/o/r/issues/101</url>\n  <description>\n${B500}\n  </description>\n</issue>\n</github-issues>`,
		);
	});

	it("renders an empty string for no refs", () => {
		expect(renderBlock(githubDefinition, [])).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Notion
// ─────────────────────────────────────────────────────────────────────────────

describe("GoldenParity: notion", () => {
	const tool = "mcp__claude_ai_Notion__notion-fetch";

	const SAMPLE_TEXT = `<page>
  <title>Adapter spec</title>
  <metadata>type=page</metadata>
  <content># Notion Adapter

Body text from the page.</content>
</page>`;
	const REAL_FETCH_PAYLOAD = {
		title: "Adapter spec",
		url: "https://www.notion.so/Adapter-spec-36c4fc101d34805ab1fdfb3e69144580",
		metadata: { type: "page" },
		text: SAMPLE_TEXT,
	};
	const GOLDEN_HAPPY_REF: Reference = {
		mapKey: "notion:36c4fc101d34805ab1fdfb3e69144580",
		source: "notion",
		nativeId: "36c4fc101d34805ab1fdfb3e69144580",
		title: "Adapter spec",
		url: "https://www.notion.so/Adapter-spec-36c4fc101d34805ab1fdfb3e69144580",
		fields: [{ key: "entity-type", label: "Type", value: "page", icon: "symbol-class" }],
		description: "# Notion Adapter\n\nBody text from the page.",
		toolName: tool,
		referencedAt: ts,
	};
	const GOLDEN_HAPPY_XML =
		'<notion-pages>\n<page id="36c4fc101d34805ab1fdfb3e69144580">\n  <title>Adapter spec</title>\n  <url>https://www.notion.so/Adapter-spec-36c4fc101d34805ab1fdfb3e69144580</url>\n  <content>\n# Notion Adapter\n\nBody text from the page.\n  </content>\n</page>\n</notion-pages>';

	it("extracts and renders the real notion-fetch payload, peeling the <content> envelope", () => {
		const ref = extractRef(notionDefinition, REAL_FETCH_PAYLOAD, tool, ts);
		expect(ref).toEqual(GOLDEN_HAPPY_REF);
		expect(renderBlock(notionDefinition, [ref as Reference])).toBe(GOLDEN_HAPPY_XML);
	});

	it("voids on metadata.type !== 'page' (the guard)", () => {
		expect(
			extractRef(notionDefinition, { ...REAL_FETCH_PAYLOAD, metadata: { type: "database" } }, tool, ts),
		).toBeNull();
	});

	it("voids on a url with no 32-hex page id", () => {
		expect(
			extractRef(
				notionDefinition,
				{ ...REAL_FETCH_PAYLOAD, url: "https://www.notion.so/Page-Title-no-hex" },
				tool,
				ts,
			),
		).toBeNull();
	});

	it("voids on a non-allow-listed host", () => {
		expect(
			extractRef(
				notionDefinition,
				{ ...REAL_FETCH_PAYLOAD, url: "https://example.com/36c4fc101d34805ab1fdfb3e69144580" },
				tool,
				ts,
			),
		).toBeNull();
	});

	it("takes the LAST (deepest) 32-hex id from a parent/child URL", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/Parent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Child-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		};
		expect(extractRef(notionDefinition, payload, tool, ts)).toEqual({
			...GOLDEN_HAPPY_REF,
			mapKey: "notion:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			nativeId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			url: payload.url,
		});
	});

	it("lowercases an uppercase page id", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, url: "https://www.notion.so/Page-36C4FC101D34805AB1FDFB3E69144580" };
		expect(extractRef(notionDefinition, payload, tool, ts)).toEqual({
			...GOLDEN_HAPPY_REF,
			url: payload.url,
		});
	});

	it("renders a minimal ref when the <content> envelope is empty", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, text: "<page><title>x</title></page>" };
		const ref = extractRef(notionDefinition, payload, tool, ts);
		expect(ref).toEqual({
			mapKey: "notion:36c4fc101d34805ab1fdfb3e69144580",
			source: "notion",
			nativeId: "36c4fc101d34805ab1fdfb3e69144580",
			title: "Adapter spec",
			url: REAL_FETCH_PAYLOAD.url,
			fields: [{ key: "entity-type", label: "Type", value: "page", icon: "symbol-class" }],
			toolName: tool,
			referencedAt: ts,
		});
		expect(renderBlock(notionDefinition, [ref as Reference])).toBe(
			'<notion-pages>\n<page id="36c4fc101d34805ab1fdfb3e69144580">\n  <title>Adapter spec</title>\n  <url>https://www.notion.so/Adapter-spec-36c4fc101d34805ab1fdfb3e69144580</url>\n</page>\n</notion-pages>',
		);
	});

	it("sorts ascending by referencedAt when both entries fit the budget", () => {
		const olderRef = extractRef(
			notionDefinition,
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/older-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				text: "<page><title>x</title><content>a</content></page>",
			},
			tool,
			tsOld,
		);
		const newerRef = extractRef(
			notionDefinition,
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/newer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				text: "<page><title>x</title><content>b</content></page>",
			},
			tool,
			tsNew,
		);
		expect(renderBlock(notionDefinition, [olderRef as Reference, newerRef as Reference])).toBe(
			'<notion-pages>\n<page id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">\n  <title>Adapter spec</title>\n  <url>https://www.notion.so/older-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</url>\n  <content>\na\n  </content>\n</page>\n<page id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">\n  <title>Adapter spec</title>\n  <url>https://www.notion.so/newer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</url>\n  <content>\nb\n  </content>\n</page>\n</notion-pages>',
		);
	});

	it("drops the oldest entry (and truncates the survivor) when the total budget forces a choice", () => {
		const olderRef = extractRef(
			notionDefinition,
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/older-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				text: `<page><title>x</title><content>${A35000}</content></page>`,
			},
			tool,
			tsOld,
		);
		const newerRef = extractRef(
			notionDefinition,
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/newer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				text: `<page><title>x</title><content>${B35000}</content></page>`,
			},
			tool,
			tsNew,
		);
		const variant = withBudget(notionDefinition, 30000, 40000);
		expect(renderBlock(variant, [olderRef as Reference, newerRef as Reference])).toBe(
			`<notion-pages>\n<page id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">\n  <title>Adapter spec</title>\n  <url>https://www.notion.so/newer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</url>\n  <content>\n${"b".repeat(30000)}\n…[truncated, 5000 more chars]\n  </content>\n</page>\n</notion-pages>`,
		);
	});

	it("renders an empty string for no refs", () => {
		expect(renderBlock(notionDefinition, [])).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Slack
// ─────────────────────────────────────────────────────────────────────────────

describe("GoldenParity: slack", () => {
	const tool = "mcp__claude_ai_Slack__slack_read_thread";

	// The literal `=== THREAD PARENT MESSAGE ===` blob shape produced by the real
	// `slack_read_thread` tool, already trimmed the way `normalizeSlackThread`
	// trims it. The engine here only ever sees the POST-normalize canonical
	// object below (channelId/parentTs/title/text/replyCount/url), never this
	// raw blob — SlackNormalize.test.ts covers the raw-blob → canonical parse.
	const THREAD_TEXT = `=== THREAD PARENT MESSAGE ===
From: Flyer Li (U0BGFSM16DN)
Time: 2026-07-07 16:46:24 CST
Message TS: 1783413984.700009
Consolidate the existing Linear / Jira / GitHub / Notion …

=== THREAD REPLIES (2 total) ===

--- Reply 1 of 2 ---
From: Flyer Li (U0BGFSM16DN)
Time: 2026-07-07 17:18:37 CST
Message TS: 1783415917.422609
Config-driven MCP integration

--- Reply 2 of 2 ---
From: Flyer Li (U0BGFSM16DN)
Time: 2026-07-07 17:23:48 CST
Message TS: 1783416228.715669
How to do?`;

	const CANON = {
		channelId: "C0BFF9UHBD1",
		parentTs: "1783413984.700009",
		title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
		text: THREAD_TEXT,
		replyCount: 2,
		url: "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009",
	};
	const GOLDEN_HAPPY_REF: Reference = {
		mapKey: "slack:C0BFF9UHBD1-1783413984.700009",
		source: "slack",
		nativeId: "C0BFF9UHBD1-1783413984.700009",
		title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
		url: "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009",
		fields: [
			{ key: "entity-type", label: "Type", value: "thread", icon: "comment-discussion" },
			{ key: "replies", label: "Replies", value: "2", icon: "reply" },
			{ key: "channel", label: "Channel", value: "C0BFF9UHBD1", icon: "symbol-namespace" },
		],
		description: THREAD_TEXT,
		toolName: tool,
		referencedAt: ts,
	};
	const GOLDEN_HAPPY_XML = `<slack-threads>\n<thread id="C0BFF9UHBD1-1783413984.700009" entity-type="thread" replies="2" channel="C0BFF9UHBD1">\n  <title>Consolidate the existing Linear / Jira / GitHub / Notion …</title>\n  <url>https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009</url>\n  <messages>\n${THREAD_TEXT}\n  </messages>\n</thread>\n</slack-threads>`;

	it("extracts and renders the real captured thread payload", () => {
		const ref = extractRef(slackDefinition, CANON, tool, ts);
		expect(ref).toEqual(GOLDEN_HAPPY_REF);
		expect(renderBlock(slackDefinition, [ref as Reference])).toBe(GOLDEN_HAPPY_XML);
	});

	it("voids on a nativeId that doesn't match the channel-dash-ts shape", () => {
		expect(extractRef(slackDefinition, { ...CANON, channelId: "not valid!" }, tool, ts)).toBeNull();
	});

	it("voids on missing title", () => {
		expect(extractRef(slackDefinition, { ...CANON, title: "" }, tool, ts)).toBeNull();
	});

	it("voids a thread with no resolvable url — linkless threads are not stored", () => {
		const canonNoUrl = {
			channelId: "C0BFF9UHBD1",
			parentTs: "1783413984.700009",
			title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
			text: THREAD_TEXT,
			replyCount: 2,
		};
		expect(extractRef(slackDefinition, canonNoUrl, tool, ts)).toBeNull();
	});

	it("renders an empty string for no refs", () => {
		expect(renderBlock(slackDefinition, [])).toBe("");
	});
});
