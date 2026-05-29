/**
 * StarterKit — I/O wrapper around the pure `getStarterFiles` template list.
 *
 * The template content (SITE_JSON, INDEX_MD, OPENAPI_YAML, etc.) lives in
 * `@jolli.ai/site-core` so the web tool can offer the same starter bundle
 * in its "create new site" flow. This module's only job is to write the
 * files to disk.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getStarterFiles, type ScaffoldResult } from "@jolli.ai/site-core";

// ─── scaffoldProject ──────────────────────────────────────────────────────────

/**
 * Scaffolds a new Content_Folder at `targetDir`.
 *
 * Returns `{ success: false }` (without modifying the filesystem) if the
 * target directory already exists.
 */
export async function scaffoldProject(targetDir: string): Promise<ScaffoldResult> {
	if (existsSync(targetDir)) {
		return {
			success: false,
			targetDir,
			message: `Directory already exists: ${targetDir}`,
		};
	}

	try {
		const files = getStarterFiles();
		await Promise.all(
			files.map(async (file) => {
				const fullPath = join(targetDir, file.path);
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, file.content, "utf-8");
			}),
		);

		return {
			success: true,
			targetDir,
			message: `Created ${targetDir}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			targetDir,
			message,
		};
	}
}
