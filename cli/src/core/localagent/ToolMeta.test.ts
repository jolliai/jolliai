import { describe, expect, it } from "vitest";
import type { LocalAgentToolId } from "../../Types.js";
import {
	ALL_LOCAL_AGENT_MODEL_IDS,
	DEFAULT_LOCAL_AGENT_MODEL,
	LOCAL_AGENT_MODEL_INHERIT,
	LOCAL_AGENT_TOOLS,
	localAgentToolDefaultModel,
	localAgentToolLabel,
	localAgentToolLoginHint,
	localAgentToolModels,
	localAgentToolSeparateLoginNote,
	normalizeStoredLocalAgentModel,
	resolveLocalAgentModel,
} from "./ToolMeta.js";

describe("ToolMeta", () => {
	it("labels every tool with the footer display name", () => {
		expect(localAgentToolLabel("claude-code")).toBe("Claude Code");
		expect(localAgentToolLabel("codex")).toBe("Codex");
		expect(localAgentToolLabel("cursor-agent")).toBe("Cursor");
		expect(localAgentToolLabel("opencode")).toBe("OpenCode");
	});

	it("carries a login hint for every tool", () => {
		for (const id of Object.keys(LOCAL_AGENT_TOOLS) as (keyof typeof LOCAL_AGENT_TOOLS)[]) {
			expect(LOCAL_AGENT_TOOLS[id].loginHint.length).toBeGreaterThan(0);
		}
	});

	// An out-of-enum id reaches these helpers when config.json / persisted
	// summary metadata was written by a newer build (or hand-edited): they must
	// degrade to a generic label / hint, never throw a TypeError that would
	// hard-crash `jolli status` / `jolli doctor` / footer rendering.
	it("degrades gracefully on an unknown tool id instead of throwing", () => {
		const unknown = "future-tool" as LocalAgentToolId;
		expect(localAgentToolLabel(unknown)).toBe("Local agent");
		expect(localAgentToolLoginHint(unknown)).toBe("Sign in to your local agent CLI.");
		expect(localAgentToolSeparateLoginNote(unknown)).toBeNull();
	});

	it("clarifies the separate desktop login only where the separation is verified", () => {
		// Null is a normal outcome, not a fallback: naming the wrong app sends the
		// user to check a login that has nothing to do with the failure, which is
		// worse than saying nothing. cursor-agent and opencode are unset on purpose.
		expect(localAgentToolSeparateLoginNote("claude-code")).toContain("Claude Desktop");
		expect(localAgentToolSeparateLoginNote("codex")).toContain("the ChatGPT app");
		expect(localAgentToolSeparateLoginNote("cursor-agent")).toBeNull();
		expect(localAgentToolSeparateLoginNote("opencode")).toBeNull();
	});
});

describe("ToolMeta model pinning", () => {
	// Which tools are pinned is a decision, so it is spelled out here rather than
	// derived: pinning or unpinning one has to be a visible edit to this list, not
	// an accident. claude-code and codex are pinned because their model namespaces
	// are ones this project can name; cursor-agent, opencode and kimi keep
	// deferring to their own configuration (cursor's catalogue is 200+ entries of
	// which a free plan can use one, and opencode spends the user's own provider
	// credit).
	it("pins a model list for claude-code and codex, and for no other tool", () => {
		for (const id of ["claude-code", "codex"] as LocalAgentToolId[]) {
			expect(localAgentToolModels(id).length).toBeGreaterThan(0);
		}
		for (const id of ["cursor-agent", "opencode", "kimi"] as LocalAgentToolId[]) {
			expect(localAgentToolModels(id)).toEqual([]);
		}
	});

	it("offers the default and the inherit escape hatch among claude-code's choices", () => {
		const ids = localAgentToolModels("claude-code").map((m) => m.id);
		expect(ids).toContain(DEFAULT_LOCAL_AGENT_MODEL);
		expect(ids).toContain(LOCAL_AGENT_MODEL_INHERIT);
	});

	it("orders the choices to match the Anthropic model picker, default NOT first", () => {
		// The two pickers sit a few rows apart in the same panel, so a different
		// order or wording reads as a different setting. The consequence is that
		// position no longer identifies the default — anything that needs it must
		// ask for it (the VS Code row falls back via `data-default`, and this test
		// is what would catch a reordering that silently re-broke that).
		const ids = localAgentToolModels("claude-code").map((m) => m.id);
		expect(ids).toEqual(["haiku", DEFAULT_LOCAL_AGENT_MODEL, "opus", LOCAL_AGENT_MODEL_INHERIT]);
		expect(ids[0]).not.toBe(DEFAULT_LOCAL_AGENT_MODEL);
	});

	it("labels every choice on every pinned tool, since the label is all a picker shows", () => {
		// Every tool, not just claude-code: a blank label renders a blank option and
		// nothing else would notice.
		for (const id of PINNED) {
			for (const m of localAgentToolModels(id)) {
				expect(m.label.length).toBeGreaterThan(0);
			}
		}
	});

	it("keeps version numbers out of the labels of a tool whose ids are ALIASES", () => {
		// An alias tracks the latest of its family, so "Opus (4.8)" would rot the
		// first time Anthropic ships a new one. Deliberately NOT generalised to
		// every pinned tool: codex has no aliases, its ids are dated slugs, and its
		// labels name the generation on purpose — see ToolMeta's codex entry.
		for (const m of localAgentToolModels("claude-code")) {
			expect(m.label).not.toMatch(/\d+[.-]\d+/);
		}
		// Wording is shared with the Anthropic picker verbatim; those three are
		// pinned against that picker's own markup in SettingsHtmlBuilder.test.ts.
		const byId = new Map(localAgentToolModels("claude-code").map((m) => [m.id, m.label]));
		expect(byId.get("haiku")).toBe("Haiku — fastest");
		expect(byId.get(DEFAULT_LOCAL_AGENT_MODEL)).toBe("Sonnet — balanced (default)");
		expect(byId.get("opus")).toBe("Opus — most capable");
	});

	it("returns an empty list for an unknown tool id rather than throwing", () => {
		expect(localAgentToolModels("future-tool" as LocalAgentToolId)).toEqual([]);
	});

	// Derived from the registry rather than naming tools, so these hold for every
	// tool pinned now and every tool pinned later.
	const PINNED = (Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]).filter(
		(id) => localAgentToolModels(id).length > 0,
	);
	const UNPINNED = (Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]).filter(
		(id) => localAgentToolModels(id).length === 0,
	);

	it("gives every pinned tool a default drawn from its OWN list", () => {
		// Nothing in the type system ties `defaultModel` to `models`, and getting it
		// wrong is invisible: the id would pass every validator and only fail at the
		// CLI, on every call, for whoever left the model unset.
		expect(PINNED.length).toBeGreaterThan(0);
		for (const id of PINNED) {
			const fallback = localAgentToolDefaultModel(id);
			expect(fallback).not.toBe("");
			expect(localAgentToolModels(id).map((m) => m.id)).toContain(fallback);
		}
	});

	it("declares models and a default together, never one without the other", () => {
		for (const id of UNPINNED) expect(localAgentToolDefaultModel(id)).toBe("");
		expect(localAgentToolDefaultModel("future-tool" as LocalAgentToolId)).toBe("");
	});

	it("never puts a pinned tool's default first, so nothing can infer it from position", () => {
		// Both panels mark the default explicitly (`isDefault` / `data-default`).
		// A list whose default happened to be first would let a positional fallback
		// pass its tests and then pick the cheapest model for every other tool.
		for (const id of PINNED) {
			expect(localAgentToolModels(id)[0]?.id).not.toBe(localAgentToolDefaultModel(id));
		}
	});

	it("offers the inherit escape hatch on every pinned tool", () => {
		for (const id of PINNED) {
			expect(localAgentToolModels(id).map((m) => m.id)).toContain(LOCAL_AGENT_MODEL_INHERIT);
		}
	});

	it("resolves a model belonging to ANOTHER tool to this tool's own default", () => {
		// The bug this whole per-tool default exists to remove: the fallback used to
		// be one global constant, so a `sonnet` stored under claude-code and carried
		// into a second pinned tool emitted `-m sonnet` at a CLI that has never
		// heard of it. Cross-product, so it stays true as tools are added.
		let checked = 0;
		for (const id of PINNED) {
			const mine = new Set(localAgentToolModels(id).map((m) => m.id));
			for (const other of PINNED) {
				for (const { id: foreign } of localAgentToolModels(other)) {
					if (mine.has(foreign)) continue;
					expect(resolveLocalAgentModel(id, foreign)).toBe(localAgentToolDefaultModel(id));
					checked++;
				}
			}
		}
		// The body is skipped entirely while only ONE tool is pinned, so without
		// this the whole case would pass by asserting nothing.
		expect(checked).toBeGreaterThan(0);
	});

	it("collects every pinned tool's ids into the shared accept-set, de-duplicated", () => {
		const everyId = (Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]).flatMap((id) =>
			localAgentToolModels(id).map((m) => m.id),
		);
		expect([...ALL_LOCAL_AGENT_MODEL_IDS].sort()).toEqual([...new Set(everyId)].sort());
		// The de-duplication is load-bearing rather than incidental: `inherit` is one
		// shared id offered by every pinned tool, so the raw concatenation is longer
		// than the accept-set and a validator built from it would list it twice.
		expect(everyId.length).toBeGreaterThan(ALL_LOCAL_AGENT_MODEL_IDS.length);
	});

	describe("resolveLocalAgentModel", () => {
		it("sends no model for a tool that is not pinned, whatever is configured", () => {
			// An unpinned tool keeps deferring to its own configuration — this is
			// what stops one tool's model id leaking into another tool's run.
			for (const id of UNPINNED) {
				expect(resolveLocalAgentModel(id, "haiku")).toBe("");
				expect(resolveLocalAgentModel(id, undefined)).toBe("");
			}
			expect(resolveLocalAgentModel("future-tool" as LocalAgentToolId, "haiku")).toBe("");
		});

		it("defaults an absent or blank value, which is how the default is stored", () => {
			expect(resolveLocalAgentModel("claude-code", undefined)).toBe(DEFAULT_LOCAL_AGENT_MODEL);
			expect(resolveLocalAgentModel("claude-code", "")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
			expect(resolveLocalAgentModel("claude-code", "   ")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
		});

		it("honours an explicit choice, trimming stray whitespace", () => {
			expect(resolveLocalAgentModel("claude-code", "haiku")).toBe("haiku");
			expect(resolveLocalAgentModel("claude-code", " opus ")).toBe("opus");
		});

		it("emits no model flag for the inherit choice", () => {
			// The one way back to the pre-pinning behaviour, and it must stay an
			// EXPLICIT choice rather than the default.
			expect(resolveLocalAgentModel("claude-code", LOCAL_AGENT_MODEL_INHERIT)).toBe("");
		});

		it("normalises what reaches disk identically for all three surfaces", () => {
			// The dashboard, the VS Code host and `configure --set` had each answered
			// this differently — one rejected an unknown id, one dropped it, one
			// stored the default literally. One function now answers for all three.
			expect(normalizeStoredLocalAgentModel("claude-code", undefined)).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("claude-code", "")).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("claude-code", "  ")).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("claude-code", DEFAULT_LOCAL_AGENT_MODEL)).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("claude-code", "claude-future-9")).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("claude-code", "haiku")).toBe("haiku");
			expect(normalizeStoredLocalAgentModel("claude-code", " opus ")).toBe("opus");
			expect(normalizeStoredLocalAgentModel("claude-code", LOCAL_AGENT_MODEL_INHERIT)).toBe(
				LOCAL_AGENT_MODEL_INHERIT,
			);
		});

		it("drops each pinned tool's OWN default to absent, and only its own", () => {
			// The reason this function takes a tool at all, and it had no coverage:
			// reverting the check to the global constant passed every test in the
			// repo. Under codex the panels would then write `gpt-5.6-terra` to
			// config.json literally instead of storing "no preference" — exactly the
			// three-surface divergence this function exists to prevent.
			for (const id of PINNED) {
				expect(normalizeStoredLocalAgentModel(id, localAgentToolDefaultModel(id))).toBeUndefined();
			}
			// A cross-tool id is KEPT, not dropped: `configure --set` writes the
			// model and the tool as two commands in either order, so a value the
			// currently-stored tool does not offer is a legal half-finished setup.
			let crossTool = 0;
			for (const id of PINNED) {
				const mine = new Set(localAgentToolModels(id).map((m) => m.id));
				for (const other of PINNED) {
					const foreignDefault = localAgentToolDefaultModel(other);
					if (mine.has(foreignDefault)) continue;
					expect(normalizeStoredLocalAgentModel(id, foreignDefault)).toBe(foreignDefault);
					crossTool++;
				}
			}
			expect(crossTool).toBeGreaterThan(0);
		});

		it("round-trips every offered choice through storage and back to the picker", () => {
			// The property that matters to a user: pick a value, save, reopen, and
			// see the same value selected.
			for (const id of PINNED) {
				for (const { id: model } of localAgentToolModels(id)) {
					// Storage may drop the tool's own default to absent; what has to
					// survive is what the RUNNER then sends, which is the same model.
					const stored = normalizeStoredLocalAgentModel(id, model);
					const expected = model === LOCAL_AGENT_MODEL_INHERIT ? "" : model;
					expect(resolveLocalAgentModel(id, stored)).toBe(expected);
				}
			}
		});

		it("falls back to the default for an id this build does not know", () => {
			// config.json is shared across surfaces AND versions, so a newer build
			// can write an id this one has never seen. Passing it through would send
			// `--model <garbage>`, which the CLI answers with a 404 before running —
			// i.e. every generation on the machine failing at once.
			expect(resolveLocalAgentModel("claude-code", "claude-future-9")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
			expect(resolveLocalAgentModel("claude-code", "__proto__")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
		});
	});
});
