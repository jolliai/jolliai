import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";

function makeLocalFolder(): string {
	const root = join(tmpdir(), `mbrd-${Math.random().toString(36).slice(2)}`);
	for (const repo of ["jolli", "jolliai", "temp", "test2"]) {
		mkdirSync(join(root, repo, ".jolli"), { recursive: true });
		writeFileSync(join(root, repo, ".jolli", "index.json"), JSON.stringify({ schemaVersion: 5, entries: [] }));
	}
	mkdirSync(join(root, "not-a-repo"), { recursive: true }); // no .jolli/index.json
	mkdirSync(join(root, ".jolli"), { recursive: true });
	writeFileSync(
		join(root, ".jolli", "repos.json"),
		JSON.stringify({
			version: 1,
			mappings: [{ repoIdentity: "https://github.com/jolliai/jolliai", folder: "jolliai" }],
		}),
	);
	return root;
}

let roots: string[] = [];
afterEach(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
	roots = [];
});

describe("discoverRepos", () => {
	it("finds dirs with .jolli/index.json, excludes by name + glob, labels via repos.json, sorted", async () => {
		const root = makeLocalFolder();
		roots.push(root);
		const repos = await discoverRepos(root, ["temp", "test*"]);
		expect(repos.map((r) => r.folder)).toEqual(["jolli", "jolliai"]);
		expect(repos.find((r) => r.folder === "jolliai")?.repoIdentity).toBe("https://github.com/jolliai/jolliai");
		expect(repos.find((r) => r.folder === "jolli")?.repoIdentity).toBeUndefined();
		expect(repos[0].kbRoot).toBe(join(root, "jolli"));
	});

	it("no excludes -> every repo dir, repos.json absent -> no labels", async () => {
		const root = join(tmpdir(), `mbrd2-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "alpha", ".jolli"), { recursive: true });
		writeFileSync(join(root, "alpha", ".jolli", "index.json"), "{}");
		roots.push(root);
		const repos = await discoverRepos(root, []);
		expect(repos.map((r) => r.folder)).toEqual(["alpha"]);
		expect(repos[0].repoIdentity).toBeUndefined();
	});

	it("missing localFolder -> []", async () => {
		expect(await discoverRepos(join(tmpdir(), `nope-${Math.random().toString(36).slice(2)}`), [])).toEqual([]);
	});

	it("repos.json present but without a mappings key -> labels stay undefined", async () => {
		const root = join(tmpdir(), `mbrd3-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "alpha", ".jolli"), { recursive: true });
		writeFileSync(join(root, "alpha", ".jolli", "index.json"), "{}");
		mkdirSync(join(root, ".jolli"), { recursive: true });
		writeFileSync(join(root, ".jolli", "repos.json"), JSON.stringify({ version: 1 })); // no `mappings`
		roots.push(root);
		const repos = await discoverRepos(root, []);
		expect(repos.map((r) => r.folder)).toEqual(["alpha"]);
		expect(repos[0].repoIdentity).toBeUndefined();
	});

	it("returns folders in ascending name order regardless of on-disk creation order", async () => {
		const root = join(tmpdir(), `mbrd4-${Math.random().toString(36).slice(2)}`);
		// Create in reverse-sorted order so the comparator must reorder them.
		for (const repo of ["zeta", "yankee", "mike", "delta", "bravo", "alpha"]) {
			mkdirSync(join(root, repo, ".jolli"), { recursive: true });
			writeFileSync(join(root, repo, ".jolli", "index.json"), "{}");
		}
		roots.push(root);
		const repos = await discoverRepos(root, []);
		expect(repos.map((r) => r.folder)).toEqual(["alpha", "bravo", "delta", "mike", "yankee", "zeta"]);
	});
});
