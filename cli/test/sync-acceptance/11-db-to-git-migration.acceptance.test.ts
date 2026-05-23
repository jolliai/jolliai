/**
 * Acceptance §8 scenario 11 — db → git first-sync migration end-to-end.
 *
 * Backend mint reports `alreadyVaultBound: false`, so the engine must:
 *
 *   1. Clone the empty vault (already covered by scenario 1).
 *   2. GET /legacy-content → receive non-empty `docs[]`.
 *   3. `LegacyMigration.apply` writes each doc to its backend-provided
 *      `<memoryBankRoot>/<doc.path>` (the personal space's source layout —
 *      filename + extension already included in `doc.path`).
 *   4. Stage + commit `[jolli-mb] migrate: N items from legacy space`.
 *   5. Push.
 *   6. POST /complete-migration (idempotent flip).
 *   7. Then run the regular steady-state round and end `synced`.
 *
 * After this round the bare repo should contain:
 *   - The bootstrap README/.gitignore at vault root.
 *   - The migrated docs at their original source paths.
 *   - A migrate-prefixed commit followed by an `add`-prefixed commit (the
 *     normal mirror commit; harmless when there is nothing else to mirror).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
	type AcceptanceWorld,
	buildEngineForWorld,
	defaultRoundOptions,
	listFilesAtMain,
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

describe("acceptance §11 — db→git first-bind migration", () => {
	it("imports legacy docs, commits a migrate-prefixed message, pushes, and flips the backing", async () => {
		// Tell backend mint to report db-backed.
		world.backend.mintResponse = {
			...world.backend.mintResponse,
			alreadyVaultBound: false,
			lockOwnerToken: "test-lock-owner-token",
			githubRepoCreated: true,
		};
		// Backend provides two legacy docs.
		world.backend.legacyResponse = {
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: false,
			docs: [
				{
					id: 1,
					jrn: "doc:hello",
					slug: "hello",
					path: "notes/hello.md",
					docType: "document",
					parentId: null,
					content: "# Hello from DB\n",
					contentType: "text/markdown",
					sortOrder: 0,
					createdAt: "2026-05-01T00:00:00Z",
					updatedAt: "2026-05-01T00:00:00Z",
				},
				{
					id: 2,
					jrn: "doc:cfg",
					slug: "cfg",
					path: "cfg.json",
					docType: "document",
					parentId: null,
					content: '{"keep":true}',
					contentType: "application/json",
					sortOrder: 1,
					createdAt: "2026-05-01T00:00:00Z",
					updatedAt: "2026-05-01T00:00:00Z",
				},
			],
		};

		const engine = buildEngineForWorld(world);
		const result = await engine.runRound(defaultRoundOptions(world));

		expect(result.newState).toBe("synced");

		// Legacy content must have been fetched + the flip requested.
		expect(world.backend.legacyContentCalls).toBe(1);
		expect(world.backend.completeMigrationCalls).toBe(1);

		// Bare repo received the migrated files at the original personal-space paths.
		const files = listFilesAtMain(world.bareRepoPath);
		expect(files).toContain("notes/hello.md");
		expect(files).toContain("cfg.json");
		expect(readBlobAtMain(world.bareRepoPath, "notes/hello.md")).toBe("# Hello from DB\n");

		// Commit history must include a `migrate:` commit referencing 2 items.
		const log = execFileSync("git", ["log", "--pretty=%s", "main"], {
			cwd: world.bareRepoPath,
			encoding: "utf-8",
		});
		expect(log).toMatch(/\[jolli-mb\] migrate: 2 items from legacy space/);
	});

	it("treats `alreadyMigrated: true` race correctly — no import, but still calls complete-migration", async () => {
		// Mint says db, but legacy-content responds with the already-migrated flag
		// (another device finished the flip between our mint and getLegacyContent).
		world.backend.mintResponse = {
			...world.backend.mintResponse,
			alreadyVaultBound: false,
			lockOwnerToken: "test-lock-owner-token",
		};
		world.backend.legacyResponse = {
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: true,
			docs: [],
		};

		const engine = buildEngineForWorld(world);
		const result = await engine.runRound(defaultRoundOptions(world));

		expect(result.newState).toBe("synced");
		expect(world.backend.legacyContentCalls).toBe(1);
		// We still call complete-migration to confirm the flip — backend is idempotent.
		expect(world.backend.completeMigrationCalls).toBe(1);

		// No migrated docs should exist (legacy-content was empty / already-migrated).
		const files = listFilesAtMain(world.bareRepoPath);
		expect(files).not.toContain("notes/hello.md");
		expect(files).not.toContain("cfg.json");

		// The fresh-clone mirror commit (from runRound's `isFirstBind` branch)
		// uses `migrate: … from <localFolder>/<repoName>` wording. The legacy-
		// content migrate commit uses `… from legacy space` — and that one
		// MUST NOT appear because the docs[] was empty.
		const log = execFileSync("git", ["log", "--pretty=%s", "main"], {
			cwd: world.bareRepoPath,
			encoding: "utf-8",
		});
		expect(log).not.toMatch(/from legacy space/);
	});

	it("completeMigration failure flips the round to offline with migration_failed — retried next round", async () => {
		// I10 contract: a thrown completeMigration is terminal for this
		// round (`offline` + `migration_failed`), not silently swallowed.
		// The earlier "still synced" behavior left the user staring at a
		// green check while the backend `backing=db` flag never flipped;
		// `complete-migration` is idempotent on the backend so the next
		// round retries cleanly. See `SyncEngine.tryCompleteMigration`.
		world.backend.mintResponse = {
			...world.backend.mintResponse,
			alreadyVaultBound: false,
			lockOwnerToken: "test-lock-owner-token",
		};
		world.backend.legacyResponse = {
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: false,
			docs: [],
		};
		world.backend.completeMigrationError = new Error("503 flip_failed");

		const engine = buildEngineForWorld(world);
		const result = await engine.runRound(defaultRoundOptions(world));

		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("migration_failed");
		expect(world.backend.completeMigrationCalls).toBe(1);
	});
});
