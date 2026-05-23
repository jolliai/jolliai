/**
 * Tests for the vault commit-message convention. `build` and `parse` must
 * round-trip for every op type.
 */

import { describe, expect, it } from "vitest";
import { buildCommitMessage, type CommitMetadata, parseCommitMessage } from "./CommitMessage.js";

describe("buildCommitMessage", () => {
	it("formats a plain add subject", () => {
		expect(buildCommitMessage({ op: "add", summary: "12 summaries from migrate" })).toBe(
			"[jolli-mb] add: 12 summaries from migrate",
		);
	});

	it("formats a delete subject", () => {
		expect(buildCommitMessage({ op: "delete", summary: "cleanup stale (1 file)" })).toBe(
			"[jolli-mb] delete: cleanup stale (1 file)",
		);
	});

	it("formats a merge aggregate (no per-file flags)", () => {
		expect(buildCommitMessage({ op: "merge", summary: "3 files via AI" })).toBe("[jolli-mb] merge: 3 files via AI");
	});

	it("formats a single-file merge with model tag", () => {
		expect(
			buildCommitMessage({
				op: "merge",
				summary: "preserved both branches",
				perFileFlags: { path: "notes/foo.md", model: "claude-sonnet-4-6" },
			}),
		).toBe("[jolli-mb] merge(notes/foo.md): preserved both branches [model=claude-sonnet-4-6]");
	});

	it("formats a Tier-3 pick subject", () => {
		expect(
			buildCommitMessage({
				op: "pick",
				summary: "theirs",
				perFileFlags: { path: "notes/foo.md", pick: "theirs" },
			}),
		).toBe("[jolli-mb] pick(notes/foo.md): theirs");
	});

	it("formats a migrate subject", () => {
		expect(buildCommitMessage({ op: "migrate", summary: "47 items from <localFolder>" })).toBe(
			"[jolli-mb] migrate: 47 items from <localFolder>",
		);
	});

	it("formats a bootstrap subject", () => {
		expect(buildCommitMessage({ op: "bootstrap", summary: "write .gitignore" })).toBe(
			"[jolli-mb] bootstrap: write .gitignore",
		);
	});
});

describe("parseCommitMessage", () => {
	it("parses a plain add", () => {
		expect(parseCommitMessage("[jolli-mb] add: 12 summaries from migrate")).toEqual({
			op: "add",
			summary: "12 summaries from migrate",
		});
	});

	it("parses a single-file merge with model", () => {
		expect(
			parseCommitMessage("[jolli-mb] merge(notes/foo.md): preserved both branches [model=claude-sonnet-4-6]"),
		).toEqual({
			op: "merge",
			summary: "preserved both branches",
			perFileFlags: { path: "notes/foo.md", model: "claude-sonnet-4-6" },
		});
	});

	it("parses a pick subject and lifts mine|theirs into perFileFlags", () => {
		expect(parseCommitMessage("[jolli-mb] pick(notes/foo.md): mine")).toEqual({
			op: "pick",
			summary: "mine",
			perFileFlags: { path: "notes/foo.md", pick: "mine" },
		});
	});

	it("returns null for non-jolli-mb commits", () => {
		expect(parseCommitMessage("chore: bump version")).toBeNull();
		expect(parseCommitMessage("")).toBeNull();
		expect(parseCommitMessage("[jolli-mb] ")).toBeNull();
	});

	it("returns null for unknown ops", () => {
		expect(parseCommitMessage("[jolli-mb] frobnicate: do a thing")).toBeNull();
	});

	it("returns null when the body shape doesn't match (missing colon)", () => {
		expect(parseCommitMessage("[jolli-mb] add")).toBeNull();
		expect(parseCommitMessage("[jolli-mb] add no-colon")).toBeNull();
	});

	it("ignores leading/trailing whitespace and parses the first line only", () => {
		const msg = "[jolli-mb] add: 1 file\n\nbody line\n  ";
		expect(parseCommitMessage(msg)).toEqual({ op: "add", summary: "1 file" });
	});

	it("captures model tag when present on a non-merge op (forward-compat)", () => {
		expect(parseCommitMessage("[jolli-mb] add: 1 file [model=m]")).toEqual({
			op: "add",
			summary: "1 file",
			perFileFlags: { path: "", model: "m" },
		});
	});
});

describe("buildCommitMessage / parseCommitMessage round-trip", () => {
	const samples: CommitMetadata[] = [
		{ op: "add", summary: "1 file" },
		{ op: "delete", summary: "stale" },
		{ op: "merge", summary: "3 files via AI" },
		{
			op: "merge",
			summary: "preserved both branches",
			perFileFlags: { path: "notes/foo.md", model: "claude-sonnet-4-6" },
		},
		{
			op: "pick",
			summary: "theirs",
			perFileFlags: { path: "a/b.md", pick: "theirs" },
		},
		{ op: "migrate", summary: "47 items" },
		{ op: "bootstrap", summary: "write .gitignore" },
		{ op: "aggregate-merge", summary: "3 files (manifest, index, catalog)" },
		{
			op: "aggregate-merge",
			summary: "merged 5 entries",
			perFileFlags: { path: ".jolli/manifest.json" },
		},
	];

	it.each(samples)("round-trips %s", (meta) => {
		const built = buildCommitMessage(meta);
		const parsed = parseCommitMessage(built);
		expect(parsed?.op).toBe(meta.op);
		expect(parsed?.summary).toBe(meta.summary);
		expect(parsed?.perFileFlags?.path).toBe(meta.perFileFlags?.path);
		expect(parsed?.perFileFlags?.model).toBe(meta.perFileFlags?.model);
		expect(parsed?.perFileFlags?.pick).toBe(meta.perFileFlags?.pick);
	});
});
