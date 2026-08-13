import { describe, expect, it } from "vitest";

import { isJolliInternalRef, JOLLI_REFS_EXCLUDE_GLOB } from "./JolliRefs.js";

describe("isJolliInternalRef", () => {
	// The namespace-vs-prefix distinction used to be pinned through
	// `DashboardCollector`'s branch-attribution scan, which is gone (attribution is
	// now the summary's recorded branch, not a per-ref reachability union). The rule
	// itself is still live in `DbBackfill.checkoutFingerprint`, where getting it
	// wrong is a silent stall rather than a visible error: a user branch wrongly
	// classified as internal is filtered out of the fingerprint, so commits landing
	// on it never move the cursor and never trigger a sweep.
	it("matches the reserved namespace in both the short and full ref forms", () => {
		expect(isJolliInternalRef("jollimemory/summaries/v3")).toBe(true);
		expect(isJolliInternalRef("refs/heads/jollimemory/summaries/v3")).toBe(true);
		// A retired version inside the namespace goes with it.
		expect(isJolliInternalRef("jollimemory/summaries/v2")).toBe(true);
	});

	it("leaves a user branch merely NAMED like the namespace alone", () => {
		// Matched by namespace (`jollimemory/`), never by prefix — `jollimemory-notes`
		// is ordinary work and must keep counting.
		expect(isJolliInternalRef("jollimemory-notes")).toBe(false);
		expect(isJolliInternalRef("refs/heads/jollimemory-notes")).toBe(false);
		// The bare namespace with no separator is not the namespace either.
		expect(isJolliInternalRef("jollimemory")).toBe(false);
	});

	it("leaves unrelated branches alone", () => {
		expect(isJolliInternalRef("main")).toBe(false);
		expect(isJolliInternalRef("feature/jollimemory/x")).toBe(false);
	});
});

describe("JOLLI_REFS_EXCLUDE_GLOB", () => {
	// Measured: the `refs/heads/`-prefixed form matches NOTHING under `--branches`
	// and is silently ignored (2468 commits listed, exactly as if absent), while
	// this form listed 668. Neither shape errors or warns, so the only thing
	// standing between the two is this assertion.
	it("is relative to the selector and keeps its mandatory trailing glob", () => {
		expect(JOLLI_REFS_EXCLUDE_GLOB).toBe("--exclude=jollimemory/*");
		expect(JOLLI_REFS_EXCLUDE_GLOB).not.toContain("refs/heads/");
	});
});
