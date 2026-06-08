import { describe, expect, it } from "vitest";
import { jiraCodexBinding } from "./CodexJiraBinding.js";

const normalize = (b: unknown) => jiraCodexBinding.normalize(b);
const recover = (event: unknown, raw: string) => jiraCodexBinding.recover?.(event, raw);

// Real Codex node: NO `fields`; summary under versionedRepresentations; webUrl top-level.
const NODE = {
	key: "KAN-4",
	self: "https://api.atlassian.com/ex/jira/x/rest/api/3/issue/10013",
	webUrl: "https://acme.atlassian.net/browse/KAN-4",
	versionedRepresentations: { summary: { "1": "Add Jira issue auto-discovery" } },
};

describe("jiraCodexBinding.normalize (derive fields.summary from versionedRepresentations)", () => {
	it("reshapes each node in the {issues:{nodes:[…]}} wrapper", () => {
		const out = normalize({ issues: { totalCount: 1, nodes: [NODE] } }) as {
			issues: { nodes: Array<{ key: string; webUrl: string; fields: { summary: string } }> };
		};
		const node = out.issues.nodes[0];
		expect(node.key).toBe("KAN-4");
		expect(node.webUrl).toBe("https://acme.atlassian.net/browse/KAN-4");
		expect(node.fields.summary).toBe("Add Jira issue auto-discovery");
	});

	it("reshapes a bare node too (recovery path input)", () => {
		const out = normalize(NODE) as { fields: { summary: string } };
		expect(out.fields.summary).toBe("Add Jira issue auto-discovery");
	});

	it("passes non-object node elements through untouched", () => {
		const out = normalize({ issues: { nodes: [123, NODE] } }) as { issues: { nodes: unknown[] } };
		expect(out.issues.nodes[0]).toBe(123);
		expect((out.issues.nodes[1] as { fields: { summary: string } }).fields.summary).toBe(
			"Add Jira issue auto-discovery",
		);
	});

	it("merges summary into an existing fields object that lacks it", () => {
		const out = normalize({
			key: "KAN-4",
			fields: { status: { name: "To Do" } },
			versionedRepresentations: { summary: { "1": "S" } },
		}) as {
			fields: { summary: string; status: { name: string } };
		};
		expect(out.fields.summary).toBe("S");
		expect(out.fields.status.name).toBe("To Do");
	});

	it("picks the latest (highest-version) summary representation", () => {
		const out = normalize({ key: "KAN-4", versionedRepresentations: { summary: { "1": "old", "2": "new" } } }) as {
			fields: { summary: string };
		};
		expect(out.fields.summary).toBe("new");
	});

	it("leaves an already adapter-shaped node (with fields.summary) untouched", () => {
		const shaped = {
			key: "KAN-4",
			webUrl: "https://acme.atlassian.net/browse/KAN-4",
			fields: { summary: "S", status: { name: "To Do" } },
		};
		expect(normalize(shaped)).toBe(shaped);
	});

	it("does not add fields when no usable summary exists", () => {
		expect((normalize({ key: "KAN-4" }) as { fields?: unknown }).fields).toBeUndefined();
		expect(
			(normalize({ key: "KAN-4", versionedRepresentations: { summary: { "1": "" } } }) as { fields?: unknown })
				.fields,
		).toBeUndefined();
		expect(
			(normalize({ key: "KAN-4", versionedRepresentations: { summary: "notobj" } }) as { fields?: unknown })
				.fields,
		).toBeUndefined();
	});

	it("returns non-object input unchanged", () => {
		expect(normalize(123)).toBe(123);
		expect(normalize(null)).toBe(null);
	});
});

describe("jiraCodexBinding.normalize — description (ADF → markdown)", () => {
	const withDescription = (description: unknown) =>
		normalize({ key: "KAN-4", versionedRepresentations: { summary: { "1": "S" }, description } }) as {
			fields: { description?: string };
		};

	it("converts an ADF document (heading/paragraph/lists/blockquote/code) to markdown", () => {
		const adf = {
			"1": {
				type: "doc",
				content: [
					{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
					{ type: "paragraph", content: [{ type: "text", text: "Do the thing." }] },
					{
						type: "bulletList",
						content: [
							{
								type: "listItem",
								content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
							},
							{
								type: "listItem",
								content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
							},
						],
					},
					{
						type: "orderedList",
						content: [
							{
								type: "listItem",
								content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }],
							},
						],
					},
					{
						type: "blockquote",
						content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
					},
					{ type: "codeBlock", content: [{ type: "text", text: "code()" }] },
				],
			},
		};
		const out = withDescription(adf).fields.description ?? "";
		expect(out).toContain("## Goal");
		expect(out).toContain("Do the thing.");
		expect(out).toContain("- a");
		expect(out).toContain("- b");
		expect(out).toContain("1. first");
		expect(out).toContain("> quoted");
		expect(out).toContain("code()");
	});

	it("uses a plain-string description representation directly", () => {
		expect(withDescription({ "1": "plain text desc" }).fields.description).toBe("plain text desc");
	});

	it("omits description when none is present or it is empty", () => {
		expect(withDescription(undefined).fields.description).toBeUndefined();
		expect(withDescription({ "1": "   " }).fields.description).toBeUndefined();
		expect(withDescription({ "1": { type: "doc", content: [] } }).fields.description).toBeUndefined();
	});

	it("clamps unknown/extreme heading levels into 1–6 markdown hashes", () => {
		const adf = {
			"1": {
				type: "doc",
				content: [{ type: "heading", attrs: { level: 9 }, content: [{ type: "text", text: "Deep" }] }],
			},
		};
		expect(withDescription(adf).fields.description).toContain("###### Deep");
	});
});

describe("jiraCodexBinding.recover (salvage webUrl from malformed output)", () => {
	const RAW_WITH_URL =
		'Wall time: 7s\nOutput:\n{"issues":{"nodes":[{ ...broken... "webUrl":"https://acme.atlassian.net/browse/KAN-4"}]}}';

	it("injects the salvaged webUrl onto a valid event payload that lacks it", () => {
		const event = { key: "KAN-4", versionedRepresentations: { summary: { "1": "s" } } };
		const out = recover(event, RAW_WITH_URL) as { webUrl: string; key: string };
		expect(out.webUrl).toBe("https://acme.atlassian.net/browse/KAN-4");
		expect(out.key).toBe("KAN-4");
	});

	it("leaves an event that already has a webUrl unchanged", () => {
		const event = { key: "KAN-4", webUrl: "https://acme.atlassian.net/browse/KAN-4" };
		expect(recover(event, "Wall time: 1s\nOutput:\n{}")).toBe(event);
	});

	it("returns null when no webUrl can be salvaged, or the event is not an object", () => {
		expect(recover({ key: "KAN-4" }, "Wall time: 1s\nOutput:\n{ no url }")).toBeNull();
		expect(recover(null, RAW_WITH_URL)).toBeNull();
	});
});
