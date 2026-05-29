/**
 * FrameworkDetector (pure half).
 *
 * Detection rules and types shared between the CLI's filesystem scanner
 * and the web tool's equivalent (which enumerates files from an
 * upload / repo browser). Both consumers iterate `FRAMEWORK_RULES`
 * and report a `DetectedFramework` when one matches.
 *
 * The I/O half — actually probing the filesystem and prompting the user
 * for migration — lives in `cli/src/site/FrameworkDetector.ts`.
 */

/** Documentation framework signatures recognized by Jolli. */
export interface DetectedFramework {
	name: "docusaurus" | "mintlify" | "vitepress" | "mkdocs" | "gitbook";
	configPath: string;
	sidebarPath?: string;
}

/**
 * A single framework's signature. Both the root source directory and its
 * parent are searched (Docusaurus configs sit one level above the docs
 * folder for many projects). `sidebarFiles` only matters when the sidebar
 * lives in a separate file from the main config (e.g. Docusaurus's
 * `sidebars.js`).
 */
export interface FrameworkRule {
	name: DetectedFramework["name"];
	/** Files to check in the source root. */
	files: string[];
	/** Files to check in the parent directory. */
	parentFiles?: string[];
	/** Sidebar config files (relative to source root) if separate from main config. */
	sidebarFiles?: string[];
	/** Sidebar config files in parent directory. */
	parentSidebarFiles?: string[];
}

/**
 * The detection table. CLI's `detectFramework` iterates this list calling
 * `existsSync` on each candidate path; a web-tool consumer can iterate it
 * against a pre-collected file list. v1 covers Docusaurus conversion only;
 * the others are detected and reported so users get a clear migration
 * status.
 */
export const FRAMEWORK_RULES: ReadonlyArray<FrameworkRule> = [
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
