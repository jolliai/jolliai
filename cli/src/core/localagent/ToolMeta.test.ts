import { describe, expect, it } from "vitest";
import type { LocalAgentToolId } from "../../Types.js";
import {
	ALL_LOCAL_AGENT_MODEL_IDS,
	DEFAULT_LOCAL_AGENT_MODEL,
	effectiveLocalAgentModel,
	LOCAL_AGENT_MODEL_INHERIT,
	LOCAL_AGENT_TOOLS,
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
	// claude-code is the ONLY pinned tool, and that is a decision rather than an
	// oversight: it is the one tool whose model-name space this project knows and
	// the one whose envelope names the model it actually ran, so a pinned model can
	// be verified. Pinning a second tool means adding a `models` list, which this
	// test is here to make a visible edit rather than an accident.
	it("pins a model list for claude-code alone", () => {
		expect(localAgentToolModels("claude-code").length).toBeGreaterThan(0);
		for (const id of ["codex", "cursor-agent", "opencode", "kimi"] as LocalAgentToolId[]) {
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

	it("labels every choice, since the label is all a picker shows", () => {
		for (const m of localAgentToolModels("claude-code")) {
			expect(m.label.length).toBeGreaterThan(0);
			// No version numbers: an alias tracks the latest of its family, so
			// "Opus (4.8)" would rot the first time Anthropic ships a new one.
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

	it("collects every pinned tool's ids into the shared accept-set, de-duplicated", () => {
		expect([...ALL_LOCAL_AGENT_MODEL_IDS].sort()).toEqual(
			[...new Set(localAgentToolModels("claude-code").map((m) => m.id))].sort(),
		);
	});

	describe("resolveLocalAgentModel", () => {
		it("sends no model for a tool that is not pinned, whatever is configured", () => {
			// The four unpinned tools keep deferring to their own configuration —
			// this is what stops a claude-code model id leaking into a codex run.
			for (const id of ["codex", "cursor-agent", "opencode", "kimi"] as LocalAgentToolId[]) {
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

		it("keeps `inherit` distinct from the default in the effective value", () => {
			// The picker has to be able to SHOW `inherit`, so the display helper must
			// not collapse it to the default the way the storage helper collapses an
			// unknown id — otherwise selecting it would silently revert on reload.
			expect(effectiveLocalAgentModel(LOCAL_AGENT_MODEL_INHERIT)).toBe(LOCAL_AGENT_MODEL_INHERIT);
			expect(effectiveLocalAgentModel(undefined)).toBe(DEFAULT_LOCAL_AGENT_MODEL);
			expect(effectiveLocalAgentModel("")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
			expect(effectiveLocalAgentModel("   ")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
			expect(effectiveLocalAgentModel("haiku")).toBe("haiku");
			// The load-bearing one: an id this build does not know must render as
			// the default, or the page shows one model while holding another and
			// every later save is rejected for a field nobody edited.
			expect(effectiveLocalAgentModel("claude-future-9")).toBe(DEFAULT_LOCAL_AGENT_MODEL);
		});

		it("normalises what reaches disk identically for all three surfaces", () => {
			// The dashboard, the VS Code host and `configure --set` had each answered
			// this differently — one rejected an unknown id, one dropped it, one
			// stored the default literally. One function now answers for all three.
			expect(normalizeStoredLocalAgentModel(undefined)).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("")).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("  ")).toBeUndefined();
			expect(normalizeStoredLocalAgentModel(DEFAULT_LOCAL_AGENT_MODEL)).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("claude-future-9")).toBeUndefined();
			expect(normalizeStoredLocalAgentModel("haiku")).toBe("haiku");
			expect(normalizeStoredLocalAgentModel(" opus ")).toBe("opus");
			expect(normalizeStoredLocalAgentModel(LOCAL_AGENT_MODEL_INHERIT)).toBe(LOCAL_AGENT_MODEL_INHERIT);
		});

		it("round-trips every offered choice through storage and back to the picker", () => {
			// The property that matters to a user: pick a value, save, reopen, and
			// see the same value selected.
			for (const { id } of localAgentToolModels("claude-code")) {
				expect(effectiveLocalAgentModel(normalizeStoredLocalAgentModel(id))).toBe(id);
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
