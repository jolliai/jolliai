/**
 * Vault commit message convention.
 *
 * All vault commits use the prefix `[jolli-mb] <op>: <summary>` so the
 * backend mirror can parse them for per-file metadata (model used for an
 * AI merge, user's binary pick, etc.) without a side table. This is the
 * convention pinned in
 * `vscode-plugin-memory-bank-final-plan.md §2.3 D16` and §5.1.
 *
 * Build / parse symmetrically — `parseCommitMessage(buildCommitMessage(m))`
 * must produce a metadata object equal to `m` (modulo defaults). The
 * backend mirror parses the same way, so if you change the format here
 * coordinate the change there.
 *
 * Op variants:
 *
 *   - `add`             — mirror detected new / modified files
 *   - `delete`          — mirror detected files removed
 *   - `merge`           — Tier 2 AI merge (carries optional per-file model)
 *   - `pick`            — Tier 3 user binary pick (mine|theirs)
 *   - `migrate`         — db→git first-bind bootstrap commit (legacy content import)
 *   - `bootstrap`       — `.gitignore` / README maintenance
 *   - `aggregate-merge` — Tier 1.5 deterministic merge of `.jolli/*` aggregate
 *                         files (JOLLI-1316 §3), no AI, no user prompt
 */

export type SyncOp = "add" | "delete" | "merge" | "pick" | "migrate" | "bootstrap" | "aggregate-merge";

const SYNC_OPS: ReadonlySet<SyncOp> = new Set([
	"add",
	"delete",
	"merge",
	"pick",
	"migrate",
	"bootstrap",
	"aggregate-merge",
]);

/** Per-file flag carried inside merge / pick commit subjects. */
export interface PerFileFlags {
	readonly path: string;
	readonly model?: string;
	readonly pick?: "mine" | "theirs";
	readonly mergeSummary?: string;
}

export interface CommitMetadata {
	readonly op: SyncOp;
	readonly summary: string;
	readonly perFileFlags?: PerFileFlags;
}

const PREFIX = "[jolli-mb]";

/**
 * Builds a one-line commit message in the canonical format:
 *
 *   `[jolli-mb] <op>: <summary>`
 *   `[jolli-mb] <op>(<path>): <summary> [model=<name>]`     (merge with single-file detail)
 *   `[jolli-mb] <op>(<path>): mine|theirs`                  (pick)
 *
 * Multi-file `merge` / `delete` / `add` commits collapse into the form
 * without parentheses — callers pass an aggregate `summary` (e.g.
 * `"3 files via AI"`) and write per-file detail into the commit body
 * (not handled here; this builder only emits subjects).
 */
export function buildCommitMessage(meta: CommitMetadata): string {
	const flags = meta.perFileFlags;
	const opSegment = flags?.path ? `${meta.op}(${flags.path})` : meta.op;

	const trailers: string[] = [];
	if (flags?.model) trailers.push(`[model=${flags.model}]`);

	const tail = trailers.length > 0 ? ` ${trailers.join(" ")}` : "";
	return `${PREFIX} ${opSegment}: ${meta.summary}${tail}`;
}

/**
 * Parses a commit message subject back into metadata. Returns `null` when
 * the message does not start with the canonical prefix or the op is
 * unknown — backend mirror uses the same logic to skip non-jolli-mb
 * commits in the vault repo.
 */
export function parseCommitMessage(message: string): CommitMetadata | null {
	/* v8 ignore start -- split always returns [string, ...]; ?? fallback is defensive */
	const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
	/* v8 ignore stop */
	if (!firstLine.startsWith(`${PREFIX} `)) return null;

	const rest = firstLine.slice(PREFIX.length + 1);
	// Match `<op>` or `<op>(<path>)` followed by `: <summary>` optionally
	// trailed by `[model=...]` (and any other future trailers).
	const match = /^([a-z][a-z-]*)(?:\(([^)]+)\))?:\s+(.*?)(?:\s+\[model=([^\]]+)\])?\s*$/.exec(rest);
	if (!match) return null;
	const op = match[1] as string;
	if (!SYNC_OPS.has(op as SyncOp)) return null;

	const opTyped = op as SyncOp;
	const pathField = match[2];
	/* v8 ignore start -- regex guarantees match[3] is captured; ?? fallback is defensive */
	const summary = match[3] ?? "";
	/* v8 ignore stop */
	const model = match[4];

	if (!pathField) {
		return model !== undefined
			? { op: opTyped, summary, perFileFlags: { path: "", model } }
			: { op: opTyped, summary };
	}

	const flags: PerFileFlags = { path: pathField };
	if (model !== undefined) (flags as { model?: string }).model = model;
	if (opTyped === "pick" && (summary === "mine" || summary === "theirs")) {
		(flags as { pick?: "mine" | "theirs" }).pick = summary;
	}
	return { op: opTyped, summary, perFileFlags: flags };
}
