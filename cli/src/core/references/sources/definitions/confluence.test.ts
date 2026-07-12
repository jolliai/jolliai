import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { confluenceDefinition as def } from "./confluence.js";

// The definition runs over the POST-normalize canonical shape (ConfluenceNormalize output).
const CANONICAL = {
	pageId: "557292",
	title: "数据库访问架构变更设计：Per-Provider 连接池",
	url: "https://jolli-team-zod7kvo1.atlassian.net/wiki/spaces/Engineerin/pages/557292/Per-Provider",
	body: "## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。",
	space: "Engineering",
	author: "Flyer Li",
};
const TOOL = "mcp__claude_ai_Atlassian__getConfluencePage";
const AT = "2026-07-11T00:00:00Z";

describe("confluence definition", () => {
	it("extracts a Reference from the canonical shape", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		expect(ref?.source).toBe("confluence");
		expect(ref?.nativeId).toBe("557292");
		expect(ref?.title).toBe("数据库访问架构变更设计：Per-Provider 连接池");
		expect(ref?.url).toBe(CANONICAL.url);
		expect(ref?.description).toContain("TL;DR");
		expect(ref?.fields).toEqual([
			{ key: "space", label: "Space", icon: "symbol-namespace", value: "Engineering" },
			{ key: "author", label: "Author", icon: "account", value: "Flyer Li" },
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "page" },
		]);
	});

	it("reflects a non-page entityType (blogpost) in the Type field", () => {
		const ref = extractRef(def, { ...CANONICAL, entityType: "blogpost" }, TOOL, AT);
		expect(ref?.fields).toContainEqual({
			key: "entity-type",
			label: "Type",
			icon: "symbol-class",
			value: "blogpost",
		});
	});

	it("voids when pageId (nativeId) is non-numeric", () => {
		expect(extractRef(def, { ...CANONICAL, pageId: "abc" }, TOOL, AT)).toBeNull();
	});

	it("voids when the URL is not a wiki URL", () => {
		expect(extractRef(def, { ...CANONICAL, url: "https://example.com/not-wiki" }, TOOL, AT)).toBeNull();
	});

	it("still extracts when body/space/author are absent (title+url suffice)", () => {
		const ref = extractRef(def, { pageId: "1", title: "t", url: "https://x.atlassian.net/wiki/p/1" }, TOOL, AT);
		expect(ref?.nativeId).toBe("1");
		expect(ref?.description).toBeUndefined();
	});

	it("renders a <confluence-pages> block", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const block = renderBlock(def, [ref]);
		expect(block).toContain("<confluence-pages>");
		expect(block).toContain("<content>");
	});
});
