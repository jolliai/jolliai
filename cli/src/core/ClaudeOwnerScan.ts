/**
 * Turns a window of Claude transcript lines into owner edges.
 *
 * `cwd` is read off the RAW line object, never off `parseTranscriptLine`: Claude
 * stamps it on records that are not conversation turns at all (`attachment`,
 * `queue-operation`), and gating on the turn parser throws away most of the
 * directories a session ever visited. This mirrors `ClaudeSessionDiscoverer`'s
 * `scanSlice`, which learned the same lesson against 64 real transcripts.
 *
 * The index a line reports is its index in the WHOLE file, because it becomes a
 * cursor lower bound — the caller passes the file's full `splitTranscriptLines`
 * output plus the line to start at, rather than a pre-sliced window, so the two
 * notions of "line N" cannot drift apart.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import { type ClaudeOwnerEdge, recordClaudeOwners } from "./ClaudeOwnership.js";
import { resolveWorktreeRootOrNull } from "./GitOps.js";
import { loadExtractorCursorLine, saveExtractorCursor } from "./SessionTracker.js";
import { splitTranscriptLines } from "./TranscriptReader.js";

const log = createLogger("ClaudeOwnerScan");

/**
 * A `cwd` → worktree-root resolver. Defaults to {@link resolveWorktreeRootOrNull},
 * which realpaths and forward-slashes and returns null for a directory that is
 * not inside any git worktree — so a scratch dir or `$HOME` a session merely
 * `cd`-ed through is ignored rather than recorded as an owner root nobody will
 * ever look up (which would be pure machine-global-ledger bloat, since a real
 * worktree-root lookup can never match it). `resolveStateRoot` is deliberately
 * NOT used here: it echoes a non-git cwd straight back, so every such line would
 * become a phantom owner.
 */
export type RootResolver = (cwd: string) => string | null;

function defaultResolveRoot(cwd: string): string | null {
	try {
		return resolveWorktreeRootOrNull(cwd);
	} catch {
		return null;
	}
}

/**
 * Tool names that AUTHOR a file, so the worktree they wrote into is one the
 * session owns even when its cwd stayed elsewhere. Read-only tools (`Read`,
 * `Grep`, `Glob`) and `Bash` are deliberately excluded: merely reading — or
 * `cd`-ing through — a directory is not authorship, and treating it as such
 * would flood the ledger with roots the session only browsed. `NotebookEdit`
 * names its target `notebook_path`; the others use `file_path`.
 */
const WRITE_TOOLS: ReadonlyMap<string, string> = new Map([
	["Edit", "file_path"],
	["Write", "file_path"],
	["MultiEdit", "file_path"],
	["NotebookEdit", "notebook_path"],
]);

/**
 * File paths authored by the write-tool calls on one transcript line. Reads the
 * assistant turn's `message.content` blocks; a non-array content (a plain user
 * string) or a line with no write-tool call yields nothing.
 */
function authoredPaths(raw: { message?: unknown }): string[] {
	const content = (raw.message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	const paths: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; name?: unknown; input?: unknown };
		if (b.type !== "tool_use" || typeof b.name !== "string") continue;
		const key = WRITE_TOOLS.get(b.name);
		if (key === undefined) continue;
		const value = (b.input as Record<string, unknown> | undefined)?.[key];
		if (typeof value === "string" && value.length > 0) paths.push(value);
	}
	return paths;
}

export function scanOwnerEdges(
	lines: ReadonlyArray<string>,
	fromLine: number,
	resolveRoot: RootResolver = defaultResolveRoot,
	now: () => string = () => new Date().toISOString(),
): { edges: Map<string, ClaudeOwnerEdge>; lastLine: number } {
	const edges = new Map<string, ClaudeOwnerEdge>();
	// Resolving a root shells out to the filesystem, so cache within the pass:
	// a long session stamps the same handful of directories on thousands of lines.
	const rootCache = new Map<string, string | null>();
	const resolveCached = (dir: string): string | null => {
		let root = rootCache.get(dir);
		if (root === undefined) {
			root = resolveRoot(dir);
			rootCache.set(dir, root);
		}
		return root;
	};
	// First contributor to a root fixes its `firstSeen*`; later ones on higher
	// lines only extend `lastSeen*`. `dir` is the directory that resolved to the
	// root — the session cwd for a cwd edge, the edited file's directory for an
	// authored edge — so `firstSeenCwd`/`lastSeenCwd` stay under `root` either way.
	const recordEdge = (root: string, i: number, at: string, dir: string): void => {
		const prior = edges.get(root);
		edges.set(
			root,
			prior
				? { ...prior, lastSeenAt: at, lastSeenCwd: dir }
				: { firstSeenAt: at, firstSeenLine: i, lastSeenAt: at, firstSeenCwd: dir, lastSeenCwd: dir },
		);
	};

	for (let i = Math.max(0, fromLine); i < lines.length; i++) {
		const text = lines[i].trim();
		if (!text.startsWith("{")) continue;
		let raw: { cwd?: unknown; timestamp?: unknown; message?: unknown };
		try {
			raw = JSON.parse(text) as typeof raw;
		} catch {
			continue;
		}
		const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
		if (cwd.length === 0) continue;

		const at = typeof raw.timestamp === "string" && raw.timestamp.length > 0 ? raw.timestamp : now();

		// (1) The directory the session was IN — its cwd.
		const cwdRoot = resolveCached(cwd);
		if (cwdRoot !== null) recordEdge(cwdRoot, i, at, cwd);

		// (2) The directories the session WROTE INTO on this line. A cross-worktree
		// or cross-repo edit is authorship of that root even though the cwd never
		// left this one — the high-frequency case a cwd-only ledger misses.
		for (const path of authoredPaths(raw)) {
			const dir = dirname(isAbsolute(path) ? path : join(cwd, path));
			const editRoot = resolveCached(dir);
			if (editRoot !== null) recordEdge(editRoot, i, at, dir);
		}
	}

	return { edges, lastLine: lines.length };
}

/**
 * Scan one transcript for owner edges against the `owners` extractor's OWN
 * high-water mark, advancing it only when it moved forward — the same three-step
 * protocol as `scanSkillsWithCursor`, and for the same reason: advancing a
 * monotonic mark without scanning, or on a throw, strands those lines forever.
 *
 * Deliberately independent of the shared `lineNumber` the plan/reference pair
 * ride, so a dist that predates this extractor cannot advance past the lines it
 * needs.
 *
 * Never throws — the Stop hook must survive an unreadable transcript.
 */
export async function scanOwnersWithCursor(
	transcriptPath: string,
	sessionId: string,
	cwd: string,
	globalDir?: string,
	record: (
		input: { sessionId: string; transcriptPath: string; edges: ReadonlyMap<string, ClaudeOwnerEdge> },
		globalDir?: string,
	) => Promise<boolean> = recordClaudeOwners,
): Promise<void> {
	try {
		const fromLine = await loadExtractorCursorLine(transcriptPath, "owners", cwd);
		const lines = splitTranscriptLines(await readFile(transcriptPath, "utf-8"));
		if (lines.length <= fromLine) return;
		const { edges, lastLine } = scanOwnerEdges(lines, fromLine);
		// Advance the owners mark ONLY when the ledger write was durable. A
		// best-effort (unlocked) write may have been clobbered by a concurrent
		// peer, and advancing past these lines would strand the dropped edge
		// forever — the recovery `withClaudeOwnersLock` promises but cannot
		// itself deliver. Leaving the mark put makes the next Stop hook re-scan
		// from here and re-emit idempotently.
		const durable = await record({ sessionId, transcriptPath, edges }, globalDir);
		if (!durable) return;
		/* v8 ignore start -- `lastLine` is unconditionally `lines.length` (see scanOwnerEdges),
		 * and the guard above already proved `lines.length > fromLine`, so this is always true
		 * once reached. Kept as an explicit check anyway to mirror scanSkillsWithCursor's
		 * protocol, whose `toLine` CAN fall short of `fromLine` (its scanner may return 0). */
		if (lastLine > fromLine) await saveExtractorCursor(transcriptPath, "owners", lastLine, cwd);
		/* v8 ignore stop */
	} catch (err) {
		log.warn("Owner discovery failed for %s: %s", basename(transcriptPath), (err as Error).message);
	}
}

/**
 * Locates a Claude session's transcript by id: `<projectsDir>/<slug>/<id>.jsonl`.
 * Claude keys the project directory by the launch cwd's encoded path, so the id
 * alone does not name it — but a session id is globally unique, so the first
 * `<slug>/<id>.jsonl` that exists is the one. Returns null when no directory
 * holds it (rotated away, or a host with no such tree). Never throws.
 */
export async function resolveClaudeTranscriptPath(
	sessionId: string,
	projectsDir: string = join(homedir(), ".claude", "projects"),
): Promise<string | null> {
	let slugs: string[];
	try {
		slugs = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return null; // projectsDir absent — nothing to resolve
	}
	for (const slug of slugs) {
		const candidate = join(projectsDir, slug, `${sessionId}.jsonl`);
		try {
			await access(candidate);
			return candidate;
		} catch {
			// not in this project dir — keep looking
		}
	}
	return null;
}

/**
 * Ensures the ownership ledger reflects a session that EXECUTED a commit in this
 * worktree, for the case the forward Stop hook has not recorded yet: the edit and
 * the commit happened in one turn, so the commit's worker drains before the Stop
 * hook that would have written the edge. Given the executing session id (from the
 * commit's inherited `CLAUDE_CODE_SESSION_ID`), it scans that session's own
 * transcript through the SAME {@link scanOwnersWithCursor} the Stop hook uses —
 * so a file the session authored under this worktree becomes an owner edge here,
 * while a session that only ran `git commit` without authoring under this root
 * records nothing, leaving the downstream `claudeSessionsOwnedBy` lookup to
 * attribute neither.
 *
 * A no-op when the transcript cannot be located. Never throws.
 */
export async function backfillExecutingSessionOwnership(
	sessionId: string,
	cwd: string,
	globalDir?: string,
	resolveTranscript: (id: string) => Promise<string | null> = resolveClaudeTranscriptPath,
): Promise<void> {
	const transcriptPath = await resolveTranscript(sessionId);
	if (transcriptPath === null) return;
	await scanOwnersWithCursor(transcriptPath, sessionId, cwd, globalDir);
}
