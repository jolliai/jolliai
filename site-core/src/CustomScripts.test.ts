import { describe, expect, it } from "vitest";
import {
	CUSTOM_SCRIPT_FOLDER,
	CUSTOM_SCRIPT_PUBLIC_DIR,
	isReservedJolliPath,
	JOLLI_RESERVED_DIR,
	MAX_CUSTOM_SCRIPT_BYTES,
	MAX_CUSTOM_SCRIPT_FILES,
} from "./CustomScripts.js";

describe("isReservedJolliPath", () => {
	it("returns true for the bare .jolli namespace and any path under it", () => {
		expect(isReservedJolliPath(".jolli")).toBe(true);
		expect(isReservedJolliPath(".jolli/scripts/foo.js")).toBe(true);
		expect(isReservedJolliPath(".jolli/jollimemory/summary.json")).toBe(true);
	});

	it("returns false for siblings, lookalike prefixes, and unrelated paths", () => {
		expect(isReservedJolliPath("docs/intro.md")).toBe(false);
		expect(isReservedJolliPath(".jolligotcha/file.js")).toBe(false);
		expect(isReservedJolliPath("jolli/scripts/foo.js")).toBe(false);
		expect(isReservedJolliPath("")).toBe(false);
	});
});

describe("CustomScripts constants", () => {
	it("expose the canonical folder names and hygiene caps", () => {
		// Locked here so a stray rename in `site-core` would be caught.
		expect(JOLLI_RESERVED_DIR).toBe(".jolli");
		expect(CUSTOM_SCRIPT_FOLDER).toBe(".jolli/scripts");
		expect(CUSTOM_SCRIPT_PUBLIC_DIR).toBe("scripts");
		expect(MAX_CUSTOM_SCRIPT_BYTES).toBe(64 * 1024);
		expect(MAX_CUSTOM_SCRIPT_FILES).toBe(20);
	});
});
