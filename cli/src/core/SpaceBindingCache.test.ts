import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import {
	clearSpaceBindingCache,
	loadSpaceBindingCache,
	SPACE_BINDING_CACHE_FILE,
	SPACE_BINDING_TTL_MS,
	type SpaceBindingCacheEntry,
	saveSpaceBindingCache,
	tenantOriginForKey,
} from "./SpaceBindingCache.js";

let cwd: string;

beforeEach(async () => {
	cwd = join(tmpdir(), `space-binding-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function filePath(): string {
	return join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR, SPACE_BINDING_CACHE_FILE);
}

const REPO_URL = "https://github.com/acme/widgets";
const ORIGIN = "https://acme.jolli.ai";
const KEY = { repoUrl: REPO_URL, origin: ORIGIN } as const;

function validEntry(overrides: Partial<SpaceBindingCacheEntry> = {}): SpaceBindingCacheEntry {
	const now = new Date().toISOString();
	return {
		version: 1,
		repoUrl: REPO_URL,
		origin: ORIGIN,
		jmSpaceId: 7,
		spaceName: "Acme Core",
		canPush: true,
		boundAt: now,
		checkedAt: now,
		...overrides,
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function fileExists(): Promise<boolean> {
	return pathExists(filePath());
}

describe("loadSpaceBindingCache", () => {
	it("returns null when the file is missing", async () => {
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
	});

	it("returns a fresh matching entry", async () => {
		await writeFile(filePath(), JSON.stringify(validEntry()), "utf8");
		const entry = await loadSpaceBindingCache(cwd, KEY);
		expect(entry).not.toBeNull();
		expect(entry?.spaceName).toBe("Acme Core");
		expect(entry?.jmSpaceId).toBe(7);
	});

	it("accepts a null jmSpaceId and a null canPush (older-server shapes)", async () => {
		await writeFile(filePath(), JSON.stringify(validEntry({ jmSpaceId: null, canPush: null })), "utf8");
		const entry = await loadSpaceBindingCache(cwd, KEY);
		expect(entry?.jmSpaceId).toBeNull();
		expect(entry?.canPush).toBeNull();
	});

	it("returns null and deletes the file on corrupt JSON", async () => {
		await writeFile(filePath(), "not json {", "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
		expect(await fileExists()).toBe(false);
	});

	it("returns null and deletes the file on shape drift (wrong version)", async () => {
		await writeFile(filePath(), JSON.stringify({ ...validEntry(), version: 2 }), "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
		expect(await fileExists()).toBe(false);
	});

	it("rejects a cached canPush=false entry (degraded states are never served)", async () => {
		await writeFile(filePath(), JSON.stringify({ ...validEntry(), canPush: false }), "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
	});

	it("rejects an empty spaceName", async () => {
		await writeFile(filePath(), JSON.stringify({ ...validEntry(), spaceName: "" }), "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
	});

	it("misses (but keeps the file) when the repoUrl differs", async () => {
		await writeFile(filePath(), JSON.stringify(validEntry()), "utf8");
		expect(await loadSpaceBindingCache(cwd, { ...KEY, repoUrl: "https://github.com/acme/other" })).toBeNull();
		expect(await fileExists()).toBe(true);
	});

	it("misses when the tenant origin differs", async () => {
		await writeFile(filePath(), JSON.stringify(validEntry()), "utf8");
		expect(await loadSpaceBindingCache(cwd, { ...KEY, origin: "https://other.jolli.ai" })).toBeNull();
	});

	it("misses when checkedAt is older than the TTL", async () => {
		const stale = new Date(Date.now() - SPACE_BINDING_TTL_MS - 1000).toISOString();
		await writeFile(filePath(), JSON.stringify(validEntry({ checkedAt: stale })), "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
	});

	it("misses when checkedAt is in the future or unparseable (clock skew safety)", async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		await writeFile(filePath(), JSON.stringify(validEntry({ checkedAt: future })), "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();

		await writeFile(filePath(), JSON.stringify(validEntry({ checkedAt: "not-a-date" })), "utf8");
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
	});

	it("returns null (without throwing) on a non-ENOENT read failure", async () => {
		// A directory at the cache path makes readFile fail with EISDIR.
		await mkdir(filePath());
		expect(await loadSpaceBindingCache(cwd, KEY)).toBeNull();
	});
});

describe("saveSpaceBindingCache", () => {
	const saveArgs = {
		repoUrl: REPO_URL,
		origin: ORIGIN,
		jmSpaceId: 7,
		spaceName: "Acme Core",
		canPush: true,
	} as const;

	it("creates the file with boundAt = checkedAt on a first save", async () => {
		await saveSpaceBindingCache(cwd, saveArgs);
		const written = JSON.parse(await readFile(filePath(), "utf8")) as SpaceBindingCacheEntry;
		expect(written.version).toBe(1);
		expect(written.spaceName).toBe("Acme Core");
		expect(written.boundAt).toBe(written.checkedAt);
		expect(await loadSpaceBindingCache(cwd, KEY)).not.toBeNull();
	});

	it("creates the directory when missing (fresh repo)", async () => {
		await rm(join(cwd, JOLLI_DIR), { recursive: true, force: true });
		await saveSpaceBindingCache(cwd, saveArgs);
		expect(await fileExists()).toBe(true);
	});

	it("preserves boundAt on a re-confirmation of the same Space", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		await writeFile(filePath(), JSON.stringify(validEntry({ boundAt: past, checkedAt: past })), "utf8");
		await saveSpaceBindingCache(cwd, saveArgs);
		const written = JSON.parse(await readFile(filePath(), "utf8")) as SpaceBindingCacheEntry;
		expect(written.boundAt).toBe(past);
		expect(written.checkedAt).not.toBe(past);
	});

	it("resets boundAt when the Space changes (a rebind is a new binding)", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		await writeFile(filePath(), JSON.stringify(validEntry({ boundAt: past, checkedAt: past })), "utf8");
		await saveSpaceBindingCache(cwd, { ...saveArgs, jmSpaceId: 9, spaceName: "Other" });
		const written = JSON.parse(await readFile(filePath(), "utf8")) as SpaceBindingCacheEntry;
		expect(written.boundAt).not.toBe(past);
		expect(written.spaceName).toBe("Other");
	});

	it("overwrites a corrupt file (boundAt falls back to now)", async () => {
		await writeFile(filePath(), "not json {", "utf8");
		await saveSpaceBindingCache(cwd, saveArgs);
		const written = JSON.parse(await readFile(filePath(), "utf8")) as SpaceBindingCacheEntry;
		expect(written.boundAt).toBe(written.checkedAt);
	});

	it("swallows a write failure — the cache is an optimization, never a gate", async () => {
		// A directory at the cache path makes the atomic rename fail.
		await mkdir(filePath());
		await expect(saveSpaceBindingCache(cwd, saveArgs)).resolves.toBeUndefined();
	});
});

describe("clearSpaceBindingCache failure tolerance", () => {
	it("swallows a non-ENOENT removal failure", async () => {
		// A non-empty directory at the cache path makes a plain (non-recursive)
		// rm fail with EISDIR/ENOTEMPTY-class errors.
		await mkdir(filePath());
		await writeFile(join(filePath(), "inner.txt"), "x", "utf8");
		await expect(clearSpaceBindingCache(cwd)).resolves.toBeUndefined();
	});
});

describe("clearSpaceBindingCache", () => {
	it("removes the file", async () => {
		await writeFile(filePath(), JSON.stringify(validEntry()), "utf8");
		await clearSpaceBindingCache(cwd);
		expect(await fileExists()).toBe(false);
	});

	it("is a no-op when the file is already gone", async () => {
		await expect(clearSpaceBindingCache(cwd)).resolves.toBeUndefined();
		await expect(clearSpaceBindingCache(cwd)).resolves.toBeUndefined();
	});
});

describe("worktree anchoring", () => {
	let base: string;
	let mainRepo: string;
	let worktree: string;

	function git(dir: string, args: ReadonlyArray<string>): void {
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	}

	beforeEach(async () => {
		base = join(tmpdir(), `space-binding-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(base, { recursive: true });
		// Resolve symlinked temp roots (macOS /var → /private/var) so the paths
		// git stores for the worktree match the paths the assertions build.
		base = await realpath(base);
		mainRepo = join(base, "main");
		worktree = join(base, "wt");
		await mkdir(mainRepo, { recursive: true });
		git(mainRepo, ["init", "-q"]);
		// A linked worktree needs at least one commit to branch from.
		await writeFile(join(mainRepo, "README.md"), "x", "utf8");
		git(mainRepo, ["add", "."]);
		git(mainRepo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
		git(mainRepo, ["worktree", "add", "-q", "-b", "feature", worktree]);
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	const saveArgs = {
		repoUrl: REPO_URL,
		origin: ORIGIN,
		jmSpaceId: 7,
		spaceName: "Acme Core",
		canPush: true,
	} as const;

	function mainFilePath(): string {
		return join(mainRepo, JOLLI_DIR, JOLLIMEMORY_DIR, SPACE_BINDING_CACHE_FILE);
	}

	it("a save from a worktree lands at the main root — one shared file, visible to every checkout", async () => {
		await saveSpaceBindingCache(worktree, saveArgs);
		expect(await pathExists(mainFilePath())).toBe(true);
		expect(await pathExists(join(worktree, JOLLI_DIR, JOLLIMEMORY_DIR, SPACE_BINDING_CACHE_FILE))).toBe(false);
		expect((await loadSpaceBindingCache(mainRepo, KEY))?.spaceName).toBe("Acme Core");
		expect((await loadSpaceBindingCache(worktree, KEY))?.spaceName).toBe("Acme Core");
	});

	it("a clear from a worktree removes the shared file for every checkout", async () => {
		await saveSpaceBindingCache(mainRepo, saveArgs);
		await clearSpaceBindingCache(worktree);
		expect(await pathExists(mainFilePath())).toBe(false);
		expect(await loadSpaceBindingCache(mainRepo, KEY)).toBeNull();
	});

	it("resolves from a deep subdirectory of a worktree", async () => {
		const deep = join(worktree, "src", "nested", "deeper");
		await mkdir(deep, { recursive: true });
		await saveSpaceBindingCache(deep, saveArgs);
		expect(await pathExists(mainFilePath())).toBe(true);
		expect((await loadSpaceBindingCache(deep, KEY))?.spaceName).toBe("Acme Core");
	});

	it("preserves boundAt when a different worktree re-confirms the same Space", async () => {
		await saveSpaceBindingCache(mainRepo, saveArgs);
		const first = JSON.parse(await readFile(mainFilePath(), "utf8")) as SpaceBindingCacheEntry;
		await saveSpaceBindingCache(worktree, saveArgs);
		const second = JSON.parse(await readFile(mainFilePath(), "utf8")) as SpaceBindingCacheEntry;
		expect(second.boundAt).toBe(first.boundAt);
	});
});

describe("tenantOriginForKey", () => {
	function keyFor(u: string): string {
		return `sk-jol-${Buffer.from(JSON.stringify({ t: "tenant", u })).toString("base64url")}.secret`;
	}

	it("returns the origin encoded in the key", async () => {
		expect(tenantOriginForKey(keyFor("https://acme.jolli.ai"))).toBe("https://acme.jolli.ai");
	});

	it("strips a tenant path down to the origin", async () => {
		expect(tenantOriginForKey(keyFor("https://jolli.ai/acme"))).toBe("https://jolli.ai");
	});

	it("returns null for a key with no embedded meta", async () => {
		expect(tenantOriginForKey("sk-jol-abcdef1234567890abcdef1234567890")).toBeNull();
	});

	it("returns null when the embedded URL is unparseable", async () => {
		expect(tenantOriginForKey(keyFor("not a url"))).toBeNull();
	});
});
