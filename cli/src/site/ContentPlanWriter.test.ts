import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyNavigationContentPlan } from "./ContentPlanWriter.js";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-content-plan-writer-test-"));
}

describe("applyNavigationContentPlan", () => {
	let sourceRoot: string;
	let contentDir: string;

	afterEach(async () => {
		if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
		if (contentDir) await rm(contentDir, { recursive: true, force: true });
	});

	it("rewrites planned markdown into navigation-defined targets and preserves root index", async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
		await mkdir(join(sourceRoot, "assets"), { recursive: true });
		await mkdir(join(contentDir, "docs"), { recursive: true });

		await writeFile(join(sourceRoot, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceRoot, "intro.md"), "![Diagram](./assets/arch.png)\n", "utf-8");
		await writeFile(join(contentDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(contentDir, "intro.md"), "stale\n", "utf-8");

		const written = await applyNavigationContentPlan(sourceRoot, contentDir, ["index.md", "intro.md"], {
			pages: [{ sourceRelPath: "intro.md", targetRelPath: "docs/intro.md", title: "Intro" }],
		});

		expect(written).toEqual(["index.md", "docs/intro.md"]);
		expect(existsSync(join(contentDir, "intro.md"))).toBe(false);
		expect(existsSync(join(contentDir, "index.md"))).toBe(true);
		expect(existsSync(join(contentDir, "docs", "intro.md"))).toBe(true);
		const rewritten = await readFile(join(contentDir, "docs", "intro.md"), "utf-8");
		expect(rewritten).toContain("![Diagram](../assets/arch.png)");
	});

	it("injects asIndexPage:true frontmatter when a non-index source is re-homed to <folder>/index.<ext>", async () => {
		// Regression for the parent-article-with-nested-children case: the
		// planner writes `<href>/index.<ext>` instead of `<href>.<ext>` so the
		// folder can hold child pages, and the frontmatter flag makes Nextra v4
		// route the folder header to the index (instead of just expanding) and
		// suppress the duplicate auto-discovered index entry in the sidebar.
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();

		// No existing frontmatter → flag block is prepended.
		await writeFile(join(sourceRoot, "deployment.mdx"), "# Deployment\nBody.\n", "utf-8");
		// Existing frontmatter → flag is merged in.
		await writeFile(join(sourceRoot, "operations.mdx"), "---\ntitle: Ops\n---\n# Operations\n", "utf-8");
		// Real index source (basename === index) → flag NOT injected; we only
		// touch frontmatter when we renamed a non-index source into an index slot.
		await writeFile(join(sourceRoot, "home.mdx"), "---\ntitle: Home\n---\n# Home\n", "utf-8");

		await applyNavigationContentPlan(sourceRoot, contentDir, ["deployment.mdx", "operations.mdx", "home.mdx"], {
			pages: [
				{ sourceRelPath: "deployment.mdx", targetRelPath: "guides/deployment/index.mdx", title: "Deployment" },
				{ sourceRelPath: "operations.mdx", targetRelPath: "sql/operations/index.mdx", title: "Operations" },
				{ sourceRelPath: "home.mdx", targetRelPath: "home.mdx", title: "Home" },
			],
		});

		const deployment = await readFile(join(contentDir, "guides/deployment/index.mdx"), "utf-8");
		expect(deployment).toMatch(/^---\nasIndexPage: true\n---\n/);
		expect(deployment).toContain("# Deployment");

		const operations = await readFile(join(contentDir, "sql/operations/index.mdx"), "utf-8");
		expect(operations).toMatch(/^---\ntitle: Ops\nasIndexPage: true\n---\n/);
		expect(operations).toContain("# Operations");

		// Source was an .mdx that didn't need renaming → frontmatter untouched.
		const home = await readFile(join(contentDir, "home.mdx"), "utf-8");
		expect(home).not.toContain("asIndexPage");
	});

	it("injects a top-level asIndexPage flag even when the frontmatter has a nested asIndexPage key", async () => {
		// Regression: the "already declared" check used to match
		// `^\s*asIndexPage\s*:` on any indentation, so a nested YAML key
		// (e.g. `things:\n  asIndexPage: true`) falsely registered as a
		// top-level declaration and the function skipped injection — the
		// resulting file then had no top-level flag, and Nextra v4 fell
		// back to its layout-conflict behaviour.
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();

		await writeFile(
			join(sourceRoot, "deployment.mdx"),
			"---\ntitle: Deployment\nthings:\n  asIndexPage: true\n---\n# Deployment\n",
			"utf-8",
		);

		await applyNavigationContentPlan(sourceRoot, contentDir, ["deployment.mdx"], {
			pages: [
				{ sourceRelPath: "deployment.mdx", targetRelPath: "guides/deployment/index.mdx", title: "Deployment" },
			],
		});

		const written = await readFile(join(contentDir, "guides/deployment/index.mdx"), "utf-8");
		// Top-level flag is present.
		expect(written).toMatch(/^---\n[\s\S]*^asIndexPage: true$/m);
		// And the original nested key was preserved.
		expect(written).toContain("things:\n  asIndexPage: true");
	});
});
