import { describe, expect, it } from "vitest";
import { normalizeConfluence } from "./ConfluenceNormalize.js";

// Real getConfluencePage capture (default/markdown contentFormat): body is a string.
const STRING_BODY = {
	content: {
		totalCount: 1,
		nodes: [
			{
				id: "557292",
				type: "page",
				status: "current",
				title: "数据库访问架构变更设计：Per-Provider 连接池",
				summary: "TL;DR…",
				space: { key: "Engineerin", name: "Engineering" },
				author: { displayName: "Flyer Li", avatarUrls: { "48x48": "https://…/aa-avatar/…" } },
				_links: { webui: "/spaces/Engineerin/pages/557292/Per-Provider" },
				lastModified: "17 minutes ago",
				body: "## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。",
				webUrl: "https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
			},
		],
	},
};

// Real getConfluencePage capture (adf contentFormat): body is an ADF document object.
const ADF_BODY = {
	content: {
		totalCount: 1,
		nodes: [
			{
				id: "557292",
				title: "数据库访问架构变更设计：Per-Provider 连接池",
				space: { key: "Engineerin", name: "Engineering" },
				author: { displayName: "Flyer Li" },
				body: {
					type: "doc",
					version: 1,
					content: [
						{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "TL;DR" }] },
						{
							type: "orderedList",
							content: [
								{
									type: "listItem",
									content: [
										{
											type: "paragraph",
											content: [
												{ type: "text", text: "现状：每个 org 的 " },
												{ type: "text", text: "poolMax", marks: [{ type: "code" }] },
												{ type: "text", text: " 配得越小。" },
											],
										},
									],
								},
							],
						},
					],
				},
				webUrl: "https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
			},
		],
	},
};

// Real Codex "Atlassian Rovo" `_getconfluencepage` result (captured 2026-07-13):
// the MCP CallToolResult's `content[0].text` — the shape the Codex envelope layer
// actually extracts — is a FLAT page node, NOT the `{content:{nodes:[…]}}` wrapper
// Claude's `getConfluencePage` structuredContent carries. There is no `space`/`author`
// object here, only `spaceId`/`authorId`.
const ROVO_FLAT_PAGE = {
	id: "8388609",
	type: "page",
	status: "current",
	title: "My second page - 002",
	spaceId: 196611,
	parentId: "98415",
	authorId: "712020:11111111-2222-3333-4444-555555555555",
	body: "## Overview\n\nSecond page body text.",
	webUrl: "https://lichengbin2008.atlassian.net/wiki/spaces/KAN/pages/8388609/My+second+page",
};

describe("normalizeConfluence", () => {
	it("captures a flat page node (Codex Rovo shape) without the content.nodes wrapper", () => {
		const out = normalizeConfluence(ROVO_FLAT_PAGE);
		expect(out).not.toBeNull();
		expect(out?.pageId).toBe("8388609");
		expect(out?.title).toBe("My second page - 002");
		expect(out?.url).toBe("https://lichengbin2008.atlassian.net/wiki/spaces/KAN/pages/8388609/My+second+page");
		expect(out?.body).toBe("## Overview\n\nSecond page body text.");
		expect(out?.entityType).toBe("page");
		// The flat node has only spaceId/authorId (opaque IDs), no space/author
		// objects — those display fields stay undefined rather than surfacing IDs.
		expect(out?.space).toBeUndefined();
		expect(out?.author).toBeUndefined();
	});

	it("flattens an ADF body on a flat page node too (Codex adf contentFormat)", () => {
		const out = normalizeConfluence({
			id: "131076",
			type: "page",
			title: "adf flat page",
			webUrl: "https://x.atlassian.net/wiki/spaces/KAN/pages/131076/p",
			body: {
				type: "doc",
				content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "TL;DR" }] }],
			},
		});
		expect(out?.body).toBe("## TL;DR");
	});

	it("identifies a flat node by webUrl when title is absent", () => {
		const out = normalizeConfluence({ id: "42", webUrl: "https://x.atlassian.net/wiki/p/42" });
		expect(out).not.toBeNull();
		expect(out?.pageId).toBe("42");
		expect(out?.title).toBeUndefined();
	});

	it("returns null for a top-level object with an id but neither title nor webUrl", () => {
		// Not the wrapper (no `content`) and not page-node-shaped enough to trust.
		expect(normalizeConfluence({ id: "1" })).toBeNull();
	});

	it("passes a string body through unchanged", () => {
		const out = normalizeConfluence(STRING_BODY);
		expect(out).not.toBeNull();
		expect(out?.pageId).toBe("557292");
		expect(out?.title).toBe("数据库访问架构变更设计：Per-Provider 连接池");
		expect(out?.url).toBe(
			"https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
		);
		expect(out?.body).toBe("## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。");
		expect(out?.space).toBe("Engineering");
		expect(out?.author).toBe("Flyer Li");
		expect(out?.entityType).toBe("page");
	});

	it("carries a non-page content type (blogpost) through, and omits it when absent", () => {
		const blogpost = normalizeConfluence({
			content: { nodes: [{ id: "1", type: "blogpost", title: "t", webUrl: "https://x.atlassian.net/wiki/p/1" }] },
		});
		expect(blogpost?.entityType).toBe("blogpost");
		const noType = normalizeConfluence({
			content: { nodes: [{ id: "1", title: "t", webUrl: "https://x.atlassian.net/wiki/p/1" }] },
		});
		expect(noType?.entityType).toBeUndefined();
	});

	it("flattens an ADF body to plain text", () => {
		const out = normalizeConfluence(ADF_BODY);
		expect(out?.body).toBe("## TL;DR\n\n1. 现状：每个 org 的 poolMax 配得越小。");
	});

	it("omits body when it is neither string nor flattenable", () => {
		const out = normalizeConfluence({ content: { nodes: [{ id: "1", title: "t", webUrl: "u", body: 42 }] } });
		expect(out?.body).toBeUndefined();
	});

	it("returns null when content is missing", () => {
		expect(normalizeConfluence({})).toBeNull();
		expect(normalizeConfluence({ content: {} })).toBeNull();
		expect(normalizeConfluence({ content: { nodes: [] } })).toBeNull();
		expect(normalizeConfluence({ content: { nodes: [42] } })).toBeNull();
		expect(normalizeConfluence(null)).toBeNull();
	});

	it("does not null-check title/url (leaves them undefined for the definition to void)", () => {
		const out = normalizeConfluence({ content: { nodes: [{ id: "1" }] } });
		expect(out).not.toBeNull();
		expect(out?.pageId).toBe("1");
		expect(out?.title).toBeUndefined();
		expect(out?.url).toBeUndefined();
	});

	it("leaves pageId undefined when the node has no id", () => {
		const out = normalizeConfluence({
			content: { nodes: [{ title: "t", webUrl: "https://x.atlassian.net/wiki/p/1" }] },
		});
		expect(out).not.toBeNull();
		expect(out?.pageId).toBeUndefined();
		expect(out?.title).toBe("t");
	});
});
