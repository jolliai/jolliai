/**
 * Logger Module
 *
 * Unified logging with timestamps and module tags.
 * Writes to both console and .jolli/jollimemory/debug.log file.
 * Uses a sequential write queue to guarantee log ordering in the file.
 */

import { appendFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogLevel } from "./Types.js";

/** The .jolli/jollimemory directory name within a project */
export const JOLLI_DIR = ".jolli";
export const JOLLIMEMORY_DIR = "jollimemory";
export const LOG_FILE = "debug.log";

/** Orphan branch name for storing summaries (matches CommitSummary version 3) */
export const ORPHAN_BRANCH = "jollimemory/summaries/v3";

/** @deprecated Legacy orphan branch (v1 flat records format) — retained only for migration */
export const ORPHAN_BRANCH_V1 = "jollimemory/summaries/v1";

/**
 * Global working directory for log file output.
 * Set once by entry points (CLI, StopHook, PostCommitHook) after resolving cwd.
 * When unset, falls back to process.cwd().
 */
let _logDirCwd: string | undefined;

/**
 * Sets the global working directory used for log file output.
 * Call this once from entry points after resolving the actual project cwd.
 */
export function setLogDir(cwd: string): void {
	_logDirCwd = cwd;
}

/**
 * Resets the global log directory (for testing only).
 */
export function resetLogDir(): void {
	_logDirCwd = undefined;
}

// ─── Log level filtering ─────────────────────────────────────────────────────

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** Global minimum log level for file output (default: "info"). */
let _globalLogLevel: LogLevel = "info";

/** Per-module log level overrides. */
let _moduleOverrides: Record<string, LogLevel> = {};

/**
 * Configures the log level filtering. Call from entry points after loading config.
 * Messages below the threshold are still written to stderr but skipped in the log file.
 */
export function setLogLevel(level: LogLevel, overrides?: Record<string, LogLevel>): void {
	_globalLogLevel = level;
	_moduleOverrides = overrides ?? {};
}

/**
 * When true, info/debug messages are not written to stderr (only to the log file).
 * warn/error always go to stderr regardless of this flag.
 * Default: true — hooks and background scripts should never pollute the user's terminal.
 */
let _silentConsole = true;

export function setSilentConsole(silent: boolean): void {
	_silentConsole = silent;
}

/** Returns true if the given level should be written to the log file for a module. */
function shouldLog(level: LogLevel, module: string): boolean {
	const threshold = _moduleOverrides[module] ?? _globalLogLevel;
	return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[threshold];
}

/** Logger interface with level-specific methods */
export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/**
 * Formats a log message with timestamp and module tag.
 * Uses printf-style formatting for consistency.
 */
export function formatLogMessage(level: LogLevel, module: string, message: string, args: unknown[]): string {
	const timestamp = new Date().toISOString();
	const levelTag = level.toUpperCase().padEnd(5);

	// Simple printf-style formatting: replace %s, %d, %j with args
	let formatted = message;
	let argIndex = 0;
	formatted = formatted.replace(/%[sdj]/g, (match) => {
		if (argIndex >= args.length) return match;
		const arg = args[argIndex++];
		if (match === "%d") return String(Number(arg));
		if (match === "%j") return JSON.stringify(arg);
		return String(arg);
	});

	return `[${timestamp}] ${levelTag} [${module}] ${formatted}`;
}

/**
 * Returns the path to the Jolli Memory state directory.
 * Priority: explicit cwd param > global _logDirCwd > process.cwd()
 */
export function getJolliMemoryDir(cwd?: string): string {
	const base = cwd ?? _logDirCwd ?? process.cwd();
	return join(base, JOLLI_DIR, JOLLIMEMORY_DIR);
}

/**
 * Sequential write queue for the log file.
 * Ensures log lines are written in the exact order they were enqueued,
 * preventing out-of-order entries caused by concurrent async writes.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Enqueues a log line for sequential writing to the debug.log file.
 * Each write waits for the previous one to complete before starting.
 * Silently ignores write failures (logging should never crash the tool).
 * Skips file writes in test environments to avoid creating spurious log files.
 *
 * IMPORTANT: Does NOT create the .jolli/jollimemory directory. If the directory
 * does not exist (plugin not yet enabled), log writes are silently skipped.
 * The directory is created by `ensureJolliMemoryDir()` when enabling the plugin.
 */
/** Maximum log file size in bytes before rotation (500KB). */
const MAX_LOG_SIZE = 512 * 1024;

function enqueueLogWrite(line: string): void {
	if (process.env.VITEST) return;

	writeQueue = writeQueue.then(async () => {
		try {
			const dir = getJolliMemoryDir();
			const logPath = join(dir, LOG_FILE);
			// Only write if the directory already exists — never create it just for logging.
			// This prevents creating .jolli/ in repos where Jolli Memory is not enabled.
			await stat(dir);

			// Rotate: truncate old content when file exceeds size limit
			try {
				const fileStat = await stat(logPath);
				if (fileStat.size > MAX_LOG_SIZE) {
					await writeFile(logPath, `[log rotated at ${new Date().toISOString()}]\n`, "utf-8");
				}
			} catch {
				// File doesn't exist yet — that's fine, appendFile will create it
			}

			await appendFile(logPath, `${line}\n`, "utf-8");
		} catch {
			// Directory doesn't exist or write failed — silently skip
		}
	});
}

/**
 * Creates a logger instance for a specific module.
 *
 * @param module - Module name displayed in log output (e.g., "GitOps", "PostCommitHook")
 * @param cwd - Optional working directory for locating the log file
 * @returns Logger instance with debug/info/warn/error methods
 *
 * @example
 * const log = createLogger("TranscriptReader");
 * log.info("Reading transcript from line %d", cursor.lineNumber);
 * log.error("Failed to parse line %d: %s", lineNum, error.message);
 */
export function createLogger(module: string): Logger {
	function log(level: LogLevel, message: string, args: unknown[]): void {
		const formatted = formatLogMessage(level, module, message, args);

		// Write log output to stderr so stdout stays clean for JSON/command output.
		// When _silentConsole is true (CLI mode), only warn/error go to stderr.
		// info/debug are suppressed from the terminal but still written to the log file.
		const suppressConsole = _silentConsole && (level === "info" || level === "debug");
		if (!suppressConsole) {
			if (level === "warn") {
				console.warn(formatted);
			} else {
				console.error(formatted);
			}
		}

		// Only write to log file if level meets the configured threshold
		if (shouldLog(level, module)) {
			enqueueLogWrite(formatted);
		}
	}

	return {
		debug(message: string, ...args: unknown[]) {
			log("debug", message, args);
		},
		info(message: string, ...args: unknown[]) {
			log("info", message, args);
		},
		warn(message: string, ...args: unknown[]) {
			log("warn", message, args);
		},
		error(message: string, ...args: unknown[]) {
			log("error", message, args);
		},
	};
}
