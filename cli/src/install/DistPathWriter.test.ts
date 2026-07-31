import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDistPath } from "./DistPathWriter.js";

const cleanup: string[] = [];
const requiredRuntimeFiles = [
	"Cli.js",
	"StopHook.js",
	"SessionStartHook.js",
	"PostCommitHook.js",
	"PostRewriteHook.js",
	"PrepareMsgHook.js",
	"PostMergeHook.js",
	"PrePushHook.js",
	"QueueWorker.js",
	"PrePushWorker.js",
] as const;

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function completeDist(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `jolli-dist-${label}-`));
	cleanup.push(root);
	await Promise.all(requiredRuntimeFiles.map((file) => writeFile(join(root, file), "")));
	return root;
}

describe("installDistPath — source-tag write-boundary guard", () => {
	// The guard returns false BEFORE any filesystem access, so these cases never
	// touch the real ~/.jolli directory.
	it("refuses a path-traversal tag", async () => {
		expect(await installDistPath("../evil", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("a/b", "/some/dist", "1.0.0")).toBe(false);
	});

	it("refuses tags with shell metacharacters or whitespace", async () => {
		expect(await installDistPath("bad tag", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("bad;rm", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("'inject'", "/some/dist", "1.0.0")).toBe(false);
	});

	it("refuses an empty or leading-hyphen tag", async () => {
		expect(await installDistPath("", "/some/dist", "1.0.0")).toBe(false);
		expect(await installDistPath("-x", "/some/dist", "1.0.0")).toBe(false);
	});

	it("moves the entry to a different complete dist at the same version", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const first = await completeDist("first");
		const second = await completeDist("second");

		expect(await installDistPath("claude-plugin", first, "2.0.0", globalDir)).toBe(true);
		// The registry is keyed by source tag ALONE, so two builds of one version share a
		// single slot. Re-registering is an explicit claim on it and the entry must move;
		// keeping the incumbent left a same-version rebuild at a new path dispatching to
		// the old dist forever.
		expect(await installDistPath("claude-plugin", second, "2.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`2.0.0\n${second}`);
	});

	it("records a downgrade between two complete dists", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const newer = await completeDist("newer");
		const older = await completeDist("older");

		expect(await installDistPath("claude-plugin", newer, "2.0.0", globalDir)).toBe(true);
		// Installing an older build is a deliberate act; the gate no longer second-guesses
		// it as long as the incoming dist is complete.
		expect(await installDistPath("claude-plugin", older, "1.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`1.0.0\n${older}`);
	});

	it("upgrades a complete entry to a complete higher version", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const older = await completeDist("older");
		const newer = await completeDist("newer");

		expect(await installDistPath("claude-plugin", older, "1.0.0", globalDir)).toBe(true);
		expect(await installDistPath("claude-plugin", newer, "2.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`2.0.0\n${newer}`);
	});

	it("performs no write at all when the entry already matches", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const dist = await completeDist("same");
		const entry = join(globalDir, "dist-paths", "claude-plugin");

		expect(await installDistPath("claude-plugin", dist, "2.0.0", globalDir)).toBe(true);
		// Backdating beats comparing two timestamps taken microseconds apart: a rewrite
		// restores a current mtime, so the assertion holds at any clock resolution.
		const backdated = new Date(1_000_000_000_000);
		await utimes(entry, backdated, backdated);

		expect(await installDistPath("claude-plugin", dist, "2.0.0", globalDir)).toBe(true);
		expect((await stat(entry)).mtimeMs).toBe(backdated.getTime());
	});

	it("replaces an incomplete existing entry even when its recorded version is newer", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const incomplete = await mkdtemp(join(tmpdir(), "jolli-dist-incomplete-"));
		cleanup.push(incomplete);
		const complete = await completeDist("complete");

		expect(await installDistPath("claude-plugin", incomplete, "9.0.0", globalDir)).toBe(true);
		expect(await installDistPath("claude-plugin", complete, "2.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`2.0.0\n${complete}`);
	});

	it("keeps a complete entry when an incomplete higher-version candidate arrives", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const complete = await completeDist("complete");
		const incomplete = await mkdtemp(join(tmpdir(), "jolli-dist-incomplete-"));
		cleanup.push(incomplete);

		expect(await installDistPath("claude-plugin", complete, "2.0.0", globalDir)).toBe(true);
		// A corrupt/partial build at a higher version must NOT replace the working
		// complete dist — otherwise a single-source install would resolve to nothing.
		expect(await installDistPath("claude-plugin", incomplete, "9.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`2.0.0\n${complete}`);
	});
});
