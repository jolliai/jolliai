import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGit } from "../GitOps.js";
import { isReachableFromAnyRef, listReachableCommits } from "./GitReachability.js";

async function commit(dir: string, message: string): Promise<string> {
	await execGit(["commit", "--allow-empty", "-m", message], dir);
	const res = await execGit(["rev-parse", "HEAD"], dir);
	return res.stdout.trim();
}

describe("isReachableFromAnyRef", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "jolli-reach-"));
		await execGit(["init", "-b", "main"], dir);
		await execGit(["config", "user.email", "t@example.com"], dir);
		await execGit(["config", "user.name", "T"], dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reports a commit on the current branch as reachable", async () => {
		const hash = await commit(dir, "one");
		expect(await isReachableFromAnyRef(hash, dir)).toBe(true);
	});

	it("reports an amended-away commit as unreachable", async () => {
		const old = await commit(dir, "one");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "one amended"], dir);
		expect(await isReachableFromAnyRef(old, dir)).toBe(false);
	});

	it("reports a commit on ANOTHER branch as reachable", async () => {
		await commit(dir, "base");
		await execGit(["checkout", "-b", "side"], dir);
		const sideHash = await commit(dir, "side work");
		await execGit(["checkout", "main"], dir);
		expect(await isReachableFromAnyRef(sideHash, dir)).toBe(true);
	});

	it("reports an unknown hash as unreachable instead of throwing", async () => {
		await commit(dir, "one");
		expect(await isReachableFromAnyRef("0".repeat(40), dir)).toBe(false);
	});

	it("reports a commit reachable only through a tag as reachable", async () => {
		await commit(dir, "base");
		const tagged = await commit(dir, "tagged");
		await execGit(["tag", "v1.0"], dir);
		await execGit(["reset", "--hard", "HEAD~1"], dir);
		expect(await isReachableFromAnyRef(tagged, dir)).toBe(true);
	});
});

describe("listReachableCommits", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "jolli-reachset-"));
		await execGit(["init", "-b", "main"], dir);
		await execGit(["config", "user.email", "t@example.com"], dir);
		await execGit(["config", "user.name", "T"], dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("includes commits reachable from any branch or tag, excluding amended-away ones", async () => {
		const base = await commit(dir, "base");
		const onMain = await commit(dir, "on main");
		// Another branch's commit.
		await execGit(["checkout", "-b", "feature"], dir);
		const onFeature = await commit(dir, "on feature");
		// A tag-only commit, then reset the branch away from it.
		const tagged = await commit(dir, "tagged");
		await execGit(["tag", "v1"], dir);
		await execGit(["reset", "--hard", "HEAD~1"], dir);
		// An amended-away commit reachable from no ref.
		await execGit(["checkout", "main"], dir);
		const doomed = await commit(dir, "doomed");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "doomed amended"], dir);

		const reachable = await listReachableCommits(dir);

		expect(reachable.has(base)).toBe(true);
		expect(reachable.has(onMain)).toBe(true);
		expect(reachable.has(onFeature)).toBe(true);
		expect(reachable.has(tagged)).toBe(true);
		expect(reachable.has(doomed)).toBe(false);
	});
});
