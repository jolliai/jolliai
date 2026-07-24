/**
 * Writes Jolli Memory's "prefer these skills by default" standing instruction
 * into each detected AI host's GLOBAL instruction file:
 *
 *   - Claude Code → ~/.claude/CLAUDE.md
 *   - Gemini  → ~/.gemini/GEMINI.md
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
		"When Jolli Memory is enabled in a repository, its skills hold context the code",
		"alone doesn't — why past choices were made, how a topic was handled before, and",
		"where work left off. Prefer them by default, and lean toward consulting memory",
		"rather than guessing: a hit often changes the answer, and a miss costs little.",
		"",
		"Reach for a skill whenever the request is memory-shaped:",
		"",
		'- **Why / intent** — "why is this like this", "why X and not Y", "what was the',
		'  reasoning", or anything where the code shows *what* but not *why*. →',
		"  `jolli-search` (or `jolli-recall` when it's about the current branch).",
		'- **How it works / design** — "how does X work", "how is X built/designed", "how',
		'  would I implement X", or walking through an existing feature or subsystem in',
		"  this repo. The code shows the mechanism; memory holds why it is shaped that",
		"  way and what was already tried. → `jolli-search` (or `jolli-recall` for the",
		"  current branch). A quick search here is cheap and often surfaces rationale and",
		"  pitfalls the code comments don't — so search even though the ask starts",
		'  with "how".',
		'- **Prior art** — "have we done/hit this before", "how was <topic> handled", "is',
		'  there a pattern for this", "where else do we do X", or a bug that may have been',
		"  seen before. → `jolli-search` (decisions / topics / files across ALL branches).",
		'- **Resume** — "where were we", "pick up where I left off", "what\'s left on this',
		'  branch", or returning to work after a break. → `jolli-recall` (current-branch',
		"  decisions + recap + where work stopped).",
		"- **Before non-trivial edits** — before refactoring, changing, or deleting code",
		"  whose intent isn't obvious from the code itself, search memory first; a past",
		"  decision may constrain the change, and skipping this risks re-breaking what a",
		"  prior fix already addressed.",
		'- **Pull requests** — "open / write / update the PR". → `jolli-pr` (description',
		"  built from the branch's recorded commit history).",
		"",
		"Routing: current-branch history or resume → `jolli-recall`; cross-branch or",
		'"has this come up before" → `jolli-search`; PR authoring → `jolli-pr`. When',
		"unsure whether memory helps, run a quick `jolli-search` first before answering",
		"from your own assumptions.",
		"",
		"Do NOT reach for memory on narrow, current-state facts you can read straight from",
		"the code — one function's behavior, a type or signature, running a command, a",
		"rename, formatting, or a literal text lookup — answer those from the code directly.",
		"That exclusion is for single-symbol lookups only; do not let it swallow a",
		'whole-feature "how does it work / how is it designed" question — that is',
		"design-shaped, so search memory first (per the How it works / design rule above).",
		"",
		"Treat any concrete fact memory states as of-its-time: use it for why / intent /",
		"prior context, but verify names, paths, and code shape against the current code",
		"before relying on them. If a skill isn't available (Jolli Memory not enabled",
		"here), fall back to normal behavior.",
		BLOCK_END,
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Benefit-led description of what enabling the skill-preference block does.
 * Rendered as the VS Code Settings "Global Instructions" toggle helptext — the
 * single surface that now turns the block on. Kept as an exported constant so the
 * wording lives in one place next to the block it describes.
 */
// Keep this path list in sync with the `installGlobalInstructions({ claude, gemini, codex })`
// targets below (TARGETS) — adding a fourth host must update both.
export const GLOBAL_INSTRUCTIONS_PROMPT =
	"Let your AI assistants use Jolli's memory automatically? This adds a small " +
	"skill-preference block to your global instruction files (~/.claude/CLAUDE.md, " +
	"~/.gemini/GEMINI.md, ~/.codex/AGENTS.md) so your AI reaches for Jolli when you " +
	"create PRs, search past decisions, or recall a branch's history — no need to ask each time.";

/** Persisted tri-state: `undefined` = undecided (default), else the user's choice. */
export type GlobalInstructionsChoice = "enabled" | "disabled" | undefined;

/**
 * Outcome of consulting the persisted switch:
 *  - `write`   — write the block now.
 *  - `remove`  — actively remove any previously-written block (opt-out).
 */
export interface GlobalInstructionsDecision {
	readonly write: boolean;
	/** When true, actively remove any previously-written block (opt-out). */
	readonly remove?: boolean;
}

/**
 * Resolves what to do with the global-instructions block purely from the persisted
 * switch value. The block is never written on enable — the user opts in explicitly
 * (VS Code Settings toggle / `jolli configure --set globalInstructions=enabled`),
 * so this only ever applies a decision the user already made:
 *  - `enabled`   → write.
 *  - `disabled`  → remove any existing block (heals a stale block from a prior
 *                  `enabled` run the user has since turned off).
 *  - undecided   → skip. Undecided never removes — the block was never written on
 *                  the user's behalf.
 */
export function resolveGlobalInstructionsDecision(current: GlobalInstructionsChoice): GlobalInstructionsDecision {
	if (current === "enabled") return { write: true };
	if (current === "disabled") return { write: false, remove: true };
	return { write: false };
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

/**
 * Removes Jolli's marker-bracketed block from `existing`, preserving all other
 * content verbatim. The inverse of the marker branch of `applyInstructionsBlock`:
 * a line-oriented match on the first `BLOCK_START`/`BLOCK_END` pair. Returns the
 * input unchanged when no block is present (idempotent no-op).
 */
export function removeInstructionsBlock(existing: string): string {
	const lines = existing.split("\n");
	const startIdx = lines.indexOf(BLOCK_START);
	const endIdx = lines.indexOf(BLOCK_END);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		return existing;
	}
	// Also drop a single blank separator line the block was appended after, so a
	// removed trailing block doesn't leave a dangling empty line at EOF.
	const spliceStart = startIdx > 0 && lines[startIdx - 1] === "" ? startIdx - 1 : startIdx;
	return [...lines.slice(0, spliceStart), ...lines.slice(endIdx + 1)].join("\n");
}

/**
 * Strips the managed block from a single absolute file path. Fail-soft: a missing
 * file (ENOENT) is a no-op; other read/write errors are logged and swallowed.
 */
async function removeTarget(absPath: string): Promise<void> {
	let existing: string;
	try {
		existing = await readFile(absPath, "utf-8");
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		/* v8 ignore start -- defensive: non-ENOENT read errors (perm denied, EISDIR) */
		if (code !== "ENOENT") {
			log.warn("Failed to read %s: %s — skipping", absPath, (err as Error).message);
		}
		/* v8 ignore stop */
		return;
	}

	const updated = removeInstructionsBlock(existing);
	if (updated === existing) {
		return; // No block present.
	}

	try {
		await writeFile(absPath, updated, "utf-8");
		log.info("Removed Jolli Memory instructions from %s", absPath);
		/* v8 ignore start -- defensive: write failure on read-only fs / EPERM */
	} catch (err: unknown) {
		log.warn("Failed to write %s: %s", absPath, (err as Error).message);
	}
	/* v8 ignore stop */
}

/**
 * Removes the Jolli Memory instruction block from every host's global instruction
 * file. Unlike `installGlobalInstructions`, removal is NOT host-gated: a user who
 * opts out must have the block erased everywhere it might have been written, even
 * from a host they have since disabled. Never creates a file that doesn't exist.
 */
export async function removeGlobalInstructions(): Promise<void> {
	const home = homedir();
	for (const target of TARGETS) {
		await removeTarget(join(home, ...target.relPath));
	}
}
