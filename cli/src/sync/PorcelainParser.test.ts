import { describe, expect, it } from "vitest";
import { isDeletion, type PorcelainEntry, parsePorcelainZ } from "./PorcelainParser.js";

/**
 * `parsePorcelainZ` test bench. Documents the on-the-wire format with
 * concrete fixtures so a future git update that subtly changes the layout
 * fails here loudly instead of producing misclassified stage operations
 * in production.
 *
 * `-z` separator is the literal NUL byte; `\0` in template literals
 * produces it correctly.
 */

describe("parsePorcelainZ — base cases", () => {
	it("returns [] for empty input (clean tree)", () => {
		expect(parsePorcelainZ("")).toEqual([]);
	});

	it("parses a single modified entry", () => {
		// `git status --porcelain -z` for a file modified in the worktree
		// only emits ` M path\0`.
		const out = parsePorcelainZ(" M foo.txt\0");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject<Partial<PorcelainEntry>>({
			indexStatus: " ",
			worktreeStatus: "M",
			path: "foo.txt",
		});
		expect(out[0]?.oldPath).toBeUndefined();
	});

	it("parses a single untracked entry (`??`)", () => {
		const out = parsePorcelainZ("?? newfile.json\0");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject<Partial<PorcelainEntry>>({
			indexStatus: "?",
			worktreeStatus: "?",
			path: "newfile.json",
		});
	});

	it("parses a deletion (worktree side)", () => {
		const out = parsePorcelainZ(" D removed.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.worktreeStatus).toBe("D");
		expect(out[0] !== undefined && isDeletion(out[0])).toBe(true);
	});

	it("parses a deletion (already staged)", () => {
		const out = parsePorcelainZ("D  staged-delete.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.indexStatus).toBe("D");
		expect(out[0] !== undefined && isDeletion(out[0])).toBe(true);
	});

	it("parses an already-staged add (`A `)", () => {
		const out = parsePorcelainZ("A  newfile.json\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.indexStatus).toBe("A");
		expect(out[0]?.worktreeStatus).toBe(" ");
	});
});

describe("parsePorcelainZ — rename / copy pairing", () => {
	it("pairs an index-side rename with its source path (`R `)", () => {
		// `R  newpath\0oldpath\0` — two records.
		const out = parsePorcelainZ("R  newpath.md\0oldpath.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject<Partial<PorcelainEntry>>({
			indexStatus: "R",
			worktreeStatus: " ",
			path: "newpath.md",
			oldPath: "oldpath.md",
		});
	});

	it("pairs a worktree-side rename with its source path (` R`)", () => {
		const out = parsePorcelainZ(" R newpath.md\0oldpath.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe("newpath.md");
		expect(out[0]?.oldPath).toBe("oldpath.md");
	});

	it("pairs a copy (`C `) with its source path", () => {
		const out = parsePorcelainZ("C  copy.md\0orig.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.indexStatus).toBe("C");
		expect(out[0]?.oldPath).toBe("orig.md");
	});

	it("handles a rename whose source path contains a literal space (the parser fix's whole point)", () => {
		// A heuristic like "third char is space ⇒ standard prefix"
		// misparses this one. The state-machine parser must treat the
		// SECOND record as a verbatim path regardless of byte values.
		const out = parsePorcelainZ("R  destination.md\0source with space.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe("destination.md");
		expect(out[0]?.oldPath).toBe("source with space.md");
	});

	it("handles a rename whose source path's third byte is a space (the regression case)", () => {
		// Original "third byte == space" heuristic would have decoded
		// `ab cdef.md` (record length 9, byte 2 = `c`) correctly only by
		// accident. Make sure the explicit state-machine variant works
		// for the adversarial case where byte 2 IS a space.
		// Crafted record: a destination, then a source-path "ab cdef.md".
		const out = parsePorcelainZ("R  destination.md\0ab cdef.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.oldPath).toBe("ab cdef.md");
	});
});

describe("parsePorcelainZ — multi-entry batches", () => {
	it("parses several non-rename entries in one stream", () => {
		const out = parsePorcelainZ([" M modified.json\0", "?? untracked.md\0", " D deleted.md\0"].join(""));
		expect(out).toHaveLength(3);
		expect(out.map((e) => e.path)).toEqual(["modified.json", "untracked.md", "deleted.md"]);
	});

	it("interleaves renames with standard entries correctly", () => {
		// Sequence: modified -> rename (2 records) -> untracked.
		const out = parsePorcelainZ([" M a.md\0", "R  newB.md\0oldB.md\0", "?? c.md\0"].join(""));
		expect(out).toHaveLength(3);
		expect(out[0]?.path).toBe("a.md");
		expect(out[0]?.oldPath).toBeUndefined();
		expect(out[1]?.path).toBe("newB.md");
		expect(out[1]?.oldPath).toBe("oldB.md");
		expect(out[2]?.path).toBe("c.md");
	});

	it("handles back-to-back renames (state machine resets after each pair)", () => {
		const out = parsePorcelainZ(["R  new1.md\0old1.md\0", "R  new2.md\0old2.md\0"].join(""));
		expect(out).toHaveLength(2);
		expect(out[0]?.oldPath).toBe("old1.md");
		expect(out[1]?.oldPath).toBe("old2.md");
	});
});

describe("parsePorcelainZ — defensive paths", () => {
	it("drops records shorter than 3 bytes (malformed git output)", () => {
		// If git ever emitted a 2-byte record (just status codes, no
		// path), we don't crash; we drop it. Real git won't, but the
		// defence costs nothing.
		const out = parsePorcelainZ("XY\0 M valid.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe("valid.md");
	});

	it("coerces unknown status characters to `other`", () => {
		// A future git addition (e.g. a new status code) wouldn't crash
		// us — the entry passes through as "other / other" and stageVault
		// classifies the path normally.
		const out = parsePorcelainZ("XY exotic.md\0");
		expect(out).toHaveLength(1);
		expect(out[0]?.indexStatus).toBe("other");
		expect(out[0]?.worktreeStatus).toBe("other");
		expect(out[0]?.path).toBe("exotic.md");
	});

	it("ignores an empty trailing record from the terminator", () => {
		// `-z` emits a NUL after the LAST record too, so a single-entry
		// stream is "<entry>\0" which split('\0') turns into
		// ["<entry>", ""]. The empty-string filter prevents the parser
		// from emitting a phantom entry.
		const out = parsePorcelainZ(" M only.md\0\0");
		expect(out).toHaveLength(1);
	});
});

describe("isDeletion", () => {
	it.each<[PorcelainEntry, boolean]>([
		[{ indexStatus: "D", worktreeStatus: " ", path: "x" }, true],
		[{ indexStatus: " ", worktreeStatus: "D", path: "x" }, true],
		[{ indexStatus: "D", worktreeStatus: "D", path: "x" }, true],
		[{ indexStatus: "M", worktreeStatus: " ", path: "x" }, false],
		[{ indexStatus: "A", worktreeStatus: " ", path: "x" }, false],
		[{ indexStatus: "?", worktreeStatus: "?", path: "x" }, false],
		[{ indexStatus: "R", worktreeStatus: " ", path: "x", oldPath: "y" }, false],
	])("isDeletion(%j) === %s", (entry, expected) => {
		expect(isDeletion(entry)).toBe(expected);
	});
});
