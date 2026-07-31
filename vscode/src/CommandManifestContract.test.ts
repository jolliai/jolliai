/**
 * Contract guard: every command declared in `package.json` must actually be
 * registered in the extension source.
 *
 * A `contributes.commands` entry with no `registerCommand` is not inert — VS Code
 * lists it in the Command Palette, and invoking it fails with
 * "command '<id>' not found". Nothing in the build catches this: the manifest and the
 * registration live in different languages, and an unregistered command compiles,
 * bundles and activates cleanly.
 *
 * This shipped once (`jollimemory.openSkillMarkdown`): the skills row's inline edit
 * action was deliberately dropped from the UI — a sidebar test even asserts the
 * script no longer references the id — while the manifest entry was left behind,
 * leaving a palette command that could only throw.
 *
 * The reverse direction is deliberately NOT asserted: a registered command with no
 * manifest entry is a normal, working, programmatically-invoked command (see
 * `jollimemory.previewCommittedSkills`). Only palette-visible-but-dead is a defect.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vscodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
	readonly contributes?: { readonly commands?: ReadonlyArray<{ readonly command: string }> };
}

function declaredCommands(): string[] {
	const pkg = JSON.parse(readFileSync(resolve(vscodeRoot, "package.json"), "utf-8")) as Manifest;
	return (pkg.contributes?.commands ?? []).map((c) => c.command);
}

/** Every non-test `.ts` under `src/`, walked without a glob dependency. */
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(full, out);
		else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
	}
	return out;
}

function registeredCommands(): Set<string> {
	// Scanned as text rather than by importing the extension: `activate()` needs a live
	// VS Code host, and the question here is purely "does this id appear in a
	// registerCommand call site".
	const found = new Set<string>();
	for (const file of sourceFiles(resolve(vscodeRoot, "src"))) {
		const text = readFileSync(file, "utf-8");
		for (const match of text.matchAll(/registerCommand\(\s*["']([^"']+)["']/gu)) found.add(match[1]);
	}
	return found;
}

describe("command manifest contract", () => {
	it("declares at least the commands we expect to find (guard is not vacuous)", () => {
		expect(declaredCommands().length).toBeGreaterThan(20);
	});

	it("registers every command declared in package.json", () => {
		const registered = registeredCommands();
		const dead = declaredCommands().filter((id) => !registered.has(id));
		expect(dead).toEqual([]);
	});
});
