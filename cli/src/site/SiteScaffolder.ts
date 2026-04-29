/**
 * SiteScaffolder — creates a Nextra project on disk from template files.
 *
 * Template files live in cli/templates/ as real, editable files.
 * A prebuild script generates _generatedTemplates.ts which inlines them.
 * This module selects the right files, substitutes variables, and writes to disk.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templates } from "./_generatedTemplates.js";
import { generateNextConfig, generatePackageJson, substituteVars, type Template, type Theme } from "./templateUtils.js";

export type { Template, Theme };

export interface ScaffoldOptions {
	readonly targetDir: string;
	readonly theme: Theme;
	readonly template: Template;
	readonly name: string;
	readonly force: boolean;
}

export interface ScaffoldResult {
	readonly filesWritten: number;
	readonly targetDir: string;
}

/**
 * Builds the map of relative-path → file-content for the chosen theme and template.
 */
function buildFileMap(name: string, theme: Theme, template: Template): Map<string, string> {
	const files = new Map<string, string>();

	const vars: Record<string, string> = {
		PROJECT_NAME: name,
		TODAY_DATE: new Date().toISOString().split("T")[0],
	};

	// 1. Code-generated files (conditional logic)
	files.set("package.json", generatePackageJson(name, theme, template));
	files.set("next.config.mjs", generateNextConfig(theme));

	// 2. Shared template files (common to all themes/templates)
	for (const [path, content] of Object.entries(templates)) {
		if (path.startsWith("shared/")) {
			files.set(path.slice("shared/".length), substituteVars(content, vars));
		}
	}

	// 3. Theme+template specific files
	const prefix = `${theme}-${template}/`;
	for (const [path, content] of Object.entries(templates)) {
		if (path.startsWith(prefix)) {
			files.set(path.slice(prefix.length), substituteVars(content, vars));
		}
	}

	return files;
}

/**
 * Scaffolds a Nextra project into `targetDir`.
 *
 * Throws if the directory is non-empty and `force` is false.
 */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
	const { targetDir, theme, template, name, force } = options;

	// Guard: non-empty directory without --force
	if (existsSync(targetDir)) {
		const entries = readdirSync(targetDir);
		if (entries.length > 0 && !force) {
			throw new Error(`Directory "${targetDir}" is not empty. Use --force to overwrite.`);
		}
	}

	const files = buildFileMap(name, theme, template);
	let filesWritten = 0;

	for (const [relativePath, content] of files) {
		const absPath = join(targetDir, relativePath);
		const dir = join(absPath, "..");
		mkdirSync(dir, { recursive: true });
		writeFileSync(absPath, content, "utf-8");
		filesWritten++;
	}

	return { filesWritten, targetDir };
}
