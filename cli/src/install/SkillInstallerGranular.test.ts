import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installSkill,
	installSkillsForTarget,
	removeSkill,
	removeSkillsForTarget,
	SKILL_NAMES,
} from "./SkillInstaller.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-skill-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> =>
	stat(p)
		.then(() => true)
		.catch(() => false);

describe("installSkill / removeSkill (target-based)", () => {
	it("installs one skill into the claude-code target", async () => {
		await installSkill(dir, "jolli-recall", "claude-code");
		const p = join(dir, ".claude", "skills", "jolli-recall", "SKILL.md");
		expect(await exists(p)).toBe(true);
		expect(await readFile(p, "utf-8")).toContain("jolli");
	});

	it("installs into the agents-std target dir", async () => {
		await installSkill(dir, "jolli-search", "agents-std");
		expect(await exists(join(dir, ".agents", "skills", "jolli-search", "SKILL.md"))).toBe(true);
	});

	it("removeSkill deletes just that skill dir", async () => {
		await installSkill(dir, "jolli-pr", "claude-code");
		await removeSkill(dir, "jolli-pr", "claude-code");
		expect(await exists(join(dir, ".claude", "skills", "jolli-pr"))).toBe(false);
	});

	it("is a no-op for an unknown skill or target", async () => {
		await installSkill(dir, "nope", "claude-code");
		await installSkill(dir, "jolli-recall", "bogus" as never);
		await removeSkill(dir, "jolli-recall", "bogus" as never);
		expect(await exists(join(dir, ".claude", "skills", "nope"))).toBe(false);
	});
});

describe("installSkillsForTarget / removeSkillsForTarget", () => {
	it("writes then removes every managed skill for a target", async () => {
		await installSkillsForTarget(dir, "claude-code");
		for (const name of SKILL_NAMES) {
			expect(await exists(join(dir, ".claude", "skills", name, "SKILL.md"))).toBe(true);
		}
		await removeSkillsForTarget(dir, "claude-code");
		for (const name of SKILL_NAMES) {
			expect(await exists(join(dir, ".claude", "skills", name))).toBe(false);
		}
	});
});
