import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAntigravityVariants, isAntigravityInstalled } from "./AntigravityDetector.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

function freshHome(): string {
	return mkdtempSync(join(tmpdir(), "agy-home-"));
}

describe("AntigravityDetector", () => {
	it("lists only existing variants that have a conversations dir", () => {
		const home = freshHome();
		mkdirSync(join(home, ".gemini", "antigravity-ide", "conversations"), { recursive: true });
		// antigravity-cli root exists but WITHOUT conversations/ — must be excluded.
		mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
		const variants = getAntigravityVariants(home);
		expect(variants.map((v) => v.variant)).toEqual(["antigravity-ide"]);
		expect(variants[0].conversationsDir).toBe(join(home, ".gemini", "antigravity-ide", "conversations"));
		expect(variants[0].brainDir).toBe(join(home, ".gemini", "antigravity-ide", "brain"));
	});

	it("returns empty when no variant dirs exist", () => {
		expect(getAntigravityVariants(freshHome())).toEqual([]);
	});

	it("isAntigravityInstalled is false when no .db present", async () => {
		const home = freshHome();
		mkdirSync(join(home, ".gemini", "antigravity", "conversations"), { recursive: true });
		expect(await isAntigravityInstalled(home)).toBe(false);
	});

	it("isAntigravityInstalled is true when a .db exists (on sqlite-capable runtimes)", async () => {
		const home = freshHome();
		const conv = join(home, ".gemini", "antigravity", "conversations");
		mkdirSync(conv, { recursive: true });
		writeFileSync(join(conv, "abc.db"), "");
		// On the CLI's Node 22.5+ test runtime this is true; guard keeps the test
		// meaningful if ever run on an older runtime.
		expect(await isAntigravityInstalled(home)).toBe(hasNodeSqliteSupport());
	});
});
