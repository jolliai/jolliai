/**
 * SessionSources — the registry of agents whose conversations the back-fill can
 * discover.
 *
 * One entry per agent. Adding an agent is adding an entry here; nothing in
 * `DbBackfill` or `DashboardCollector` names a source, so neither has to change.
 * See {@link SessionSourceDefinition} for what an entry promises and for the two
 * rules (lazy import, absence-not-empty) a new one must honour.
 *
 * ## Why every import in this file is lazy, including the narrowing halves
 *
 * The scan halves must be lazy — several discoverers reach for `node:sqlite`, and
 * eager loading emits its ExperimentalWarning in processes that never scan a
 * session. The narrowing halves (`…SessionsForRepo`) live in those same modules,
 * so importing them statically would drag the whole set in anyway and quietly
 * undo it. Keeping both sides lazy leaves this module free of side effects: a
 * process may load the registry to ask what exists without opening anything.
 *
 * The cost is one `await import` per source per repo, which after the first is a
 * cache lookup — set against a scan that reads megabytes.
 *
 * ## Two entries are asymmetric on purpose
 *
 * `claude` and `antigravity` declare `usesAlreadyRecorded`, because their
 * per-session read is the expensive kind: Claude parses each whole transcript to
 * collect the directories a `cd` scattered through it, and Antigravity opens one
 * SQLite per conversation. Everything else reads a few hundred bytes per session
 * or answers the whole store in one query, where the check would cost about what
 * it saves.
 *
 * Neither of them hands its parsed content over to the collector, and that is a
 * deliberate reversal: `claude` used to, which made the collector's read free and
 * the whole run's memory unbounded. See `acceptFacts` for the measurement and for
 * why a carried payload may not come back without a byte cap.
 */

import type { ClaudeDiskSession } from "../ClaudeSessionDiscoverer.js";
import type { CodexDiskSession } from "../CodexSessionDiscoverer.js";
import type { CursorDiskComposer } from "../CursorSessionDiscoverer.js";
import type { DiskSession } from "../DiskSessionScan.js";
import { defineSessionSource, type SessionSourceDefinition } from "./SessionSourceDefinition.js";

/**
 * The shape every one of these scans reports a failure in: `{ kind, message }`, on a
 * channel beside the sessions rather than as a throw.
 */
export interface ScanError {
	readonly kind: string;
	readonly message: string;
}

/**
 * Turns a scan that reported a TOTAL failure on its error channel back into a throw,
 * which is the only way `scanAllStores` can record it as ABSENCE.
 *
 * Most of these discoverers never throw: they answer `{ sessions, error? }` and let the
 * caller decide. Reading `.sessions` alone therefore spells a failed scan as `[]` — the
 * one thing the registry's absence-not-empty rule exists to prevent (see
 * {@link SessionSourceDefinition}'s header). The consequences are both silent: the
 * per-repo `scanForRepo` fallback is skipped for the whole run, because a present-but-
 * empty entry means "the store was read and holds nothing", and the collector's
 * per-source counts report that same nothing as a positive fact about the agent.
 *
 * A PARTIAL result is kept and not thrown, which is why the sessions are consulted and
 * not just the error. Cline scans each editor flavour independently and Copilot Chat
 * each workspace, so one unreadable directory beside several readable ones has
 * genuinely found the sessions it returned — dropping them would lose data the old
 * per-repo path kept, and its callers read `.sessions` and ignored `.error` for exactly
 * that reason.
 *
 * Exported for its own tests: which of the three outcomes it picks is the difference
 * between a source falling back to per-repo scans and a source silently reporting
 * "this agent was not used", and nine definitions depend on getting it right. Reaching
 * it through those definitions would mean mocking nine discoverers to assert one rule.
 */
export function orFail<T>(source: string, sessions: ReadonlyArray<T>, error: ScanError | undefined): ReadonlyArray<T> {
	if (error === undefined || sessions.length > 0) return sessions;
	throw new Error(`${source} scan failed (${error.kind}): ${error.message}`);
}

const claudeSource = defineSessionSource<ClaudeDiskSession>({
	source: "claude",
	usesAlreadyRecorded: true,
	scan: async ({ windowMs, alreadyRecorded }) => {
		const mod = await import("../ClaudeSessionDiscoverer.js");
		return mod.scanClaudeSessionsOnDisk({ windowMs, ...(alreadyRecorded ? { alreadyRecorded } : {}) });
	},
	forRepo: async (scanned, cwd) =>
		(await import("../ClaudeSessionDiscoverer.js")).claudeSessionsForRepo(scanned, cwd),
});

const codexSource = defineSessionSource<CodexDiskSession>({
	source: "codex",
	// The one source the global daemon re-scans on a timer today. Its `updatedAt` is
	// the rollout file's mtime, so it moves when a conversation is appended to —
	// which is the property {@link SessionSourceSpec.daemonRescan} asks for.
	daemonRescan: true,
	scan: async ({ windowMs }) => (await import("../CodexSessionDiscoverer.js")).scanCodexSessionsOnDisk(windowMs),
	forRepo: async (scanned, cwd) => (await import("../CodexSessionDiscoverer.js")).codexSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../CodexSessionDiscoverer.js")).discoverCodexSessions(cwd, windowMs),
});

const cursorSource = defineSessionSource<CursorDiskComposer>({
	source: "cursor",
	// No window at scan time, and passing one here would be wrong rather than
	// merely redundant: anchored composers bypass the window, so a scan that
	// applied it would drop them before the narrowing step could rescue them.
	scan: async () =>
		(await import("../CursorSessionDiscoverer.js"))
			.scanCursorComposersOnDisk()
			.then((r) => orFail("cursor", r.composers, r.error)),
	forRepo: async (scanned, cwd, windowMs) =>
		(await import("../CursorSessionDiscoverer.js")).cursorSessionsForRepo(scanned, cwd, windowMs),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../CursorSessionDiscoverer.js")).scanCursorSessions(cwd, windowMs).then((r) => r.sessions),
});

const kimiSource = defineSessionSource<DiskSession>({
	source: "kimi",
	scan: async ({ windowMs }) => (await import("../KimiSessionDiscoverer.js")).scanKimiSessionsOnDisk(windowMs),
	forRepo: async (scanned, cwd) => (await import("../KimiSessionDiscoverer.js")).kimiSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../KimiSessionDiscoverer.js")).discoverKimiSessions(cwd, windowMs),
});

const openCodeSource = defineSessionSource<DiskSession>({
	source: "opencode",
	scan: async ({ windowMs }) =>
		(await import("../OpenCodeSessionDiscoverer.js"))
			.scanOpenCodeSessionsOnDisk(windowMs)
			.then((r) => orFail("opencode", r.sessions, r.error)),
	forRepo: async (scanned, cwd) =>
		(await import("../OpenCodeSessionDiscoverer.js")).openCodeSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../OpenCodeSessionDiscoverer.js")).scanOpenCodeSessions(cwd, windowMs).then((r) => r.sessions),
});

const copilotSource = defineSessionSource<DiskSession>({
	source: "copilot",
	scan: async ({ windowMs }) =>
		(await import("../CopilotSessionDiscoverer.js"))
			.scanCopilotSessionsOnDisk(windowMs)
			.then((r) => orFail("copilot", r.sessions, r.error)),
	forRepo: async (scanned, cwd) =>
		(await import("../CopilotSessionDiscoverer.js")).copilotSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../CopilotSessionDiscoverer.js")).scanCopilotSessions(cwd, windowMs).then((r) => r.sessions),
});

const copilotChatSource = defineSessionSource<DiskSession>({
	source: "copilot-chat",
	scan: async ({ windowMs }) =>
		(await import("../CopilotChatSessionDiscoverer.js"))
			.scanCopilotChatSessionsOnDisk(windowMs)
			.then((r) => orFail("copilot-chat", r.sessions, r.error)),
	forRepo: async (scanned, cwd) =>
		(await import("../CopilotChatSessionDiscoverer.js")).copilotChatSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../CopilotChatSessionDiscoverer.js"))
			.scanCopilotChatSessions(cwd, windowMs)
			.then((r) => r.sessions),
});

// The four below take the window in a LATER position, behind their own
// directory-override seams — passing `undefined` there keeps each default.
const clineSource = defineSessionSource<DiskSession>({
	source: "cline",
	scan: async ({ windowMs }) =>
		(await import("../ClineSessionDiscoverer.js"))
			.scanClineSessionsOnDisk(undefined, windowMs)
			.then((r) => r.sessions),
	forRepo: async (scanned, cwd) => (await import("../ClineSessionDiscoverer.js")).clineSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../ClineSessionDiscoverer.js"))
			.scanClineSessions(cwd, undefined, windowMs)
			.then((r) => r.sessions),
});

const clineCliSource = defineSessionSource<DiskSession>({
	source: "cline-cli",
	scan: async ({ windowMs }) =>
		(await import("../ClineCliSessionDiscoverer.js"))
			.scanClineCliSessionsOnDisk(undefined, windowMs)
			.then((r) => orFail("cline-cli", r.sessions, r.error)),
	forRepo: async (scanned, cwd) =>
		(await import("../ClineCliSessionDiscoverer.js")).clineCliSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../ClineCliSessionDiscoverer.js"))
			.scanClineCliSessions(cwd, undefined, windowMs)
			.then((r) => r.sessions),
});

const devinSource = defineSessionSource<DiskSession>({
	source: "devin",
	scan: async ({ windowMs }) =>
		(await import("../DevinSessionDiscoverer.js"))
			.scanDevinSessionsOnDisk(windowMs)
			.then((r) => orFail("devin", r.sessions, r.error)),
	forRepo: async (scanned, cwd) => (await import("../DevinSessionDiscoverer.js")).devinSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../DevinSessionDiscoverer.js")).scanDevinSessions(cwd, windowMs).then((r) => r.sessions),
});

const cursorCliSource = defineSessionSource<DiskSession>({
	source: "cursor-cli",
	scan: async ({ windowMs }) =>
		(await import("../CursorCliSessionDiscoverer.js"))
			.scanCursorCliSessionsOnDisk(undefined, undefined, windowMs)
			.then((r) => orFail("cursor-cli", r.sessions, r.error)),
	forRepo: async (scanned, cwd) =>
		(await import("../CursorCliSessionDiscoverer.js")).cursorCliSessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../CursorCliSessionDiscoverer.js"))
			.scanCursorCliSessions(cwd, undefined, undefined, windowMs)
			.then((r) => r.sessions),
});

const antigravitySource = defineSessionSource<DiskSession>({
	source: "antigravity",
	usesAlreadyRecorded: true,
	scan: async ({ windowMs, alreadyRecorded }) => {
		const mod = await import("../AntigravitySessionDiscoverer.js");
		const result = alreadyRecorded
			? await mod.scanAntigravitySessionsOnDisk(undefined, windowMs, { alreadyRecorded })
			: await mod.scanAntigravitySessionsOnDisk(undefined, windowMs);
		return orFail("antigravity", result.sessions, result.error);
	},
	forRepo: async (scanned, cwd) =>
		(await import("../AntigravitySessionDiscoverer.js")).antigravitySessionsForRepo(scanned, cwd),
	scanForRepo: async (cwd, windowMs) =>
		(await import("../AntigravitySessionDiscoverer.js"))
			.scanAntigravitySessions(cwd, undefined, windowMs)
			.then((r) => r.sessions),
});

/**
 * Every agent whose sessions the back-fill can discover.
 *
 * Order is the fan-out order and carries no meaning — the scans run concurrently
 * and the collector dedupes on `(source, sessionId)` afterwards. Kept
 * alphabetical-ish by family so a reader can find an entry, not because anything
 * depends on it.
 */
export const SESSION_SOURCES: ReadonlyArray<SessionSourceDefinition> = [
	claudeSource,
	codexSource,
	cursorSource,
	kimiSource,
	openCodeSource,
	copilotSource,
	copilotChatSource,
	clineSource,
	clineCliSource,
	devinSource,
	cursorCliSource,
	antigravitySource,
];

/**
 * The sources the global daemon may re-scan on a timer.
 *
 * Derived from the registry rather than listed again here, so opting a source in is
 * one field on its definition and this list cannot fall behind it. See
 * {@link SessionSourceSpec.daemonRescan} for the single property a source has to
 * have before it belongs here.
 *
 * Empty is a legitimate answer and the daemon treats it as "nothing to do" — which
 * is what makes turning the feature off a one-line change.
 */
export const DAEMON_RESCAN_SOURCES: ReadonlyArray<SessionSourceDefinition> = SESSION_SOURCES.filter(
	(source) => source.daemonRescan,
);

// A run's scan results are `PreScannedSessions` in `DashboardCollector`, keyed by
// source tag with the same absent-versus-empty rule this file's `orFail` enforces.
// A second type for the same value used to live here and had no callers — the shape
// belongs next to the collector that narrows it, not next to the registry.
