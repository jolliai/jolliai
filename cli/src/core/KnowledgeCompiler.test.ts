import { describe, expect, it } from "vitest";
import type { CommitSummary, TopicSummary } from "../Types.js";
import { extractField, formatSummaryForCompile, parseCompileResponse } from "./KnowledgeCompiler.js";

function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "abc123456789",
		commitMessage: "Add OAuth flow",
		commitAuthor: "Dev",
		commitDate: "2026-01-01T00:00:00Z",
		branch: "feature/oauth",
		generatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeTopic(overrides: Partial<TopicSummary> = {}): TopicSummary {
	return {
		title: "OAuth Integration",
		trigger: "Users needed SSO",
		response: "Implemented PKCE flow",
		decisions: "Chose PKCE over implicit",
		filesAffected: ["src/auth.ts", "src/session.ts"],
		...overrides,
	};
}

describe("parseCompileResponse", () => {
	it("should parse a single topic response", () => {
		const response = `===TOPIC===
---TITLE---
OAuth2 Provider Integration
---CONTENT---
## Background
Integrated OAuth2 provider for user auth.
## Design Decisions
Chose PKCE flow for security.
---KEYDECISIONS---
- Chose PKCE flow over implicit flow due to security audit requirements
- Token storage uses httpOnly cookies instead of localStorage
---RELATEDBRANCHES---
feature/session-management
---SOURCECOMMITS---
abc12345, def67890`;

		const topics = parseCompileResponse(response);

		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("OAuth2 Provider Integration");
		expect(topics[0].content).toContain("## Background");
		expect(topics[0].keyDecisions).toHaveLength(2);
		expect(topics[0].keyDecisions?.[0]).toContain("PKCE flow");
		expect(topics[0].relatedBranches).toEqual(["feature/session-management"]);
		expect(topics[0].sourceCommits).toEqual(["abc12345", "def67890"]);
	});

	it("should parse multiple topics", () => {
		const response = `===TOPIC===
---TITLE---
Topic One
---CONTENT---
Content one
---KEYDECISIONS---
- Decision A
---RELATEDBRANCHES---

---SOURCECOMMITS---
aaa111

===TOPIC===
---TITLE---
Topic Two
---CONTENT---
Content two
---KEYDECISIONS---
- Decision B
---RELATEDBRANCHES---
feature/other
---SOURCECOMMITS---
bbb222`;

		const topics = parseCompileResponse(response);

		expect(topics).toHaveLength(2);
		expect(topics[0].title).toBe("Topic One");
		expect(topics[1].title).toBe("Topic Two");
	});

	it("should return empty array for NO_TOPICS response", () => {
		const topics = parseCompileResponse("===NO_TOPICS===");
		expect(topics).toEqual([]);
	});

	it("should return empty array for empty response", () => {
		const topics = parseCompileResponse("");
		expect(topics).toEqual([]);
	});

	it("should handle topic with empty source commits field", () => {
		const response = `===TOPIC===
---TITLE---
A Topic
---CONTENT---
Some content
---SOURCECOMMITS---
`;

		const topics = parseCompileResponse(response);
		expect(topics).toHaveLength(1);
		expect(topics[0].sourceCommits).toEqual([]);
	});

	it("should skip topics missing title or content", () => {
		const response = `===TOPIC===
---TITLE---

---CONTENT---
Some content
---SOURCECOMMITS---
aaa111

===TOPIC===
---TITLE---
Valid Topic
---CONTENT---
Valid content
---SOURCECOMMITS---
bbb222`;

		const topics = parseCompileResponse(response);
		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("Valid Topic");
	});

	// spec 110 — STABLESLUG handling
	it("uses the LLM-supplied stableSlug verbatim when it is already kebab-normalized", () => {
		const response = `===TOPIC===
---TITLE---
OAuth Integration
---STABLESLUG---
oauth-pkce-flow
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);
		expect(topics).toHaveLength(1);
		expect(topics[0].stableSlug).toBe("oauth-pkce-flow");
	});

	it("normalizes a non-kebab stableSlug to lowercase-kebab", () => {
		const response = `===TOPIC===
---TITLE---
Session Rotation
---STABLESLUG---
Session_Rotation Logic
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);
		expect(topics[0].stableSlug).toBe("session-rotation-logic");
	});

	it("falls back to title-slug when STABLESLUG is missing (pre-spec110 LLM response)", () => {
		const response = `===TOPIC===
---TITLE---
Token Refresh Strategy
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);
		expect(topics[0].stableSlug).toBe("token-refresh-strategy");
	});

	it("falls back to title-slug when STABLESLUG normalizes to empty", () => {
		const response = `===TOPIC===
---TITLE---
Pure Title
---STABLESLUG---
!!!@@@###
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);
		expect(topics[0].stableSlug).toBe("pure-title");
	});

	it("yields 'untitled-topic' when both title and STABLESLUG cannot produce a valid slug", () => {
		const response = `===TOPIC===
---TITLE---
!!
---STABLESLUG---
@@
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);
		expect(topics[0].stableSlug).toBe("untitled-topic");
	});

	it("dedups two topics with identical stableSlug (first wins per spec 110)", () => {
		const response = `===TOPIC===
---TITLE---
First version
---STABLESLUG---
oauth-flow
---CONTENT---
body 1
---SOURCECOMMITS---
abc12345

===TOPIC===
---TITLE---
Second version
---STABLESLUG---
oauth-flow
---CONTENT---
body 2
---SOURCECOMMITS---
def67890`;

		const topics = parseCompileResponse(response);
		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("First version");
	});

	it("clamps stableSlug to 40 chars", () => {
		const long = "very-long-slug-that-exceeds-the-forty-character-limit-by-quite-a-bit";
		const response = `===TOPIC===
---TITLE---
Long
---STABLESLUG---
${long}
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);
		expect(topics[0].stableSlug.length).toBeLessThanOrEqual(40);
		expect(topics[0].stableSlug).toBe(long.substring(0, 40).replace(/-+$/, ""));
	});

	// A source whose own content documents the delimiter format (e.g. a design
	// note for the reconcile parser) embeds `---FIELD---` strings inside CONTENT.
	// Field markers are emitted on their OWN line; an inline mention (in backticks,
	// mid-sentence) must NOT be treated as a delimiter, or it hijacks the parse.
	it("ignores ---FIELD--- markers that appear inline inside a field value", () => {
		const response = `===TOPIC===
---TITLE---
Topic KB Ingest Pipeline
---STABLESLUG---
topic-kb-ingest-pipeline
---CONTENT---
The reconcile output uses fields \`---TITLE---\`, \`---STABLESLUG---\`, \`---RELATEDBRANCHES---\`, \`---SOURCECOMMITS---\`.
- \`relatedBranches\` ← union of the page's prior \`relatedBranches\` and the sources' branches
---RELATEDBRANCHES---
feature-knowledge-compilation
---SOURCECOMMITS---
abc12345`;

		const topics = parseCompileResponse(response);

		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("Topic KB Ingest Pipeline");
		expect(topics[0].stableSlug).toBe("topic-kb-ingest-pipeline");
		// relatedBranches must come from the real line-anchored field, not the
		// backticked inline mention earlier in CONTENT.
		expect(topics[0].relatedBranches).toEqual(["feature-knowledge-compilation"]);
		expect(topics[0].sourceCommits).toEqual(["abc12345"]);
		// CONTENT keeps the documented markers verbatim.
		expect(topics[0].content).toContain("`---RELATEDBRANCHES---`");
	});
});

describe("extractField", () => {
	it("matches a marker only at the start of a line", () => {
		const block = `
---TITLE---
Real Title
---CONTENT---
body`;
		expect(extractField(block, "TITLE")).toBe("Real Title");
	});

	it("skips a marker that is embedded inline (backticked) and finds the real one", () => {
		const block = `
---CONTENT---
prose mentioning \`---TITLE---\` as data, not a delimiter
---TITLE---
Real Title`;
		expect(extractField(block, "TITLE")).toBe("Real Title");
	});

	it("does not match an inline-only marker (returns empty when no line-anchored marker exists)", () => {
		const block = `
---CONTENT---
the \`---RELATEDBRANCHES---\` field is advisory`;
		expect(extractField(block, "RELATEDBRANCHES")).toBe("");
	});

	it("reads a value that ends at end-of-string (no trailing newline)", () => {
		const block = `
---CONTENT---
body
---SOURCECOMMITS---
abc12345`;
		expect(extractField(block, "SOURCECOMMITS")).toBe("abc12345");
	});

	it("returns empty for an empty field value", () => {
		const block = `
---RELATEDBRANCHES---

---SOURCECOMMITS---
abc`;
		expect(extractField(block, "RELATEDBRANCHES")).toBe("");
	});

	it("does not truncate the value at an unknown ---TOKEN--- line (only known field markers end a field)", () => {
		const block = `
---CONTENT---
First paragraph.
---NOTE---
This line and everything after must stay in CONTENT.
---SOURCECOMMITS---
abc12345`;
		expect(extractField(block, "CONTENT")).toBe(
			"First paragraph.\n---NOTE---\nThis line and everything after must stay in CONTENT.",
		);
	});
});

describe("formatSummaryForCompile", () => {
	it("formats a summary header with truncated hash, message, and date", () => {
		const summary = makeSummary({ topics: [makeTopic()] });
		const out = formatSummaryForCompile(summary);
		const header = out.split("\n")[0];
		expect(header).toBe("### Commit abc12345 -- Add OAuth flow (2026-01-01T00:00:00Z)");
	});

	it("emits all topic fields when present", () => {
		const summary = makeSummary({ topics: [makeTopic()] });
		const out = formatSummaryForCompile(summary);
		expect(out).toContain("**OAuth Integration**");
		expect(out).toContain("- Why: Users needed SSO");
		expect(out).toContain("- Decisions: Chose PKCE over implicit");
		expect(out).toContain("- What: Implemented PKCE flow");
		expect(out).toContain("- Files: src/auth.ts, src/session.ts");
	});

	it("omits optional lines when topic fields are empty/absent", () => {
		const summary = makeSummary({
			topics: [makeTopic({ trigger: "", decisions: "", response: "", filesAffected: [] })],
		});
		const out = formatSummaryForCompile(summary);
		expect(out).toContain("**OAuth Integration**");
		expect(out).not.toContain("- Why:");
		expect(out).not.toContain("- Decisions:");
		expect(out).not.toContain("- What:");
		expect(out).not.toContain("- Files:");
	});

	it("omits the Files line when filesAffected is undefined", () => {
		const summary = makeSummary({
			topics: [makeTopic({ filesAffected: undefined })],
		});
		const out = formatSummaryForCompile(summary);
		expect(out).not.toContain("- Files:");
	});

	it("produces only a header when the summary has no topics", () => {
		const summary = makeSummary({ topics: [] });
		const out = formatSummaryForCompile(summary);
		expect(out).toBe("### Commit abc12345 -- Add OAuth flow (2026-01-01T00:00:00Z)");
	});

	it("flattens child topics (tree) into the formatted output", () => {
		const child = makeSummary({
			commitHash: "child0000000",
			commitDate: "2025-12-31T00:00:00Z",
			topics: [makeTopic({ title: "Child Topic" })],
		});
		const summary = makeSummary({ topics: [makeTopic({ title: "Root Topic" })], children: [child] });
		const out = formatSummaryForCompile(summary);
		// collectAllTopics yields children (oldest) first, then own.
		expect(out.indexOf("**Child Topic**")).toBeLessThan(out.indexOf("**Root Topic**"));
	});
});
