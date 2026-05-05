/**
 * SQLite Helpers
 *
 * Shared SQLite utilities for SQLite-based agents (OpenCode, Cursor, Copilot).
 * Extracted out of the per-agent discoverers so agents don't depend on a file
 * named for a different agent.
 */

/**
 * Database handle shape passed to `withSqliteDb` callbacks.
 *
 * Structurally typed against node:sqlite's DatabaseSync rather than importing
 * the type directly, so the module is not loaded until the helper runs — this
 * keeps the ExperimentalWarning out of every PostCommitHook invocation that
 * only transitively imports this file.
 */
export interface SqliteDbHandle {
	prepare(sql: string): {
		all(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown[];
		get(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown;
		run(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown;
	};
	close(): void;
}

/**
 * Opens a SQLite database read-only, runs a callback, then closes it.
 *
 * Uses Node's built-in `node:sqlite` (statically-linked SQLite; full WAL support).
 * The module is imported dynamically so the ExperimentalWarning only appears
 * when this helper is actually invoked — not when PostCommitHook merely
 * transitively imports this file.
 */
export async function withSqliteDb<T>(dbPath: string, fn: (db: SqliteDbHandle) => T): Promise<T> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return fn(db as unknown as SqliteDbHandle);
	} finally {
		db.close();
	}
}

/**
 * Minimum Node version that ships `node:sqlite`. SQLite-based agent support
 * requires this built-in module; older runtimes cannot load it even if the DB
 * file is present.
 *
 * Exported for unit tests; callers should use the agent-specific `isInstalled`
 * helper.
 */
export const NODE_SQLITE_MIN_VERSION = { major: 22, minor: 5 } as const;

/**
 * Returns true when the current runtime can load `node:sqlite`. Compares the
 * major.minor of `process.versions.node` against NODE_SQLITE_MIN_VERSION
 * rather than doing a live probe, which would emit the ExperimentalWarning on
 * matching runtimes and defeat the lazy-import pattern used by `withSqliteDb`.
 */
export function hasNodeSqliteSupport(nodeVersion: string = process.versions.node): boolean {
	const match = /^(\d+)\.(\d+)/.exec(nodeVersion);
	/* v8 ignore start -- process.versions.node is always well-formed semver in supported runtimes; guard is purely defensive */
	if (!match) return false;
	/* v8 ignore stop */
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major > NODE_SQLITE_MIN_VERSION.major) return true;
	if (major < NODE_SQLITE_MIN_VERSION.major) return false;
	return minor >= NODE_SQLITE_MIN_VERSION.minor;
}

/**
 * Classifies a real SQLite scan failure into a user-facing severity. Only
 * *genuine* failures are represented here — ENOENT is excluded because a
 * DB that's absent between the install-check and the read is indistinguishable
 * from "not installed" and should stay silent.
 *
 * - `corrupt` — SQLite reports SQLITE_CORRUPT / SQLITE_NOTADB. The file exists
 *   but is unreadable. Users should know.
 * - `locked` — another process holds an exclusive lock (SQLITE_BUSY). Transient,
 *   but worth surfacing if it persists.
 * - `permission` — EACCES / EPERM / SQLITE_CANTOPEN opening the DB. Users
 *   should know.
 * - `schema` — the expected table or column is missing. Likely agent version
 *   drift; users should know so we can support the new schema.
 * - `unknown` — anything else. Surface as a generic scan-failed warning.
 */
export type SqliteScanErrorKind = "corrupt" | "locked" | "permission" | "schema" | "unknown";

export interface SqliteScanError {
	readonly kind: SqliteScanErrorKind;
	readonly message: string;
}

/**
 * Returns null if the error is ENOENT (treat as "not installed" — silent).
 * Exported for unit testing; callers should use the agent-specific scan helper.
 */
export function classifyScanError(error: unknown): SqliteScanError | null {
	const err = error as (Error & { code?: string }) | undefined;
	const message = err?.message ?? String(error);
	const code = err?.code;
	if (code === "ENOENT") return null;
	if (code === "EACCES" || code === "EPERM") return { kind: "permission", message };
	// node:sqlite surfaces low-level SQLite error codes in the message
	// (e.g. "SQLITE_CORRUPT: database disk image is malformed").
	if (/SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database/i.test(message)) {
		return { kind: "corrupt", message };
	}
	if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) {
		return { kind: "locked", message };
	}
	if (/no such table|no such column/i.test(message)) {
		return { kind: "schema", message };
	}
	if (/SQLITE_CANTOPEN|unable to open/i.test(message)) {
		return { kind: "permission", message };
	}
	return { kind: "unknown", message };
}
