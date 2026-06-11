/**
 * Tests for RepoMapping — load/save + collision-aware allocation + merge.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalizeRepoMapping,
	emptyMapping,
	findRepoMappingConflicts,
	loadRepoMapping,
	mergeRepoMapping,
	parseRepoMapping,
	REPO_MAPPING_PATH,
	type RepoMappingFile,
	reconcileMappingAdditive,
	resolveOrAssignFolder,
	saveRepoMapping,
	scanFolderIdentities,
	serializeRepoMapping,
} from "./RepoMapping.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "repo-mapping-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("parseRepoMapping", () => {
	it("accepts a well-formed envelope", () => {
		const raw = '{"version":1,"mappings":[{"repoIdentity":"x","folder":"jolliai"}]}';
		const parsed = parseRepoMapping(raw);
		expect(parsed?.mappings).toHaveLength(1);
		expect(parsed?.mappings[0]?.folder).toBe("jolliai");
	});

	it("returns null for wrong version", () => {
		expect(parseRepoMapping('{"version":2,"mappings":[]}')).toBeNull();
	});

	it("returns null when mappings is missing or not an array", () => {
		expect(parseRepoMapping('{"version":1}')).toBeNull();
		expect(parseRepoMapping('{"version":1,"mappings":"oops"}')).toBeNull();
	});

	it("returns null when an entry has the wrong shape", () => {
		expect(parseRepoMapping('{"version":1,"mappings":[{"folder":"x"}]}')).toBeNull();
		expect(parseRepoMapping('{"version":1,"mappings":[{"repoIdentity":42,"folder":"x"}]}')).toBeNull();
		// `folder` must be a string — exercise the explicit type check at line 80.
		expect(parseRepoMapping('{"version":1,"mappings":[{"repoIdentity":"x","folder":42}]}')).toBeNull();
		// `folder` missing entirely.
		expect(parseRepoMapping('{"version":1,"mappings":[{"repoIdentity":"x"}]}')).toBeNull();
	});

	it("returns null on garbage JSON", () => {
		expect(parseRepoMapping("nope")).toBeNull();
	});
});

describe("loadRepoMapping", () => {
	it("returns empty when the file doesn't exist", async () => {
		const m = await loadRepoMapping(tempDir);
		expect(m).toEqual(emptyMapping());
	});

	it("reads and parses a stored file", async () => {
		await mkdir(join(tempDir, ".jolli"), { recursive: true });
		await writeFile(
			join(tempDir, REPO_MAPPING_PATH),
			serializeRepoMapping({
				version: 1,
				mappings: [{ repoIdentity: "https://github.com/a/b", folder: "b" }],
			}),
		);
		const m = await loadRepoMapping(tempDir);
		expect(m.mappings[0]?.folder).toBe("b");
	});

	it("falls back to empty for corrupted JSON", async () => {
		await mkdir(join(tempDir, ".jolli"), { recursive: true });
		await writeFile(join(tempDir, REPO_MAPPING_PATH), "{not json");
		const m = await loadRepoMapping(tempDir);
		expect(m).toEqual(emptyMapping());
	});
});

describe("saveRepoMapping", () => {
	it("creates the parent .jolli/ dir + writes canonical JSON", async () => {
		await saveRepoMapping(tempDir, {
			version: 1,
			mappings: [{ repoIdentity: "id", folder: "f" }],
		});
		const raw = await readFile(join(tempDir, REPO_MAPPING_PATH), "utf-8");
		expect(raw).toBe(
			'{\n  "version": 1,\n  "mappings": [\n    {\n      "repoIdentity": "id",\n      "folder": "f"\n    }\n  ]\n}\n',
		);
	});
});

describe("resolveOrAssignFolder", () => {
	it("returns the stored folder + null update when repoIdentity is already mapped", () => {
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/a/jolliai", folder: "jolliai" }],
		};
		const { folder, updatedMapping } = resolveOrAssignFolder(mapping, {
			repoIdentity: "https://github.com/a/jolliai",
			authoritativeFolder: "jolliai",
		});
		expect(folder).toBe("jolliai");
		expect(updatedMapping).toBeNull();
	});

	it("assigns the bare slug + returns updated mapping when slug is free", () => {
		const { folder, updatedMapping } = resolveOrAssignFolder(emptyMapping(), {
			repoIdentity: "https://github.com/a/jolliai",
			authoritativeFolder: "jolliai",
		});
		expect(folder).toBe("jolliai");
		expect(updatedMapping?.mappings).toHaveLength(1);
		expect(updatedMapping?.mappings[0]?.folder).toBe("jolliai");
	});

	it("honors caller's authoritativeFolder even when that name is already taken by a different repoIdentity (collisions handled at merge time)", () => {
		// `desiredFolder` reflects what `KBPathResolver.resolveKBPath()`
		// picked locally — KBPathResolver disambiguates via `-N` suffix
		// using local disk state, so the caller never asks us to claim a
		// folder another identity owns LOCALLY. If `repos.json` says
		// another device's identity claims the same folder, that's a
		// cross-device collision and `mergeRepoMapping` resolves it
		// lexicographically on the next pull. Allocation here is just
		// "record what the caller decided" — see the new module doc.
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/a/jolliai", folder: "jolliai" }],
		};
		const { folder, updatedMapping } = resolveOrAssignFolder(mapping, {
			repoIdentity: "https://gitlab.com/a/jolliai",
			authoritativeFolder: "jolliai",
		});
		expect(folder).toBe("jolliai");
		expect(updatedMapping?.mappings).toHaveLength(2);
		expect(updatedMapping?.mappings[1]?.folder).toBe("jolliai");
	});

	it("rewrites the mapping in place when authoritativeFolder diverges from the stored folder", () => {
		// Cross-device divergence scenario: another device's `repos.json`
		// claimed `jolliai` for this identity, but THIS device's
		// `KBPathResolver` picked `jolliai-2` (because `jolliai` is already
		// claimed locally by a different repo). Returning the stored
		// `jolliai` would leave `repos.json` and disk layout split. The
		// function must rewrite the mapping so the next push carries the
		// truthful local folder; `findRepoMappingConflicts` will then
		// surface the same-folder/different-identity collision after both
		// sides have pushed.
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "https://github.com/a/other", folder: "unrelated" },
				{ repoIdentity: "https://github.com/a/jolliai", folder: "jolliai" },
			],
		};
		const { folder, updatedMapping } = resolveOrAssignFolder(mapping, {
			repoIdentity: "https://github.com/a/jolliai",
			authoritativeFolder: "jolliai-2",
		});
		expect(folder).toBe("jolliai-2");
		expect(updatedMapping?.mappings).toHaveLength(2);
		const rewritten = updatedMapping?.mappings.find((m) => m.repoIdentity === "https://github.com/a/jolliai");
		expect(rewritten?.folder).toBe("jolliai-2");
		// Other identities are left untouched.
		const untouched = updatedMapping?.mappings.find((m) => m.repoIdentity === "https://github.com/a/other");
		expect(untouched?.folder).toBe("unrelated");
	});
});

describe("canonicalizeRepoMapping", () => {
	it("returns the same object with changed=false when every row is already canonical", () => {
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "https://github.com/jolliai/jolli", folder: "jolli" },
				{ repoIdentity: "my-notes", folder: "my-notes" },
				// Bare fallback identity ending in `.git` — must NOT be
				// rewritten to `foo` (it never went through the URL
				// normalizer at compute time).
				{ repoIdentity: "foo.git", folder: "foo.git" },
			],
		};
		const result = canonicalizeRepoMapping(mapping);
		expect(result.changed).toBe(false);
		expect(result.merged).toBe(mapping);
	});

	it("collapses SSH- and https-style rows of the same repo into one canonical row", () => {
		// The exact duplicate observed in the field: one device's remote was
		// SSH, another's https, both rounds appended their own row for the
		// same repo + folder.
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "git@github.com:jolliai/jolli", folder: "jolli" },
				{ repoIdentity: "https://github.com/jolliai/jolli", folder: "jolli" },
			],
		};
		const result = canonicalizeRepoMapping(mapping);
		expect(result.changed).toBe(true);
		expect(result.merged.mappings).toEqual([{ repoIdentity: "https://github.com/jolliai/jolli", folder: "jolli" }]);
		// The collapse also removes the bogus folder-collision warning.
		expect(findRepoMappingConflicts(result.merged)).toHaveLength(0);
	});

	it("rewrites a lone legacy SSH row in place (changed=true)", () => {
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "git@github.com:foo/bar", folder: "bar" }],
		};
		const result = canonicalizeRepoMapping(mapping);
		expect(result.changed).toBe(true);
		expect(result.merged.mappings).toEqual([{ repoIdentity: "https://github.com/foo/bar", folder: "bar" }]);
	});

	it("lets the later row win when collapsing rows that disagree on folder", () => {
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "git@github.com:foo/bar", folder: "bar" },
				{ repoIdentity: "https://github.com/foo/bar", folder: "bar-2" },
			],
		};
		const result = canonicalizeRepoMapping(mapping);
		expect(result.merged.mappings).toEqual([{ repoIdentity: "https://github.com/foo/bar", folder: "bar-2" }]);
	});

	it("emits stable order (sorted by canonical repoIdentity)", () => {
		const mapping: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "https://github.com/z/z", folder: "z" },
				{ repoIdentity: "git@github.com:a/a", folder: "a" },
			],
		};
		const result = canonicalizeRepoMapping(mapping);
		expect(result.merged.mappings.map((m) => m.repoIdentity)).toEqual([
			"https://github.com/a/a",
			"https://github.com/z/z",
		]);
	});
});

describe("mergeRepoMapping", () => {
	it("returns the union when repoIdentities are disjoint", () => {
		const local: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "a", folder: "fa" }],
		};
		const remote: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "b", folder: "fb" }],
		};
		const { merged, conflicts } = mergeRepoMapping(local, remote);
		expect(merged.mappings.map((m) => m.repoIdentity).sort()).toEqual(["a", "b"]);
		expect(conflicts).toHaveLength(0);
	});

	it("dedupes by repoIdentity (remote overrides local)", () => {
		const local: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "a", folder: "old" }],
		};
		const remote: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "a", folder: "new" }],
		};
		expect(mergeRepoMapping(local, remote).merged.mappings[0]?.folder).toBe("new");
	});

	it("detects folder-name collisions WITHOUT renaming (P2#3) — both keep the bare name, conflict reported", () => {
		// Concurrent bootstrap: two devices both claimed `jolliai` for different repos.
		// Pre-P2#3 the loser got renamed to `<folder>-<hash6>`, but no code
		// physically moved its on-disk content, so the renamed mapping
		// pointed at an empty directory. Current behavior: keep both
		// mappings intact, surface the conflict to the caller for manual
		// disambiguation.
		const local: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/a/jolliai", folder: "jolliai" }],
		};
		const remote: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/b/jolliai", folder: "jolliai" }],
		};
		const { merged, conflicts } = mergeRepoMapping(local, remote);
		expect(merged.mappings).toHaveLength(2);
		// BOTH identities still claim `jolliai`. No silent hash-suffix.
		const a = merged.mappings.find((m) => m.repoIdentity === "https://github.com/a/jolliai");
		const b = merged.mappings.find((m) => m.repoIdentity === "https://github.com/b/jolliai");
		expect(a?.folder).toBe("jolliai");
		expect(b?.folder).toBe("jolliai");
		// Conflict reported so the engine can notify the user.
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]?.folder).toBe("jolliai");
		expect(conflicts[0]?.identities).toEqual(["https://github.com/a/jolliai", "https://github.com/b/jolliai"]);
	});

	it("emits stable order (sorted by repoIdentity)", () => {
		const local: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "c", folder: "fc" },
				{ repoIdentity: "a", folder: "fa" },
			],
		};
		const remote: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "b", folder: "fb" }],
		};
		const { merged } = mergeRepoMapping(local, remote);
		expect(merged.mappings.map((m) => m.repoIdentity)).toEqual(["a", "b", "c"]);
	});

	it("folds an SSH-style row from an older client into this client's https row for the same repo", () => {
		const local: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/jolliai/jolli", folder: "jolli" }],
		};
		const remote: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "git@github.com:jolliai/jolli", folder: "jolli" }],
		};
		const { merged, conflicts } = mergeRepoMapping(local, remote);
		expect(merged.mappings).toEqual([{ repoIdentity: "https://github.com/jolliai/jolli", folder: "jolli" }]);
		expect(conflicts).toHaveLength(0);
	});

	it("is idempotent — merging identical inputs returns the same shape and no conflicts", () => {
		const m: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "a", folder: "fa" },
				{ repoIdentity: "b", folder: "fb" },
			],
		};
		const { merged, conflicts } = mergeRepoMapping(m, m);
		expect(merged.mappings.map((m) => m.repoIdentity).sort()).toEqual(["a", "b"]);
		expect(conflicts).toHaveLength(0);
	});
});

describe("findRepoMappingConflicts", () => {
	it("returns [] when every identity claims a distinct folder", () => {
		const conflicts = findRepoMappingConflicts({
			version: 1,
			mappings: [
				{ repoIdentity: "a", folder: "fa" },
				{ repoIdentity: "b", folder: "fb" },
			],
		});
		expect(conflicts).toEqual([]);
	});

	it("returns one entry per colliding folder with sorted identities", () => {
		const conflicts = findRepoMappingConflicts({
			version: 1,
			mappings: [
				{ repoIdentity: "alpha", folder: "shared" },
				{ repoIdentity: "beta", folder: "shared" },
				{ repoIdentity: "gamma", folder: "lonely" },
			],
		});
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toEqual({
			folder: "shared",
			identities: ["alpha", "beta"],
		});
	});
});

describe("scanFolderIdentities", () => {
	async function writeFolder(name: string, config: Record<string, unknown> | null): Promise<void> {
		const dir = join(tempDir, name, ".jolli");
		await mkdir(dir, { recursive: true });
		if (config !== null) {
			await writeFile(join(dir, "config.json"), JSON.stringify(config));
		}
	}

	it("derives identity per folder from its config, skipping dot dirs and config-less folders", async () => {
		await writeFolder("jolliai", { remoteUrl: "https://github.com/jolliai/jolliai.git", repoName: "jolliai" });
		await writeFolder("jolli", { remoteUrl: "git@github.com:jolliai/jolli.git", repoName: "jolli" });
		// `.jolli` (vault metadata) and a bootstrap stash must be ignored.
		await mkdir(join(tempDir, ".jolli"), { recursive: true });
		await mkdir(join(tempDir, ".jolli-bootstrap-stash", ".jolli"), { recursive: true });
		// A folder with no config.json is not a managed repo folder.
		await mkdir(join(tempDir, "loose", ".jolli"), { recursive: true });
		// A plain file at the root must be ignored (not a directory).
		await writeFile(join(tempDir, "README.md"), "# vault");

		const scanned = await scanFolderIdentities(tempDir);
		expect(scanned.sort((a, b) => a.folder.localeCompare(b.folder))).toEqual([
			// SCP-style config remoteUrl folds to the same https identity the
			// live round computes, so the reconcile can't re-add style duplicates.
			{ identity: "https://github.com/jolliai/jolli", folder: "jolli" },
			{ identity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
		]);
	});

	it("falls back to repoName, and skips identity-less / unparseable configs", async () => {
		await writeFolder("local-only", { repoName: "local-only" });
		await writeFolder("stripped", { version: 1, sortOrder: "date" });
		await writeFolder("broken", null);
		await mkdir(join(tempDir, "broken", ".jolli"), { recursive: true });
		await writeFile(join(tempDir, "broken", ".jolli", "config.json"), "{ not json");

		const scanned = await scanFolderIdentities(tempDir);
		expect(scanned).toEqual([{ identity: "local-only", folder: "local-only" }]);
	});

	it("returns [] when the root cannot be read", async () => {
		expect(await scanFolderIdentities(join(tempDir, "does-not-exist"))).toEqual([]);
	});
});

describe("reconcileMappingAdditive", () => {
	it("adds a missing on-disk folder while preserving existing rows", () => {
		// mb_test shape: repos.json has only jolliai, but jolli exists on disk.
		const loaded: RepoMappingFile = {
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/jolliai/jolliai", folder: "jolliai" }],
		};
		const { merged, changed } = reconcileMappingAdditive(loaded, [
			{ identity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
			{ identity: "git@github.com:jolliai/jolli", folder: "jolli" },
		]);
		expect(changed).toBe(true);
		expect(merged.mappings).toEqual([
			{ repoIdentity: "git@github.com:jolliai/jolli", folder: "jolli" },
			{ repoIdentity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
		]);
	});

	it("is idempotent — a second pass over the same disk is a no-op", () => {
		const loaded: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "git@github.com:jolliai/jolli", folder: "jolli" },
				{ repoIdentity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
			],
		};
		const result = reconcileMappingAdditive(loaded, [
			{ identity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
			{ identity: "git@github.com:jolliai/jolli", folder: "jolli" },
		]);
		expect(result.changed).toBe(false);
		expect(result.merged).toBe(loaded);
	});

	it("never deletes a row whose folder is absent on this device", () => {
		// repos.json carries a peer's repo; this device has only jolliai locally.
		const loaded: RepoMappingFile = {
			version: 1,
			mappings: [
				{ repoIdentity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
				{ repoIdentity: "https://github.com/peer/only", folder: "peer-only" },
			],
		};
		const { merged, changed } = reconcileMappingAdditive(loaded, [
			{ identity: "https://github.com/jolliai/jolliai", folder: "jolliai" },
		]);
		expect(changed).toBe(false);
		expect(merged.mappings.map((m) => m.repoIdentity)).toContain("https://github.com/peer/only");
	});

	it("skips an identity backed by more than one local folder (migrate-to-fresh case)", () => {
		// Old + new folders share one remoteUrl → one identity. Guessing a row
		// could point repos.json at the stale folder; defer to the per-repo path.
		const { merged, changed } = reconcileMappingAdditive(emptyMapping(), [
			{ identity: "https://github.com/jolliai/jolli", folder: "jolli" },
			{ identity: "https://github.com/jolliai/jolli", folder: "jolli-2" },
		]);
		expect(changed).toBe(false);
		expect(merged.mappings).toEqual([]);
	});

	it("adds a single-folder identity even when another identity is ambiguous", () => {
		const { merged, changed } = reconcileMappingAdditive(emptyMapping(), [
			{ identity: "dup", folder: "a" },
			{ identity: "dup", folder: "a-2" },
			{ identity: "unique", folder: "u" },
		]);
		expect(changed).toBe(true);
		expect(merged.mappings).toEqual([{ repoIdentity: "unique", folder: "u" }]);
	});
});
