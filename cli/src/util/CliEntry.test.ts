import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCliEntry, resolveCliInvocation } from "./CliEntry.js";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "jolli-cli-entry-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

describe("resolveCliEntry", () => {
	it("resolves Cli.js as a sibling of the calling module", async () => {
		await writeFile(join(scratch, "Cli.js"), "");
		const caller = pathToFileURL(join(scratch, "PostCommitHook.js")).href;

		// Every bundle that ships this code — the CLI's flat vite dist, the VS Code
		// extension, both plugin dists — puts Cli.js beside every other entry, so a
		// sibling lookup names the CLI wherever this module ended up inlined.
		expect(resolveCliEntry(caller)).toBe(join(scratch, "Cli.js"));
	});

	it("returns undefined when no Cli.js sits beside the caller", () => {
		const caller = pathToFileURL(join(scratch, "PostCommitHook.js")).href;
		expect(resolveCliEntry(caller)).toBeUndefined();
	});
});

describe("resolveCliInvocation", () => {
	it("returns the built Cli.js with no extra Node args when a sibling dist entry exists", async () => {
		await writeFile(join(scratch, "Cli.js"), "");
		const caller = pathToFileURL(join(scratch, "PostCommitHook.js")).href;

		expect(resolveCliInvocation(caller, "/ignored/hook.js", ["--import", "tsx"])).toEqual({
			entry: join(scratch, "Cli.js"),
			nodeArgs: [],
		});
	});

	it("falls back to src/Cli.ts plus the current loader args during a tsx dev run", async () => {
		const srcDir = join(scratch, "src");
		const caller = pathToFileURL(join(srcDir, "hooks", "PostCommitHook.ts")).href;
		await mkdir(srcDir, { recursive: true });
		await writeFile(join(srcDir, "Cli.ts"), "");

		expect(resolveCliInvocation(caller, "/repo/cli/src/hooks/PostCommitHook.ts", ["--import", "tsx"])).toEqual({
			entry: join(srcDir, "Cli.ts"),
			nodeArgs: ["--import", "tsx"],
		});
	});

	it("returns undefined when neither a built nor source CLI entry is available", () => {
		const caller = pathToFileURL(join(scratch, "src", "hooks", "PostCommitHook.ts")).href;

		expect(
			resolveCliInvocation(caller, "/repo/cli/src/hooks/PostCommitHook.ts", ["--import", "tsx"]),
		).toBeUndefined();
	});
});
