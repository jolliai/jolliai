import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

async function source(relative: string): Promise<string> {
	return await readFile(join(SRC, relative), "utf8");
}

describe("global daemon trigger wiring", () => {
	it.each([
		["Cli.ts", "Cli.ts"],
		["post-commit hook", "hooks/PostCommitHook.ts"],
		["session start hook", "hooks/SessionStartHook.ts"],
		["Claude plugin bootstrap", "hooks/PluginBootstrapHook.ts"],
		["Codex plugin bootstrap", "hooks/CodexPluginBootstrapHook.ts"],
	])("%s triggers the detached ensure helper", async (_label, file) => {
		expect(await source(file)).toContain("triggerEnsureGlobalDaemon");
	});

	it("uninstall retires the daemon rather than leaving an orphan", async () => {
		expect(await source("commands/UninstallCommand.ts")).toContain("retireGlobalDaemon");
	});

	it("no trigger writes to stdout — the Codex bootstrap validates its stdout as one JSON object", async () => {
		const helper = await source("daemon/EnsureGlobalDaemon.ts");
		expect(helper).not.toContain("console.log");
		expect(helper).not.toContain("process.stdout.write");
	});
});
