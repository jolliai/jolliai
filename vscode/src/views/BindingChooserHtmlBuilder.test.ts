import { describe, expect, it } from "vitest";
import { buildBindingChooserHtml } from "./BindingChooserHtmlBuilder.js";

describe("buildBindingChooserHtml", () => {
	it("only offers binding to an existing Memory space", () => {
		const html = buildBindingChooserHtml("test-nonce");

		expect(html).toContain("Choose a Memory space");
		expect(html).toContain("Bind and push");
		expect(html).not.toContain("New space");
		expect(html).not.toContain("newSpaceName");
		expect(html).not.toContain("repoName");
	});
});
