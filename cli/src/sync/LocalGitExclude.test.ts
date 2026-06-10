/**
 * Tests for `appendLocalExclude` — per-clone exclude shim used by
 * `CorruptJsonQuarantine` to keep its quarantine directories off staging
 * during the first round before `MemoryBankBootstrap` writes `.gitignore`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLocalExclude } from "./LocalGitExclude.js";

describe("appendLocalExclude", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await mkdtemp(join(tmpdir(), "local-exclude-"));
		// Pre-create `.git/` so the helper has a parent to write into;
		// callers in production only run after fetch/clone has succeeded.
		await mkdir(join(vault, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	it("creates `.git/info/exclude` with a Jolli header and the pattern on first call", async () => {
		const ok = await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		expect(ok).toBe(true);
		const content = await readFile(join(vault, ".git", "info", "exclude"), "utf-8");
		expect(content).toContain("# Jolli Memory engine-owned exclusions");
		expect(content.split("\n")).toContain(".jolli-quarantine-corrupt/");
	});

	it("is idempotent — a second call with the same pattern does NOT duplicate the line", async () => {
		await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		const content = await readFile(join(vault, ".git", "info", "exclude"), "utf-8");
		const occurrences = content.split("\n").filter((l) => l === ".jolli-quarantine-corrupt/");
		expect(occurrences).toHaveLength(1);
	});

	it("preserves pre-existing user content (any prior hand-written lines stay verbatim)", async () => {
		await mkdir(join(vault, ".git", "info"), { recursive: true });
		await writeFile(join(vault, ".git", "info", "exclude"), "# user notes\nmy-secret.env\n", "utf-8");
		await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		const content = await readFile(join(vault, ".git", "info", "exclude"), "utf-8");
		expect(content).toContain("# user notes");
		expect(content).toContain("my-secret.env");
		expect(content).toContain(".jolli-quarantine-corrupt/");
		// User content must come BEFORE the appended pattern — we append,
		// not prepend.
		expect(content.indexOf("my-secret.env")).toBeLessThan(content.indexOf(".jolli-quarantine-corrupt/"));
	});

	it("appends a trailing newline when the existing file does not end with one", async () => {
		await mkdir(join(vault, ".git", "info"), { recursive: true });
		// Deliberately omit trailing newline — appending without injecting
		// one would concatenate onto the prior line.
		await writeFile(join(vault, ".git", "info", "exclude"), "previous-rule", "utf-8");
		await appendLocalExclude(vault, "new-rule");
		const content = await readFile(join(vault, ".git", "info", "exclude"), "utf-8");
		expect(content.split("\n")).toEqual(expect.arrayContaining(["previous-rule", "new-rule"]));
	});

	it("does NOT skip the append when a longer line happens to contain the pattern as a substring", async () => {
		// Whole-line match: a negation like `!foo-dir/extra` must not
		// shadow our `foo-dir/` append. Otherwise an attacker (or
		// well-meaning user) could neutralise the exclude by adding a
		// loose substring line.
		await mkdir(join(vault, ".git", "info"), { recursive: true });
		await writeFile(join(vault, ".git", "info", "exclude"), "!.jolli-quarantine-corrupt/-keep\n");
		await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		const content = await readFile(join(vault, ".git", "info", "exclude"), "utf-8");
		expect(content.split("\n")).toContain(".jolli-quarantine-corrupt/");
	});

	it("returns true when the pattern is already present and skips the file write", async () => {
		await mkdir(join(vault, ".git", "info"), { recursive: true });
		await writeFile(join(vault, ".git", "info", "exclude"), ".jolli-quarantine-corrupt/\n");
		const ok = await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		expect(ok).toBe(true);
		// Same exact content (no duplicate, no header injection on an
		// already-populated file).
		const content = await readFile(join(vault, ".git", "info", "exclude"), "utf-8");
		expect(content).toBe(".jolli-quarantine-corrupt/\n");
	});

	it("returns false (non-fatal) when the read fails for a non-ENOENT reason", async () => {
		// Plant a DIRECTORY where `exclude` should be a file: readFile throws
		// EISDIR (not ENOENT), exercising the non-ENOENT warn branch, and the
		// subsequent writeFile also fails — the helper degrades to false rather
		// than throwing (its contract is "best-effort, never propagate").
		await mkdir(join(vault, ".git", "info", "exclude"), { recursive: true });
		const ok = await appendLocalExclude(vault, ".jolli-quarantine-corrupt/");
		expect(ok).toBe(false);
	});
});
