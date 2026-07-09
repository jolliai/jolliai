import { describe, expect, it } from "vitest";
import type { Reference } from "../../Types.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import { evalPipe, extractRef, renderBlock, TRANSFORMS } from "./SourceEngine.js";
import { linearDefinition } from "./sources/definitions/linear.js";
import { slackDefinition } from "./sources/definitions/slack.js";

function miniLinearDef(): SourceDefinition {
	return {
		id: "linear",
		label: "Linear",
		icon: "circle-large-filled",
		match: { claude: { prefixes: ["mcp__linear__"] } },
		wrapperKeys: ["items", "issues", "nodes", "results"],
		reference: {
			nativeId: { pipe: [{ op: "path", path: "id" }], require: "^[A-Z][A-Z0-9_]*-\\d+$" },
			title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
			url: { pipe: [{ op: "path", path: "url" }], require: "^https?://" },
			description: { pipe: [{ op: "path", path: "description" }], optional: true },
		},
		fields: [
			{ key: "status", label: "Status", icon: "circle-large-filled", pipe: [{ op: "path", path: "status" }] },
			{
				key: "priority",
				label: "Priority",
				icon: "flame",
				pipe: [
					{
						op: "coalesce",
						of: [[{ op: "path", path: "priority" }], [{ op: "path", path: "priority.name" }]],
					},
				],
			},
			{
				key: "labels",
				label: "Labels",
				icon: "tag",
				pipe: [
					{ op: "path", path: "labels" },
					{ op: "join", sep: ", " },
				],
			},
		],
		storage: { nativeIdPathSafe: true },
		render: {
			wrapperTag: "linear-issues",
			itemTag: "issue",
			bodyTag: "description",
			maxCharsPerReference: 4000,
			maxTotalChars: 30000,
		},
	};
}

function miniNotionDef(): SourceDefinition {
	return {
		id: "notion",
		label: "Notion",
		icon: "file-text",
		match: {},
		wrapperKeys: ["results", "items", "pages"],
		reference: {
			guard: { pipe: [{ op: "path", path: "metadata.type" }], require: "^page$" },
			nativeId: {
				pipe: [
					{ op: "path", path: "url" },
					{ op: "regex", pattern: "[-/]([0-9a-fA-F]{32})(?=[/?#]|$)", lastMatch: true },
					{ op: "transform", fn: "lowercase" },
				],
			},
			title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
			url: { pipe: [{ op: "path", path: "url" }] },
			description: { pipe: [{ op: "path", path: "text" }], optional: true },
		},
		fields: [{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "page" }] }],
		storage: { nativeIdPathSafe: true },
		render: {
			wrapperTag: "notion-pages",
			itemTag: "page",
			bodyTag: "content",
			fieldAttrs: false,
			maxCharsPerReference: 30000,
			maxTotalChars: 60000,
		},
	};
}

describe("SourceEngine ops", () => {
	it("path reads dotted json path", () => {
		expect(evalPipe([{ op: "path", path: "a.b" }], { a: { b: "x" } })).toBe("x");
		expect(evalPipe([{ op: "path", path: "missing" }], {})).toBeUndefined();
	});
	it("coalesce takes first non-empty pipe", () => {
		const p = [{ op: "coalesce", of: [[{ op: "path", path: "a" }], [{ op: "path", path: "b" }]] }] as const;
		expect(evalPipe(p, { b: "y" })).toBe("y");
	});
	it("regex extract composes capture groups", () => {
		const p = [
			{ op: "path", path: "u" },
			{ op: "regex", pattern: "gh/(\\w+)/(\\w+)#(\\d+)", extract: "$1/$2#$3" },
		] as const;
		expect(evalPipe(p, { u: "gh/o/r#5" })).toBe("o/r#5");
	});
	it("regex lastMatch takes the last global match's group 1", () => {
		const p = [
			{ op: "path", path: "u" },
			{ op: "regex", pattern: "-([0-9a-f]{4})", lastMatch: true },
		] as const;
		expect(evalPipe(p, { u: "x-aaaa-bbbb" })).toBe("bbbb");
	});
	it("regex with no extract and no capture group returns whole match; no match → undefined (validate use)", () => {
		// No capture group → `m[1] ?? m[0]` falls back to the whole match `m[0]`. For an
		// unanchored-at-end pattern like `^https?://` that is the matched prefix
		// ("https://"), not the full input string.
		expect(
			evalPipe(
				[
					{ op: "path", path: "u" },
					{ op: "regex", pattern: "^https?://" },
				],
				{ u: "https://x" },
			),
		).toBe("https://");
		expect(
			evalPipe(
				[
					{ op: "path", path: "u" },
					{ op: "regex", pattern: "^https?://" },
				],
				{ u: "ftp://x" },
			),
		).toBeUndefined();
	});
	it("regex with no extract but a capture group returns group 1 (parity with lastMatch branch)", () => {
		// Single-match and lastMatch branches must agree: a capture group yields that
		// group, not the whole match. (Regression guard for the old `m[0]`-only default.)
		expect(
			evalPipe(
				[
					{ op: "path", path: "u" },
					{ op: "regex", pattern: "KAN-(\\d+)" },
				],
				{ u: "KAN-123" },
			),
		).toBe("123");
	});
	it("a non-first `path` op after an undefined-yielding op stays undefined (no root re-read)", () => {
		// `[coalesce→undefined, path]`: the trailing `path` must operate on the threaded
		// `undefined`, NOT jump back to the root payload. Regression guard for the old
		// `input === undefined ? payload : input` first-op detection.
		expect(
			evalPipe(
				[
					{ op: "coalesce", of: [[{ op: "path", path: "missing" }]] },
					{ op: "path", path: "present" },
				],
				{ present: "root-value" },
			),
		).toBeUndefined();
	});
	it("template interpolates named sub-pipes", () => {
		const p = [
			{
				op: "template",
				template: "{o}/{r}#{n}",
				from: {
					o: [{ op: "path", path: "owner" }],
					r: [{ op: "path", path: "repo" }],
					n: [{ op: "path", path: "number" }],
				},
			},
		] as const;
		expect(evalPipe(p, { owner: "o", repo: "r", number: 5 })).toBe("o/r#5");
	});
	it("template yields undefined if any slot is missing", () => {
		const p = [
			{
				op: "template",
				template: "{o}/{r}",
				from: { o: [{ op: "path", path: "owner" }], r: [{ op: "path", path: "repo" }] },
			},
		] as const;
		expect(evalPipe(p, { owner: "o" })).toBeUndefined();
	});
	it("join collapses an array", () => {
		expect(
			evalPipe(
				[
					{ op: "path", path: "labels" },
					{ op: "join", sep: ", " },
				],
				{ labels: ["a", "b"] },
			),
		).toBe("a, b");
	});
	it("const returns literal", () => {
		expect(evalPipe([{ op: "const", value: "page" }], {})).toBe("page");
	});
	it("transform decodeHtmlEntities + lowercase from closed registry", () => {
		expect(
			evalPipe(
				[
					{ op: "const", value: "a&#x27;b" },
					{ op: "transform", fn: "decodeHtmlEntities" },
				],
				{},
			),
		).toBe("a'b");
		expect(
			evalPipe(
				[
					{ op: "const", value: "ABC" },
					{ op: "transform", fn: "lowercase" },
				],
				{},
			),
		).toBe("abc");
	});
	it("unknown transform fn throws (fail-closed)", () => {
		expect(() =>
			evalPipe(
				[
					{ op: "const", value: "x" },
					{ op: "transform", fn: "rm -rf" },
				],
				{},
			),
		).toThrow(/unknown transform/i);
	});
	it("transform fn resolving to a prototype method throws (closed-registry, not prototype-chain lookup)", () => {
		expect(() =>
			evalPipe(
				[
					{ op: "const", value: "x" },
					{ op: "transform", fn: "toString" },
				],
				{},
			),
		).toThrow(/unknown transform/i);
	});
	it("registry is closed and enumerable", () => {
		expect(Object.keys(TRANSFORMS).sort()).toEqual(["decodeHtmlEntities", "lowercase"]);
	});
	it("transform on an undefined threaded input yields undefined (no call)", () => {
		expect(
			evalPipe(
				[
					{ op: "path", path: "missing" },
					{ op: "transform", fn: "lowercase" },
				],
				{},
			),
		).toBeUndefined();
	});
	it("an empty-string pipe result evaluates to undefined", () => {
		expect(evalPipe([{ op: "const", value: "" }], {})).toBeUndefined();
	});
	it("regex on an undefined threaded input yields undefined", () => {
		expect(
			evalPipe(
				[
					{ op: "path", path: "missing" },
					{ op: "regex", pattern: "x" },
				],
				{},
			),
		).toBeUndefined();
	});
	it("regex lastMatch with zero matches yields undefined", () => {
		const p = [
			{ op: "path", path: "u" },
			{ op: "regex", pattern: "-([0-9a-f]{4})", lastMatch: true },
		] as const;
		expect(evalPipe(p, { u: "no-hex-here" })).toBeUndefined();
	});
	it("regex lastMatch combined with extract applies the capture-group template to the last match", () => {
		const p = [
			{ op: "path", path: "u" },
			{ op: "regex", pattern: "id=(\\d+)", lastMatch: true, extract: "n$1" },
		] as const;
		expect(evalPipe(p, { u: "id=1 id=2 id=3" })).toBe("n3");
	});
	it("regex lastMatch with no capture group falls back to the whole last match", () => {
		const p = [
			{ op: "path", path: "u" },
			{ op: "regex", pattern: "\\d+", lastMatch: true },
		] as const;
		expect(evalPipe(p, { u: "a1 b22 c333" })).toBe("333");
	});
	it("an empty threaded string coerces to undefined for regex input", () => {
		expect(
			evalPipe(
				[
					{ op: "const", value: "" },
					{ op: "regex", pattern: "x" },
				],
				{},
			),
		).toBeUndefined();
	});
	it("expand falls back to an empty string for a missing capture group index", () => {
		const p = [
			{ op: "path", path: "u" },
			{ op: "regex", pattern: "(\\d+)", extract: "$1-$2" },
		] as const;
		expect(evalPipe(p, { u: "42" })).toBe("42-");
	});
	it("chained path ops thread the sub-object into the second path", () => {
		expect(
			evalPipe(
				[
					{ op: "path", path: "a" },
					{ op: "path", path: "b" },
				],
				{ a: { b: "x" } },
			),
		).toBe("x");
	});
	it("join yields undefined when the array has no usable string entries", () => {
		expect(
			evalPipe(
				[
					{ op: "path", path: "labels" },
					{ op: "join", sep: ", " },
				],
				{ labels: [1, null, ""] },
			),
		).toBeUndefined();
	});

	it("deep single path reads a nested field (jira fields.status.name)", () => {
		expect(evalPipe([{ op: "path", path: "fields.status.name" }], { fields: { status: { name: "Done" } } })).toBe(
			"Done",
		);
	});

	it("path -> regex -> transform threads the value through the chain (notion page-id case)", () => {
		const p = [
			{ op: "path", path: "url" },
			{ op: "regex", pattern: "[-/]([0-9a-fA-F]{32})(?=[/?#]|$)", lastMatch: true },
			{ op: "transform", fn: "lowercase" },
		] as const;
		expect(evalPipe(p, { url: "https://www.notion.so/Page-Title-36C4FC101D34805AB1FDFB3E69144580" })).toBe(
			"36c4fc101d34805ab1fdfb3e69144580",
		);
	});
});

describe("extractRef", () => {
	it("extractRef builds a Reference and voids on failed require", () => {
		const def = miniLinearDef();
		const ok = extractRef(
			def,
			{ id: "PROJ-1", title: "T", url: "https://x", status: "Open", labels: ["a", "b"] },
			"tool",
			"TS",
		);
		expect(ok).toMatchObject({
			mapKey: "linear:PROJ-1",
			source: "linear",
			nativeId: "PROJ-1",
			title: "T",
			url: "https://x",
		});
		expect(ok?.fields?.find((f) => f.key === "labels")?.value).toBe("a, b");
		expect(ok?.description).toBeUndefined();
		expect(extractRef(def, { id: "bad id", title: "T", url: "https://x" }, "tool", "TS")).toBeNull();
	});

	it("returns null for a non-object payload", () => {
		expect(extractRef(miniLinearDef(), "not-an-object", "tool", "TS")).toBeNull();
	});

	it("voids when a required field is entirely missing (not just require-mismatched)", () => {
		expect(extractRef(miniLinearDef(), { id: "PROJ-1", url: "https://x" }, "tool", "TS")).toBeNull();
	});

	it("voids when a normally-required field is misconfigured as optional and ends up undefined", () => {
		const base = miniLinearDef();
		const def: SourceDefinition = {
			...base,
			reference: { ...base.reference, nativeId: { pipe: [{ op: "path", path: "id" }], optional: true } },
		};
		expect(extractRef(def, { title: "T", url: "https://x" }, "tool", "TS")).toBeNull();
	});

	it("bag fields render without an icon key when the spec has none", () => {
		const base = miniLinearDef();
		const def: SourceDefinition = {
			...base,
			fields: [{ key: "note", label: "Note", pipe: [{ op: "const", value: "n" }] }],
		};
		const ref = extractRef(def, { id: "PROJ-1", title: "T", url: "https://x" }, "tool", "TS");
		expect(ref?.fields).toEqual([{ key: "note", label: "Note", value: "n" }]);
	});

	it("keeps an optional description when present and drops it when absent", () => {
		const def = miniLinearDef();
		const withDesc = extractRef(
			def,
			{ id: "PROJ-1", title: "T", url: "https://x", description: "Body" },
			"tool",
			"TS",
		);
		expect(withDesc?.description).toBe("Body");
		const withoutDesc = extractRef(def, { id: "PROJ-1", title: "T", url: "https://x" }, "tool", "TS");
		expect(withoutDesc?.description).toBeUndefined();
	});

	it("resolves priority from a coalesced object shape and omits empty priority", () => {
		const def = miniLinearDef();
		const withPriorityObj = extractRef(
			def,
			{ id: "PROJ-1", title: "T", url: "https://x", priority: { name: "Urgent" } },
			"tool",
			"TS",
		);
		expect(withPriorityObj?.fields?.find((f) => f.key === "priority")?.value).toBe("Urgent");
		const withEmptyPriority = extractRef(
			def,
			{ id: "PROJ-1", title: "T", url: "https://x", priority: { name: "" } },
			"tool",
			"TS",
		);
		expect(withEmptyPriority?.fields?.find((f) => f.key === "priority")).toBeUndefined();
	});

	it("coalesce drops a bare numeric scalar rather than stringifying it", () => {
		// A numeric priority is not a display value — the pre-migration adapters'
		// `readPriority` required string-or-`{name}` and dropped a number. The engine
		// must not stringify it into `priority="42"`. (Guards the numeric-scalar regression.)
		const def = miniLinearDef();
		const numericPriority = extractRef(
			def,
			{ id: "PROJ-1", title: "T", url: "https://x", priority: 42 },
			"tool",
			"TS",
		);
		expect(numericPriority?.fields?.find((f) => f.key === "priority")).toBeUndefined();
	});

	it("extracts fine with no description spec at all in the definition", () => {
		const base = miniLinearDef();
		const { description: _omit, ...refWithoutDescription } = base.reference;
		const def: SourceDefinition = { ...base, reference: refWithoutDescription };
		const ref = extractRef(def, { id: "PROJ-1", title: "T", url: "https://x" }, "tool", "TS");
		expect(ref?.description).toBeUndefined();
	});

	it("voids when a present description fails its require pattern", () => {
		const base = miniLinearDef();
		const def: SourceDefinition = {
			...base,
			reference: {
				...base.reference,
				description: { pipe: [{ op: "path", path: "description" }], require: "^ok:" },
			},
		};
		expect(
			extractRef(def, { id: "PROJ-1", title: "T", url: "https://x", description: "nope" }, "tool", "TS"),
		).toBeNull();
	});

	it("guard voids the reference when the gate does not match", () => {
		const def = miniNotionDef();
		const payload = {
			metadata: { type: "database" },
			title: "T",
			url: "https://www.notion.so/36c4fc101d34805ab1fdfb3e69144580",
		};
		expect(extractRef(def, payload, "tool", "TS")).toBeNull();
	});

	it("guard passes the reference through when the gate matches", () => {
		const def = miniNotionDef();
		const payload = {
			metadata: { type: "page" },
			title: "T",
			url: "https://www.notion.so/36C4FC101D34805AB1FDFB3E69144580",
		};
		const ref = extractRef(def, payload, "tool", "TS");
		expect(ref?.nativeId).toBe("36c4fc101d34805ab1fdfb3e69144580");
	});
});

describe("extractRef required url", () => {
	const canonNoUrl = { channelId: "C1", parentTs: "1700000000.000001", title: "t", text: "body", replyCount: 0 };
	it("voids Slack when its (now-required) url is missing", () => {
		expect(extractRef(slackDefinition, canonNoUrl, "tool", "2026-01-01T00:00:00Z")).toBeNull();
	});
	it("still voids a source whose url is required and missing (linear)", () => {
		expect(extractRef(linearDefinition, { id: "PROJ-1", title: "x" }, "tool", "2026-01-01T00:00:00Z")).toBeNull();
	});
});

describe("renderBlock", () => {
	it("renderBlock reproduces the Linear XML byte-for-byte", () => {
		const def = miniLinearDef();
		const ref: Reference = {
			mapKey: "linear:ENG-1",
			source: "linear",
			nativeId: "ENG-1",
			title: "Fix",
			url: "https://l/ENG-1",
			description: "Body",
			fields: [{ key: "status", label: "Status", value: "Open", icon: "circle-large-filled" }],
			toolName: "t",
			referencedAt: "2026-01-01",
		};
		const out = renderBlock(def, [ref]);
		expect(out).toBe(
			'<linear-issues>\n<issue id="ENG-1" status="Open">\n  <title>Fix</title>\n  <url>https://l/ENG-1</url>\n  <description>\nBody\n  </description>\n</issue>\n</linear-issues>',
		);
	});

	it("renderBlock omits body block when no description; Notion uses <content> + no field attrs", () => {
		const def = miniNotionDef();
		const ref: Reference = {
			mapKey: "notion:36c4fc101d34805ab1fdfb3e69144580",
			source: "notion",
			nativeId: "36c4fc101d34805ab1fdfb3e69144580",
			title: "Page",
			url: "https://www.notion.so/36c4fc101d34805ab1fdfb3e69144580",
			fields: [{ key: "entity-type", label: "Type", value: "page", icon: "symbol-class" }],
			toolName: "t",
			referencedAt: "2026-01-01",
		};
		const out = renderBlock(def, [ref]);
		expect(out).toBe(
			'<notion-pages>\n<page id="36c4fc101d34805ab1fdfb3e69144580">\n  <title>Page</title>\n  <url>https://www.notion.so/36c4fc101d34805ab1fdfb3e69144580</url>\n</page>\n</notion-pages>',
		);
	});

	it("renderBlock omits the <url> line entirely when a reference has no url", () => {
		const def = miniLinearDef();
		const ref: Reference = {
			mapKey: "linear:X-1",
			source: "linear",
			nativeId: "X-1",
			title: "T",
			toolName: "t",
			referencedAt: "2026-01-01",
		};
		const out = renderBlock(def, [ref]);
		expect(out).not.toContain("<url>");
	});

	it("renderBlock returns an empty string for an empty ref list", () => {
		expect(renderBlock(miniLinearDef(), [])).toBe("");
	});

	it("renderBlock drops references that would blow the total budget, returning empty string if none fit", () => {
		const def = miniLinearDef();
		const tight: SourceDefinition = { ...def, render: { ...def.render, maxTotalChars: 5 } };
		const ref: Reference = {
			mapKey: "linear:X-1",
			source: "linear",
			nativeId: "X-1",
			title: "T",
			url: "https://x",
			toolName: "t",
			referencedAt: "2026-01-01",
		};
		expect(renderBlock(tight, [ref])).toBe("");
	});

	it("renderBlock skips an over-budget newest reference but keeps a smaller older one that fits", () => {
		const def = miniLinearDef();
		// Budget fits the small ref but not the large newest one — the large one must
		// be skipped (not `break`), so the small older ref is still packed.
		const small: Reference = {
			mapKey: "linear:S-1",
			source: "linear",
			nativeId: "S-1",
			title: "small",
			url: "https://x",
			toolName: "t",
			referencedAt: "2020-01-01",
		};
		const large: Reference = {
			mapKey: "linear:L-1",
			source: "linear",
			nativeId: "L-1",
			title: "large",
			url: "https://x",
			description: "x".repeat(5000),
			toolName: "t",
			referencedAt: "2026-01-01", // newest → sorted first
		};
		const smallRendered = renderBlock(def, [small]).length;
		const tight: SourceDefinition = { ...def, render: { ...def.render, maxTotalChars: smallRendered } };
		const out = renderBlock(tight, [large, small]);
		expect(out).toContain("S-1");
		expect(out).not.toContain("L-1");
	});

	it("renderBlock truncates a description longer than maxCharsPerReference", () => {
		const def = miniLinearDef();
		const tight: SourceDefinition = { ...def, render: { ...def.render, maxCharsPerReference: 4 } };
		const ref: Reference = {
			mapKey: "linear:X-1",
			source: "linear",
			nativeId: "X-1",
			title: "T",
			url: "https://x",
			description: "x".repeat(10),
			toolName: "t",
			referencedAt: "2026-01-01",
		};
		const out = renderBlock(tight, [ref]);
		expect(out).toContain("…[truncated, 6 more chars]");
	});

	it("renderBlock orders multiple fitting references oldest-first in the final block", () => {
		const def = miniLinearDef();
		const refOld: Reference = {
			mapKey: "linear:A-1",
			source: "linear",
			nativeId: "A-1",
			title: "Old",
			url: "https://x",
			toolName: "t",
			referencedAt: "2020-01-01",
		};
		const refNew: Reference = {
			mapKey: "linear:A-2",
			source: "linear",
			nativeId: "A-2",
			title: "New",
			url: "https://x",
			toolName: "t",
			referencedAt: "2026-01-01",
		};
		const out = renderBlock(def, [refNew, refOld]);
		expect(out.indexOf("A-1")).toBeLessThan(out.indexOf("A-2"));
	});
});
