/**
 * SessionSourceDefinition — one agent's machine-global session store, described
 * as data rather than as four hand-kept lists.
 *
 * ## What this replaces, and why the lists were dangerous
 *
 * Discovering "which conversations exist on this disk" used to be spelled out in
 * FOUR places, each enumerating the same set of agents:
 *
 *   - the `PreScannedSessions` interface (one optional field per agent),
 *   - `scanAllStores` (one `tryScan` per agent),
 *   - `preScannedForRepo` (one `if (pre.x)` per agent),
 *   - `loadAllSessions` (one lazy loader per agent).
 *
 * Adding an agent meant editing all four, and the compiler could not enforce it
 * because every list keys off a different thing. Worse, the two failure modes
 * differ: miss the scan list and the agent is simply never read; miss the narrow
 * list and its sessions ARE read but can never be attributed to a repo, so they
 * vanish with no error anywhere. A definition here is the single edit, and a
 * source that is registered is registered for every phase at once.
 *
 * ## Why each definition closes over its own types
 *
 * The scanners genuinely do not agree, and normalising them would mean rewriting
 * twelve modules to fit a shape none of them chose:
 *
 *   - **Arguments.** Some take the window alone, some take `(root, window)`,
 *     Cursor's composer scan takes nothing, and two accept the already-recorded
 *     predicate because their per-session read is expensive enough to be worth
 *     skipping (Claude parses whole transcripts, Antigravity opens a SQLite each).
 *   - **Results.** Most yield `DiskSession`, Claude yields a richer record that
 *     also carries whatever its whole-file read produced, and Cursor yields
 *     composers rather than sessions.
 *   - **Narrowing.** Most are synchronous filters over carried directories; two
 *     are async because the question is genuinely per-repo — Antigravity has to
 *     enumerate the repo's worktrees, Cursor has to resolve its workspace hash.
 *
 * {@link defineSessionSource} keeps all of that type-checked AT THE DEFINITION,
 * then erases the payload type so the registry can hold twelve unrelated shapes
 * in one array. The erasure is why `scan` and `forRepo` may only ever be called
 * as a PAIR, through the same definition — see {@link SessionSourceDefinition}.
 *
 * ## Two rules a new definition must honour
 *
 * **Import the discoverer lazily, inside `scan`.** Several reach for
 * `node:sqlite`, and a static import would emit its ExperimentalWarning in every
 * process that merely loads this registry — including ones that never scan a
 * session. Every existing definition does this; a static import here is a
 * review blocker, not a style preference.
 *
 * **A failed scan is ABSENCE, never an empty array.** They are different claims:
 * absence means "this store could not be read", an empty array means "this store
 * holds no sessions in the window". The collector's per-source reporting reads
 * the second as a positive fact about the agent, so degrading one into the other
 * turns an I/O failure into a confident, wrong statement about the user's usage.
 */

import type { SessionInfo, TranscriptSource } from "../../Types.js";
import type { AlreadyCurrent } from "../DiskSessionScan.js";

/** What every machine-wide scan is given. */
export interface SessionScanOptions {
	/** How far back to look. The back-fill's 7-day horizon, not the live 48 h one. */
	readonly windowMs: number;
	/**
	 * Lets an expensive scanner skip a session the database already holds at or
	 * past its last turn. Forwarded to the two definitions that declare
	 * {@link SessionSourceSpec.usesAlreadyRecorded}; ignored by the rest, whose
	 * per-session cost is smaller than the check would save.
	 */
	readonly alreadyRecorded?: AlreadyCurrent;
}

/** A source definition with its payload type still visible. See {@link defineSessionSource}. */
export interface SessionSourceSpec<T> {
	/** The `TranscriptSource` tag every downstream row is stamped with. */
	readonly source: TranscriptSource;
	/**
	 * True when {@link SessionScanOptions.alreadyRecorded} actually reaches the
	 * scanner. Declared rather than inferred so the registry can report which
	 * sources participate in scan-level skipping — a fact worth reading off the
	 * table, since it is the difference between a converged re-run costing a tail
	 * read per file and costing a full parse of every one.
	 */
	readonly usesAlreadyRecorded?: boolean;
	/**
	 * True when the global daemon may re-scan this source on a timer, without a
	 * `jolli dashboard` run behind it.
	 *
	 * The bar is ONE property, and it is about the source's `updatedAt`, not about
	 * scan cost: the instant this source reports must move forward when a
	 * conversation is appended to. That is what a periodic re-scan compares against
	 * the database, so a source whose `updatedAt` is a CREATION time answers
	 * "unchanged" forever and a timer over it burns I/O to discover nothing — which
	 * is exactly what Codex did before its scan moved to file mtime.
	 *
	 * So this is opt-in per source and deliberately conservative. Today only `codex`
	 * declares it. Adding a source means checking that one property against a real
	 * capture of its store, not assuming it: Claude's mtime, for instance, moves for
	 * `ai-title` writes that are not conversation at all, which is sound for a
	 * re-scan trigger but is the reason its `updatedAt` is read from the transcript
	 * instead — see `ClaudeSessionDiscoverer`.
	 */
	readonly daemonRescan?: boolean;
	/** Read this agent's machine-global store. MUST import its discoverer lazily. */
	readonly scan: (opts: SessionScanOptions) => Promise<ReadonlyArray<T>>;
	/**
	 * Narrow one scan's result to the sessions belonging to `cwd`.
	 *
	 * Async is allowed because two sources genuinely need I/O here — see the
	 * header. A synchronous filter may simply return its array.
	 */
	readonly forRepo: (
		scanned: ReadonlyArray<T>,
		cwd: string,
		windowMs?: number,
	) => ReadonlyArray<SessionInfo> | Promise<ReadonlyArray<SessionInfo>>;
	/**
	 * True when {@link forRepo} resolves the repo's OWN worktree set from the
	 * directory it is handed, so one call already answers for every checkout.
	 *
	 * Declared because the collector asks each root separately (a conversation is
	 * keyed by the directory it ran in, and every other source matches against the
	 * one `cwd` it is given). For a source that spans worktrees by itself, that
	 * loop is not a wider search — it is the SAME search run N times, and the
	 * dedupe throws all but one result away. Antigravity is the entry that
	 * declares it, and its narrowing reads a title per claimed session, so the
	 * discarded passes are the expensive kind: N × one streamed transcript read
	 * per session, on a repo with six worktrees.
	 *
	 * A source that declares this is asked once per REGISTERED CHECKOUT; the rest
	 * are asked per root. Per checkout rather than once overall, because what such
	 * a source resolves is the worktree set of the repository it is HANDED — one
	 * call covers one clone's linked checkouts and reaches no other clone's `.git`,
	 * while a repo identity is a remote and can have several clones. Both routes
	 * into the source obey it: the narrowing of a supplied scan AND the per-repo
	 * `scanForRepo` fallback, which is the more expensive of the two.
	 *
	 * Getting it wrong in the other direction LOSES sessions rather than costing
	 * time, so it stays opt-in and false by default.
	 */
	readonly forRepoSpansWorktrees?: boolean;
	/**
	 * The per-repo fallback: discover this source's sessions for ONE repo,
	 * without a machine-wide scan behind it.
	 *
	 * This is a DIFFERENT function from {@link scan}, not a wrapper over it —
	 * every discoverer ships both, and the per-repo one re-reads the store each
	 * time it is called. It runs only when {@link scan} produced nothing for this
	 * source (it failed, or the caller supplied no pre-scan), which is what keeps
	 * a failed machine-wide read from costing the source its sessions entirely.
	 *
	 * Optional, and Claude is the one entry without it: its per-repo route is the
	 * hook registry (`sessions.json`), which is not this source's own store and is
	 * loaded unconditionally by the collector for Gemini's sake anyway.
	 */
	readonly scanForRepo?: (cwd: string, windowMs?: number) => Promise<ReadonlyArray<SessionInfo>>;
}

/**
 * A registered source, payload type erased.
 *
 * `scan` returns `unknown` and `forRepo` accepts `unknown` by construction, so
 * the two are only sound when called through the SAME definition — the registry
 * never holds a scan result apart from the definition that produced it, and
 * {@link defineSessionSource} is what guarantees the pair type-checked together.
 */
export interface SessionSourceDefinition {
	readonly source: TranscriptSource;
	readonly usesAlreadyRecorded: boolean;
	/** See {@link SessionSourceSpec.daemonRescan}. */
	readonly daemonRescan: boolean;
	readonly scan: (opts: SessionScanOptions) => Promise<unknown>;
	readonly forRepo: (
		scanned: unknown,
		cwd: string,
		windowMs?: number,
	) => ReadonlyArray<SessionInfo> | Promise<ReadonlyArray<SessionInfo>>;
	readonly forRepoSpansWorktrees: boolean;
	readonly scanForRepo?: (cwd: string, windowMs?: number) => Promise<ReadonlyArray<SessionInfo>>;
}

/**
 * Registers one source, checking `scan` and `forRepo` against each other and
 * then erasing the payload type.
 *
 * The cast below is the erasure and is safe for one reason: nothing outside this
 * function ever produces a value for `forRepo` except the matching `scan`, and
 * callers are structurally unable to cross the two (a scan result is passed
 * straight back to the definition it came from). That is the same trade the
 * context-kind registry makes — a narrow, contained cast bought with a type-safe
 * definition site.
 */
export function defineSessionSource<T>(spec: SessionSourceSpec<T>): SessionSourceDefinition {
	return {
		source: spec.source,
		usesAlreadyRecorded: spec.usesAlreadyRecorded ?? false,
		daemonRescan: spec.daemonRescan ?? false,
		scan: spec.scan,
		forRepo: (scanned, cwd, windowMs) => spec.forRepo(scanned as ReadonlyArray<T>, cwd, windowMs),
		forRepoSpansWorktrees: spec.forRepoSpansWorktrees ?? false,
		...(spec.scanForRepo ? { scanForRepo: spec.scanForRepo } : {}),
	};
}
