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

describe("normalizeConfluence", () => {
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
