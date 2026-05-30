import { describe, expect, it } from "vitest";
import { parseNotionEnvelope } from "./NotionEnvelope.js";

describe("parseNotionEnvelope", () => {
	it("extracts the body inside <content>…</content>", () => {
		const text = `<page>
  <title>Sample</title>
  <metadata>type=page</metadata>
  <content># Heading

Body of the page with **markdown**.</content>
</page>`;
		const out = parseNotionEnvelope(text);
		expect(out.content).toBe("# Heading\n\nBody of the page with **markdown**.");
	});

	it("preserves newlines inside the content (multi-line dotall match)", () => {
		const text = "<content>line one\nline two\nline three</content>";
		expect(parseNotionEnvelope(text).content).toBe("line one\nline two\nline three");
	});

	it("returns empty content for input with no <content> block", () => {
		expect(parseNotionEnvelope("<page><title>x</title></page>").content).toBe("");
	});

	it("returns empty content for malformed input (only opening tag, no close)", () => {
		expect(parseNotionEnvelope("<content>oops no close tag").content).toBe("");
	});

	it("returns empty content for an empty string input", () => {
		expect(parseNotionEnvelope("").content).toBe("");
	});

	it("returns empty content for a non-string input (defensive — runtime safety)", () => {
		// Cast through unknown to satisfy the type system; we still want runtime
		// guard behaviour to be observable.
		expect(parseNotionEnvelope(undefined as unknown as string).content).toBe("");
		expect(parseNotionEnvelope(null as unknown as string).content).toBe("");
	});

	it("captures only the first <content> block when multiple appear", () => {
		const text = "<content>first</content><content>second</content>";
		expect(parseNotionEnvelope(text).content).toBe("first");
	});

	it("captures an empty body when <content></content> is empty", () => {
		expect(parseNotionEnvelope("<content></content>").content).toBe("");
	});

	it("extracts content when the <content> open tag carries attributes", () => {
		// notion-fetch may evolve to emit `<content type="markdown">…`. Without
		// attribute tolerance the body would be silently dropped (returns "").
		expect(parseNotionEnvelope('<content type="markdown">body here</content>').content).toBe("body here");
	});
});
