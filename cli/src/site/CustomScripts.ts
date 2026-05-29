/**
 * CustomScripts — the `.jolli/scripts/` file-convention escape-hatch (JOLLI-1505).
 *
 * Customers commit `.js`/`.css` files under a `.jolli/scripts/` folder at the
 * content root; those files are bundled verbatim into the generated site's
 * `public/scripts/` and injected on every page (analytics, chat widgets, custom
 * CSS). Mintlify/Vercel-style: the files run as-is on the customer's own site —
 * the repo IS the trust boundary, so there's no sanitization, only the size /
 * count hygiene caps below.
 *
 * The folder is namespaced under `.jolli/` (rather than a bare `scripts/`) so it
 * can't collide with a `scripts/` directory the customer already uses for build
 * tooling — only files explicitly placed under `.jolli/scripts/` are injected.
 * `.jolli/` is reserved (see `isReservedJolliPath`), so files there are never
 * mirrored as doc pages or scanned as OpenAPI specs.
 */

import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import {
	CUSTOM_SCRIPT_EXTENSIONS,
	CUSTOM_SCRIPT_FOLDER,
	CUSTOM_SCRIPT_PUBLIC_DIR,
	type CustomScriptAsset,
	MAX_CUSTOM_SCRIPT_BYTES,
	MAX_CUSTOM_SCRIPT_FILES,
} from "@jolli.ai/site-core";

// Re-export the shared constants + predicate so CLI consumers that import
// from `./CustomScripts.js` keep working without changes.
export {
	CUSTOM_SCRIPT_FOLDER,
	CUSTOM_SCRIPT_PUBLIC_DIR,
	isReservedJolliPath,
	JOLLI_RESERVED_DIR,
	MAX_CUSTOM_SCRIPT_BYTES,
	MAX_CUSTOM_SCRIPT_FILES,
} from "@jolli.ai/site-core";

// ─── discoverCustomScripts ────────────────────────────────────────────────────

/** A discovered custom-script source file plus its derived inject descriptor. */
export interface DiscoveredCustomScript {
	/** Absolute path to the source file. */
	absPath: string;
	/** Path relative to `.jolli/scripts/`, posix (e.g. `"analytics.js"`, `"nested/widget.js"`). */
	relPath: string;
	/** The derived inject descriptor (`{ url, type }`). */
	asset: CustomScriptAsset;
}

/** Normalises an OS path to forward slashes for stable matching/URLs. */
function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * Recursively discovers the `.js`/`.css` files under `<sourceRoot>/.jolli/scripts/`.
 * Files larger than the per-file cap are skipped with a warning; the result is
 * sorted by relative path and capped at the per-build limit for deterministic
 * output. Returns `[]` when the folder is absent (the common case).
 */
export async function discoverCustomScripts(sourceRoot: string): Promise<DiscoveredCustomScript[]> {
	const scriptsRoot = join(sourceRoot, CUSTOM_SCRIPT_FOLDER);
	const candidates: DiscoveredCustomScript[] = [];

	const walk = async (currentDir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(currentDir, { withFileTypes: true });
		} catch {
			// Folder absent or unreadable — nothing to bundle.
			return;
		}
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (!CUSTOM_SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
				continue;
			}
			const relPath = toPosix(relative(scriptsRoot, fullPath));
			// `stat` follows symlinks (unlike the `withFileTypes` Dirent), so this
			// is also where a broken symlink under `.jolli/scripts/` is skipped
			// rather than crashing the build.
			let size: number;
			try {
				size = (await stat(fullPath)).size;
			} catch {
				continue;
			}
			if (size > MAX_CUSTOM_SCRIPT_BYTES) {
				console.warn(
					`  ⚠ Skipping custom script "${CUSTOM_SCRIPT_FOLDER}/${relPath}": ` +
						`exceeds the ${MAX_CUSTOM_SCRIPT_BYTES / 1024} KB per-file cap.`,
				);
				continue;
			}
			const type = extname(relPath).toLowerCase() === ".css" ? "css" : "js";
			candidates.push({
				absPath: fullPath,
				relPath,
				asset: { url: `/${CUSTOM_SCRIPT_PUBLIC_DIR}/${relPath}`, type },
			});
		}
	};

	await walk(scriptsRoot);

	candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
	if (candidates.length > MAX_CUSTOM_SCRIPT_FILES) {
		console.warn(
			`  ⚠ Found ${candidates.length} custom scripts under "${CUSTOM_SCRIPT_FOLDER}/"; ` +
				`bundling the first ${MAX_CUSTOM_SCRIPT_FILES} (sorted by name).`,
		);
	}
	return candidates.slice(0, MAX_CUSTOM_SCRIPT_FILES);
}

// ─── bundleCustomScripts ──────────────────────────────────────────────────────

/**
 * Discovers the custom scripts and copies each verbatim into
 * `<publicDir>/scripts/<rel>`, preserving sub-folder structure. Returns the
 * inject descriptors (`{ url, type }`) for the bundled files so the generated
 * `CustomScripts` component references exactly what landed on disk.
 */
export async function bundleCustomScripts(sourceRoot: string, publicDir: string): Promise<CustomScriptAsset[]> {
	const discovered = await discoverCustomScripts(sourceRoot);
	const targetRoot = join(publicDir, CUSTOM_SCRIPT_PUBLIC_DIR);
	for (const { absPath, relPath } of discovered) {
		const dest = join(targetRoot, relPath);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(absPath, dest);
	}
	return discovered.map((d) => d.asset);
}
