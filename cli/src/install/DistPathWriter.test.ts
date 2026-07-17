import { describe, expect, it } from "vitest";
import { installDistPath } from "./DistPathWriter.js";

describe("installDistPath — source-tag write-boundary guard", () => {
	// The guard returns false BEFORE any filesystem access, so these cases never
	// touch the real ~/.jolli directory.
	it("refuses a path-traversal tag", async () => {
		expect(await installDistPath("../evil", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("a/b", "/some/dist", "1.0.0")).toBe(false);
	});

	it("refuses tags with shell metacharacters or whitespace", async () => {
		expect(await installDistPath("bad tag", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("bad;rm", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("'inject'", "/some/dist", "1.0.0")).toBe(false);
	});

	it("refuses an empty or leading-hyphen tag", async () => {
		expect(await installDistPath("", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("-x", "/some/dist", "1.0.0")).toBe(false);
	});
});
