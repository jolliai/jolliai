/**
 * Tests for CliConflictUi — TTY prompt + non-TTY fallback + git diff path.
 *
 * The readline factory is stubbed with `promptImpl`; we don't drive a real
 * TTY. `showDiff` writes temp files and shells out to `git diff --no-index`,
 * so we mock `execFile` too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliConflictUi } from "./CliConflictUi.js";

let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	writeSpy.mockRestore();
	vi.restoreAllMocks();
});

describe("CliConflictUi.promptBinaryPick", () => {
	it("returns skip immediately when stdin is not a TTY", async () => {
		const ui = new CliConflictUi({ isTty: false });
		const result = await ui.promptBinaryPick("foo.md", null, null);
		expect(result).toBe("skip");
	});

	it("maps 'm' to mine", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "m" });
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("mine");
	});

	it("maps 't' to theirs", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "t" });
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("theirs");
	});

	it("maps 'd' to viewDiff", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "d" });
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("viewDiff");
	});

	it("maps 's' to skip", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "s" });
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("skip");
	});

	it("is case-insensitive (uppercase MINE)", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "MINE" });
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("mine");
	});

	it("tolerates whitespace around the answer", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "  theirs  " });
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("theirs");
	});

	it("writes the prompt text to stdout before reading", async () => {
		const ui = new CliConflictUi({ isTty: true, promptImpl: async () => "s" });
		await ui.promptBinaryPick("notes/foo.md", null, null);
		const calls = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(calls).toContain("Conflict in: notes/foo.md");
		expect(calls).toContain("Use mine");
		expect(calls).toContain("Use theirs");
	});
});

describe("CliConflictUi.showDiff", () => {
	it("writes diff output to stdout when git emits a non-empty diff (exit 0)", async () => {
		const execFileImpl = vi.fn(async () => ({ stdout: "+++added line", stderr: "" }));
		const ui = new CliConflictUi({
			isTty: true,
			promptImpl: async () => "s",
			execFileImpl: execFileImpl as never,
		});
		await ui.showDiff("a.md", "old", "new");
		const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("[diff for a.md]");
		expect(written).toContain("+++added line");
	});

	it("recovers diff stdout from a non-zero exit (git diff exit=1 means diffs were found)", async () => {
		const execFileImpl = vi.fn(async () => {
			const err = new Error("non-zero exit") as Error & { stdout?: string; code?: number };
			err.stdout = "+++added line";
			err.code = 1;
			throw err;
		});
		const ui = new CliConflictUi({
			isTty: true,
			promptImpl: async () => "s",
			execFileImpl: execFileImpl as never,
		});
		await ui.showDiff("a.md", "x", "y");
		const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("[diff for a.md]");
		expect(written).toContain("+++added line");
	});

	it("does not crash when both stdout paths are empty", async () => {
		const execFileImpl = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const ui = new CliConflictUi({
			isTty: true,
			promptImpl: async () => "s",
			execFileImpl: execFileImpl as never,
		});
		await expect(ui.showDiff("a.md", "x", "x")).resolves.toBeUndefined();
	});

	it("handles a rejection that carries no stdout field (`?? ''` fallback)", async () => {
		// `git diff` could throw for reasons other than "diffs found" — e.g.
		// git not installed, or the executable itself segfaulted. The catch
		// must still resolve cleanly when the rejection object has no stdout
		// property at all.
		const execFileImpl = vi.fn(async () => {
			throw new Error("ENOENT spawning git");
		});
		const ui = new CliConflictUi({
			isTty: true,
			promptImpl: async () => "s",
			execFileImpl: execFileImpl as never,
		});
		await expect(ui.showDiff("a.md", "x", "y")).resolves.toBeUndefined();
	});
});
