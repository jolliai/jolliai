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

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

	for (let i = Math.max(0, fromLine); i < lines.length; i++) {
		const text = lines[i].trim();
		if (!text.startsWith("{")) continue;
		let raw: { cwd?: unknown; timestamp?: unknown };
		try {
			raw = JSON.parse(text) as typeof raw;
		} catch {
			continue;
		}
		const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
		if (cwd.length === 0) continue;

		let root = rootCache.get(cwd);
		if (root === undefined) {
			root = resolveRoot(cwd);
			rootCache.set(cwd, root);
		}
		if (root === null) continue;

		const at = typeof raw.timestamp === "string" && raw.timestamp.length > 0 ? raw.timestamp : now();
		const prior = edges.get(root);
		edges.set(
			root,
			prior
				? { ...prior, lastSeenAt: at, lastSeenCwd: cwd }
				: { firstSeenAt: at, firstSeenLine: i, lastSeenAt: at, firstSeenCwd: cwd, lastSeenCwd: cwd },
		);
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
