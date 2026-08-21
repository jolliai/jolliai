import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDistPath } from "./DistPathWriter.js";

// Redirect homedir() so the "globalDir omitted" fallback test doesn't touch the
// developer's real ~/.jolli/jollimemory — mirrors the pattern in
// SessionTracker.test.ts. Default passes through to the real homedir(); the one
// test that needs the fallback branch opts in via mockHomedir.mockReturnValue().
const { mockHomedir, realHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn<typeof import("node:os").homedir>(),
	realHomedir: { current: null as typeof import("node:os").homedir | null },
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	realHomedir.current = original.homedir;
	mockHomedir.mockImplementation(original.homedir);
	return {
		...original,
		homedir: mockHomedir,
	};
});

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

	// Both defaulted params (`distDir`, `globalDir`) are `??` fallbacks that every
	// other case in this file bypasses by passing explicit values — cover the
	// fallback side of each separately.
	it("falls back to the caller's own directory when distDir is omitted", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		cleanup.push(globalDir);
		// DistPathWriter.ts and this test file are co-located, so the module's own
		// `dirname(fileURLToPath(import.meta.url))` fallback resolves to the same
		// directory as this test's.
		const expectedCallerDir = dirname(fileURLToPath(import.meta.url));

		expect(await installDistPath("claude-plugin", undefined, "1.0.0", globalDir)).toBe(true);
		expect(await readFile(join(globalDir, "dist-paths", "claude-plugin"), "utf-8")).toBe(
			`1.0.0\n${expectedCallerDir}`,
		);
	});

	it("falls back to the real home directory when globalDir is omitted", async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), "jolli-fakehome-"));
		cleanup.push(fakeHome);
		mockHomedir.mockReturnValue(fakeHome);
		try {
			const dist = await completeDist("home-fallback");
			expect(await installDistPath("claude-plugin", dist, "1.0.0")).toBe(true);
			expect(
				await readFile(join(fakeHome, ".jolli", "jollimemory", "dist-paths", "claude-plugin"), "utf-8"),
			).toBe(`1.0.0\n${dist}`);
		} finally {
			if (realHomedir.current) mockHomedir.mockImplementation(realHomedir.current);
		}
	});

	it("returns false and logs a warning when the filesystem write fails", async () => {
		// A plain FILE where a directory is expected makes `mkdir(distPathsDir, {
		// recursive: true })` throw ENOTDIR, exercising the catch branch.
		const notADir = await mkdtemp(join(tmpdir(), "jolli-notadir-"));
		cleanup.push(notADir);
		const filePath = join(notADir, "im-a-file");
		await writeFile(filePath, "");

		expect(await installDistPath("claude-plugin", "/some/dist", "1.0.0", filePath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// REQUIRED_RUNTIME_FILES lockstep — three hand-maintained copies exist:
//
//   1. cli/src/install/DistPathWriter.ts — production source of truth,
//      used by `isCompleteRuntimeDist` to gate every dist-paths write.
//   2. intellij/scripts/run-sandbox.mjs — dev-only sandbox launcher's copy,
//      used to assert the local build is complete before it stomps
//      `dist-paths/{cli,intellij}`. Outside biome coverage AND outside
//      `npm run all`, so drift is silent without a test.
//   3. claude-plugin/plugins/jolli/scripts/build.mjs — plugin build's
//      canonical entry set, checked at build time. Superset of the other
//      two (adds `PluginBootstrapHook`, no `.js` extension), self-checked
//      by its own build.mjs — so this test asserts the SUPERSET relation
//      rather than exact equality.
//
// A single lockstep test here would have caught the exact class of drift
// every other lockstep contract in this repo has a pin for
// (LocalAgentToolsTest, skill fingerprints, …). Keeping the assertion at
// the DistPathWriter site — the source of truth — because that's where
// authors editing the array will look next.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function extractStringArray(source: string, name: string): string[] {
	// Match `const <name> = [ ... ]` up to the closing bracket. Trailing
	// commas, mixed whitespace, and per-line comments are all fine — we
	// only pluck the string literals out of the captured region.
	const declaration = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
	const match = source.match(declaration);
	if (!match) throw new Error(`Could not find \`const ${name}\` array in source`);
	const items: string[] = [];
	// Non-greedy match on either quote style; matches only in-array string literals.
	const literal = /"([^"]+)"|'([^']+)'/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop shape
	while ((m = literal.exec(match[1] ?? "")) !== null) {
		items.push(m[1] ?? m[2] ?? "");
	}
	return items;
}

describe("REQUIRED_RUNTIME_FILES — lockstep with sibling copies", () => {
	it("matches run-sandbox.mjs's copy in name AND order", async () => {
		const [writerSrc, sandboxSrc] = await Promise.all([
			readFile(join(repoRoot, "cli", "src", "install", "DistPathWriter.ts"), "utf-8"),
			readFile(join(repoRoot, "intellij", "scripts", "run-sandbox.mjs"), "utf-8"),
		]);
		const writerList = extractStringArray(writerSrc, "REQUIRED_RUNTIME_FILES");
		const sandboxList = extractStringArray(sandboxSrc, "REQUIRED_RUNTIME_FILES");
		// The completeness check in run-sandbox.mjs runs the same
		// every-file-must-exist loop — a name/order drift silently allows
		// through a dist that `installDistPath()` would later reject.
		expect(sandboxList).toEqual(writerList);
		// Sanity guard on our own local copy at the top of this file. If the
		// production list ever grows/shrinks, the test-file copy powers the
		// `completeDist(...)` fixtures below — its own regression would show
		// up as unrelated tests failing, but this assertion pins it directly.
		expect([...requiredRuntimeFiles]).toEqual(writerList);
	});

	it("is a subset of claude-plugin's entry set (plugin adds PluginBootstrapHook)", async () => {
		const [writerSrc, buildSrc] = await Promise.all([
			readFile(join(repoRoot, "cli", "src", "install", "DistPathWriter.ts"), "utf-8"),
			readFile(join(repoRoot, "claude-plugin", "plugins", "jolli", "scripts", "build.mjs"), "utf-8"),
		]);
		const writerList = extractStringArray(writerSrc, "REQUIRED_RUNTIME_FILES");
		const pluginList = extractStringArray(buildSrc, "EXPECTED_ENTRY_OUTS");
		// build.mjs strips `.js` from each entry (`Cli.js` → `Cli`) and adds one
		// entry that never resolves through `dist-paths/`: `PluginBootstrapHook`,
		// which the manifest launches directly. (It used to add a second,
		// `DashboardServerEntry`; `jolli dashboard` serves in its own process now,
		// so the dashboard server is part of `Cli.js` and there is no separate file
		// to ship.) Reconstruct the plugin's expected shape and assert the relation
		// both ways so a removal on either side fails loudly.
		const pluginOnly = ["PluginBootstrapHook"];
		const pluginExpected = new Set([...writerList.map((f) => f.replace(/\.js$/, "")), ...pluginOnly]);
		expect(new Set(pluginList)).toEqual(pluginExpected);
	});
});
