import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPin, listPins, pinGroupKey, removePin } from "./PinStore.js";

describe("PinStore", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pinstore-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("composes the group key as repo::branch", () => {
		expect(pinGroupKey("acme", "main")).toBe("acme::main");
	});

	it("returns [] when no pins file exists", async () => {
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("adds, lists, and scopes pins per repo::branch", async () => {
		await addPin(dir, "acme", "main", { kind: "memory", id: "abc123", title: "Fix bug", pinnedAt: 1 });
		await addPin(dir, "acme", "feat", { kind: "plan", id: "p1", title: "Plan", pinnedAt: 2 });
		const main = await listPins(dir, "acme", "main");
		expect(main).toHaveLength(1);
		expect(main[0]).toMatchObject({ kind: "memory", id: "abc123" });
		expect(await listPins(dir, "acme", "feat")).toHaveLength(1);
		expect(await listPins(dir, "other", "main")).toEqual([]);
	});

	it("is idempotent on (kind,id) — re-adding updates in place", async () => {
		await addPin(dir, "acme", "main", { kind: "memory", id: "x", title: "old", pinnedAt: 1 });
		await addPin(dir, "acme", "main", { kind: "memory", id: "x", title: "new", pinnedAt: 5 });
		const pins = await listPins(dir, "acme", "main");
		expect(pins).toHaveLength(1);
		expect(pins[0].title).toBe("new");
	});

	it("removes a pin by (kind,id)", async () => {
		await addPin(dir, "acme", "main", { kind: "note", id: "n1", title: "N", pinnedAt: 1 });
		await removePin(dir, "acme", "main", "note", "n1");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("removing a missing pin is a no-op", async () => {
		await removePin(dir, "acme", "main", "note", "nope");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("tolerates a corrupt pins file by treating it as empty", async () => {
		await addPin(dir, "acme", "main", { kind: "plan", id: "p", title: "P", pinnedAt: 1 });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, ".jolli", "jollimemory", "pins.json"), "{ not json", "utf8");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("tolerates a malformed pins file (missing groups) by treating it as empty", async () => {
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(dir, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(join(dir, ".jolli", "jollimemory", "pins.json"), '{"version": 1}', "utf8");
		expect(await listPins(dir, "acme", "main")).toEqual([]);
	});

	it("serializes concurrent adds so no update is lost", async () => {
		// Fire three adds without awaiting individually — the sidebar issues
		// pin clicks fire-and-forget. An unlocked read-modify-write would let
		// later calls read a pre-state and clobber earlier writes; the
		// serialize() chain must preserve all three.
		await Promise.all([
			addPin(dir, "acme", "main", { kind: "memory", id: "a", title: "A", pinnedAt: 1 }),
			addPin(dir, "acme", "main", { kind: "memory", id: "b", title: "B", pinnedAt: 2 }),
			addPin(dir, "acme", "main", { kind: "memory", id: "c", title: "C", pinnedAt: 3 }),
		]);
		const pins = await listPins(dir, "acme", "main");
		expect(pins.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("rethrows when the atomic write fails (errors surface, never silently swallowed)", async () => {
		const { mkdir } = await import("node:fs/promises");
		// Pre-create the destination as a directory so the rename inside
		// atomicWriteFile fails with EISDIR (non-recoverable, unlike the Windows
		// EPERM/EACCES path it retries). The pin save must reject, not swallow.
		const jolliDir = join(dir, ".jolli", "jollimemory");
		await mkdir(join(jolliDir, "pins.json"), { recursive: true });
		await expect(addPin(dir, "acme", "main", { kind: "memory", id: "x", title: "X", pinnedAt: 1 })).rejects.toThrow(
			/EISDIR|is a directory|EPERM/i,
		);
	});

	it("round-trips a conversation pin with source and transcriptPath", async () => {
		await addPin(dir, "acme", "main", {
			kind: "conversation",
			id: "sess-abc",
			title: "My chat",
			pinnedAt: 42,
			source: "claude",
			transcriptPath: "/home/user/.claude/projects/foo/session.jsonl",
		});
		const pins = await listPins(dir, "acme", "main");
		expect(pins).toHaveLength(1);
		expect(pins[0]).toMatchObject({
			kind: "conversation",
			id: "sess-abc",
			title: "My chat",
			source: "claude",
			transcriptPath: "/home/user/.claude/projects/foo/session.jsonl",
		});
	});

	// ─── C4: version + per-group validation (mirrors CommitSelectionStore) ──────
	describe("corruption tolerance (C4)", () => {
		async function writePins(content: string): Promise<void> {
			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(join(dir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(join(dir, ".jolli", "jollimemory", "pins.json"), content, "utf8");
		}

		it("degrades a non-array group to [] without throwing on listPins", async () => {
			// A hand-edit / corruption turned a group into an object. Pre-fix this
			// reached addPin/removePin's `.filter` and threw a TypeError.
			await writePins(JSON.stringify({ version: 1, groups: { "acme::main": { bogus: true } } }));
			expect(await listPins(dir, "acme", "main")).toEqual([]);
		});

		it("does not throw on addPin when an existing group is a non-array", async () => {
			await writePins(JSON.stringify({ version: 1, groups: { "acme::main": "not-an-array" } }));
			await addPin(dir, "acme", "main", { kind: "memory", id: "z", title: "Z", pinnedAt: 9 });
			const pins = await listPins(dir, "acme", "main");
			expect(pins.map((p) => p.id)).toEqual(["z"]);
		});

		it("does not throw on removePin when an existing group is a non-array", async () => {
			await writePins(JSON.stringify({ version: 1, groups: { "acme::main": 42 } }));
			await expect(removePin(dir, "acme", "main", "memory", "anything")).resolves.toBeUndefined();
			expect(await listPins(dir, "acme", "main")).toEqual([]);
		});

		it("filters out malformed entries but keeps the well-formed ones in a group", async () => {
			await writePins(
				JSON.stringify({
					version: 1,
					groups: {
						"acme::main": [
							{ kind: "memory", id: "good", title: "Good", pinnedAt: 1 },
							{ kind: "bogus-kind", id: "x", title: "bad kind", pinnedAt: 2 },
							{ kind: "memory", id: "missing-title", pinnedAt: 3 },
							{ kind: "memory", id: "bad-pinnedAt", title: "T", pinnedAt: "nope" },
							null,
							"a string",
						],
					},
				}),
			);
			const pins = await listPins(dir, "acme", "main");
			expect(pins.map((p) => p.id)).toEqual(["good"]);
		});

		it("treats a recognized-shape file with an unrecognized version as empty", async () => {
			await writePins(
				JSON.stringify({
					version: 999,
					groups: { "acme::main": [{ kind: "memory", id: "x", title: "X", pinnedAt: 1 }] },
				}),
			);
			expect(await listPins(dir, "acme", "main")).toEqual([]);
		});
	});
});
