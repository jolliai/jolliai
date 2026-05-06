import { describe, expect, it } from "vitest";
import { buildBindingChooserScript } from "./BindingChooserScriptBuilder.js";

describe("buildBindingChooserScript", () => {
	it("does not post create-space choices from the plugin", () => {
		const script = buildBindingChooserScript();

		expect(script).toContain("jmSpaceId: selectedExistingSpaceId()");
		expect(script).not.toContain("choice: 'new'");
		expect(script).not.toContain("newSpaceName");
		expect(script).not.toContain("repoName");
	});

	it("disables binding when no existing spaces are available", () => {
		const script = buildBindingChooserScript();

		expect(script).toContain("Create one on jolli.ai");
		expect(script).toContain("confirmBtn.disabled = b || spaces.length === 0");
	});

	it("pre-selects only the server-designated default space, never spaces[0]", () => {
		const script = buildBindingChooserScript();

		// Reads defaultSpaceId from the init message and only accepts numeric values.
		expect(script).toContain("typeof msg.defaultSpaceId === 'number'");
		// Walks the spaces list to confirm the default id is actually present.
		expect(script).toContain("spaces[i].id === defaultId");
		// MUST NOT auto-select the first listed space when the server did not
		// nominate a default — list order is not guaranteed and silently
		// preselecting spaces[0] would let "Bind and push" bind the repo to an
		// arbitrary space without an explicit user pick.
		expect(script).not.toContain("spaces[0].id");
	});
});
