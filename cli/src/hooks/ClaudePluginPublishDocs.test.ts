/**
 * Shape tests for the Claude plugin's published README.
 *
 * The marketplace repo's README is the front page end users see, and it is a
 * GENERATED mirror — so the two halves that must agree live in different files and
 * nothing type-checks either. Same technique and rationale as the Codex pair in
 * CodexPluginManifest.test.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readme = () => readFileSync(join(repoRoot, "claude-plugin", "README.md"), "utf-8");
const script = (name: string) => readFileSync(join(repoRoot, "claude-plugin", "scripts", name), "utf-8");

describe("Claude publish resolves the README marketplace source", () => {
	// The README used to hardcode the PROD slug, so the dev mirror told dry-run
	// readers to install the public release instead of the rehearsal copy. The
	// placeholder is what lets one source README serve both targets.
	it("names no concrete marketplace slug in the source README", () => {
		const text = readme();
		const placeholder = script("_publish-lib.sh").match(/^README_SOURCE_PLACEHOLDER='([^']+)'$/mu)?.[1] ?? "";

		expect(placeholder).toBe("<marketplace-source>");
		expect(text).toContain(`/plugin marketplace add ${placeholder}`);
		expect(text).not.toContain("marketplace add jolliai/");
		expect(text).not.toContain("marketplace add jolli-plugin-dev/");
	});

	// publish_readme_source replaces at most one occurrence per LINE, then asserts the
	// token is gone — so several placeholders are fine, two on one line are not.
	it("keeps every placeholder on its own line", () => {
		for (const line of readme().split("\n")) {
			expect(line.split("<marketplace-source>").length).toBeLessThanOrEqual(2);
		}
	});

	it("passes each target's own marketplace slug", () => {
		expect(script("publish-dev.sh")).toContain(
			'publish_git_repo "$DEST" "jolli-plugin-dev/claude-plugin-marketplace"',
		);
		expect(script("publish-prod.sh")).toContain('publish_git_repo "$DEST" "jolliai/jolli-claude-plugin"');
		// publish-local.sh resolves to the local directory it just wrote; publish-zip.sh
		// needs no call at all because it packs plugins/jolli/ and ships no README.
		expect(script("publish-local.sh")).toContain('publish_readme_source "$DEST" "$DEST"');
		expect(script("publish-zip.sh")).not.toContain("publish_readme_source");
	});
});

describe("Claude plugin README entry point", () => {
	// `/jolli` is the front door: its "not fully set up" branch invokes jolli:init
	// itself. The README pointed at /jolli:init as "the one-shot path", which teaches
	// a sub-skill and skips the state-aware routing.
	it("leads with the bare /jolli front door", () => {
		const text = readme();
		expect(text).toContain("Start with **`/jolli`**");
		expect(text).not.toContain("is the one-shot path");
		// The first-session caveat is load-bearing on Claude (unlike Codex, whose
		// umbrella ships in the bundle): the bare menu is a project skill this plugin
		// writes, so a brand-new repo may not show it until the next session.
		expect(text).toMatch(/brand-new repo[\s\S]{0,200}`\/jolli:init`/u);
	});
});
