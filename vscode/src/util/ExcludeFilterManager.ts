/**
 * ExcludeFilterManager
 *
 * Manages glob-based exclude patterns for the Files panel.
 * Patterns are persisted in ~/.jolli/jollimemory/config.json (excludePatterns field)
 * and use minimatch for glob matching — the same syntax as VSCode's search.exclude.
 *
 * Examples: **\/*.vsix, [0-9]*, docs/*.md
 */

import { minimatch } from "minimatch";
import { saveConfig } from "../../../cli/src/core/SessionTracker.js";
import { log } from "./Logger.js";
import { loadGlobalConfig } from "./WorkspaceUtils.js";

/** Minimatch options: dot files match, basename matching enabled */
const MATCH_OPTIONS = { dot: true, matchBase: true } as const;

export class ExcludeFilterManager {
	private patterns: Array<string> = [];

	/**
	 * Loads exclude patterns from ~/.jolli/jollimemory/config.json.
	 * Must be called once during extension activation before using the filter.
	 */
	async load(): Promise<void> {
		try {
			const config = await loadGlobalConfig();
			this.patterns = config.excludePatterns ? [...config.excludePatterns] : [];
			log.debug("ExcludeFilter", `Loaded ${this.patterns.length} patterns`);
		} catch {
			this.patterns = [];
		}
	}

	/** Returns the current exclude patterns. */
	getPatterns(): ReadonlyArray<string> {
		return this.patterns;
	}

	/** Returns true if any exclude patterns are configured. */
	hasPatterns(): boolean {
		return this.patterns.length > 0;
	}

	/** Returns the patterns as a comma-separated string for display/editing. */
	toPatternsString(): string {
		return this.patterns.join(", ");
	}

	/**
	 * Updates the exclude patterns and persists them to config.json.
	 * Empty/whitespace-only patterns are silently filtered out.
	 */
	async setPatterns(patterns: ReadonlyArray<string>): Promise<void> {
		this.patterns = patterns
			.filter((p) => p.trim().length > 0)
			.map((p) => p.trim());
		await saveConfig({ excludePatterns: this.patterns });
		log.info("ExcludeFilter", `Saved ${this.patterns.length} patterns`);
	}

	/**
	 * Tests whether a file path should be excluded.
	 * Returns true if the path matches ANY of the configured patterns.
	 */
	isExcluded(relativePath: string): boolean {
		return this.patterns.some((pattern) =>
			minimatch(relativePath, pattern, MATCH_OPTIONS),
		);
	}
}
