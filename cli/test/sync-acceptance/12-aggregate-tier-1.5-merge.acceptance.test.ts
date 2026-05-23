/**
 * Acceptance §8 scenario 12 — Aggregate Tier 1.5 deterministic merge.
 *
 * Setup: a peer device pushes `.jolli/manifest.json` containing entry "B".
 * Our device then runs a sync round with a local FolderStorage that has the
 * same `manifest.json` containing entry "A". `git pull --rebase` produces a
 * conflict on `.jolli/manifest.json`; the conflict resolver's **Tier 1.5**
 * path must:
 *
 *   - JSON.parse both stages (ours = A, theirs = B).
 *   - Call `mergeManifest` → entries [A, B].
 *   - Write merged content + `git add`.
 *   - `git rebase --continue` → push succeeds.
 *   - Tier 2 (AI merge) + Tier 3 (UI prompt) must NOT be invoked.
 *
 * The bare repo's final `main:.jolli/manifest.json` carries both entries.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConflictUi } from "../../src/sync/ConflictResolver.js";
import {
	type AcceptanceWorld,
	buildEngineForWorld,
	defaultRoundOptions,
	pushFromPeerDevice,
	readBlobAtMain,
	setupAcceptance,
	teardownAcceptance,
} from "./_helpers.js";

let world: AcceptanceWorld;

beforeEach(async () => {
	world = await setupAcceptance();
});

afterEach(async () => {
	await teardownAcceptance(world);
});

function entry(fileId: string, generatedAt: string) {
	return {
		path: `notes/${fileId}.md`,
		fileId,
		type: "commit",
		fingerprint: `fp-${fileId}`,
		title: `title-${fileId}`,
		source: { commitHash: `c-${fileId}`, branch: "main", generatedAt },
	};
}

describe("acceptance §12 — aggregate Tier 1.5 merge", () => {
	it("auto-merges manifest.json on rebase conflict without invoking Tier 2 or Tier 3", async () => {
		// Both peer + local must write to the SAME canonical aggregate path
		// for the conflict to materialize. Per §0.13, that path is
		// `<repoFolder>/.jolli/manifest.json` (NOT root-level — the old
		// "mirror to vault root" step is gone).
		const aggregatePath = "test-repo/.jolli/manifest.json";

		// Peer pushed manifest.json with entry B.
		const peerManifest = JSON.stringify(
			{ version: 1, files: [entry("B", "2026-05-02T00:00:00Z")] },
			null,
			2,
		);
		await pushFromPeerDevice(
			world.bareRepoPath,
			{ [aggregatePath]: `${peerManifest}\n` },
			"[peer] add manifest with B",
		);

		// Our FolderStorage has the same path with entry A.
		await mkdir(join(world.folderRoot, ".jolli"), { recursive: true });
		const ourManifest = JSON.stringify(
			{ version: 1, files: [entry("A", "2026-05-01T00:00:00Z")] },
			null,
			2,
		);
		await writeFile(join(world.folderRoot, ".jolli", "manifest.json"), `${ourManifest}\n`);

		// Wire a strict UI/AI: any call would fail the test.
		const aiMerge = vi.fn();
		const ui: ConflictUi = {
			promptBinaryPick: vi.fn(async () => {
				throw new Error("Tier 3 should not run for aggregate file");
			}),
		};

		const engine = buildEngineForWorld(world, {
			ai: async () => ({ merge: aiMerge }),
			ui,
		});

		const result = await engine.runRound(defaultRoundOptions(world));
		expect(result.newState).toBe("synced");
		expect(aiMerge).not.toHaveBeenCalled();
		expect(ui.promptBinaryPick).not.toHaveBeenCalled();

		// Merged manifest at origin/main contains BOTH entries.
		const merged = readBlobAtMain(world.bareRepoPath, aggregatePath);
		const parsed = JSON.parse(merged);
		const ids = parsed.files.map((f: { fileId: string }) => f.fileId).sort();
		expect(ids).toEqual(["A", "B"]);
	});

	// Note: Tier 1.5 fallthrough on malformed aggregate JSON is unit-tested in
	// `ConflictResolver.test.ts` (test: "falls through to Tier 2/3 when
	// aggregate JSON fails to parse"). Reproducing it at acceptance scope
	// would require engineering a true rebase conflict where stage 2 ≠
	// stage 3 with one side malformed — fresh-clone + mirror collapses the
	// scenario into a plain overwrite. Keeping the assertion at the unit
	// layer is good enough; if we ever need an end-to-end repro, generate
	// two competing local commits before running `pullRebase`.
});
