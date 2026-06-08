import { describe, expect, it } from "vitest";
import type { Reference } from "../../../Types.js";
import { NotionAdapter } from "./NotionAdapter.js";

const fieldVal = (r: Reference | null | undefined, key: string): string | undefined =>
	r?.fields?.find((f) => f.key === key)?.value;

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

describe("NotionAdapter.extractRef", () => {
	const ts = "2026-05-27T00:00:00.000Z";
	const fetchTool = "mcp__claude_ai_Notion__notion-fetch";

	it("extracts a real notion-fetch payload to an Reference", () => {
		const ref = NotionAdapter.extractRef(REAL_FETCH_PAYLOAD, fetchTool, ts);
		expect(ref).toMatchObject({
			mapKey: "notion:36c4fc101d34805ab1fdfb3e69144580",
			source: "notion",
			nativeId: "36c4fc101d34805ab1fdfb3e69144580",
			title: "Adapter spec",
			url: REAL_FETCH_PAYLOAD.url,
			toolName: fetchTool,
			referencedAt: ts,
		});
		expect(fieldVal(ref, "entity-type")).toBe("page");
		expect(ref?.description).toContain("Notion Adapter");
	});

	// Note: the notion-fetch-only tool gate (rejecting notion-search/update/write)
	// moved to the Claude binding (bindings/claude); see its test for that scope.

	it("extracts the page id from a slug-32hex URL (Page-Title-<32hex>)", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/My-Page-Title-36c4fc101d34805ab1fdfb3e69144580",
		};
		const ref = NotionAdapter.extractRef(payload, fetchTool, ts);
		expect(ref?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("extracts the page id from a plain 32hex URL", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/36c4fc101d34805ab1fdfb3e69144580",
		};
		const ref = NotionAdapter.extractRef(payload, fetchTool, ts);
		expect(ref?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("extracts the page id when a subpath follows (…/Page-<32hex>/subpath)", () => {
		// Regression: a slugged URL can carry a trailing path segment after the
		// page id (a comment thread, a child block); the id must still be
		// extracted, not silently dropped.
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/My-Page-36c4fc101d34805ab1fdfb3e69144580/comment-thread",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("extracts the page id when a query string follows (…?v=…)", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/Page-36c4fc101d34805ab1fdfb3e69144580?v=abc123",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("takes the DEEPEST id from a nested parent/child URL (…/Parent-<id>/Child-<id>)", () => {
		// The fetched page is the child; the reference must key on the child id,
		// not the parent id that appears earlier in the path.
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/Parent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Child-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)?.nativeId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
	});

	it("accepts *.notion.site subdomain hosts", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://my-workspace.notion.site/36c4fc101d34805ab1fdfb3e69144580",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("accepts the bare notion.so host (no www)", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://notion.so/36c4fc101d34805ab1fdfb3e69144580",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("normalizes the page id to lowercase", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://www.notion.so/Page-36C4FC101D34805AB1FDFB3E69144580",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});

	it("rejects metadata.type === 'database'", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, metadata: { type: "database" } };
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects metadata.type === 'data_source'", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, metadata: { type: "data_source" } };
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects payloads from non-notion domains", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "https://example.com/36c4fc101d34805ab1fdfb3e69144580",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects http:// (non-https) URLs", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			url: "http://www.notion.so/36c4fc101d34805ab1fdfb3e69144580",
		};
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects malformed URLs", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, url: "not a url" };
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects URLs missing the 32hex page id", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, url: "https://www.notion.so/Page-Title-no-hex" };
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects non-object payloads", () => {
		expect(NotionAdapter.extractRef(null, fetchTool, ts)).toBeNull();
		expect(NotionAdapter.extractRef([], fetchTool, ts)).toBeNull();
		expect(NotionAdapter.extractRef("string", fetchTool, ts)).toBeNull();
	});

	it("rejects payloads missing metadata", () => {
		const payload = { title: "x", url: REAL_FETCH_PAYLOAD.url };
		expect(NotionAdapter.extractRef(payload, fetchTool, ts)).toBeNull();
	});

	it("rejects payloads with empty / missing title or url", () => {
		expect(
			NotionAdapter.extractRef(
				{ title: "", url: REAL_FETCH_PAYLOAD.url, metadata: { type: "page" } },
				fetchTool,
				ts,
			),
		).toBeNull();
		expect(NotionAdapter.extractRef({ title: "x", metadata: { type: "page" } }, fetchTool, ts)).toBeNull();
	});

	it("omits description when the envelope <content> is empty", () => {
		const payload = {
			...REAL_FETCH_PAYLOAD,
			text: "<page><title>x</title></page>",
		};
		const ref = NotionAdapter.extractRef(payload, fetchTool, ts);
		expect(ref?.description).toBeUndefined();
	});

	it("treats non-string text as empty envelope (no description)", () => {
		const payload = { ...REAL_FETCH_PAYLOAD, text: 42 };
		const ref = NotionAdapter.extractRef(payload, fetchTool, ts);
		expect(ref?.description).toBeUndefined();
	});
});

describe("NotionAdapter.renderPromptBlock", () => {
	const ts = "2026-05-27T00:00:00.000Z";
	const fetchTool = "mcp__claude_ai_Notion__notion-fetch";

	it("emits <notion-pages> wrapper with id/title/url/content", () => {
		const ref = NotionAdapter.extractRef(REAL_FETCH_PAYLOAD, fetchTool, ts);
		expect(ref).not.toBeNull();
		const out = NotionAdapter.renderPromptBlock([ref as Reference]);
		expect(out).toContain("<notion-pages>");
		expect(out).toContain("</notion-pages>");
		expect(out).toContain('id="36c4fc101d34805ab1fdfb3e69144580"');
		expect(out).toContain("<title>Adapter spec</title>");
		expect(out).toContain("<url>");
		expect(out).toContain("<content>");
		expect(out).toContain("Notion Adapter");
	});

	it("returns empty string for empty input", () => {
		expect(NotionAdapter.renderPromptBlock([])).toBe("");
	});

	it("applies the default 30 KB per-entity budget when no override is given", () => {
		// Build a content > 30 KB and verify truncation marker appears.
		const long = "x".repeat(35000);
		const text = `<page><title>x</title><content>${long}</content></page>`;
		const ref = NotionAdapter.extractRef({ ...REAL_FETCH_PAYLOAD, text }, fetchTool, ts);
		const out = NotionAdapter.renderPromptBlock([ref as Reference]);
		expect(out).toContain("…[truncated, ");
	});

	it("respects maxCharsPerReference override (small budget → small body)", () => {
		const long = "x".repeat(35000);
		const text = `<page><title>x</title><content>${long}</content></page>`;
		const ref = NotionAdapter.extractRef({ ...REAL_FETCH_PAYLOAD, text }, fetchTool, ts);
		const out = NotionAdapter.renderPromptBlock([ref as Reference], { maxCharsPerReference: 100 });
		expect(out).toContain("…[truncated, ");
		// The rendered body is much smaller than the original 35000 chars.
		expect(out.length).toBeLessThan(1000);
	});

	it("returns empty when maxTotalChars forbids any entity", () => {
		const ref = NotionAdapter.extractRef(REAL_FETCH_PAYLOAD, fetchTool, ts);
		expect(NotionAdapter.renderPromptBlock([ref as Reference], { maxTotalChars: 10 })).toBe("");
	});

	it("sorts ascending by referencedAt (newest budget priority, ascending output)", () => {
		const older = NotionAdapter.extractRef(
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/older-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				text: "<page><title>x</title><content>a</content></page>",
			},
			fetchTool,
			"2026-01-01T00:00:00Z",
		);
		const newer = NotionAdapter.extractRef(
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/newer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				text: "<page><title>x</title><content>b</content></page>",
			},
			fetchTool,
			"2026-05-01T00:00:00Z",
		);
		const out = NotionAdapter.renderPromptBlock([older as Reference, newer as Reference]);
		// ascending output order: older first
		expect(out.indexOf('id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).toBeLessThan(
			out.indexOf('id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'),
		);
	});

	it("drops the oldest when budget forces a choice (newest wins)", () => {
		const longA = "a".repeat(35000);
		const longB = "b".repeat(35000);
		const older = NotionAdapter.extractRef(
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/older-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				text: `<page><title>x</title><content>${longA}</content></page>`,
			},
			fetchTool,
			"2026-01-01T00:00:00Z",
		);
		const newer = NotionAdapter.extractRef(
			{
				...REAL_FETCH_PAYLOAD,
				url: "https://www.notion.so/newer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				text: `<page><title>x</title><content>${longB}</content></page>`,
			},
			fetchTool,
			"2026-05-01T00:00:00Z",
		);
		// Total budget fits exactly one rendered entity.
		const out = NotionAdapter.renderPromptBlock([older as Reference, newer as Reference], {
			maxTotalChars: 40000,
		});
		expect(out).toContain('id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
		expect(out).not.toContain('id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
	});

	it("renders minimal ref without description block", () => {
		const ref: Reference = {
			mapKey: "notion:36c4fc101d34805ab1fdfb3e69144580",
			source: "notion",
			nativeId: "36c4fc101d34805ab1fdfb3e69144580",
			title: "Minimal",
			url: "https://www.notion.so/36c4fc101d34805ab1fdfb3e69144580",
			fields: [{ key: "entity-type", label: "Type", value: "page", icon: "symbol-class" }],
			toolName: fetchTool,
			referencedAt: ts,
		};
		const out = NotionAdapter.renderPromptBlock([ref]);
		expect(out).toContain('<page id="36c4fc101d34805ab1fdfb3e69144580">');
		expect(out).not.toContain("<content>");
	});
});

describe("NotionAdapter metadata", () => {
	it("exposes id, wrapperKeys, maxCharsPerReference", () => {
		expect(NotionAdapter.id).toBe("notion");
		expect(NotionAdapter.wrapperKeys).toEqual(["results", "items", "pages"]);
		expect(NotionAdapter.maxCharsPerReference).toBe(30000);
	});
});
