/**
 * FrameworkDetector — detects documentation framework config files in a
 * content folder and prompts the user for migration.
 *
 * Supports detection of: Docusaurus, Mintlify, VitePress, MkDocs, GitBook.
 * v1 only implements Docusaurus conversion; others are detected and reported.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

// ─── DetectedFramework ───────────────────────────────────────────────────────

export interface DetectedFramework {
	name: "docusaurus" | "mintlify" | "vitepress" | "mkdocs" | "gitbook";
	configPath: string;
	sidebarPath?: string;
}

// ─── Framework detection rules ───────────────────────────────────────────────

interface FrameworkRule {
	name: DetectedFramework["name"];
	/** Files to check in the source root */
	files: string[];
	/** Files to check in the parent directory */
	parentFiles?: string[];
	/** Which file contains sidebar config (if different from main config) */
	sidebarFiles?: string[];
	/** Sidebar files to check in parent directory */
	parentSidebarFiles?: string[];
}

const FRAMEWORK_RULES: FrameworkRule[] = [
	{
		name: "docusaurus",
		files: ["docusaurus.config.js", "docusaurus.config.ts", "sidebars.js", "sidebars.ts"],
		parentFiles: ["docusaurus.config.js", "docusaurus.config.ts"],
		sidebarFiles: ["sidebars.js", "sidebars.ts"],
		parentSidebarFiles: ["sidebars.js", "sidebars.ts"],
	},
	{
		name: "mintlify",
		files: ["mint.json"],
	},
	{
		name: "vitepress",
		files: [".vitepress/config.js", ".vitepress/config.ts"],
	},
	{
		name: "mkdocs",
		files: ["mkdocs.yml", "mkdocs.yaml"],
	},
	{
		name: "gitbook",
		files: ["SUMMARY.md", ".gitbook.yaml"],
	},
];

// ─── detectFramework ─────────────────────────────────────────────────────────

/**
 * Scans the source root (and its parent directory for Docusaurus) for known
 * documentation framework config files.
 *
 * Returns the first detected framework, or `null` if none found.
 */
export function detectFramework(sourceRoot: string): DetectedFramework | null {
	const parentDir = dirname(sourceRoot);

	for (const rule of FRAMEWORK_RULES) {
		// Check source root
		for (const file of rule.files) {
			const fullPath = join(sourceRoot, file);
			if (existsSync(fullPath)) {
				return {
					name: rule.name,
					configPath: fullPath,
					sidebarPath: findSidebarFile(sourceRoot, parentDir, rule),
				};
			}
		}

		// Check parent directory
		if (rule.parentFiles) {
			for (const file of rule.parentFiles) {
				const fullPath = join(parentDir, file);
				if (existsSync(fullPath)) {
					return {
						name: rule.name,
						configPath: fullPath,
						sidebarPath: findSidebarFile(sourceRoot, parentDir, rule),
					};
				}
			}
		}
	}

	return null;
}

/**
 * Finds the sidebar config file, checking source root first, then parent.
 */
function findSidebarFile(sourceRoot: string, parentDir: string, rule: FrameworkRule): string | undefined {
	if (rule.sidebarFiles) {
		for (const file of rule.sidebarFiles) {
			const fullPath = join(sourceRoot, file);
			if (existsSync(fullPath)) return fullPath;
		}
	}
	if (rule.parentSidebarFiles) {
		for (const file of rule.parentSidebarFiles) {
			const fullPath = join(parentDir, file);
			if (existsSync(fullPath)) return fullPath;
		}
	}
	return undefined;
}

// ─── promptMigration ─────────────────────────────────────────────────────────

/**
 * Prompts the user whether to migrate from the detected framework.
 * Returns `true` if the user wants to migrate (Y), `false` otherwise.
 */
export function promptMigration(framework: DetectedFramework): Promise<boolean> {
	if (!process.stdin.isTTY) return Promise.resolve(true);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const name = framework.name.charAt(0).toUpperCase() + framework.name.slice(1);

	return new Promise((resolve) => {
		rl.question(`Found ${name} config. Generate site.json from it? (Y/n) `, (answer) => {
			rl.close();
			const trimmed = answer.trim().toLowerCase();
			resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
		});
	});
}
