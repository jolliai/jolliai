import { describe, expect, it, vi } from "vitest";
import { getRegistry, validateDefinition } from "./SourceDefinitionRegistry.js";
import { linearDefinition } from "./sources/definitions/linear.js";

/** Deep-cloned copy of the real Linear definition, safe to mutate per-test. */
function structuredCloneOfLinear() {
	return structuredClone(linearDefinition);
}

describe("SourceDefinitionRegistry", () => {
	it("match resolves Claude by prefix, honoring acceptSuffix", () => {
		const r = getRegistry();
		expect(r.match("claude", "mcp__linear__get_issue")?.id).toBe("linear");
		expect(r.match("claude", "mcp__claude_ai_Notion__notion-fetch")?.id).toBe("notion");
		expect(r.match("claude", "mcp__claude_ai_Notion__notion-search")).toBeUndefined(); // acceptSuffix gate
	});

	it("match rejects Claude enumeration tools via denySuffixes, keeps single-entity fetches", () => {
		const r = getRegistry();
		// Enumeration tools are excluded (bulk-capture guard):
		expect(r.match("claude", "mcp__linear__list_issues")).toBeUndefined();
		expect(r.match("claude", "mcp__linear__search_issues")).toBeUndefined();
		expect(r.match("claude", "mcp__claude_ai_Linear__list_issues")).toBeUndefined();
		// Single-entity fetches still resolve:
		expect(r.match("claude", "mcp__linear__get_issue")?.id).toBe("linear");
	});

	it("no longer matches Codex Linear enumeration tools", () => {
		const r = getRegistry();
		expect(r.match("codex", "_list_issues", "linear")).toBeUndefined();
		expect(r.match("codex", "_search", "linear")).toBeUndefined();
		expect(r.match("codex", "linear.list_issues")).toBeUndefined();
		expect(r.match("codex", "linear.search")).toBeUndefined();
		// Single-entity Codex Linear tools still resolve:
		expect(r.match("codex", "_get_issue", "linear")?.id).toBe("linear");
		expect(r.match("codex", "linear.get_issue")?.id).toBe("linear");
	});

	it("match resolves Codex by namespaceSuffix + name, and by invocation tool", () => {
		const r = getRegistry();
		expect(r.match("codex", "_fetch", "linear")?.id).toBe("linear"); // function_call path
		expect(r.match("codex", "_fetch", "notion")?.id).toBe("notion"); // same name, disambiguated by namespace
		expect(r.match("codex", "linear.get_issue")?.id).toBe("linear"); // invocation-tool path (no namespace)
	});

	it("all() is stable order linear,confluence,jira,github,notion,slack,zoom-meeting,zoom-doc,asana,monday,context7", () => {
		expect(
			getRegistry()
				.all()
				.map((d) => d.id),
		).toEqual([
			"linear",
			"confluence",
			"jira",
			"github",
			"notion",
			"slack",
			"zoom-meeting",
			"zoom-doc",
			"asana",
			"monday",
			"context7",
		]);
	});

	it("routes getConfluencePage to confluence and getJiraIssue to jira", () => {
		const r = getRegistry();
		expect(r.match("claude", "mcp__claude_ai_Atlassian__getConfluencePage")?.id).toBe("confluence");
		expect(r.match("claude", "mcp__claude_ai_Atlassian__getJiraIssue")?.id).toBe("jira");
	});

	it("byId() finds a known definition and returns undefined for unknown ids", () => {
		const r = getRegistry();
		expect(r.byId("linear")?.id).toBe("linear");
		expect(r.byId("unknown-source")).toBeUndefined();
	});

	it("match returns undefined for an agent/tool combination with no matching definition", () => {
		const r = getRegistry();
		expect(r.match("claude", "mcp__unknown__tool")).toBeUndefined();
		expect(r.match("codex", "_fetch", "unknown-namespace")).toBeUndefined();
		expect(r.match("codex", "unknown.tool")).toBeUndefined();
	});

	it("built-in invalid definition fails fast", () => {
		expect(validateDefinition({ id: "x" }).ok).toBe(false);
	});

	it("fields[].key charset is enforced at load", () => {
		const bad = {
			...structuredCloneOfLinear(),
			fields: [{ key: "bad key", label: "L", pipe: [{ op: "const", value: "x" }] }],
		};
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("valid definition passes validation and is returned unchanged", () => {
		const result = validateDefinition(structuredCloneOfLinear());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.def.id).toBe("linear");
	});

	it("rejects a transform.fn not present in the closed TRANSFORMS registry", () => {
		const bad = {
			...structuredCloneOfLinear(),
			fields: [
				{
					key: "status",
					label: "Status",
					pipe: [
						{ op: "path", path: "status" },
						{ op: "transform", fn: "not-a-real-transform" },
					],
				},
			],
		};
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it.each(["toString", "constructor", "hasOwnProperty"])(
		"rejects a transform.fn of '%s' resolved via the prototype chain, not own-key membership",
		(fn) => {
			const bad = {
				...structuredCloneOfLinear(),
				fields: [
					{
						key: "status",
						label: "Status",
						pipe: [
							{ op: "path", path: "status" },
							{ op: "transform", fn },
						],
					},
				],
			};
			expect(validateDefinition(bad).ok).toBe(false);
		},
	);

	it("rejects a pipe exceeding 64 ops", () => {
		const bigPipe = Array.from({ length: 65 }, () => ({ op: "const", value: "x" }));
		const bad = { ...structuredCloneOfLinear(), fields: [{ key: "big", label: "Big", pipe: bigPipe }] };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects coalesce/template nesting deeper than 8", () => {
		// Build a coalesce chain nested 9 levels deep.
		let pipe: unknown = [{ op: "const", value: "leaf" }];
		for (let i = 0; i < 9; i++) {
			pipe = [{ op: "coalesce", of: [pipe] }];
		}
		const bad = { ...structuredCloneOfLinear(), fields: [{ key: "deep", label: "Deep", pipe }] };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects an unknown op", () => {
		const bad = {
			...structuredCloneOfLinear(),
			fields: [{ key: "x", label: "X", pipe: [{ op: "not-a-real-op" }] }],
		};
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("getRegistry() returns the same singleton instance across calls", () => {
		expect(getRegistry()).toBe(getRegistry());
	});

	it.each([
		["not an object", "nope"],
		["missing id", { ...structuredCloneOfLinear(), id: "" }],
		["missing label", { ...structuredCloneOfLinear(), label: "" }],
		["missing icon", { ...structuredCloneOfLinear(), icon: "" }],
		["match not an object", { ...structuredCloneOfLinear(), match: undefined }],
		["wrapperKeys not an array", { ...structuredCloneOfLinear(), wrapperKeys: undefined }],
		["reference not an object", { ...structuredCloneOfLinear(), reference: undefined }],
		["fields not an array", { ...structuredCloneOfLinear(), fields: undefined }],
		["storage not an object", { ...structuredCloneOfLinear(), storage: undefined }],
		["render not an object", { ...structuredCloneOfLinear(), render: undefined }],
	])("rejects definitions missing required structure: %s", (_label, bad) => {
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects a reference key (nativeId/title/url) that is not an object", () => {
		const base = structuredCloneOfLinear();
		const bad = { ...base, reference: { ...base.reference, nativeId: undefined } };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("accepts a definition with no reference.description at all", () => {
		const base = structuredCloneOfLinear();
		const referenceWithoutDescription = { ...base.reference };
		delete (referenceWithoutDescription as { description?: unknown }).description;
		const ok = { ...base, reference: referenceWithoutDescription };
		expect(validateDefinition(ok).ok).toBe(true);
	});

	it("rejects reference.description that is present but not an object", () => {
		const base = structuredCloneOfLinear();
		const bad = { ...base, reference: { ...base.reference, description: "nope" } };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects reference.description.pipe that is malformed", () => {
		const base = structuredCloneOfLinear();
		const bad = { ...base, reference: { ...base.reference, description: { pipe: "nope" } } };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects a reference.guard that is not an object", () => {
		const base = structuredCloneOfLinear();
		const bad = { ...base, reference: { ...base.reference, guard: "nope" } };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects a reference.guard whose pipe is not an array", () => {
		const base = structuredCloneOfLinear();
		const bad = { ...base, reference: { ...base.reference, guard: { pipe: "nope" } } };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects a reference.guard.pipe that is malformed", () => {
		const base = structuredCloneOfLinear();
		const bad = {
			...base,
			reference: { ...base.reference, guard: { pipe: [{ op: "not-a-real-op" }] } },
		};
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("accepts a well-formed reference.guard (a FieldSpec with require)", () => {
		const base = structuredCloneOfLinear();
		const ok = {
			...base,
			reference: { ...base.reference, guard: { pipe: [{ op: "const", value: "x" }], require: "^x$" } },
		};
		expect(validateDefinition(ok).ok).toBe(true);
	});

	it("rejects fields[] entries that are not objects", () => {
		const bad = { ...structuredCloneOfLinear(), fields: ["nope"] };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects fields[].label that is empty", () => {
		const bad = {
			...structuredCloneOfLinear(),
			fields: [{ key: "x", label: "", pipe: [{ op: "const", value: "v" }] }],
		};
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it.each([
		["path missing 'path'", { op: "path" }],
		["const missing 'value'", { op: "const" }],
		["join missing 'sep'", { op: "join" }],
		["regex missing 'pattern'", { op: "regex" }],
		["regex extract not a string", { op: "regex", pattern: ".*", extract: 1 }],
		["regex lastMatch not a boolean", { op: "regex", pattern: ".*", lastMatch: "yes" }],
		["transform missing 'fn'", { op: "transform" }],
		["coalesce missing 'of'", { op: "coalesce" }],
		["coalesce branch malformed", { op: "coalesce", of: [[{ op: "not-a-real-op" }]] }],
		["template missing 'template'", { op: "template", from: {} }],
		["template missing 'from'", { op: "template", template: "{a}" }],
		["template sub-pipe malformed", { op: "template", template: "{a}", from: { a: [{ op: "not-a-real-op" }] } }],
		["op is not an object", "nope"],
	])("rejects a malformed op: %s", (_label, badOp) => {
		const bad = { ...structuredCloneOfLinear(), fields: [{ key: "x", label: "X", pipe: [badOp] }] };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects a malformed reference.nativeId.pipe", () => {
		const base = structuredCloneOfLinear();
		const bad = { ...base, reference: { ...base.reference, nativeId: { pipe: [{ op: "not-a-real-op" }] } } };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("rejects template nesting deeper than 8", () => {
		let pipe: unknown = [{ op: "const", value: "leaf" }];
		for (let i = 0; i < 9; i++) {
			pipe = [{ op: "template", template: "{a}", from: { a: pipe } }];
		}
		const bad = { ...structuredCloneOfLinear(), fields: [{ key: "deep", label: "Deep", pipe }] };
		expect(validateDefinition(bad).ok).toBe(false);
	});

	it("getRegistry() throws fail-fast when a built-in definition is invalid", async () => {
		vi.resetModules();
		vi.doMock("./sources/definitions/index.js", () => ({
			BUILTIN_DEFINITIONS: [{ id: "" }],
		}));
		const { getRegistry: freshGetRegistry } = await import("./SourceDefinitionRegistry.js");
		expect(() => freshGetRegistry()).toThrow(/invalid built-in source definition/);
		vi.doUnmock("./sources/definitions/index.js");
		vi.resetModules();
	});

	it("accepts well-formed regex/coalesce/template ops", () => {
		const ok = {
			...structuredCloneOfLinear(),
			fields: [
				{
					key: "x",
					label: "X",
					pipe: [
						{
							op: "template",
							template: "{a}",
							from: {
								a: [
									{
										op: "coalesce",
										of: [[{ op: "const", value: "" }], [{ op: "const", value: "v" }]],
									},
									{ op: "regex", pattern: "(v)", extract: "$1", lastMatch: true },
								],
							},
						},
					],
				},
			],
		};
		expect(validateDefinition(ok).ok).toBe(true);
	});

	describe("zoom-meeting registration", () => {
		it("resolves get_meeting_assets to zoom-meeting", () => {
			const def = getRegistry().match("claude", "mcp__claude_ai_Zoom_for_Claude__get_meeting_assets");
			expect(def?.id).toBe("zoom-meeting");
		});
		it("does NOT match other Zoom tools (suffix gate)", () => {
			expect(getRegistry().match("claude", "mcp__claude_ai_Zoom_for_Claude__search_meetings")).toBeUndefined();
		});
		it("resolves the Codex zoom connector by namespace+name and by invocation tool", () => {
			const r = getRegistry();
			expect(r.match("codex", "_get_meeting_assets", "zoom")?.id).toBe("zoom-meeting"); // function_call path
			expect(r.match("codex", "zoom.get_meeting_assets")?.id).toBe("zoom-meeting"); // invocation-tool path
		});
		it("does NOT match Codex zoom enumeration / recording-resource tools", () => {
			const r = getRegistry();
			expect(r.match("codex", "_search_meetings", "zoom")).toBeUndefined();
			expect(r.match("codex", "_recordings_list", "zoom")).toBeUndefined();
			expect(r.match("codex", "_get_recording_resource", "zoom")).toBeUndefined();
			expect(r.match("codex", "zoom.search_meetings")).toBeUndefined();
		});
	});

	describe("zoom-doc registration", () => {
		it("resolves hub_get_file_content to zoom-doc", () => {
			const def = getRegistry().match("claude", "mcp__claude_ai_Zoom_for_Claude__hub_get_file_content");
			expect(def?.id).toBe("zoom-doc");
		});
	});

	describe("asana registration", () => {
		it("resolves get_task to asana", () => {
			expect(getRegistry().match("claude", "mcp__claude_ai_Asana__get_task")?.id).toBe("asana");
		});
		it("does NOT match enumeration or write tools (suffix gate)", () => {
			const r = getRegistry();
			expect(r.match("claude", "mcp__claude_ai_Asana__get_tasks")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_Asana__get_my_tasks")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_Asana__search_tasks")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_Asana__create_task_confirm")).toBeUndefined();
		});
		it("resolves the codex get_task via both the function_call and invocation paths", () => {
			const r = getRegistry();
			expect(r.match("codex", "_get_task", "asana")?.id).toBe("asana"); // function_call path
			expect(r.match("codex", "asana.get_task")?.id).toBe("asana"); // invocation-tool path (dotted, verbatim)
		});
		it("does NOT match codex enumeration/write tools or a mistyped invocation name", () => {
			const r = getRegistry();
			expect(r.match("codex", "_get_tasks", "asana")).toBeUndefined();
			expect(r.match("codex", "_get_my_tasks", "asana")).toBeUndefined();
			expect(r.match("codex", "_search_tasks", "asana")).toBeUndefined();
			expect(r.match("codex", "asana_get_task")).toBeUndefined(); // underscore, not the real dotted tool
		});
	});

	describe("monday registration", () => {
		it("resolves the Claude item-fetch tool", () => {
			expect(getRegistry().match("claude", "mcp__claude_ai_monday_com__get_board_items_page")?.id).toBe("monday");
		});
		it("resolves both Codex match paths", () => {
			const r = getRegistry();
			expect(r.match("codex", "_get_board_items_page", "monday_com")?.id).toBe("monday"); // function_call path
			expect(r.match("codex", "monday_com.get_board_items_page")?.id).toBe("monday"); // invocation-tool path
		});
		it("does NOT match monday write/enumeration/other tools", () => {
			const r = getRegistry();
			expect(r.match("claude", "mcp__claude_ai_monday_com__create_item")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_monday_com__get_board_info")).toBeUndefined();
			expect(r.match("claude", "mcp__claude_ai_monday_com__get_updates")).toBeUndefined();
			expect(r.match("codex", "_get_board_info", "monday_com")).toBeUndefined();
		});
	});
});
