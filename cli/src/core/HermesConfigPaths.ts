/**
 * Shared paths and the shell-hook allowlist upsert for Hermes.
 *
 * ## Why this module exists
 *
 * Two callers write to `~/.hermes/` — the MCP + hook registrar
 * (`HostRegistrars.ts`) and the eventual uninstall path. Both share:
 *
 *   - the path to `config.yaml` (respecting `HERMES_HOME`, Hermes' own env
 *     override — a Hermes install can move its entire state root),
 *   - the path to `shell-hooks-allowlist.json` (same override),
 *   - the shape of one allowlist entry.
 *
 * Rather than duplicating them, this module owns the three shared concerns.
 *
 * ## Why we pre-record the shell-hook approval
 *
 * `shell-hooks-allowlist.json` is Hermes' first-use consent file. Every
 * `(event, command)` pair Hermes finds in `config.yaml` that is NOT in the
 * allowlist prompts the user for consent on next launch — and if stdin is not
 * a TTY (a headless gateway launch, an IDE-embedded run), Hermes silently
 * REFUSES to register the hook. So writing the config alone is not enough:
 * even in an interactive run the user gets a "Hermes is about to register a
 * shell hook…" prompt for a hook they never asked for.
 *
 * The install therefore records the approval on the user's behalf — this is
 * scoped to the specific `(event, command)` pair Jolli wrote to config.yaml,
 * so no other tool's hook is pre-approved, and Hermes still asks about every
 * OTHER hook the user might have. The alternative (setting
 * `hooks_auto_accept: true` in config) would blanket-approve every future
 * hook Jolli or anyone else adds — that is a policy call the user must make,
 * not one this install may make for them.
 *
 * ## What we do NOT do
 *
 * We do NOT hold the flock() Hermes' own writer takes. Node has no first-class
 * `flock` and the allowlist is only ever contended during hook prompts (a
 * TTY-only path), so a plain atomic write is enough — the racy case is
 * exclusively agent-vs-agent while the human is answering `y/N`. If we did
 * hold one, the sibling `<file>.lock` file is what to acquire, not the config
 * file itself.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";

const log = createLogger("HermesConfigPaths");

/**
 * The root of the Hermes state directory. `$HERMES_HOME` is Hermes' own
 * documented override (see `hermes_constants.get_hermes_home`), so an install
 * with a moved state root does not silently skip Jolli.
 */
export function hermesHomeDir(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	const override = env.HERMES_HOME?.trim();
	if (override && override.length > 0) return override;
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA?.trim();
		return join(localAppData && localAppData.length > 0 ? localAppData : join(home, "AppData", "Local"), "hermes");
	}
	return join(home, ".hermes");
}

/**
 * Every isolated Hermes home that may be active: the default home first, then
 * each named profile under `<home>/profiles/<name>`.
 *
 * Registration writes every returned home. A profile is a complete Hermes
 * instance with its own config and hook allowlist, so detecting its state.db
 * while writing only the default config produces a convincing but inert setup.
 * Profile directories are included before their first conversation creates a
 * state.db, matching {@link isHermesPresent}'s install-before-first-chat case.
 *
 * An EMPTY or UNREADABLE directory under `profiles/` is not treated as a home.
 * Nothing has initialized an empty directory, while an unreadable directory
 * cannot be verified as Hermes-owned and must never be a write target. A
 * readable profile that has produced any artifact (its config, a state.db, a
 * log) is included.
 */
export async function listHermesHomeDirs(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
	const root = hermesHomeDir(env, home, platform);
	let entries: Dirent[];
	try {
		entries = await readdir(join(root, "profiles"), { withFileTypes: true });
	} catch {
		return [root];
	}
	const profiles: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const profileDir = join(root, "profiles", entry.name);
		if (!(await isPopulatedProfileDir(profileDir))) continue;
		profiles.push(profileDir);
	}
	return [root, ...profiles.sort()];
}

/**
 * Whether any active Hermes home declares Jolli's `on_session_end` shell hook.
 *
 * The hook is the machine-global `config.yaml` counterpart to the per-repo Git
 * hooks. Detection is deliberately looser than the registrar's upsert: we look
 * for the `hermes-stop` command token inside the `hooks:` block, so both the
 * canonical path and a quoted path around a home with spaces are recognised.
 * The command token is specific to Jolli and never appears in the MCP block.
 *
 * Win32 returns false: registration writes the MCP entry but skips the POSIX
 * `run-hook` command, so there is no Hermes hook to report.
 */
export async function isHermesHookInstalled(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
	if (platform === "win32") return false;
	for (const dir of await listHermesHomeDirs(env, home, platform)) {
		try {
			const text = await readFile(join(dir, "config.yaml"), "utf-8");
			if (hasHermesStopHook(text)) return true;
		} catch {
			// Absent or unreadable home config — keep checking other homes.
		}
	}
	return false;
}

/**
 * True when the top-level `hooks:` block contains Jolli's `hermes-stop` command.
 *
 * Uses the same block boundary as {@link findBlock} in the registrar's writer:
 * the block continues while a line is blank or indented, and ends at the next
 * top-level non-comment line.
 */
function hasHermesStopHook(text: string): boolean {
	const lines = text.split("\n");
	const header = lines.findIndex((line) => /^hooks:/.test(line));
	if (header === -1) return false;
	let end = lines.length;
	for (let i = header + 1; i < lines.length; i++) {
		if (lines[i].length === 0 || /^[ \t]/.test(lines[i])) continue;
		end = i;
		break;
	}
	return lines.slice(header, end).some((line) => line.includes("hermes-stop"));
}

/** True only when `dir` is readable and contains at least one entry. */
async function isPopulatedProfileDir(dir: string): Promise<boolean> {
	try {
		return (await readdir(dir)).length > 0;
	} catch (err) {
		log.warn("Skipping unreadable Hermes profile directory %s: %s", dir, String(err));
		return false;
	}
}

/** `<HERMES_HOME>/config.yaml` — the file the MCP + hook registrar writes. */
export function hermesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(hermesHomeDir(env), "config.yaml");
}

/** `<HERMES_HOME>/shell-hooks-allowlist.json` — the first-use consent file. */
export function hermesAllowlistPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(hermesHomeDir(env), "shell-hooks-allowlist.json");
}

/**
 * A single allowlist entry. This shape is Hermes' — do not change it.
 *
 * `approved_at` is ISO-8601 UTC with `Z` (Hermes'`_utc_now_iso` shape,
 * `+00:00` replaced by `Z`), and `script_mtime_at_approval` is the same shape
 * over the resolved script's mtime (null when the script does not exist yet —
 * the dispatcher `run-hook` is written by the same install, so it always
 * exists by the time this record is made).
 */
interface AllowlistEntry {
	event: string;
	command: string;
	approved_at: string;
	script_mtime_at_approval: string | null;
}

interface AllowlistFile {
	approvals: AllowlistEntry[];
}

/**
 * Pre-record an allowlist approval for a single `(event, command)` pair.
 *
 * Idempotent by design: an existing entry is rewritten only when the approved
 * script's mtime changed. `run-hook` is atomically replaced on every runtime
 * upgrade, and Hermes treats an approval for an older mtime as stale. Keeping
 * the old record would make a second `jolli enable` unable to repair the hook.
 *
 * The stamp is passed in, not read from a clock — the CronCreate/wakeup rule
 * against reading `Date.now()` at the top of the install path is a habit that
 * pays off here too: tests can pin a stamp, and a resume replay reproduces the
 * same file.
 */
export async function preAcceptHermesShellHook(
	path: string,
	entry: { event: string; command: string; scriptPath: string; nowIso: string },
): Promise<void> {
	let raw = "";
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Skipping Hermes allowlist upsert: %s unreadable (%s)", path, String(err));
			return;
		}
	}
	let parsed: AllowlistFile;
	try {
		parsed = raw.trim().length === 0 ? { approvals: [] } : (JSON.parse(raw) as AllowlistFile);
	} catch (err) {
		log.warn("Skipping Hermes allowlist upsert: %s not valid JSON (%s)", path, String(err));
		return;
	}
	if (!Array.isArray(parsed.approvals)) parsed.approvals = [];

	const mtime = await scriptMtimeIso(entry.scriptPath);
	const existing = parsed.approvals.find((e) => e.event === entry.event && e.command === entry.command);
	if (existing !== undefined) {
		if (existing.script_mtime_at_approval === mtime) return;
		existing.approved_at = entry.nowIso;
		existing.script_mtime_at_approval = mtime;
	} else {
		parsed.approvals.push({
			event: entry.event,
			command: entry.command,
			approved_at: entry.nowIso,
			script_mtime_at_approval: mtime,
		});
	}
	// Key order matches Hermes' own writer: sort_keys=true (each object's keys
	// sorted alphabetically), indent=2, no trailing newline (json.dumps default).
	// The APPROVALS ARRAY is sorted by (event, command) for Jolli's own
	// byte-stability — Python does not sort array elements, so Hermes' writer
	// keeps insertion order there, but the allowlist is a set to Hermes and order
	// is irrelevant to it. A deterministic order makes a re-scan of the file
	// compare equal no matter which pair was added first.
	const sorted = { approvals: sortApprovals(parsed.approvals) };
	await atomicWriteFile(path, `${JSON.stringify(sorted, hermesJsonKeyOrder, 2)}`, await currentMode(path));
}

/**
 * Remove Jolli's `(event, command)` entry from Hermes' allowlist.
 *
 * Uninstall companion to {@link preAcceptHermesShellHook}. Kept for API
 * symmetry — no reachable path invokes it today, matching the rule for global
 * MCP registrars whose remove() lives against a future full-uninstall entry
 * point but is not currently wired.
 */
export async function revokeHermesShellHook(path: string, entry: { event: string; command: string }): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return;
	}
	let parsed: AllowlistFile;
	try {
		parsed = JSON.parse(raw) as AllowlistFile;
	} catch {
		return;
	}
	if (!Array.isArray(parsed.approvals)) return;
	const before = parsed.approvals.length;
	parsed.approvals = parsed.approvals.filter((e) => !(e.event === entry.event && e.command === entry.command));
	if (parsed.approvals.length === before) return;
	await atomicWriteFile(
		path,
		`${JSON.stringify({ approvals: sortApprovals(parsed.approvals) }, hermesJsonKeyOrder, 2)}`,
		await currentMode(path),
	);
}

/** Stable array order shared by approval and revocation writes. */
function sortApprovals(approvals: AllowlistEntry[]): AllowlistEntry[] {
	return approvals.sort((a, b) =>
		a.event === b.event ? (a.command < b.command ? -1 : a.command > b.command ? 1 : 0) : a.event < b.event ? -1 : 1,
	);
}

/** Preserve permissions across the atomic replace; undefined for a new file. */
async function currentMode(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return undefined;
	}
}

/**
 * Key-order replacer matching Hermes' `json.dumps(sort_keys=True)`.
 *
 * A per-object sort of keys, not a whole-tree recursive sort — Python's
 * sort_keys is depth-1 (each dict's own keys). JSON.stringify with a `null`
 * replacer preserves insertion order, so we hand-write the ordering.
 */
function hermesJsonKeyOrder(_key: string, value: unknown): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
		);
	}
	return value;
}

/**
 * ISO-8601 UTC mtime of `path` in Hermes' `Z`-suffixed shape, or null when
 * the file does not exist.
 *
 * Errors other than ENOENT surface as null too — a file we cannot stat is
 * indistinguishable from a missing one for allowlist purposes.
 */
async function scriptMtimeIso(path: string): Promise<string | null> {
	try {
		const s = await stat(path, { bigint: true });
		return hermesScriptMtimeIsoFromNs(s.mtimeNs);
	} catch {
		return null;
	}
}

/**
 * Format a filesystem nanosecond timestamp exactly as Hermes does:
 * `datetime.fromtimestamp(os.path.getmtime(...), tz=UTC).isoformat()`.
 *
 * `getmtime()` first converts the timestamp to a binary64 epoch-seconds value;
 * CPython then rounds that FLOAT to microseconds using round-half-even. Rounding
 * the original bigint nanoseconds directly can differ by one microsecond at
 * today's epoch, making an unchanged script look newer than its approval.
 * Exported so the two sub-microsecond boundary directions stay regression-tested
 * without relying on a test host's filesystem timestamp-setting precision.
 */
export function hermesScriptMtimeIsoFromNs(mtimeNs: bigint): string {
	const billion = 1_000_000_000n;
	const secondsPart = mtimeNs / billion;
	const nanosPart = mtimeNs % billion;
	const epochSeconds = Number(secondsPart) + Number(nanosPart) / 1_000_000_000;
	let seconds = Math.floor(epochSeconds);
	let micros = roundHalfEven((epochSeconds - seconds) * 1_000_000);
	if (micros === 1_000_000) {
		seconds += 1;
		micros = 0;
	}
	const base = new Date(seconds * 1_000).toISOString().replace(".000Z", "");
	return micros === 0 ? `${base}Z` : `${base}.${micros.toString().padStart(6, "0")}Z`;
}

/** CPython's `_PyTime_ROUND_HALF_EVEN` for a finite non-negative value. */
function roundHalfEven(value: number): number {
	const lower = Math.floor(value);
	const fraction = value - lower;
	if (fraction < 0.5) return lower;
	if (fraction > 0.5) return lower + 1;
	return lower % 2 === 0 ? lower : lower + 1;
}
