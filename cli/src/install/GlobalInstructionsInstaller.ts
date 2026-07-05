/**
 * Writes Jolli Memory's "prefer these skills by default" standing instruction
 * into each detected AI host's GLOBAL instruction file:
 *
 *   - Claude Code → ~/.claude/CLAUDE.md
 *   - Gemini CLI  → ~/.gemini/GEMINI.md
 *   - Codex       → ~/.codex/AGENTS.md
 *
 * The rule tells the host LLM to reach for the jolli-pr / jolli-search /
 * jolli-recall skills by default for PR creation / search / recall, instead of
 * leaving skill selection to chance.
 *
 * Managed-block strategy mirrors GitExclude.ts: a marker-bracketed section is
 * upserted, everything outside the markers is preserved verbatim, and the whole
 * operation is fail-soft — a broken or read-only global file never breaks
 * `jolli enable`.
 *
 * These files are machine-GLOBAL (one per host, shared by every repo), so
 * `jolli uninstall` deliberately does NOT remove the block — the same policy as
 * global-scope MCP registration.
 *
 * A global `AGENTS.md` is only read by Codex; Cursor / OpenCode / Copilot read
 * AGENTS.md at the project root, so they are intentionally out of reach here.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("GlobalInstructionsInstaller");

/**
 * Marker pair bracketing Jolli's managed block. Lines between the markers
 * belong to Jolli and may be rewritten on future installs; anything outside is
 * untouched. HTML comments so the block is invisible when the markdown renders.
 */
const BLOCK_START = "<!-- >>> jolli memory instructions >>> -->";
const BLOCK_END = "<!-- <<< jolli memory instructions <<< -->";

/**
 * Markdown heading Jolli's block leads with. Also used to detect a pre-existing
 * *unmarked* section a user added by hand (older docs told people to paste this
 * section manually) so we adopt it in place instead of appending a duplicate.
 */
const MANAGED_HEADING = "## Jolli Memory";

/** Which hosts to write the global instruction file for (per-host gated). */
export interface InstructionHosts {
	readonly claude: boolean;
	readonly gemini: boolean;
	readonly codex: boolean;
}

interface InstructionTarget {
	readonly host: keyof InstructionHosts;
	/** Path segments relative to the user's home dir. */
	readonly relPath: ReadonlyArray<string>;
}

const TARGETS: ReadonlyArray<InstructionTarget> = [
	{ host: "claude", relPath: [".claude", "CLAUDE.md"] },
	{ host: "gemini", relPath: [".gemini", "GEMINI.md"] },
	{ host: "codex", relPath: [".codex", "AGENTS.md"] },
];

/**
 * Renders the managed block including marker lines and a trailing newline.
 * Joined with `\n` (not the platform EOL) so the file reads identically for a
 * team sharing dotfiles across OSes.
 */
export function renderInstructionsBlock(): string {
	const lines = [
		BLOCK_START,
		MANAGED_HEADING,
		"",
		"When Jolli Memory is enabled in a repository, prefer its skills by default:",
		"",
		"- **Creating or updating a pull request** → use the `jolli-pr` skill (its",
		"  description comes from Jolli Memory's recorded commit history), unless the",
		"  user explicitly asks for another method.",
		"- **Searching prior work, decisions, or related commits** → use the",
		"  `jolli-search` skill.",
		"- **Recalling or resuming prior context on a branch** → use the `jolli-recall`",
		"  skill.",
		"",
		"If a skill is not available (Jolli Memory is not enabled in that repository),",
		"fall back to normal behavior.",
		BLOCK_END,
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Upserts the managed block into `existing`, preserving all other content
 * verbatim. Resolution order:
 *
 *   1. A marker-bracketed block → replaced in place (line-oriented match, so a
 *      stray marker substring inside prose never confuses the parser; the first
 *      matching pair wins).
 *   2. Otherwise, an *unmarked* `## Jolli Memory` section a user pasted by hand
 *      → adopted: that whole section (heading up to the next `#`/`##` heading or
 *      EOF) is replaced with the marked block, so we never append a duplicate.
 *   3. Otherwise → the block is appended.
 */
export function applyInstructionsBlock(existing: string, block: string): string {
	const lines = existing.split("\n");
	const startIdx = lines.indexOf(BLOCK_START);
	const endIdx = lines.indexOf(BLOCK_END);

	// `renderInstructionsBlock` always appends a trailing `\n`; strip it before
	// splitting so the spliced lines don't carry an empty trailing element.
	const newBlockLines = block.slice(0, -1).split("\n");

	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const next = [...lines.slice(0, startIdx), ...newBlockLines, ...lines.slice(endIdx + 1)];
		return next.join("\n");
	}

	// Adopt an unmarked, hand-pasted section rather than appending a second copy.
	const headingIdx = lines.indexOf(MANAGED_HEADING);
	if (headingIdx !== -1) {
		// Section runs to the next same-or-higher-level heading (`#`/`##`) or EOF.
		// `###`+ subsections stay inside the section (they don't match).
		let sectionEnd = lines.length;
		for (let i = headingIdx + 1; i < lines.length; i++) {
			if (/^#{1,2} /.test(lines[i])) {
				sectionEnd = i;
				break;
			}
		}
		const before = lines.slice(0, headingIdx).join("\n");
		const after = lines.slice(sectionEnd).join("\n");
		// `block` already carries its trailing newline; only add a separator on a
		// side that actually has content.
		return `${before.length > 0 ? `${before}\n` : ""}${block}${after}`;
	}

	if (existing.length === 0) {
		return block;
	}
	const sep = existing.endsWith("\n") ? "" : "\n";
	return `${existing}${sep}${block}`;
}

/**
 * Upserts the managed block into a single absolute file path. Fail-soft: logs
 * and returns on any read/write error rather than throwing.
 */
async function upsertTarget(absPath: string, block: string): Promise<void> {
	let existing = "";
	try {
		existing = await readFile(absPath, "utf-8");
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		/* v8 ignore start -- defensive: non-ENOENT read errors (perm denied, EISDIR) */
		if (code !== "ENOENT") {
			log.warn("Failed to read %s: %s — skipping", absPath, (err as Error).message);
			return;
		}
		/* v8 ignore stop */
	}

	const updated = applyInstructionsBlock(existing, block);
	if (updated === existing) {
		return; // No change needed.
	}

	try {
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, updated, "utf-8");
		log.info("Updated %s with Jolli Memory instructions", absPath);
		/* v8 ignore start -- defensive: write failure on read-only fs / EPERM */
	} catch (err: unknown) {
		log.warn("Failed to write %s: %s", absPath, (err as Error).message);
	}
	/* v8 ignore stop */
}

/**
 * Writes the Jolli Memory instruction block into the global instruction file of
 * every host whose flag is `true`. Called once from `Installer.install()`,
 * outside the per-worktree loop, because these files are machine-global.
 */
export async function installGlobalInstructions(hosts: InstructionHosts): Promise<void> {
	const block = renderInstructionsBlock();
	const home = homedir();
	for (const target of TARGETS) {
		if (!hosts[target.host]) continue;
		await upsertTarget(join(home, ...target.relPath), block);
	}
}
