/**
 * TTY-based conflict UI for the CLI sync path.
 *
 * When sync runs inside a CLI process (post-commit hook, `jolli sync`
 * invocation) and the conflict pyramid escalates to Tier 3, the user gets
 * an interactive `readline` prompt with four choices. The post-commit
 * code path is usually short-lived and silent, so the prompt is a no-op
 * fallback in non-TTY contexts: anything that isn't a real terminal
 * (CI, IDE-injected hooks, headless test runners) returns `"skip"` so
 * the conflict surfaces on the next sync round when a real user can
 * see it.
 *
 * `viewDiff` shells out to `git diff --no-index --color=auto` against
 * temp files containing the two blobs. We use `--no-index` because the
 * blobs may not exist in any worktree (`:2:` / `:3:` stages live in the
 * index only).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../Logger.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import type { ConflictUi, Tier3Pick } from "./ConflictResolver.js";

const log = createLogger("Sync:CliUi");

export interface CliConflictUiOpts {
	/** Test seam — override the readline factory to drive a scripted answer. */
	readonly promptImpl?: (question: string) => Promise<string>;
	/** Test seam — force TTY detection on/off. Default: `process.stdin.isTTY`. */
	readonly isTty?: boolean;
	/** Test seam — override `execFile` for the diff path. */
	readonly execFileImpl?: typeof execFileAsyncHidden;
}

const PROMPT_TEXT = [
	"  [m] Use mine (local edit)",
	"  [t] Use theirs (remote edit)",
	"  [d] View diff",
	"  [s] Skip (resolve later)",
	"Choice (m/t/d/s): ",
].join("\n");

export class CliConflictUi implements ConflictUi {
	private readonly promptImpl: (question: string) => Promise<string>;
	private readonly isTty: boolean;
	private readonly execFileImpl: typeof execFileAsyncHidden;

	constructor(opts: CliConflictUiOpts = {}) {
		this.promptImpl = opts.promptImpl ?? defaultPrompt;
		this.isTty = opts.isTty ?? Boolean(process.stdin.isTTY);
		this.execFileImpl = opts.execFileImpl ?? execFileAsyncHidden;
	}

	async promptBinaryPick(path: string, _oursOid: string | null, _theirsOid: string | null): Promise<Tier3Pick> {
		if (!this.isTty) {
			log.info("Non-TTY context — auto-skipping conflict on %s for later resolution", path);
			return "skip";
		}
		process.stdout.write(`\nConflict in: ${path}\n${PROMPT_TEXT}`);
		const answer = (await this.promptImpl("")).trim().toLowerCase();
		switch (answer[0]) {
			case "m":
				return "mine";
			case "t":
				return "theirs";
			case "d":
				return "viewDiff";
			case "s":
				return "skip";
			/* v8 ignore start -- defensive: any unrecognized answer falls back to skip */
			default:
				log.info("Unrecognized answer '%s' — skipping %s", answer, path);
				return "skip";
			/* v8 ignore stop */
		}
	}

	async showDiff(path: string, ours: string, theirs: string): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), "jolli-sync-diff-"));
		try {
			const oursPath = join(dir, "ours");
			const theirsPath = join(dir, "theirs");
			await writeFile(oursPath, ours);
			await writeFile(theirsPath, theirs);
			try {
				const result = await this.execFileImpl("git", [
					"diff",
					"--no-index",
					"--color=auto",
					"--",
					oursPath,
					theirsPath,
				]);
				if (result.stdout.length > 0) process.stdout.write(`\n[diff for ${path}]\n${result.stdout}\n`);
			} catch (err: unknown) {
				// `git diff` exits 1 when there ARE differences, which is the normal
				// case — execFileAsync rejects on non-zero exit, so capture stdout
				// from the rejection object instead of treating it as a real failure.
				const stdout = (err as { stdout?: string }).stdout ?? "";
				if (stdout.length > 0) process.stdout.write(`\n[diff for ${path}]\n${stdout}\n`);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
}

/**
 * Default readline prompt. Question text is written to stdout by the
 * caller (so we can format multi-line prompts uniformly); this helper
 * just reads one line from stdin.
 */
/* v8 ignore start -- readline integration; covered by manual TTY testing */
async function defaultPrompt(): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await new Promise<string>((resolve) => rl.once("line", resolve));
	} finally {
		rl.close();
	}
}
/* v8 ignore stop */
