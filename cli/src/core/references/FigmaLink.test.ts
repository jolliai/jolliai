import { describe, expect, it } from "vitest";
import { parseFigmaLink, scanUserFigmaLinks } from "./FigmaLink.js";

/** One transcript line carrying a role:user text block. */
function userLine(text: string): string {
	return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

// The two links from the real 2026-08-11 capture, verbatim.
const DESIGN_LINK =
	"https://www.figma.com/design/bJRNYiLoMlBI1UIgMSnOxt/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-?node-id=0-1&p=f&t=2VLISxYAQv0t5i6Y-0";
const BOARD_LINK = "https://www.figma.com/board/pb6Hry0yvWpYI0UyyCx3bt/Untitled?t=2VLISxYAQv0t5i6Y-0";

describe("parseFigmaLink", () => {
	it("reads key, canonical url and decoded name from a real /design/ link", () => {
		const link = parseFigmaLink(DESIGN_LINK);
		expect(link?.fileKey).toBe("bJRNYiLoMlBI1UIgMSnOxt");
		// Query string dropped: it carries a session token and a transient node-id.
		expect(link?.url).toBe(
			"https://www.figma.com/design/bJRNYiLoMlBI1UIgMSnOxt/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-",
		);
		expect(link?.name).toBe("小程序--Copy-");
	});

	it("reads a real /board/ (FigJam) link", () => {
		const link = parseFigmaLink(BOARD_LINK);
		expect(link?.fileKey).toBe("pb6Hry0yvWpYI0UyyCx3bt");
		expect(link?.url).toBe("https://www.figma.com/board/pb6Hry0yvWpYI0UyyCx3bt/Untitled");
		expect(link?.name).toBe("Untitled");
	});

	it("accepts /make/ — get_design_context passes a makeFileKey through as fileKey", () => {
		const link = parseFigmaLink("https://www.figma.com/make/MakeKey0000000000000000/Prototype");
		expect(link?.fileKey).toBe("MakeKey0000000000000000");
	});

	it("accepts a scheme-only host without www", () => {
		expect(parseFigmaLink("https://figma.com/design/AbC0000000000000000000/Name")?.fileKey).toBe(
			"AbC0000000000000000000",
		);
	});

	// The whole reason the branch alternative exists: four tool schemas say the CALL
	// carries the branchKey, so the harvest must be keyed by it. And without the
	// alternative the slug group swallows the literal "branch", labelling the file
	// "branch" — a wrong name, not a missing one.
	it("keys a branch link by branchKey, keeps the full path, and never names it 'branch'", () => {
		const link = parseFigmaLink(
			"https://www.figma.com/design/PARENTkey00000000000000/branch/BRANCHkey00000000000/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-?node-id=1-2",
		);
		expect(link?.fileKey).toBe("BRANCHkey00000000000");
		expect(link?.name).not.toBe("branch");
		expect(link?.url).toBe(
			"https://www.figma.com/design/PARENTkey00000000000000/branch/BRANCHkey00000000000/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-",
		);
	});

	// A branch link's slug is the PARENT's file name, so without the suffix the two
	// references render as the same row label (figma is not in labelLeadsWithNativeId).
	it("suffixes a branch name so it cannot render identically to its parent", () => {
		const parent = parseFigmaLink("https://www.figma.com/design/PARENTkey00000000000000/Design-System");
		const branch = parseFigmaLink(
			"https://www.figma.com/design/PARENTkey00000000000000/branch/BRANCHkey00000000000/Design-System",
		);
		expect(parent?.name).toBe("Design-System");
		expect(branch?.name).toBe("Design-System (branch)");
		expect(branch?.name).not.toBe(parent?.name);
	});

	it("does not mistake a path segment merely starting with 'branch' for a branch", () => {
		const link = parseFigmaLink("https://www.figma.com/design/PARENTkey00000000000000/branchoffice-plan");
		expect(link?.fileKey).toBe("PARENTkey00000000000000");
		expect(link?.name).toBe("branchoffice-plan");
	});

	// A pasted link almost never stands alone. None of these closers is `/`, `?`, `#` or
	// whitespace, so the slug group swallows them: before the strip, a markdown link
	// produced the name `Login-Page)` and a url ending in `)`. figma is not in
	// `labelLeadsWithNativeId`, so that corrupted name IS the whole sidebar row label.
	it("strips wrapper and sentence punctuation the slug group would otherwise swallow", () => {
		const key = "bJRNYiLoMlBI1UIgMSnOxt";
		const bare = `https://www.figma.com/design/${key}/Login-Page`;
		for (const raw of [
			`[设计稿](${bare})`,
			`<${bare}>`,
			`see ${bare}.`,
			`${bare}, thanks`,
			`请看 ${bare}。`,
			`(${bare})`,
			bare,
		]) {
			const link = parseFigmaLink(raw);
			expect(link?.name, raw).toBe("Login-Page");
			expect(link?.url, raw).toBe(bare);
		}
	});

	// Figma slugifies punctuation to `-`, so a real slug routinely ENDS in one — the
	// capture's own name does. Stripping it would corrupt the name this exists to keep.
	it("keeps a trailing hyphen, which a real Figma slug genuinely ends with", () => {
		expect(parseFigmaLink(DESIGN_LINK)?.name).toBe("小程序--Copy-");
		expect(parseFigmaLink(`见 ${DESIGN_LINK}`)?.name).toBe("小程序--Copy-");
	});

	it("omits name when the link carries no slug", () => {
		const link = parseFigmaLink("https://www.figma.com/design/AbC0000000000000000000?node-id=1-2");
		expect(link?.fileKey).toBe("AbC0000000000000000000");
		expect(link?.name).toBeUndefined();
	});

	it("keeps a malformed percent-sequence verbatim rather than throwing", () => {
		expect(parseFigmaLink("https://www.figma.com/design/AbC0000000000000000000/100%-done")?.name).toBe("100%-done");
	});

	it("returns null for a non-Figma url and for a Figma url with no file segment", () => {
		expect(parseFigmaLink("https://example.com/design/AbC0000000000000000000/Name")).toBeNull();
		expect(parseFigmaLink("https://www.figma.com/files/recent")).toBeNull();
	});

	// The slug group used to be unbounded, and `figmaDefinition` bounds neither the title
	// (`require: ".+"`) nor the url (`^https://www\.figma\.com/`) — measured on the full
	// path, a 120 000-char slug produced a 120 000-char title and a 120 052-char url, both
	// passing, and that title is the sidebar row label and the pushed memory's title.
	it("bounds the captured slug, so neither the name nor the url can be unbounded", () => {
		const key = "bJRNYiLoMlBI1UIgMSnOxt";
		const link = parseFigmaLink(`https://www.figma.com/design/${key}/${"A".repeat(120_000)}`);
		// `https://www.figma.com/design/` (29) + key (22) + `/` (1) + MAX_SLUG_LEN (512).
		expect(link?.url).toHaveLength(564);
		// 120 code points plus the ellipsis.
		expect([...(link?.name ?? "")]).toHaveLength(121);
		expect(link?.name?.endsWith("…")).toBe(true);
	});

	// Same bound, viewed from the other failure it removes: TRAILING_PUNCT_RE is
	// `[<class>]+$`, which backtracks over every start position when the string ends in an
	// out-of-class byte. Through `scanUserFigmaLinks` that measured 151 ms at 10 000
	// in-class chars, 407 ms at 20 000 and 1091 ms at 40 000 — in the Stop hook. Asserting
	// the bound rather than a duration keeps this deterministic under a loaded CI run, but
	// the input stays pathological: removing the bound fails the assertion AND takes ~1 s.
	it("cannot be handed an unbounded slug to strip punctuation from", () => {
		const key = "bJRNYiLoMlBI1UIgMSnOxt";
		const link = parseFigmaLink(`https://www.figma.com/design/${key}/${")".repeat(40_000)}A`);
		// All 512 captured chars are strippable punctuation, so the slug empties out and the
		// link degrades to the no-name form — the honest answer for a slug that is punctuation.
		expect(link?.url).toBe(`https://www.figma.com/design/${key}`);
		expect(link?.name).toBeUndefined();
	});

	// The cap is applied to the DECODED name and slices by code point. A naive
	// `String.prototype.slice` cuts an astral pair in half and leaves a lone surrogate in
	// the frontmatter and in every push payload built from it.
	it("caps a long name without splitting an astral character", () => {
		const key = "bJRNYiLoMlBI1UIgMSnOxt";
		// 119 ASCII + 🎨 puts the emoji astride UTF-16 index 120 — exactly where a naive
		// slice would cut — and the trailing run pushes the name past the cap.
		const slug = `${"a".repeat(119)}%F0%9F%8E%A8${"b".repeat(30)}`;
		const name = parseFigmaLink(`https://www.figma.com/design/${key}/${slug}`)?.name ?? "";
		expect(name).toContain("🎨");
		expect([...name]).toHaveLength(121);
		// No unpaired high surrogate anywhere.
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name)).toBe(false);
	});
});

describe("scanUserFigmaLinks", () => {
	it("harvests from role:user text blocks, keyed by the tool-facing key", () => {
		const map = scanUserFigmaLinks([userLine(`${DESIGN_LINK}\n\n看一下这个设计文稿`)]);
		expect(map.get("bJRNYiLoMlBI1UIgMSnOxt")?.name).toBe("小程序--Copy-");
	});

	// Unlike SlackPermalink, ALL links in one block are harvested: naming a design file
	// and a FigJam board in one prompt is ordinary Figma usage.
	it("harvests every link in one message, not just the first", () => {
		const map = scanUserFigmaLinks([userLine(`设计稿 ${DESIGN_LINK} 和流程板 ${BOARD_LINK}`)]);
		expect(map.size).toBe(2);
		expect(map.get("bJRNYiLoMlBI1UIgMSnOxt")?.name).toBe("小程序--Copy-");
		expect(map.get("pb6Hry0yvWpYI0UyyCx3bt")?.name).toBe("Untitled");
	});

	// A later bare deep-link to the same file would otherwise replace a good name with
	// none.
	it("keeps the first link for a key so a named one is not displaced by a nameless one", () => {
		const map = scanUserFigmaLinks([
			userLine(DESIGN_LINK),
			userLine("https://www.figma.com/design/bJRNYiLoMlBI1UIgMSnOxt?node-id=474-2318"),
		]);
		expect(map.get("bJRNYiLoMlBI1UIgMSnOxt")?.name).toBe("小程序--Copy-");
	});

	// A link the AGENT produced must not name a file it merely mentioned.
	it("ignores links outside role:user text blocks", () => {
		const assistant = JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: DESIGN_LINK }] },
		});
		const toolResult = JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: DESIGN_LINK }] },
		});
		expect(scanUserFigmaLinks([assistant, toolResult]).size).toBe(0);
	});

	it("skips lines without the host substring and lines that are not JSON", () => {
		expect(scanUserFigmaLinks(["", "not json at all", userLine("no links here")]).size).toBe(0);
		// Present substring but unparseable JSON — must not throw.
		expect(scanUserFigmaLinks(["{ figma.com/ broken"]).size).toBe(0);
	});

	// The host gate lives HERE, not in `parseFigmaLink` — worth pinning, because the
	// single-shot parser is anchored on the scheme but not on the start of the string, so
	// it happily reads a Figma url nested inside another host's path. Only the scanner
	// (which is what the transcript path actually calls) resolves each URL candidate's
	// hostname first.
	it("rejects a Figma url nested inside another host's path", () => {
		const nested = `https://evil.example/https://www.figma.com/design/bJRNYiLoMlBI1UIgMSnOxt/Name`;
		expect(scanUserFigmaLinks([userLine(nested)]).size).toBe(0);
		// Same string through the un-gated parser, for contrast.
		expect(parseFigmaLink(nested)?.fileKey).toBe("bJRNYiLoMlBI1UIgMSnOxt");
	});

	it("tolerates malformed user content shapes", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: "figma.com/ not an array" } }),
			JSON.stringify({ message: { role: "user", content: [null, 7, { type: "text" }] } }),
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: DESIGN_LINK }] } }),
		];
		expect(scanUserFigmaLinks(lines).size).toBe(1);
	});
});
