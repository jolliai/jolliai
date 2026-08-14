/**
 * ImportablePaths — the one rule two callers used to spell separately.
 *
 * It gets its own test rather than riding on its callers' because of where
 * those callers live: the compare that exercises every REJECTING branch is
 * `CutoverEngine.test.ts`, which is in the slow tier, so the inner loop saw
 * this module at 94.1% statements / 85.7% branches — a pure string predicate
 * under the floor for no better reason than which suite happened to call it.
 * Everything here is a string test with no git, no storage and no fixture, so
 * it belongs in the fast tier by nature.
 */

import { describe, expect, it } from "vitest";
import { IMPORT_FAMILIES, importTakesPath, isTopicPagePath } from "./ImportablePaths.js";

describe("isTopicPagePath", () => {
	it("accepts a canonical page", () => {
		expect(isTopicPagePath("topics/auth-refactor.json")).toBe(true);
	});

	it("rejects another family's path and a non-JSON topic file", () => {
		// Both halves of the same guard: the import lists `topics/` and takes only
		// the pages out of it, so a path from elsewhere and a stray extension are
		// equally not-a-page.
		expect(isTopicPagePath("summaries/a.json")).toBe(false);
		expect(isTopicPagePath("topics/notes.md")).toBe(false);
	});

	it("rejects the two synthesized union views", () => {
		// Not dropped on the floor — the cutover compare handles these separately,
		// by containment. Answering true here would put them through the byte-exact
		// page comparison, which a union view can never pass for a multi-source repo.
		expect(isTopicPagePath("topics/index.json")).toBe(false);
		expect(isTopicPagePath("topics/processed.json")).toBe(false);
	});

	it("rejects nested paths and an empty slug", () => {
		expect(isTopicPagePath("topics/sub/page.json")).toBe(false);
		expect(isTopicPagePath("topics/.json")).toBe(false);
	});
});

describe("importTakesPath", () => {
	it("applies each family's own extension", () => {
		expect(importTakesPath("summaries/", "summaries/abc.json")).toBe(true);
		expect(importTakesPath("transcripts/", "transcripts/abc.json")).toBe(true);
		expect(importTakesPath("plan-progress/", "plan-progress/abc.json")).toBe(true);
		expect(importTakesPath("plans/", "plans/a.md")).toBe(true);
		expect(importTakesPath("notes/", "notes/a.md")).toBe(true);
		expect(importTakesPath("references/", "references/a.md")).toBe(true);
		expect(importTakesPath("skills/", "skills/claude/a.md")).toBe(true);
		expect(importTakesPath("topics/", "topics/a.json")).toBe(true);
	});

	it("refuses the strays that used to block a cutover forever", () => {
		// The measured shapes: an editor's scratch file and a backup copy. The
		// import is designed never to store either, so the database can never
		// answer for them — demanding it did made any such file a permanent,
		// silent blocker.
		expect(importTakesPath("notes/", "notes/scratch.txt")).toBe(false);
		expect(importTakesPath("summaries/", "summaries/abc.json.bak")).toBe(false);
	});

	it("defers to isTopicPagePath for the topics family", () => {
		expect(importTakesPath("topics/", "topics/index.json")).toBe(false);
		expect(importTakesPath("topics/", "topics/sub/page.json")).toBe(false);
	});
});

describe("IMPORT_FAMILIES", () => {
	it("is the complete set, in compare order", () => {
		// Pinned because a family dropped from this list is not "unchecked", it is
		// INVISIBLE: the cutover's containment compare only ever visits paths this
		// produces, so an absent family reports ok having read nothing. Archived
		// skills came within one release of being certified that way and then
		// silently unreadable.
		expect([...IMPORT_FAMILIES]).toEqual([
			"summaries/",
			"transcripts/",
			"plans/",
			"notes/",
			"references/",
			"skills/",
			"plan-progress/",
			"topics/",
		]);
	});

	it("every family answers for a path of its own", () => {
		// Guards the pairing rather than the list: a prefix whose predicate belongs
		// to a different family would still satisfy the assertion above.
		for (const family of IMPORT_FAMILIES) {
			const ext = family === "plans/" || family === "notes/" || family === "references/" || family === "skills/";
			expect(importTakesPath(family, `${family}sample${ext ? ".md" : ".json"}`)).toBe(true);
		}
	});
});
