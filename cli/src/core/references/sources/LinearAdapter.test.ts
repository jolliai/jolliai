import { describe, expect, it } from "vitest";
import type { Reference } from "../../../Types.js";
import { LinearAdapter } from "./LinearAdapter.js";
import { unwrap } from "./TestHelpers.js";

const fieldVal = (r: Reference | null | undefined, key: string): string | undefined =>
	r?.fields?.find((f) => f.key === key)?.value;

describe("LinearAdapter", () => {
	const ts = "2026-05-26T00:00:00.000Z";
	const toolName = "mcp__linear__get_issue";

	it("extracts a Linear issue payload to an Reference", () => {
		const ref = LinearAdapter.extractRef(
			{
				id: "PROJ-1234",
				title: "Sample",
				url: "https://linear.app/x/issue/PROJ-1234",
				status: "In Progress",
				priority: "High",
				labels: ["bug"],
				description: "Body",
			},
			toolName,
			ts,
		);
		expect(ref).toMatchObject({
			mapKey: "linear:PROJ-1234",
			source: "linear",
			nativeId: "PROJ-1234",
			description: "Body",
		});
		expect(fieldVal(ref, "status")).toBe("In Progress");
		expect(fieldVal(ref, "priority")).toBe("High");
		expect(fieldVal(ref, "labels")).toBe("bug");
	});

	it("accepts priority as an object with name", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "x", url: "https://x.example", priority: { name: "Urgent" } },
			toolName,
			ts,
		);
		expect(fieldVal(ref, "priority")).toBe("Urgent");
	});

	it("filters non-string labels", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "x", url: "https://x.example", labels: ["good", 42, ""] },
			toolName,
			ts,
		);
		expect(fieldVal(ref, "labels")).toBe("good");
	});

	it("rejects non-ticket id / missing fields / bad url / non-object payload", () => {
		expect(LinearAdapter.extractRef({ id: "not-a-ticket", title: "x", url: "https://x" }, toolName, ts)).toBeNull();
		expect(LinearAdapter.extractRef({ id: "PROJ-1", url: "https://x" }, toolName, ts)).toBeNull();
		expect(LinearAdapter.extractRef({ id: "PROJ-1", title: "", url: "https://x" }, toolName, ts)).toBeNull();
		expect(LinearAdapter.extractRef({ id: "PROJ-1", title: "x", url: "javascript:1" }, toolName, ts)).toBeNull();
		expect(LinearAdapter.extractRef(null, toolName, ts)).toBeNull();
		expect(LinearAdapter.extractRef([], toolName, ts)).toBeNull();
		expect(LinearAdapter.extractRef("string", toolName, ts)).toBeNull();
	});

	it("renderPromptBlock emits <linear-issues> wrapper; respects maxCharsPerReference", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-9", title: "T", url: "https://x.example", description: "x".repeat(5000) },
			toolName,
			ts,
		);
		const out = LinearAdapter.renderPromptBlock([unwrap(ref)], { maxCharsPerReference: 1000 });
		expect(out).toContain("<linear-issues>");
		expect(out).toContain('id="PROJ-9"');
		expect(out).toContain("…[truncated, ");
	});

	it("renderPromptBlock returns empty for empty input", () => {
		expect(LinearAdapter.renderPromptBlock([])).toBe("");
	});

	it("renderPromptBlock returns empty when nothing fits the budget", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-9", title: "T", url: "https://x.example", description: "x".repeat(5000) },
			toolName,
			ts,
		);
		expect(LinearAdapter.renderPromptBlock([unwrap(ref)], { maxCharsPerReference: 5000, maxTotalChars: 10 })).toBe(
			"",
		);
	});

	it("renderPromptBlock sorts ascending by referencedAt; both included when total fits", () => {
		const older = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "older", url: "https://x.example" },
			toolName,
			"2026-01-01T00:00:00Z",
		);
		const newer = LinearAdapter.extractRef(
			{ id: "PROJ-2", title: "newer", url: "https://x.example" },
			toolName,
			"2026-05-01T00:00:00Z",
		);
		const out = LinearAdapter.renderPromptBlock([unwrap(older), unwrap(newer)]);
		expect(out.indexOf('id="PROJ-1"')).toBeGreaterThan(-1);
		expect(out.indexOf('id="PROJ-2"')).toBeGreaterThan(-1);
		// ascending order in output (older first)
		expect(out.indexOf('id="PROJ-1"')).toBeLessThan(out.indexOf('id="PROJ-2"'));
	});

	it("renderPromptBlock drops the oldest when budget forces a choice", () => {
		const older = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "older", url: "https://x.example", description: "a".repeat(500) },
			toolName,
			"2026-01-01T00:00:00Z",
		);
		const newer = LinearAdapter.extractRef(
			{ id: "PROJ-2", title: "newer", url: "https://x.example", description: "b".repeat(500) },
			toolName,
			"2026-05-01T00:00:00Z",
		);
		// Budget fits exactly one entity (chrome + 500-char body ≈ 620 chars).
		const out = LinearAdapter.renderPromptBlock([unwrap(older), unwrap(newer)], { maxTotalChars: 700 });
		expect(out).toContain('id="PROJ-2"');
		expect(out).not.toContain('id="PROJ-1"');
	});

	it("renderPromptBlock escapes attributes and text content per XML context", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: 'Title with "quote" & <tag>', url: "https://x.example", status: 'evil"value' },
			toolName,
			ts,
		);
		const out = LinearAdapter.renderPromptBlock([unwrap(ref)]);
		// status is an attribute → quotes ARE escaped.
		expect(out).toContain('status="evil&quot;value"');
		// title goes into text content → & and < escaped, but " preserved.
		expect(out).toContain('Title with "quote" &amp; &lt;tag&gt;');
	});

	it("exposes id, mcpPrefix, wrapperKeys, maxCharsPerReference", () => {
		expect(LinearAdapter.id).toBe("linear");
		expect(LinearAdapter.mcpPrefix).toBe("mcp__linear__");
		expect(LinearAdapter.wrapperKeys).toEqual(["items", "issues", "nodes", "results"]);
		expect(LinearAdapter.maxCharsPerReference).toBe(4000);
	});

	it("priority object with empty name falls back to undefined", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "x", url: "https://x.example", priority: { name: "" } },
			toolName,
			ts,
		);
		expect(fieldVal(ref, "priority")).toBeUndefined();
	});

	it("priority object without a name field falls back to undefined", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "x", url: "https://x.example", priority: {} },
			toolName,
			ts,
		);
		expect(fieldVal(ref, "priority")).toBeUndefined();
	});

	it("labels with no string entries returns undefined", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "x", url: "https://x.example", labels: [42, null, ""] },
			toolName,
			ts,
		);
		expect(fieldVal(ref, "labels")).toBeUndefined();
	});

	it("renderPromptBlock works for minimal ref (no status/priority/labels/description)", () => {
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "Minimal", url: "https://x.example" },
			toolName,
			ts,
		);
		const out = LinearAdapter.renderPromptBlock([unwrap(ref)]);
		expect(out).toContain('<issue id="PROJ-1">');
		expect(out).toContain("<title>Minimal</title>");
		expect(out).not.toContain("status=");
		expect(out).not.toContain("priority=");
		expect(out).not.toContain("labels=");
		expect(out).not.toContain("<description>");
	});

	it("renderPromptBlock emits no field attrs when the fields bag is absent", () => {
		// Hand-built ref with no fields bag: renderOne emits only the id attr.
		const ref: Reference = {
			mapKey: "linear:PROJ-1",
			source: "linear",
			nativeId: "PROJ-1",
			title: "x",
			url: "https://x.example",
			toolName,
			referencedAt: ts,
		};
		const out = LinearAdapter.renderPromptBlock([ref]);
		expect(out).toContain('<issue id="PROJ-1">');
		expect(out).not.toContain("labels=");
		expect(out).not.toContain("status=");
	});

	it("renderPromptBlock skips description block when description is empty string", () => {
		// A LinearRef with description="" should pass through extractRef as undefined,
		// but if a caller hand-constructs a ref with empty description, renderOne
		// must not emit the <description> wrapper.
		const ref = LinearAdapter.extractRef(
			{ id: "PROJ-1", title: "x", url: "https://x.example", description: "" },
			toolName,
			ts,
		);
		const out = LinearAdapter.renderPromptBlock([unwrap(ref)]);
		expect(out).not.toContain("<description>");
	});
});
