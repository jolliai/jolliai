/**
 * OptionalFlags — per-tool "nice to have" CLI flags that a MISSING one must not
 * turn into a broken install.
 *
 * The isolation flags each backend passes (claude's `--strict-mcp-config` &c.,
 * codex's `--disable plugins`, opencode's `--pure`) are pure optimizations: they
 * strip the user's MCP servers, plugins and skills out of a prompt that is
 * forbidden from calling any tool. Dropping one costs tokens and nothing else.
 * But an agent CLI that does not RECOGNISE a flag does not ignore it — it exits
 * non-zero before running, which turns "your claude is a few versions old" into
 * "every summary on this machine fails", non-retryably.
 *
 * There is no cheap way to ask a CLI whether it knows a flag. Measured on
 * claude 2.1.220: `--version` is pre-scanned before options are validated, so
 * `claude --permission-mode dontAsk --bogus-flag --version` exits 0 — a probe
 * cannot detect the mismatch, and the failure only surfaces on a real run.
 *
 * So detection is after-the-fact, and the authority is deliberately NOT the
 * error text: it is whether re-running WITHOUT the flag succeeds.
 * {@link attributeUnsupportedFlag} reads stderr only to narrow which flag to
 * drop first, and a bad guess is self-correcting because nothing is persisted
 * until a degraded invocation actually completes. That matters because the three
 * CLIs disagree completely on how they report an unknown flag — all measured:
 *
 *   claude   (commander)  exit 1  `error: unknown option '--bogus-flag'`
 *   codex    (clap)       exit 2  `error: unexpected argument '--bogus-flag' found`
 *   codex    (bad feature)exit 1  `Error: Unknown feature flag: bogus_feature_xyz`
 *   opencode (yargs)      exit 1  the whole help text, with NO error line at all
 *
 * opencode is why matching-by-text can only ever be an optimization: it names
 * nothing, and its help is longer than the 2 KB stderr tail the runner keeps, so
 * even the distinctive `Positionals:` header is truncated away before we see it.
 * Its (single) flag is found by dropping everything and seeing if that works.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg } from "../../Logger.js";
import { atomicWriteFile } from "../AtomicWrite.js";
import { getGlobalConfigDir } from "../SessionTracker.js";

const log = createLogger("OptionalFlags");

export const UNSUPPORTED_FLAGS_FILE = "agent-unsupported-flags.json";
export const UNSUPPORTED_FLAGS_VERSION = 1;

/**
 * One droppable flag. `id` is the stable key persisted on disk and matched
 * against stderr; `args` is what it expands to in the argv vector.
 *
 * `id` is normally the flag itself (`"--pure"`), but for a flag that takes a
 * value the id stays the flag alone while `args` carries the pair — codex's
 * `--disable plugins` is one unit to drop, and clap names only `--disable` when
 * it is the unrecognised token.
 */
export interface OptionalFlag {
	readonly id: string;
	readonly args: readonly string[];
	/**
	 * Extra strings in a failure message that also indict this flag. Defaults to
	 * `[id]`, which covers every CLI that names the offending token.
	 *
	 * codex needs more: when `--disable` exists but the feature does not, it says
	 * `Error: Unknown feature flag: plugins` and never writes `--disable` at all,
	 * so matching the id alone misses a failure whose remedy is identical. Use a
	 * distinctive phrase, not a bare value — `"plugins"` on its own would match
	 * any message merely mentioning plugins.
	 */
	readonly matches?: readonly string[];
}

/** Expands the flags that are not currently known-unsupported into argv items. */
export function applyOptionalFlags(
	flags: readonly OptionalFlag[],
	disabled: ReadonlySet<string> | undefined,
): string[] {
	const out: string[] = [];
	for (const flag of flags) {
		if (disabled?.has(flag.id)) continue;
		out.push(...flag.args);
	}
	return out;
}

/**
 * A flag the failure text points at, plus the phrase that pointed at it.
 *
 * `matched` exists for diagnosis, not control flow: a flag can be indicted by
 * its own id OR by an unrelated-looking phrase (codex's
 * `Unknown feature flag: plugins` never writes `--disable`), and knowing WHICH
 * fired is the difference between "your codex is too old for `--disable`" and
 * "your codex has `--disable` but not the `plugins` feature". The caller logs it;
 * nothing branches on it.
 */
export interface FlagAttribution {
	readonly flag: OptionalFlag;
	readonly matched: string;
}

/**
 * Which flag, if any, the failure names — a hint for what to drop FIRST, never
 * a verdict. Scans for each candidate's id as a whole token so that
 * `--disable-slash-commands` appearing in a message cannot be attributed to a
 * hypothetical `--disable` (substring) flag.
 *
 * Returns undefined when the text names none of them, which is both the
 * opencode case (names nothing) and any unrelated failure (ENOENT, a crash).
 * The caller degrades wholesale in that case rather than guessing.
 */
export function attributeUnsupportedFlag(
	message: string,
	candidates: readonly OptionalFlag[],
): FlagAttribution | undefined {
	// Only look at failures that read like argument parsing, so an unrelated
	// error that happens to quote a flag (e.g. a stack trace) does not get one
	// dropped on its say-so. All three phrasings measured; see the file header.
	if (!/unknown option|unexpected argument|unknown feature flag|unrecognized|unrecognised/i.test(message)) {
		return undefined;
	}
	for (const flag of candidates) {
		for (const needle of flag.matches ?? [flag.id]) {
			// Word-boundary on the RIGHT only: a flag id is already anchored on the
			// left by its leading dashes, and the trailing boundary is what stops
			// `--disable` matching inside `--disable-slash-commands`.
			const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`${escaped}(?![\\w-])`).test(message)) return { flag, matched: needle };
		}
	}
	return undefined;
}

/** On-disk shape. Keys are `<toolId>@<version>`; values are unsupported flag ids. */
interface UnsupportedFlagsFile {
	readonly version: number;
	readonly tools: Record<string, string[]>;
}

/**
 * Store key. Versioned on purpose: an upgraded CLI is a different capability
 * set, so upgrading silently re-enables every flag instead of stranding the user
 * on a degraded invocation forever. It also means a wrong entry ages out.
 */
export function flagStoreKey(toolId: string, version: string): string {
	return `${toolId}@${version}`;
}

function storePath(globalDir?: string): string {
	return join(globalDir ?? getGlobalConfigDir(), UNSUPPORTED_FLAGS_FILE);
}

async function readStore(globalDir?: string): Promise<Record<string, string[]>> {
	try {
		const raw = await readFile(storePath(globalDir), "utf8");
		const parsed = JSON.parse(raw) as Partial<UnsupportedFlagsFile>;
		const tools = parsed?.tools;
		// A hand-mangled or partially-written file must not break summary
		// generation: the whole feature is an optimization, so an unreadable store
		// degrades to "nothing known unsupported" and the flags get retried.
		return tools && typeof tools === "object" ? tools : {};
	} catch {
		return {};
	}
}

/** Flag ids already known not to work for this exact tool+version. */
export async function loadUnsupportedFlagIds(
	toolId: string,
	version: string,
	globalDir?: string,
): Promise<Set<string>> {
	const tools = await readStore(globalDir);
	const ids = tools[flagStoreKey(toolId, version)];
	return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
}

/**
 * Persists the ids that a degraded run proved unnecessary. Merges with whatever
 * is already recorded (another repo's worker may have learned a different flag
 * first) and never throws — failing to write costs one extra probe next time,
 * which must not be allowed to fail the summary that just succeeded.
 */
export async function recordUnsupportedFlagIds(
	toolId: string,
	version: string,
	ids: ReadonlySet<string>,
	globalDir?: string,
): Promise<void> {
	if (ids.size === 0) return;
	const key = flagStoreKey(toolId, version);
	try {
		const tools = await readStore(globalDir);
		const merged = new Set([...(tools[key] ?? []), ...ids]);
		const next: UnsupportedFlagsFile = {
			version: UNSUPPORTED_FLAGS_VERSION,
			// Sorted so repeated writes from different orders produce identical
			// bytes, keeping the file diffable and free of pointless churn.
			tools: { ...tools, [key]: [...merged].sort() },
		};
		await atomicWriteFile(storePath(globalDir), `${JSON.stringify(next, null, 2)}\n`);
		log.info("Recorded unsupported flags for %s: %s", key, [...ids].join(", "));
	} catch (err) {
		log.warn("Could not record unsupported flags for %s: %s", key, errMsg(err));
	}
}
