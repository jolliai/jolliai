import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAntigravityVariants, isAntigravityInstalled, isAntigravityPresent } from "./AntigravityDetector.js";
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

	it("isAntigravityPresent is true when a .db exists, regardless of the SQLite gate", async () => {
		const home = freshHome();
		const conv = join(home, ".gemini", "antigravity", "conversations");
		mkdirSync(conv, { recursive: true });
		writeFileSync(join(conv, "abc.db"), "");
		// Presence is a pure filesystem check — used for MCP registration, which
		// never reads the DB — so it is true even where isAntigravityInstalled
		// (SQLite-gated) would be false on a Node-18 VS Code host.
		expect(await isAntigravityPresent(home)).toBe(true);
	});

	it("isAntigravityPresent is false when no variant dir exists at all", async () => {
		expect(await isAntigravityPresent(freshHome())).toBe(false);
	});

	// The MCP gate must fire for "installed but never chatted": Antigravity's dbs
	// are per-conversation, and MCP registration only runs on an explicit
	// `jolli enable` (SessionStart / plugin bootstrap short-circuits every detector
	// via repoHooksOnly), so keying presence on a db meant the natural ordering
	// install → enable → start chatting silently got no MCP server.
	it("isAntigravityPresent is true for a bare variant dir with no conversation db", async () => {
		const home = freshHome();
		mkdirSync(join(home, ".gemini", "antigravity-ide"), { recursive: true });
		expect(await isAntigravityPresent(home)).toBe(true);
		// …while `installed` stays false — status tree and session discovery have
		// nothing to show for a host with no readable conversations.
		expect(await isAntigravityInstalled(home)).toBe(false);
	});

	it("isAntigravityPresent ignores unrelated ~/.gemini content (Gemini CLI's own dirs)", async () => {
		const home = freshHome();
		mkdirSync(join(home, ".gemini", "tmp"), { recursive: true });
		mkdirSync(join(home, ".gemini", "commands"), { recursive: true });
		expect(await isAntigravityPresent(home)).toBe(false);
	});
});
