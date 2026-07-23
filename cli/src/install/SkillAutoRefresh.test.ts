import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import { autoRefreshSkillsIfStale } from "./SkillAutoRefresh.js";

const tmpDirs: string[] = [];

async function makeEnabledRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "jolli-autorefresh-"));
	tmpDirs.push(root);
	// The "Jolli is enabled here" probe: a full enable writes jolli-recall.
	const skillDir = join(root, ".agents", "skills", "jolli-recall");
	await mkdir(skillDir, { recursive: true });
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: jolli-recall\n---\n");
	return root;
}

function markerPathFor(root: string): string {
	return join(getJolliMemoryDir(root), "skills-refresh.json");
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("autoRefreshSkillsIfStale", () => {
	it("is a no-op on a dev build (never rewrites skills)", async () => {
		const root = await makeEnabledRepo();
		const updateSkills = vi.fn(async () => {});
		// A "dev" build (tsx / unbuilt) must never self-heal — developers iterate via
		// `jolli enable`. This is the guard that keeps a dev run from rewriting skills.
		await autoRefreshSkillsIfStale(root, { version: "dev", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).not.toHaveBeenCalled();
		expect(existsSync(markerPathFor(root))).toBe(false);
	});

	it("is a no-op when Jolli is not enabled in the repo (never creates skills)", async () => {
		const root = await mkdtemp(join(tmpdir(), "jolli-autorefresh-"));
		tmpDirs.push(root);
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).not.toHaveBeenCalled();
		expect(existsSync(markerPathFor(root))).toBe(false);
	});

	it("refreshes and stamps the marker when there is no marker yet", async () => {
		const root = await makeEnabledRepo();
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).toHaveBeenCalledWith(root, { claudeEnabled: undefined });
		expect(JSON.parse(await readFile(markerPathFor(root), "utf-8"))).toEqual({ version: "1.2.3" });
	});

	it("passes through claudeEnabled from config to the skill upsert", async () => {
		const root = await makeEnabledRepo();
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, {
			version: "1.2.3",
			loadConfig: async () => ({ claudeEnabled: false }),
			updateSkills,
		});
		expect(updateSkills).toHaveBeenCalledWith(root, { claudeEnabled: false });
	});

	it("refreshes when the marker records a different version", async () => {
		const root = await makeEnabledRepo();
		await mkdir(getJolliMemoryDir(root), { recursive: true });
		await writeFile(markerPathFor(root), JSON.stringify({ version: "1.0.0" }));
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).toHaveBeenCalledOnce();
		expect(JSON.parse(await readFile(markerPathFor(root), "utf-8"))).toEqual({ version: "1.2.3" });
	});

	it("skips the refresh when the marker already records the running version", async () => {
		const root = await makeEnabledRepo();
		await mkdir(getJolliMemoryDir(root), { recursive: true });
		await writeFile(markerPathFor(root), JSON.stringify({ version: "1.2.3" }));
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).not.toHaveBeenCalled();
	});

	it("treats an unparseable marker as absent and refreshes", async () => {
		const root = await makeEnabledRepo();
		await mkdir(getJolliMemoryDir(root), { recursive: true });
		await writeFile(markerPathFor(root), "not json");
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).toHaveBeenCalledOnce();
	});

	it("treats a marker with a non-string version as absent and refreshes", async () => {
		const root = await makeEnabledRepo();
		await mkdir(getJolliMemoryDir(root), { recursive: true });
		await writeFile(markerPathFor(root), JSON.stringify({ version: 123 }));
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).toHaveBeenCalledOnce();
	});

	it("defaults to the build-stamped version when none is injected", async () => {
		// Exercises the `deps.version ?? VERSION` default. Under the test runner VERSION
		// is a real published version (not "dev"), so the refresh proceeds and the marker
		// records that version rather than the "dev" sentinel.
		const root = await makeEnabledRepo();
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(root, { loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).toHaveBeenCalledOnce();
		const stamped = JSON.parse(await readFile(markerPathFor(root), "utf-8")) as { version: string };
		expect(typeof stamped.version).toBe("string");
		expect(stamped.version).not.toBe("dev");
	});

	it("walks up from a nested cwd to find the enabled worktree root", async () => {
		const root = await makeEnabledRepo();
		const nested = join(root, "packages", "app", "src");
		await mkdir(nested, { recursive: true });
		const updateSkills = vi.fn(async () => {});
		await autoRefreshSkillsIfStale(nested, { version: "1.2.3", loadConfig: async () => ({}), updateSkills });
		expect(updateSkills).toHaveBeenCalledWith(root, { claudeEnabled: undefined });
	});

	it("is fail-soft when the skill upsert throws (never rejects, no marker stamped)", async () => {
		const root = await makeEnabledRepo();
		const updateSkills = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(
			autoRefreshSkillsIfStale(root, { version: "1.2.3", loadConfig: async () => ({}), updateSkills }),
		).resolves.toBeUndefined();
		expect(existsSync(markerPathFor(root))).toBe(false);
	});

	it("uses the real loadConfig + skill upsert when no deps are injected", async () => {
		// Exercises the default-dependency branches: a real refresh writes the full
		// skill set into the (temp) worktree and stamps the marker.
		const root = await makeEnabledRepo();
		await autoRefreshSkillsIfStale(root, { version: "1.2.3" });
		expect(existsSync(join(root, ".agents", "skills", "jolli-remote-run", "SKILL.md"))).toBe(true);
		expect(JSON.parse(await readFile(markerPathFor(root), "utf-8"))).toEqual({ version: "1.2.3" });
	});
});
