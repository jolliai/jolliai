/**
 * ConvertCommand — Permanently converts a documentation folder to
 * Nextra-compatible structure.
 *
 * Detects the source framework (Docusaurus etc.), reorganizes the directory
 * structure according to the sidebar config, downgrades incompatible MDX
 * files, fixes image paths, and writes a clean site.json without pathMappings.
 *
 * For in-place conversion, creates a timestamped backup first.
 */

import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
// AssetResolver used for favicon handling
import {
	applyPathMapping,
	classifyFile,
	hasIncompatibleImports,
	rewriteRelativeImagePaths,
	stripIncompatibleContent,
} from "../site/ContentMirror.js";
import {
	type ConversionResult,
	convertDocusaurusSidebar,
	extractFaviconFromConfig,
} from "../site/DocusaurusConverter.js";
import { detectFramework, promptMigration } from "../site/FrameworkDetector.js";
import type { PathMappings, SiteJson } from "../site/Types.js";

// ─── registerConvertCommand ──────────────────────────────────────────────────

export function registerConvertCommand(program: Command): void {
	program
		.command("convert")
		.description("Convert a documentation folder to Nextra-compatible structure")
		.argument("[source]", "Source folder (default: current directory)")
		.option("--output <path>", "Output folder (default: convert in-place)")
		.action(async (sourceArg?: string, opts?: { output?: string }) => {
			const sourceRoot = resolve(sourceArg ?? process.cwd());
			const outputDir = opts?.output ? resolve(opts.output) : sourceRoot;
			const inPlace = outputDir === sourceRoot;

			if (!existsSync(sourceRoot)) {
				console.error(`  Error: Source folder does not exist: ${sourceRoot}`);
				process.exitCode = 1;
				return;
			}

			try {
				await convertFolder(sourceRoot, outputDir, inPlace);
			} catch (err) {
				console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}

// ─── convertFolder ───────────────────────────────────────────────────────────

interface ConvertStats {
	totalFiles: number;
	downgraded: number;
	movedFolders: string[];
}

async function convertFolder(sourceRoot: string, targetRoot: string, inPlace: boolean): Promise<void> {
	// Step 1: Detect framework and generate conversion config
	let conversion: ConversionResult | undefined;
	const framework = detectFramework(sourceRoot);

	if (framework) {
		const shouldMigrate = await promptMigration(framework);
		if (shouldMigrate && framework.name === "docusaurus" && framework.sidebarPath) {
			conversion = await convertDocusaurusSidebar(framework.sidebarPath);
			const faviconPath = extractFaviconFromConfig(framework.configPath);
			if (faviconPath) conversion.favicon = faviconPath;
		}
	}

	// Step 2: Prompt for site title
	const folderName = basename(sourceRoot);
	const defaultTitle = folderName.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	const title = await promptTitle(defaultTitle);

	const pathMappings = conversion?.pathMappings ?? {};

	// Step 3: Backup if in-place
	if (inPlace) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const backupDir = `${sourceRoot}.backup-${timestamp}`;
		console.log(`  Creating backup → ${backupDir}`);
		await cp(sourceRoot, backupDir, { recursive: true });
		console.log("  ✓ Backup created");
	}

	// Step 4: Prepare target directory
	if (!inPlace) {
		await mkdir(targetRoot, { recursive: true });
	}

	// Step 5: Convert files
	const stats: ConvertStats = { totalFiles: 0, downgraded: 0, movedFolders: [] };

	// Track unique moved folders for summary
	for (const [src, tgt] of Object.entries(pathMappings)) {
		stats.movedFolders.push(`${src} → ${tgt}`);
	}

	await processDirectory(sourceRoot, sourceRoot, targetRoot, pathMappings, stats, inPlace);

	// Step 6: Handle slug: / → index.md
	const renamedKey = await handleSlugIndex(targetRoot);

	// Step 7: Handle favicon
	if (conversion?.favicon) {
		const faviconDest = join(targetRoot, "favicon.ico");
		if (existsSync(conversion.favicon)) {
			await copyFile(conversion.favicon, faviconDest);
		}
	}

	// Step 8: Write site.json (WITHOUT pathMappings)
	const sidebar = conversion?.sidebar;

	// If a file was renamed to index.md, update sidebar key
	if (renamedKey && sidebar?.["/"]?.[renamedKey]) {
		const label = sidebar["/"][renamedKey];
		delete sidebar["/"][renamedKey];
		sidebar["/"] = { index: label, ...sidebar["/"] };
	}

	const siteJson: SiteJson = {
		title,
		description: `${title} documentation`,
		nav: [],
	};
	if (sidebar && Object.keys(sidebar).length > 0) {
		siteJson.sidebar = sidebar;
	}
	if (conversion?.favicon) {
		siteJson.favicon = "favicon.ico";
	}
	await writeFile(join(targetRoot, "site.json"), `${JSON.stringify(siteJson, null, 2)}\n`, "utf-8");

	// Step 9: Clean up framework-specific files in target
	await cleanupFrameworkFiles(targetRoot);

	// Summary
	console.log("");
	console.log(
		`  ✓ Converted ${stats.totalFiles} files${stats.downgraded > 0 ? ` (${stats.downgraded} downgraded)` : ""}`,
	);
	if (stats.movedFolders.length > 0) {
		console.log(`  ✓ Moved ${stats.movedFolders.length} folders:`);
		for (const move of stats.movedFolders) {
			console.log(`      ${move}`);
		}
	}
	if (inPlace) {
		console.log(`  ✓ Original backed up`);
	}
	console.log(`  ✓ Created site.json`);
	console.log(`\n  Run \`jolli dev${targetRoot !== process.cwd() ? ` ${targetRoot}` : ""}\` to preview.\n`);
}

// ─── processDirectory ────────────────────────────────────────────────────────

async function processDirectory(
	currentDir: string,
	sourceRoot: string,
	targetRoot: string,
	pathMappings: PathMappings,
	stats: ConvertStats,
	inPlace: boolean,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(currentDir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry === ".jolli-site" || entry.startsWith(".backup-")) continue;

		const fullPath = join(currentDir, entry);
		let entryStat: Awaited<ReturnType<typeof stat>>;
		try {
			entryStat = await stat(fullPath);
		} catch {
			continue;
		}

		if (entryStat.isDirectory()) {
			await processDirectory(fullPath, sourceRoot, targetRoot, pathMappings, stats, inPlace);
		} else if (entryStat.isFile()) {
			await processFile(fullPath, sourceRoot, targetRoot, pathMappings, stats, inPlace);
		}
	}
}

async function processFile(
	fullPath: string,
	sourceRoot: string,
	targetRoot: string,
	pathMappings: PathMappings,
	stats: ConvertStats,
	inPlace: boolean,
): Promise<void> {
	const originalRelPath = relative(sourceRoot, fullPath);
	const mappedRelPath = applyPathMapping(originalRelPath, pathMappings);
	const ext = extname(fullPath).toLowerCase();
	const destPath = join(targetRoot, mappedRelPath);

	// Skip framework config files
	if (isFrameworkFile(originalRelPath)) return;

	// Read content for classification if needed
	let content: string | undefined;
	if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
		try {
			content = await readFile(fullPath, "utf-8");
		} catch {
			return;
		}
	}

	const fileType = classifyFile(fullPath, content);

	switch (fileType) {
		case "markdown": {
			stats.totalFiles++;
			await mkdir(dirname(destPath), { recursive: true });

			if (ext === ".mdx") {
				let mdxContent: string;
				try {
					mdxContent = await readFile(fullPath, "utf-8");
				} catch {
					return;
				}

				if (hasIncompatibleImports(mdxContent)) {
					// Downgrade to .md
					const cleaned = stripIncompatibleContent(mdxContent);
					const mdDestPath = destPath.replace(/\.mdx$/, ".md");
					// Rewrite image paths if file was remapped
					const mdMappedRelPath = mappedRelPath.replace(/\.mdx$/, ".md");
					const rewritten =
						originalRelPath !== mdMappedRelPath
							? rewriteRelativeImagePaths(cleaned, originalRelPath, mdMappedRelPath, pathMappings)
							: cleaned;
					await writeFile(mdDestPath, rewritten, "utf-8");
					stats.downgraded++;

					// Remove original .mdx if in-place (we wrote .md instead)
					if (inPlace) {
						await safeRemove(fullPath);
					}
					return;
				}
			}

			// Normal copy/move
			if (originalRelPath !== mappedRelPath) {
				let mdContent: string;
				try {
					mdContent = await readFile(fullPath, "utf-8");
				} catch {
					await safeCopyOrMove(fullPath, destPath, inPlace);
					return;
				}
				const rewritten = rewriteRelativeImagePaths(mdContent, originalRelPath, mappedRelPath, pathMappings);
				await writeFile(destPath, rewritten, "utf-8");
				if (inPlace && fullPath !== destPath) await safeRemove(fullPath);
			} else if (!inPlace) {
				await copyFile(fullPath, destPath);
			}
			// If in-place and path unchanged, file stays where it is
			break;
		}
		case "image":
		case "openapi":
		case "ignored": {
			if (fileType !== "ignored") stats.totalFiles++;
			await mkdir(dirname(destPath), { recursive: true });
			await safeCopyOrMove(fullPath, destPath, inPlace);
			break;
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function promptTitle(defaultTitle: string): Promise<string> {
	if (!process.stdin.isTTY) return Promise.resolve(defaultTitle);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`Site title (${defaultTitle}): `, (answer) => {
			rl.close();
			resolve(answer.trim() || defaultTitle);
		});
	});
}

async function safeCopyOrMove(src: string, dest: string, inPlace: boolean): Promise<void> {
	if (src === dest) return;
	await mkdir(dirname(dest), { recursive: true });
	if (inPlace) {
		try {
			await rename(src, dest);
		} catch {
			// Cross-device — fall back to copy + remove
			await copyFile(src, dest);
			await safeRemove(src);
		}
	} else {
		await copyFile(src, dest);
	}
}

async function safeRemove(path: string): Promise<void> {
	try {
		const { rm } = await import("node:fs/promises");
		await rm(path, { force: true });
	} catch {
		// Ignore removal errors
	}
}

/** Files to skip during conversion (framework-specific configs). */
function isFrameworkFile(relPath: string): boolean {
	const name = basename(relPath);
	return [
		"sidebars.js",
		"sidebars.ts",
		"docusaurus.config.js",
		"docusaurus.config.ts",
		"package.json",
		"package-lock.json",
		"yarn.lock",
		"node_modules",
		"site.json",
	].includes(name);
}

/** Rename file with slug: / to index.md. Returns old key if renamed. */
async function handleSlugIndex(targetRoot: string): Promise<string | undefined> {
	const entries = await readdir(targetRoot);
	for (const entry of entries) {
		const ext = extname(entry).toLowerCase();
		if (ext !== ".md" && ext !== ".mdx") continue;
		if (entry === "index.md" || entry === "index.mdx") return undefined;

		const fullPath = join(targetRoot, entry);
		try {
			const content = await readFile(fullPath, "utf-8");
			if (/^slug:\s*\/\s*$/m.test(content)) {
				await rename(fullPath, join(targetRoot, "index.md"));
				return entry.replace(/\.(md|mdx)$/, "");
			}
		} catch {}
	}
	return undefined;
}

/** Remove framework-specific files from target after conversion. */
async function cleanupFrameworkFiles(targetRoot: string): Promise<void> {
	const toRemove = ["sidebars.js", "sidebars.ts"];
	for (const file of toRemove) {
		const fullPath = join(targetRoot, file);
		if (existsSync(fullPath)) {
			await safeRemove(fullPath);
		}
	}
}
