import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../Types.js";
import { defineSessionSource } from "./SessionSourceDefinition.js";

/** A scan payload shape no other source uses, so the erasure is visibly round-tripped. */
interface FakeScanned {
	readonly id: string;
}

const SESSION: SessionInfo = {
	sessionId: "s1",
	transcriptPath: "/tmp/s1.jsonl",
	updatedAt: "2026-08-01T00:00:00.000Z",
	source: "claude",
};

describe("defineSessionSource", () => {
	it("defaults `usesAlreadyRecorded` to false when the spec omits it", () => {
		// Declared rather than inferred, so the registry can report which sources
		// participate in scan-level skipping. Most do not.
		const def = defineSessionSource<FakeScanned>({
			source: "codex",
			scan: async () => [],
			forRepo: () => [],
		});
		expect(def.usesAlreadyRecorded).toBe(false);
	});

	it("keeps `usesAlreadyRecorded` when the spec declares it", () => {
		const def = defineSessionSource<FakeScanned>({
			source: "claude",
			usesAlreadyRecorded: true,
			scan: async () => [],
			forRepo: () => [],
		});
		expect(def.usesAlreadyRecorded).toBe(true);
	});

	it("hands `scan`'s own payload straight back to `forRepo`", () => {
		// The erasure is only sound because the pair is called through one definition:
		// whatever `scan` produced is what `forRepo` receives, untouched.
		const scanned: FakeScanned[] = [{ id: "a" }];
		const forRepo = vi.fn(() => [SESSION]);
		const def = defineSessionSource<FakeScanned>({
			source: "codex",
			scan: async () => scanned,
			forRepo,
		});

		expect(def.forRepo(scanned, "/repo", 1_000)).toEqual([SESSION]);
		expect(forRepo).toHaveBeenCalledWith(scanned, "/repo", 1_000);
	});

	it("forwards an absent window as undefined rather than inventing one", () => {
		// Most sources ignore the argument; the ones that read it (Cursor) must be able
		// to tell "no window given" from a number.
		const forRepo = vi.fn(() => []);
		const def = defineSessionSource<FakeScanned>({ source: "codex", scan: async () => [], forRepo });

		def.forRepo([], "/repo");

		expect(forRepo).toHaveBeenCalledWith([], "/repo", undefined);
	});

	it("carries `scanForRepo` through when the spec has one", async () => {
		const scanForRepo = vi.fn(async () => [SESSION]);
		const def = defineSessionSource<FakeScanned>({
			source: "codex",
			scan: async () => [],
			forRepo: () => [],
			scanForRepo,
		});

		expect(def.scanForRepo).toBeDefined();
		await expect(def.scanForRepo?.("/repo", 500)).resolves.toEqual([SESSION]);
		expect(scanForRepo).toHaveBeenCalledWith("/repo", 500);
	});

	it("OMITS `scanForRepo` when the spec has none — Claude's case", () => {
		// Absent, not a no-op stub: `loadAllSessions` reads its presence to decide
		// whether a source has a per-repo fallback at all, and Claude's per-repo route
		// is the hook registry rather than its own store.
		const def = defineSessionSource<FakeScanned>({
			source: "claude",
			scan: async () => [],
			forRepo: () => [],
		});
		expect(def.scanForRepo).toBeUndefined();
		expect("scanForRepo" in def).toBe(false);
	});

	it("passes the scan options through verbatim, including the skip predicate", async () => {
		const scan = vi.fn(async () => []);
		const alreadyRecorded = vi.fn(() => false);
		const def = defineSessionSource<FakeScanned>({ source: "claude", scan, forRepo: () => [] });

		await def.scan({ windowMs: 42, alreadyRecorded });

		expect(scan).toHaveBeenCalledWith({ windowMs: 42, alreadyRecorded });
	});

	it("supports an ASYNC `forRepo`, which two sources genuinely need", async () => {
		// Antigravity enumerates the repo's worktrees, Cursor resolves a workspace
		// hash — both are per-repo questions no machine-wide scan could answer ahead.
		const def = defineSessionSource<FakeScanned>({
			source: "antigravity",
			scan: async () => [],
			forRepo: async () => [SESSION],
		});
		await expect(def.forRepo([], "/repo")).resolves.toEqual([SESSION]);
	});
});
