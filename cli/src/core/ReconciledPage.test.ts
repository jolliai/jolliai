import { describe, expect, it } from "vitest";
import { parseReconciledPage } from "./ReconciledPage.js";

const block = `===TOPIC===
---TITLE---
Auth and origin allowlist
---STABLESLUG---
auth-origin-allowlist
---SUMMARY---
How origin allowlisting is validated at save time.
---CONTENT---
The allowlist is jolli.ai, jolli.dev. Validation happens at save time.
---KEYDECISIONS---
- Save-time validation, request path trusts saved value
---RELATEDBRANCHES---
main, feature/auth
---SOURCECOMMITS---
abc123, def456
`;

describe("parseReconciledPage", () => {
	it("parses content, summary, decisions, branches, commits", () => {
		const p = parseReconciledPage(block, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p).not.toBeNull();
		expect(p?.content).toContain("allowlist is jolli.ai");
		expect(p?.summary).toBe("How origin allowlisting is validated at save time.");
		expect(p?.keyDecisions).toEqual(["Save-time validation, request path trusts saved value"]);
		expect(p?.relatedBranches).toEqual(["main", "feature/auth"]);
		expect(p?.sourceCommits).toEqual(["abc123", "def456"]);
	});

	it("returns null when the LLM emitted no topic block", () => {
		expect(parseReconciledPage("garbage with no markers", "slug", "Title")).toBeNull();
	});

	it("falls back to the authoritative slug/title when the LLM echoes a different slug", () => {
		const drifted = block.replace("auth-origin-allowlist", "something-else");
		const p = parseReconciledPage(drifted, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p?.stableSlug).toBe("auth-origin-allowlist"); // authoritative wins
	});

	it("tolerates a missing SUMMARY field (empty summary)", () => {
		const noSummary = block.replace(/---SUMMARY---\n.*\n/, "");
		const p = parseReconciledPage(noSummary, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p?.summary).toBe("");
		expect(p?.content).toContain("allowlist is jolli.ai");
	});

	it("recovers the page with the authoritative title when the LLM omits ---TITLE---", () => {
		const noTitle = `===TOPIC===
---STABLESLUG---
auth-origin-allowlist
---SUMMARY---
How origin allowlisting is validated.
---CONTENT---
The allowlist is jolli.ai, jolli.dev.
`;
		const p = parseReconciledPage(noTitle, "auth-origin-allowlist", "Auth and origin allowlist");
		expect(p).not.toBeNull();
		expect(p?.title).toBe("Auth and origin allowlist"); // authoritative title fills the gap
		expect(p?.stableSlug).toBe("auth-origin-allowlist");
		expect(p?.content).toContain("allowlist is jolli.ai");
		expect(p?.summary).toBe("How origin allowlisting is validated.");
	});

	it("returns null when a title-less block also has no CONTENT (genuine reconcile failure)", () => {
		const noContent = `===TOPIC===
---STABLESLUG---
slug-only
---SUMMARY---
just a summary, nothing to write
`;
		expect(parseReconciledPage(noContent, "slug-only", "Title")).toBeNull();
	});

	it("yields an empty summary when the response omits the ===TOPIC=== delimiter", () => {
		// parseCompileResponse still parses a lone block (TITLE+CONTENT present), but
		// `response.split("===TOPIC===")[1]` is undefined → summary falls back to "".
		const noDelimiter = `---TITLE---
Lone block
---CONTENT---
Body with no topic delimiter.`;
		const p = parseReconciledPage(noDelimiter, "lone-slug", "Lone Title");
		expect(p).not.toBeNull();
		expect(p?.summary).toBe("");
		expect(p?.content).toContain("Body with no topic delimiter.");
	});
});
