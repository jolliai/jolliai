import { describe, expect, it } from "vitest";
import { extractRef } from "../../SourceEngine.js";
import { FIGMA_TOOL_NAMES, FIGMA_TOOL_PREFIXES, normalizeFigma } from "../FigmaNormalize.js";
import { figmaDefinition } from "./figma.js";

const AT = "2026-08-11T02:39:25.131Z";
const FILE_KEY = "bJRNYiLoMlBI1UIgMSnOxt";
const TOOL = "mcp__Figma__get_screenshot";

/** The post-normalize shape `FigmaNormalize` hands the engine. */
function payload(over: Partial<Record<string, string>> = {}) {
	return {
		fileKey: FILE_KEY,
		title: "小程序--Copy-",
		url: `https://www.figma.com/design/${FILE_KEY}/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-`,
		detail: "Viewed screenshot · node 474:2318",
		...over,
	};
}

describe("figmaDefinition", () => {
	it("is track-only, arguments-derived and accumulating", () => {
		expect(figmaDefinition.trackOnly).toBe(true);
		expect(figmaDefinition.argumentsDerived).toBe(true);
		expect(figmaDefinition.accumulateBody).toBe(true);
	});

	// The allow-list is DERIVED because `validateDefinition` does not deep-validate
	// `match`, so a hand-written entry that drifts from FigmaNormalize's tool set (or a
	// typo in one) disables that tool with no error anywhere. This pins the derivation.
	it("declares exactly the cross product of its prefixes and captured tool names", () => {
		const expected = FIGMA_TOOL_PREFIXES.flatMap((p) => FIGMA_TOOL_NAMES.map((t) => `${p}${t}`));
		expect(figmaDefinition.match.claude?.exact).toEqual(expected);
		expect(figmaDefinition.match.claude?.prefixes).toEqual([...FIGMA_TOOL_PREFIXES]);
		expect(expected).toHaveLength(FIGMA_TOOL_PREFIXES.length * FIGMA_TOOL_NAMES.length);
	});

	it("declares no Codex match — no real Codex envelope has been captured", () => {
		expect(figmaDefinition.match.codex).toBeUndefined();
	});

	// Lockstep guard: the pattern is a string in the definition while the title it must
	// recognise is built in `FigmaNormalize`, so nothing type-checks the pair. Drift is
	// silent in the direction that matters — a pattern that stops matching simply lets a
	// harvested name be overwritten again, which is the bug the flag exists to stop.
	it("declares a titleFallbackPattern matching every title normalizeFigma can synthesize", () => {
		const pattern = figmaDefinition.titleFallbackPattern;
		expect(pattern).toBeDefined();
		const re = new RegExp(pattern as string);
		// No harvested link → the synthesized label, for a real key and a short one.
		for (const key of [FILE_KEY, "pb6Hry0yvWpYI0UyyCx3bt", "Ab12"]) {
			const synthesized = normalizeFigma({ fileKey: key }, TOOL)?.title;
			expect(re.test(synthesized as string), synthesized).toBe(true);
		}
		// A harvested name must NOT read as a fallback, or a rename could never land.
		for (const real of ["小程序--Copy-", "Untitled", "Design-System", "Figma files", "Figma file"]) {
			expect(re.test(real), real).toBe(false);
		}
	});

	it("extracts a per-FILE reference whose mapKey is the file, not the node", () => {
		const ref = extractRef(figmaDefinition, payload(), TOOL, AT);
		expect(ref?.source).toBe("figma");
		expect(ref?.nativeId).toBe(FILE_KEY);
		expect(ref?.mapKey).toBe(`figma:${FILE_KEY}`);
		expect(ref?.title).toBe("小程序--Copy-");
		expect(ref?.description).toBe("Viewed screenshot · node 474:2318");
		expect(ref?.fields ?? []).toEqual([]);
	});

	it("accepts both the harvested /design/ url and the synthesized /file/ url", () => {
		expect(extractRef(figmaDefinition, payload(), TOOL, AT)?.url).toBe(
			`https://www.figma.com/design/${FILE_KEY}/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-`,
		);
		expect(
			extractRef(figmaDefinition, payload({ url: `https://www.figma.com/file/${FILE_KEY}` }), TOOL, AT)?.url,
		).toBe(`https://www.figma.com/file/${FILE_KEY}`);
	});

	// `url` is REQUIRED here, not optional, so a host it cannot vouch for voids the whole
	// reference rather than degrading to an unclickable row.
	it("voids on a url outside the Figma host", () => {
		expect(extractRef(figmaDefinition, payload({ url: "https://evil.example/figma" }), TOOL, AT)).toBeNull();
		// A lookalike whose host merely STARTS with the real one must fail too.
		expect(
			extractRef(figmaDefinition, payload({ url: "https://www.figma.com.evil.example/x" }), TOOL, AT),
		).toBeNull();
		expect(extractRef(figmaDefinition, payload({ url: "" }), TOOL, AT)).toBeNull();
	});

	// The auto-generated "only the query and the <label> link are recorded here" note in a
	// persisted reference keys on whether the DEFINITION declares a url, not on whether a
	// given row has one. Declaring it while leaving it optional would make that note
	// promise a link some rows lack — the exact confusion the note exists to prevent. So
	// "url is declared AND non-optional" is a load-bearing pair, not a style choice.
	it("declares url as non-optional so the persisted bookmark note cannot overpromise", () => {
		expect(figmaDefinition.reference.url).toBeDefined();
		expect(figmaDefinition.reference.url?.optional).toBeUndefined();
	});

	// The `require` is the ONLY gate: a transcript records the tool_use the model emitted
	// whether or not the server accepted it, and this source never reads the result that
	// would have carried the error. Voiding beats storing a junk reference.
	it("voids a fileKey outside Figma's declared 22-128 base62 grammar", () => {
		expect(extractRef(figmaDefinition, payload({ fileKey: "tooshort" }), TOOL, AT)).toBeNull();
		expect(extractRef(figmaDefinition, payload({ fileKey: "has-a-dash-0000000000000" }), TOOL, AT)).toBeNull();
		expect(extractRef(figmaDefinition, payload({ fileKey: "" }), TOOL, AT)).toBeNull();
	});

	it("voids an empty title but tolerates an absent detail", () => {
		expect(extractRef(figmaDefinition, payload({ title: "" }), TOOL, AT)).toBeNull();
		const ref = extractRef(figmaDefinition, { ...payload(), detail: undefined }, TOOL, AT);
		expect(ref?.nativeId).toBe(FILE_KEY);
		expect(ref?.description).toBeUndefined();
	});

	// A file key is base62, so its on-disk stem is the identity form rather than the
	// replace-then-hash branch github and context7 take.
	it("declares itself path-safe", () => {
		expect(figmaDefinition.storage.nativeIdPathSafe).toBe(true);
		expect(FILE_KEY).toMatch(/^[0-9a-zA-Z]+$/);
	});
});
