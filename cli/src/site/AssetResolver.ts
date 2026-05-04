/**
 * AssetResolver — resolves external images and favicon for the build.
 *
 * Handles three scenarios:
 *   1. Image found inside sourceRoot → handled by ContentMirror (not here)
 *   2. Image found outside sourceRoot → copied to public/images/<unique-name>
 *   3. Image not found → SVG placeholder generated in public/images/
 *
 * Also handles favicon: copies from config path or generates a default.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// ─── ResolvedAsset ───────────────────────────────────────────────────────────

export interface ResolvedAsset {
	/** Absolute path where the file was found, or undefined if missing */
	sourcePath?: string;
	/** Path relative to public/ (e.g. "images/static-img-logo.svg") */
	publicPath: string;
	/** Whether a placeholder was generated */
	isPlaceholder: boolean;
}

// ─── resolveExternalImage ────────────────────────────────────────────────────

/**
 * Resolves an image reference that points outside the sourceRoot.
 *
 * Searches upward from sourceRoot to find the file. If found, returns
 * a unique public path. If not found, returns a placeholder path.
 *
 * @param relImagePath - The resolved relative path from the markdown file's
 *                       original directory (e.g. "../../static/img/logo.svg")
 * @param originalMdDir - The original directory of the markdown file
 *                        (absolute path, e.g. "/project/docs/connectors")
 * @param sourceRoot    - The docs root (absolute path, e.g. "/project/docs")
 */
export function resolveExternalImage(relImagePath: string, originalMdDir: string, sourceRoot: string): ResolvedAsset {
	const projectRoot = findProjectRoot(sourceRoot);

	// Try multiple search paths
	const candidates = [
		resolve(originalMdDir, relImagePath),
		join(projectRoot, "static", relImagePath), // Docusaurus static/ dir
		join(projectRoot, relImagePath),
		join(dirname(sourceRoot), "static", relImagePath),
		join(dirname(sourceRoot), relImagePath),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			const uniqueName = generateUniqueName(candidate, projectRoot);
			return { sourcePath: candidate, publicPath: `images/${uniqueName}`, isPlaceholder: false };
		}
	}

	// Not found — generate placeholder
	const filename = basename(relImagePath);
	return { publicPath: `images/${toPlaceholderName(filename)}`, isPlaceholder: true };
}

// ─── copyExternalAsset ───────────────────────────────────────────────────────

/**
 * Copies an external asset to public/images/ or generates a placeholder.
 */
export async function copyExternalAsset(asset: ResolvedAsset, publicDir: string): Promise<void> {
	const destPath = join(publicDir, asset.publicPath);
	await mkdir(dirname(destPath), { recursive: true });

	if (asset.sourcePath) {
		await copyFile(asset.sourcePath, destPath);
	} else {
		const filename = basename(asset.publicPath);
		const svg = generatePlaceholderSvg(filename.replace(/\.svg$/, "").replace(/^placeholder-/, ""));
		await writeFile(destPath, svg, "utf-8");
	}
}

// ─── resolveFavicon ──────────────────────────────────────────────────────────

/**
 * Copies favicon to `public/favicon.ico`.
 *
 * @param faviconPath - Relative path from sourceRoot (e.g. "../static/img/favicon.ico")
 * @param sourceRoot  - The docs root
 * @param publicDir   - The build public/ directory
 */
export async function resolveFavicon(
	faviconPath: string | undefined,
	sourceRoot: string,
	publicDir: string,
): Promise<void> {
	const destPath = join(publicDir, "favicon.ico");

	if (faviconPath) {
		const absolutePath = resolve(sourceRoot, faviconPath);
		if (existsSync(absolutePath)) {
			await mkdir(dirname(destPath), { recursive: true });
			await copyFile(absolutePath, destPath);
			return;
		}
	}

	// Generate default favicon SVG
	await mkdir(dirname(destPath), { recursive: true });
	const defaultFavicon = generateDefaultFavicon();
	await writeFile(destPath, defaultFavicon, "utf-8");
}

// ─── generatePlaceholderSvg ──────────────────────────────────────────────────

/**
 * Generates an SVG placeholder image for a missing file.
 * Shows the original filename so users know what to replace.
 */
export function generatePlaceholderSvg(filename: string): string {
	// Escape special XML characters
	const escaped = filename.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="100%" height="100%" fill="#f5f5f5" stroke="#ddd" stroke-width="2"/>
  <text x="50%" y="40%" text-anchor="middle" fill="#999" font-family="sans-serif" font-size="18">
    Missing image
  </text>
  <text x="50%" y="55%" text-anchor="middle" fill="#666" font-family="monospace" font-size="12">
    ${escaped}
  </text>
</svg>
`;
}

// ─── generateDefaultFavicon ──────────────────────────────────────────────────

/**
 * Generates a simple default favicon as SVG (a "J" for Jolli).
 */
function generateDefaultFavicon(): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#0070f3"/>
  <text x="50%" y="75%" text-anchor="middle" fill="white" font-family="sans-serif" font-size="22" font-weight="bold">
    J
  </text>
</svg>
`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Finds the project root by looking for common markers.
 * Falls back to sourceRoot's parent.
 */
function findProjectRoot(sourceRoot: string): string {
	let dir = resolve(sourceRoot);
	const markers = ["package.json", ".git", "docusaurus.config.ts", "docusaurus.config.js"];

	// Search up to 5 levels
	for (let i = 0; i < 5; i++) {
		if (markers.some((m) => existsSync(join(dir, m)))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return dirname(sourceRoot);
}

/**
 * Generates a unique filename for an external asset based on its path
 * relative to the project root. Replaces path separators with dashes.
 *
 * "static/img/logo.svg" → "static-img-logo.svg"
 */
function generateUniqueName(absolutePath: string, projectRoot: string): string {
	const rel = absolutePath.startsWith(projectRoot)
		? absolutePath.slice(projectRoot.length + 1)
		: basename(absolutePath);

	const ext = rel.includes(".") ? `.${rel.split(".").pop()}` : "";
	const stem = ext ? rel.slice(0, -ext.length) : rel;

	return `${stem.replace(/[/\\]/g, "-")}${ext}`;
}

/**
 * Generates a placeholder filename for a missing image.
 */
function toPlaceholderName(filename: string): string {
	const ext = filename.includes(".") ? `.${filename.split(".").pop()}` : ".svg";
	const stem = ext !== ".svg" ? filename.slice(0, -ext.length) : filename.replace(/\.\w+$/, "");
	return `placeholder-${stem}.svg`;
}
