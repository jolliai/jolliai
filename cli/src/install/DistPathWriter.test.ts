import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

	it("never downgrades or churns an existing complete source entry", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const newer = await completeDist("newer");
		const older = await completeDist("older");

		expect(await installDistPath("claude-plugin", newer, "2.0.0", globalDir)).toBe(true);
		expect(await installDistPath("claude-plugin", older, "1.0.0", globalDir)).toBe(true);
		expect(await installDistPath("claude-plugin", older, "2.0.0", globalDir)).toBe(true);

		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`2.0.0\n${newer}`);
	});

	it("upgrades a complete entry to a complete higher version", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		const older = await completeDist("older");
		const newer = await completeDist("newer");

		expect(await installDistPath("claude-plugin", older, "1.0.0", globalDir)).toBe(true);
		// A complete, strictly-newer candidate legitimately replaces a complete entry —
		// the monotonic guard must not freeze real upgrades.
		expect(await installDistPath("claude-plugin", newer, "2.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(`2.0.0\n${newer}`);
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
