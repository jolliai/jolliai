import { describe, expect, it } from "vitest";
import type { FigmaLink } from "../FigmaLink.js";
import {
	FIGMA_TOOL_NAMES,
	FIGMA_TOOL_PREFIXES,
	figmaFileUrl,
	normalizeFigma,
	WHOLE_FILE_DETAIL,
} from "./FigmaNormalize.js";

const FILE_KEY = "bJRNYiLoMlBI1UIgMSnOxt";
const BOARD_KEY = "pb6Hry0yvWpYI0UyyCx3bt";

const LINKS: ReadonlyMap<string, FigmaLink> = new Map<string, FigmaLink>([
	[
		FILE_KEY,
		{
			fileKey: FILE_KEY,
			url: `https://www.figma.com/design/${FILE_KEY}/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-`,
			name: "小程序--Copy-",
		},
	],
]);

describe("normalizeFigma", () => {
	it("captures every declared tool under BOTH prefix spellings", () => {
		for (const prefix of FIGMA_TOOL_PREFIXES) {
			for (const tool of FIGMA_TOOL_NAMES) {
				const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, `${prefix}${tool}`);
				expect(out, `${prefix}${tool}`).not.toBeNull();
				expect(out?.fileKey).toBe(FILE_KEY);
			}
		}
	});

	it("accepts a bare tool name, so one normalizer would serve a future Codex binding", () => {
		expect(normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, "get_metadata")?.fileKey).toBe(FILE_KEY);
	});

	// The exact-allow-list's counterpart gate: writes and enumerations share this
	// namespace and their arguments are shape-identical to a read's.
	it("voids a write or enumeration tool even with a perfectly valid payload", () => {
		for (const tool of [
			"mcp__Figma__use_figma",
			"mcp__Figma__create_new_file",
			"mcp__Figma__add_code_connect_map",
			"mcp__Figma__upload_assets",
			"mcp__Figma__get_libraries",
			"mcp__Figma__search_design_system",
			"mcp__Figma__list_shader_fills",
		]) {
			expect(normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, tool), tool).toBeNull();
		}
	});

	// `TOOL_LABELS` is a plain object, so a bare `TOOL_LABELS[name]` answers
	// `Object.prototype.toString` for the name "toString" — the `label === undefined`
	// void would not fire and the call would be captured with a native-function body as
	// its detail. `figmaDefinition.exact` blocks this on the Claude path, but the test
	// directly above pins that BARE names are accepted for a future Codex/Kimi binding,
	// and that caller has no allow-list in front of it.
	it("voids a prototype-chain tool name instead of resolving it to an inherited member", () => {
		for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
			expect(normalizeFigma({ fileKey: FILE_KEY }, name), name).toBeNull();
			expect(normalizeFigma({ fileKey: FILE_KEY }, `mcp__Figma__${name}`), name).toBeNull();
		}
	});

	it("voids when fileKey is unreadable — the desktop Dev Mode envelope is not guessed", () => {
		expect(normalizeFigma({ nodeId: "1:2" }, "mcp__Figma__get_screenshot")).toBeNull();
		expect(normalizeFigma({ fileKey: "" }, "mcp__Figma__get_metadata")).toBeNull();
		expect(normalizeFigma({ fileKey: 42 }, "mcp__Figma__get_metadata")).toBeNull();
		expect(normalizeFigma(undefined, "mcp__Figma__get_metadata")).toBeNull();
		expect(normalizeFigma("nope", "mcp__Figma__get_metadata")).toBeNull();
	});

	// Captured live: one real `get_metadata` call passes fileKey alone, and Figma answers
	// with the document's top-level page list. Requiring nodeId would drop it silently.
	it("keeps a nodeId-less call and records it as a whole-file read", () => {
		const out = normalizeFigma({ fileKey: FILE_KEY }, "mcp__Figma__get_metadata");
		expect(out?.detail).toBe(`Read structure ${WHOLE_FILE_DETAIL}`);
	});

	it("records the tool label and node in the accumulating detail line", () => {
		expect(normalizeFigma({ fileKey: FILE_KEY, nodeId: "474:2318" }, "mcp__Figma__get_screenshot")?.detail).toBe(
			"Viewed screenshot · node 474:2318",
		);
		expect(normalizeFigma({ fileKey: BOARD_KEY, nodeId: "0:1" }, "mcp__Figma__get_figjam")?.detail).toBe(
			"Read FigJam board · node 0:1",
		);
	});

	// The detail line becomes one entry of an accumulating body, whose parser splits on
	// the LAST "` — " in the line — so it must contain neither a backtick nor that
	// separator, or the round-trip breaks.
	it("produces a detail line that is safe for the accumulated-body entry format", () => {
		const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "474:2318" }, "mcp__Figma__get_variable_defs");
		expect(out?.detail).not.toContain("`");
		expect(out?.detail).not.toContain("` — ");
		expect(out?.detail).not.toContain("\n");
	});

	// …and that has to hold for the nodeId the MODEL emitted, not just a well-formed
	// one: nothing upstream validates it (an arguments-derived source never reads the
	// result that would have carried the server's rejection), and the body parser is
	// line-anchored, so a newline splits one entry into a stray plus a mangled entry.
	it("flattens a multi-line nodeId so it cannot forge a second accumulated-body entry", () => {
		const out = normalizeFigma(
			{ fileKey: FILE_KEY, nodeId: "1:2\n- `INJECTED` — 2020-01-01T00:00:00Z" },
			"mcp__Figma__get_metadata",
		);
		expect(out?.detail).not.toContain("\n");
		expect(out?.detail).toBe("Read structure · node 1:2 - `INJECTED` — 2020-01-01T00:00:00Z");
	});

	// The cap is sized off the schema's INSTANCE form (`I<int>:<int>` plus one
	// `;<int>:<int>` per nesting level, unbounded in the pattern), not off the common
	// `474:2318`. A deep instance id must survive intact — truncating one yields a
	// string that still reads as a valid node id while pointing at nothing.
	it("keeps a deeply nested instance nodeId intact", () => {
		const instance = `I1234:5678${";1234:5678".repeat(9)}`; // 10 levels, 100 chars
		expect(normalizeFigma({ fileKey: FILE_KEY, nodeId: instance }, "mcp__Figma__get_metadata")?.detail).toBe(
			`Read structure · node ${instance}`,
		);
	});

	it("caps a pathological nodeId so one call cannot dominate the 20-entry body", () => {
		const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "9".repeat(500) }, "mcp__Figma__get_metadata");
		expect(out?.detail).toBe(`Read structure · node ${"9".repeat(256)}`);
	});

	it("treats an all-whitespace nodeId as absent rather than trailing a dangling separator", () => {
		expect(normalizeFigma({ fileKey: FILE_KEY, nodeId: "  \n " }, "mcp__Figma__get_metadata")?.detail).toBe(
			`Read structure ${WHOLE_FILE_DETAIL}`,
		);
	});

	describe("title and url", () => {
		it("uses the harvested name and canonical url when a link was pasted", () => {
			const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, "mcp__Figma__get_screenshot", LINKS);
			expect(out?.title).toBe("小程序--Copy-");
			expect(out?.url).toBe(`https://www.figma.com/design/${FILE_KEY}/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-`);
		});

		it("synthesizes a title but still yields a working url when no link was pasted", () => {
			const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, "mcp__Figma__get_screenshot", LINKS);
			const missing = normalizeFigma({ fileKey: BOARD_KEY, nodeId: "0:1" }, "mcp__Figma__get_figjam", LINKS);
			expect(missing?.title).toBe("Figma file pb6Hry0y");
			expect(missing?.url).toBe(figmaFileUrl(BOARD_KEY));
			// The harvested row is unaffected by its neighbour's miss.
			expect(out?.title).toBe("小程序--Copy-");
		});

		it("synthesizes both when the harvest map is absent entirely (Codex / Kimi)", () => {
			const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, "mcp__Figma__get_screenshot");
			expect(out?.title).toBe("Figma file bJRNYiLo");
			expect(out?.url).toBe(`https://www.figma.com/file/${FILE_KEY}`);
		});

		it("falls back to a synthesized title when the harvested link had no slug", () => {
			const nameless: ReadonlyMap<string, FigmaLink> = new Map([
				[FILE_KEY, { fileKey: FILE_KEY, url: `https://www.figma.com/design/${FILE_KEY}` }],
			]);
			const out = normalizeFigma({ fileKey: FILE_KEY, nodeId: "1:2" }, "mcp__Figma__get_metadata", nameless);
			expect(out?.title).toBe("Figma file bJRNYiLo");
			// …but the harvested url is still preferred over the `/file/` form.
			expect(out?.url).toBe(`https://www.figma.com/design/${FILE_KEY}`);
		});
	});

	it("builds the universal /file/ link, never a per-type path", () => {
		// `/design/` would be wrong for the FigJam board in the capture, and get_screenshot
		// spans design/board/slides so tool-name dispatch cannot cover it either.
		expect(figmaFileUrl(BOARD_KEY)).toBe(`https://www.figma.com/file/${BOARD_KEY}`);
	});
});
