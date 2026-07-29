import { describe, expect, it } from "vitest";
import { describeMemoryBank } from "./MemoryBankStatusText.js";

describe("describeMemoryBank", () => {
	it("shows the resolved folder when dual-write is live", () => {
		// No mode qualifier for dual-write: it's the default, so naming it would
		// add noise to the common case.
		expect(describeMemoryBank({ kind: "active", mode: "dual-write", folder: "/bank/widgets" })).toEqual({
			severity: "ok",
			text: "/bank/widgets",
		});
	});

	it("qualifies folder-only mode so the missing orphan branch isn't a surprise", () => {
		expect(describeMemoryBank({ kind: "active", mode: "folder", folder: "/bank/widgets" })).toEqual({
			severity: "ok",
			text: "/bank/widgets (folder-only)",
		});
	});

	it("treats orphan-only as informational, not a warning", () => {
		// A deliberate configuration. Rendering it as a warning would train users
		// to ignore the row that matters.
		const display = describeMemoryBank({ kind: "orphan-only" });
		expect(display.severity).toBe("off");
		expect(display.text).toContain("orphan branch only");
	});

	it("names both the blocker and the remedy for an in-repo folder", () => {
		// The user can see neither input (storageMode has no UI, the gate's verdict
		// comes from a cwd they never typed), so the text has to carry both.
		const display = describeMemoryBank({
			kind: "degraded",
			blocker: "folder-inside-repo",
			parent: "/repo/memory-bank",
		});
		expect(display.severity).toBe("warn");
		expect(display.text).toContain("/repo/memory-bank");
		expect(display.text).toContain("outside the working tree");
	});

	it("warns when the cwd is not a git worktree", () => {
		const display = describeMemoryBank({ kind: "degraded", blocker: "not-a-project" });
		expect(display.severity).toBe("warn");
		expect(display.text).toContain("not inside a git worktree");
	});

	it("warns without inventing a path when the folder is unresolvable", () => {
		// `parent` is absent for this blocker precisely because resolving it is
		// what failed — the text must not print `undefined`.
		const display = describeMemoryBank({ kind: "degraded", blocker: "unresolvable-folder" });
		expect(display.severity).toBe("warn");
		expect(display.text).not.toContain("undefined");
		expect(display.text).toContain("$HOME");
	});
});
