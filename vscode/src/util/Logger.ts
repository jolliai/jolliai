/**
 * Logger
 *
 * Centralized logging for the JolliMemory extension.
 * Writes to two destinations simultaneously:
 *
 * 1. VSCode OutputChannel ("Jolli Memory") — visible in View → Output → JolliMemory.
 * 2. `.jolli/jollimemory/debug.log` — via the jollimemory core logger, so the
 *    extension's errors and warnings appear in the same file as hook/CLI output.
 *
 * Call `initLogger(workspaceRoot)` once on activation to route file writes to the
 * correct project directory.
 */

import * as vscode from "vscode";
import {
	createLogger as coreCreateLogger,
	setLogDir,
} from "../../../cli/src/Logger.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type CoreLogLevel = "debug" | "info" | "warn" | "error";

const CORE_LEVEL: Record<LogLevel, CoreLogLevel> = {
	DEBUG: "debug",
	INFO: "info",
	WARN: "warn",
	ERROR: "error",
};

let channel: vscode.OutputChannel | undefined;

/** Creates the OutputChannel lazily on first use. */
function getChannel(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel("Jolli Memory");
	}
	return channel;
}

// ─── Per-tag core loggers (lazy) ─────────────────────────────────────────────

type CoreLogger = ReturnType<typeof coreCreateLogger>;
// Tags are a small fixed set ("bridge", "commit", "activate", etc.) — no cleanup needed.
const coreLoggers = new Map<string, CoreLogger>();

function getCoreLogger(tag: string): CoreLogger {
	let logger = coreLoggers.get(tag);
	if (!logger) {
		logger = coreCreateLogger(tag);
		coreLoggers.set(tag, logger);
	}
	return logger;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Formats and writes a log line to the OutputChannel and the core file logger.
 * Note: the two destinations each generate their own timestamp independently,
 * so timestamps may differ by a few milliseconds for the same event.
 */
function write(
	level: LogLevel,
	tag: string,
	message: string,
	extra?: unknown,
): void {
	// ── OutputChannel ──
	const now = new Date();
	const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
	const line =
		extra !== undefined
			? `[${timestamp}] [${level}] [${tag}] ${message} ${JSON.stringify(extra)}`
			: `[${timestamp}] [${level}] [${tag}] ${message}`;
	getChannel().appendLine(line);

	// ── debug.log (via core logger) ──
	const coreMsg =
		extra !== undefined ? `${message} ${JSON.stringify(extra)}` : message;
	getCoreLogger(tag)[CORE_LEVEL[level]](coreMsg);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises the file logger for the current workspace.
 * Must be called once during extension activation so that log writes land in
 * the correct project's `.jolli/jollimemory/debug.log` rather than the
 * extension host's working directory.
 */
export function initLogger(workspaceRoot: string): void {
	setLogDir(workspaceRoot);
}

export const log = {
	debug(tag: string, message: string, extra?: unknown): void {
		write("DEBUG", tag, message, extra);
	},
	info(tag: string, message: string, extra?: unknown): void {
		write("INFO", tag, message, extra);
	},
	warn(tag: string, message: string, extra?: unknown): void {
		write("WARN", tag, message, extra);
	},
	error(tag: string, message: string, extra?: unknown): void {
		write("ERROR", tag, message, extra);
	},
	/** Shows the output channel in the Output panel. */
	show(): void {
		getChannel().show(true);
	},
	/** Disposes the output channel. Call on deactivate. */
	dispose(): void {
		channel?.dispose();
		channel = undefined;
	},
};
