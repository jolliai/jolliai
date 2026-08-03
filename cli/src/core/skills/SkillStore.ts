/**
 * SkillStore — per-skill working-area markdown, mirroring ReferenceStore.
 *
 * Each captured skill is persisted as one markdown file at
 * `<jolliMemoryDir>/skills/<source>/<stem>.md`, where `<source>` is the
 * {@link SkillSource} and `<stem>` comes from {@link sanitizeSkillIdForPath}.
 *
 * The file is NOT a convenience cache — it is load-bearing in three ways, all
 * inherited from how plans / notes / references already work:
 *
 *   1. `SkillEntry.contentHashAtCommit` hashes THIS file. With no file there is
 *      nothing to hash and the archive guard would be inert.
 *   2. Archival is a COPY of this file onto the orphan branch, not a re-render
 *      from the registry row. Rendering at archive time would put the display
 *      format in a second place.
 *   3. The file exists from the moment of capture, so working state is
 *      inspectable on disk without an IDE.
 *
 * Frontmatter format: YAML-style keys with JSON-encoded values, matching
 * ReferenceStore so the two files read the same way. The body is the invocation
 * detail list, newest-first.
 *
 * **Accumulating by nature.** Unlike an entity-shaped reference, a skill file is
 * always a read-modify-write: each scan pass discovers only the invocations in
 * the lines it read, and folds them into whatever is already on disk. That makes
 * `withPlansLock` mandatory for callers — see {@link writeSkillMarkdown}.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../../Logger.js";
import type { SkillEntryPath, SkillInvocation, SkillSource, SkillUsage, SkillUse } from "../../Types.js";

const log = createLogger("SkillStore");

/**
 * Invocation detail rows kept in the markdown body, newest-first.
 *
 * `SkillEntry.invocationCount` stays exact past this cap — only the per-entry
 * detail is trimmed. A plan-driven loop re-entering one skill per step (e.g.
 * `/j:specs-plan-build`) can legitimately exceed it, which is precisely why the
 * total is carried separately rather than derived from the list length.
 */
export const SKILL_INVOCATION_CAP = 20;

/** Absolute directory `<jolliMemoryDir>/skills/<source>`. */
export function skillDir(cwd: string, source: SkillSource): string {
	return join(getJolliMemoryDir(cwd), "skills", source);
}

/** Absolute path to the per-skill markdown file. `stem` is post-sanitize. */
export function skillPath(cwd: string, source: SkillSource, stem: string): string {
	return join(skillDir(cwd, source), `${stem}.md`);
}

/**
 * Returns the filesystem stem for a skill id.
 *
 * Skill ids are host-namespaced and routinely contain a colon —
 * `superpowers:brainstorming`, `j:specs-pr-review`, `code-review:code-review` —
 * while others carry no namespace at all (`jolli-init`). A colon is illegal in a
 * Windows filename and is displayed as a path separator by macOS Finder, so it
 * cannot survive into the stem.
 *
 * Two properties are load-bearing and are pinned by tests in SkillStore.test.ts:
 *
 *   - **Path-safe.** No `:`, no `/`, no `\`, no `..` may appear in the result,
 *     for any input. This function is the only boundary between a host-supplied
 *     id and a filesystem path, and ids arrive from transcripts written by other
 *     programs — untrusted input, even though no real id looks hostile today.
 *   - **Injective.** Two different skill ids must never map to the same stem.
 *     A collision is silent data loss: both skills write the same file and each
 *     overwrites the other's invocation history, while the registry rows (keyed
 *     `<source>:<skill>`, unaffected) keep claiming both exist.
 *
 * Chosen encoding: substitute every byte outside `[\w-]` with `-`, strip leading
 * and trailing `-`, cap the readable part, then append 8 hex of sha256 over the
 * ORIGINAL id — the strict route `sanitizeNativeIdForPath` already takes for
 * GitHub, whose nativeIds are likewise collision-prone.
 *
 * Three notes on why it is shaped this way:
 *
 *   - **The hash is unconditional, not a fallback.** A pure substitution
 *     (`:` → `-` or `:` → `--`) reads better but is not injective: it collapses
 *     `superpowers:brainstorming` onto a skill literally named
 *     `superpowers-brainstorming`, and `a:b:c` onto `a:b-c`. Since the suffix is
 *     derived from the original id, the readable prefix may collide freely
 *     without ever putting two skills in one file.
 *   - **`.` is substituted too**, unlike the GitHub rule which keeps it. Keeping
 *     `.` would let `..` survive into the stem. A stem of `..-..-etc-passwd` is
 *     in fact harmless (it is one path segment, not a traversal), but "the stem
 *     never contains `..`" is a property that can be checked at a glance, while
 *     "contains `..` but cannot traverse" needs an argument about every future
 *     caller. Skill ids essentially never contain `.`, so the cost is nil.
 *   - **The readable part is capped.** Path components are limited to 255 bytes
 *     on every filesystem we target. Truncation cannot cause a collision because
 *     the suffix is computed before it.
 */
export function sanitizeSkillIdForPath(skill: string): string {
	const readable = skill
		.replace(/[^\w-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_READABLE_STEM_CHARS);
	const suffix = sha256(skill).slice(0, 8);
	// An id made entirely of substituted bytes (e.g. "..") leaves nothing readable;
	// the hash alone is still a valid, unique, path-safe stem.
	return readable === "" ? suffix : `${readable}-${suffix}`;
}

/** Readable-prefix budget, well inside the 255-byte path-component limit once the suffix and `.md` are added. */
const MAX_READABLE_STEM_CHARS = 80;

export interface WriteSkillResult {
	readonly sourcePath: string;
	readonly contentHash: string;
	/** Exact running total after folding, for the caller to persist on the registry row. */
	readonly invocationCount: number;
	/** Union of entry paths across the folded history. */
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	/** Oldest invocation timestamp across the folded history. */
	readonly firstUsedAt: string;
	/** Newest invocation timestamp across the folded history. */
	readonly lastUsedAt: string;
	/** Invocation detail actually written (capped, newest-first). */
	readonly invocations: ReadonlyArray<SkillInvocation>;
	/**
	 * Post-fold total. The caller MUST persist this rather than the `usage` it passed
	 * in: the incoming value covers one session, while this is the sum across every
	 * session that has used the skill.
	 */
	readonly usage?: SkillUsage;
	/** Post-fold per-session split — the authoritative record behind {@link usage}. */
	readonly usageBySession?: Readonly<Record<string, SkillUsage>>;
	/** Post-fold detection quality — sticky once heuristic. */
	readonly detection?: "heuristic";
}

/**
 * Write or overwrite `<jolliMemoryDir>/skills/<source>/<stem>.md`, folding the
 * incoming scan pass into whatever is already on disk. Idempotent: if the merged
 * bytes equal what is already there, the write is skipped so mtime is untouched.
 *
 * **Callers must hold `withPlansLock`.** This is a read-modify-write on both the
 * markdown and the derived counters, so two unsynchronized writers of the same
 * skill each fold into the same pre-merge body and the later write drops the
 * earlier one's invocations. That is reachable, not theoretical: the Claude Stop
 * hook and the hookless 60 s discovery tick can both be capturing skills for one
 * project at once — the same contention that forced `writeReferenceMarkdown`
 * inside the lock.
 */
export async function writeSkillMarkdown(use: SkillUse, cwd: string): Promise<WriteSkillResult> {
	const stem = sanitizeSkillIdForPath(use.skill);
	const sourcePath = skillPath(cwd, use.source, stem);

	let existing: string | undefined;
	try {
		existing = await readFile(sourcePath, "utf-8");
	} catch {
		existing = undefined;
	}

	// A corrupt file parses to null and must degrade to "no prior history" — the same
	// outcome as no file at all, so the two collapse to undefined here.
	const prior = (existing === undefined ? undefined : parseSkillMarkdownFromString(existing)) ?? undefined;
	const folded = foldSkillUse(use, prior);
	const content = renderSkillMarkdown(folded);
	const contentHash = sha256(content);

	if (existing !== content) {
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, content, "utf-8");
		log.debug("Wrote skill markdown: %s (%d chars)", sourcePath, content.length);
	} else {
		log.debug("Skill markdown unchanged, skipping write: %s", sourcePath);
	}

	return {
		sourcePath,
		contentHash,
		invocationCount: folded.invocationCount,
		entryPaths: folded.entryPaths,
		firstUsedAt: folded.firstUsedAt,
		lastUsedAt: folded.lastUsedAt,
		invocations: folded.invocations,
		...(folded.usage !== undefined ? { usage: folded.usage } : {}),
		...(folded.usageBySession !== undefined ? { usageBySession: folded.usageBySession } : {}),
		...(folded.detection !== undefined ? { detection: folded.detection } : {}),
	};
}

/** The full persisted shape of a skill file — frontmatter plus invocation detail. */
export interface SkillFileContent {
	readonly source: SkillSource;
	readonly skill: string;
	readonly plugin?: string;
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	readonly invocations: ReadonlyArray<SkillInvocation>;
	readonly invocationCount: number;
	readonly firstUsedAt: string;
	readonly lastUsedAt: string;
	/** Sum over {@link usageBySession}, recomputed on every fold. */
	readonly usage?: SkillUsage;
	/** Per-session spend keyed `<source>:<sessionId>` — the authoritative record. */
	readonly usageBySession?: Readonly<Record<string, SkillUsage>>;
	/** Sticky: a skill inferred once stays marked inferred. */
	readonly detection?: "heuristic";
	/** Sticky once set: a file that has announced a trim keeps saying so. */
	readonly trimmed: boolean;
}

/**
 * Fold this pass's usage into the per-session record, then re-total.
 *
 * Replace-per-session, add-across-sessions. Attribution recomputes a whole session
 * from line 0 on every pass, so re-scanning session A must overwrite A's entry
 * rather than add to it; a first pass over session B must add alongside A. A single
 * aggregate cannot express both, which is why the split is persisted.
 *
 * `confidence` degrades to the weakest contributor: a total that mixes an
 * attributed session with an estimated one is only as trustworthy as the estimate,
 * and reporting it as fully attributed would overstate what we know.
 */
function foldUsage(
	use: SkillUse,
	prior: SkillFileContent | undefined,
): { usage?: SkillUsage; usageBySession?: Readonly<Record<string, SkillUsage>> } {
	const merged: Record<string, SkillUsage> = { ...(prior?.usageBySession ?? {}) };

	if (use.usage !== undefined && use.sessionKey !== undefined) {
		merged[use.sessionKey] = use.usage;
	} else if (use.usage !== undefined) {
		// A scanner that reported usage without naming its session cannot participate
		// in per-session folding. Keeping the prior split and ignoring this number is
		// the conservative read; overwriting the whole split would discard known-good
		// per-session data in favour of one unattributable figure.
		log.debug("Skill usage without a sessionKey; retaining the existing per-session split");
	}

	const keys = Object.keys(merged);
	if (keys.length === 0) return {};

	let input = 0;
	let cached = 0;
	let output = 0;
	let estimated = false;
	for (const key of keys) {
		const entry = merged[key];
		input += entry.input;
		cached += entry.cached;
		output += entry.output;
		if (entry.confidence !== "attributed") estimated = true;
	}
	return {
		usage: { input, cached, output, confidence: estimated ? "estimated" : "attributed" },
		usageBySession: merged,
	};
}

/**
 * Fold one scan pass into the prior file content.
 *
 * Invocations are identified by their `at` timestamp: a skill cannot be entered
 * twice at the same instant, and re-scanning the same lines (a cursor rewind, or
 * a catch-up pass) must not inflate the count. Newest-first ordering and the
 * {@link SKILL_INVOCATION_CAP} trim are applied after the union.
 *
 * A collision UPGRADES the stored row rather than discarding the incoming one — see
 * {@link moreCompleteInvocation}. First-write-wins looks like the safe default here
 * and is not: the scanner deliberately reports a tool_use whose result has not
 * arrived yet, and rewinds its cursor so the next pass can complete it. Dropping the
 * duplicate would throw away exactly the fields that pass exists to supply, leaving
 * the fragment's gaps frozen forever. The count is untouched either way — a colliding
 * invocation is not fresh.
 *
 * **Known bounded imprecision.** `invocationCount` advances by the number of
 * incoming invocations not present in the retained detail list. Invocations
 * already trimmed past the cap are no longer available to dedupe against, so a
 * cursor rewind that re-reads them counts them a second time. The alternative —
 * deriving the total from the retained list — would under-report by the whole
 * trimmed tail on every capped skill, which is the worse error. Rewinds are rare
 * (version skew, catch-up) and the drift is bounded by what was trimmed.
 */
export function foldSkillUse(use: SkillUse, prior: SkillFileContent | undefined): SkillFileContent {
	const priorInvocations = prior?.invocations ?? [];
	const byAt = new Map(priorInvocations.map((i) => [i.at, i]));
	let freshCount = 0;
	for (const incoming of use.invocations) {
		const existing = byAt.get(incoming.at);
		if (existing === undefined) {
			byAt.set(incoming.at, incoming);
			freshCount++;
			continue;
		}
		byAt.set(incoming.at, moreCompleteInvocation(existing, incoming));
	}

	const merged = [...byAt.values()].sort((a, b) => {
		/* v8 ignore start -- unreachable today: `byAt` is keyed on `at`, so two surviving
		   invocations can never carry the same one. Kept anyway, because dropping it makes
		   the comparator INCONSISTENT for a duplicate key (both argument orders would
		   return the same sign), and V8's TimSort answers an inconsistent comparator with
		   an arbitrary order — so a future change that admits duplicates would silently
		   reorder this invocation list with no test failing. */
		if (a.at === b.at) return 0;
		/* v8 ignore stop */
		return a.at < b.at ? 1 : -1;
	});
	const kept = merged.slice(0, SKILL_INVOCATION_CAP);
	const trimmed = (prior?.trimmed ?? false) || merged.length > kept.length;
	if (merged.length > kept.length) {
		log.debug("Skill invocation detail over cap: keeping %d of %d", kept.length, merged.length);
	}

	const entryPaths = [...new Set([...(prior?.entryPaths ?? []), ...use.entryPaths])].sort();

	// Bounds come from every timestamp seen in this fold PLUS the prior frontmatter —
	// never from `kept`. The cap drops the oldest rows, so a retained-list minimum
	// walks `firstUsedAt` forward on every trim and makes a long-running skill look
	// freshly started. The prior file's own bounds are the only surviving record of
	// invocations already trimmed away.
	const seenAt = merged.map((i) => i.at);
	const firstCandidates = [...seenAt, ...(prior?.firstUsedAt ? [prior.firstUsedAt] : [])];
	const lastCandidates = [...seenAt, ...(prior?.lastUsedAt ? [prior.lastUsedAt] : [])];

	return {
		source: use.source,
		skill: use.skill,
		...(use.plugin !== undefined || prior?.plugin !== undefined ? { plugin: use.plugin ?? prior?.plugin } : {}),
		entryPaths,
		invocations: kept,
		invocationCount: (prior?.invocationCount ?? 0) + freshCount,
		firstUsedAt: minOf(firstCandidates) ?? "",
		lastUsedAt: maxOf(lastCandidates) ?? "",
		// Replace this session's contribution, add across sessions, re-total. See foldUsage.
		...foldUsage(use, prior),
		// Sticky, like `trimmed`: once a skill has been recorded as inferred it stays
		// inferred, even if a later pass happens not to say so. Downgrading to
		// "observed" would overstate what is known.
		...(use.detection !== undefined || prior?.detection !== undefined
			? { detection: use.detection ?? prior?.detection }
			: {}),
		trimmed,
	};
}

/**
 * Reconcile two records of the SAME invocation, field by field.
 *
 * Not a blanket "newer wins": the two readings are a fragment and a completed triple,
 * and which one is newer says nothing about which is right. Each field is resolved by
 * what can actually be known.
 *
 * `ok` is the asymmetric one. `true` is the scanner's DEFAULT, carried by an entry
 * whose result has not been read; `false` is only ever set from an observed failure.
 * So a false from either reading stands, and a later `true` cannot revive an
 * invocation already known to have failed.
 *
 * `bodyChars` and `args` prefer whichever reading has them: absent means "not seen in
 * that window", never "measured as nothing".
 */
function moreCompleteInvocation(prior: SkillInvocation, incoming: SkillInvocation): SkillInvocation {
	const bodyChars = incoming.bodyChars ?? prior.bodyChars;
	const args = incoming.args ?? prior.args;
	return {
		at: prior.at,
		...(args !== undefined ? { args } : {}),
		...(bodyChars !== undefined ? { bodyChars } : {}),
		ok: prior.ok && incoming.ok,
	};
}

/** Sentinel announcing that invocation detail was trimmed. Stripped on parse so it never accumulates. */
const SKILL_TRIM_SENTINEL = "<!-- jolli:skill-trimmed -->";

function trimNotice(): string {
	return `${SKILL_TRIM_SENTINEL}\n_Only the ${SKILL_INVOCATION_CAP} most recent invocations are listed; the count above is exact._`;
}

/** Render the canonical markdown for a skill file. */
export function renderSkillMarkdown(content: SkillFileContent): string {
	const lines: string[] = ["---"];
	lines.push(`source: ${JSON.stringify(content.source)}`);
	lines.push(`skill: ${JSON.stringify(content.skill)}`);
	if (content.plugin !== undefined) lines.push(`plugin: ${JSON.stringify(content.plugin)}`);
	lines.push(`entryPaths: ${JSON.stringify(content.entryPaths)}`);
	lines.push(`invocationCount: ${JSON.stringify(content.invocationCount)}`);
	lines.push(`firstUsedAt: ${JSON.stringify(content.firstUsedAt)}`);
	lines.push(`lastUsedAt: ${JSON.stringify(content.lastUsedAt)}`);
	if (content.detection !== undefined) lines.push(`detection: ${JSON.stringify(content.detection)}`);
	if (content.usage !== undefined) lines.push(`usage: ${JSON.stringify(content.usage)}`);
	// The per-session split is the authoritative record, so it must survive the
	// round-trip; `usage` above is its recomputed total.
	if (content.usageBySession !== undefined) lines.push(`usageBySession: ${JSON.stringify(content.usageBySession)}`);
	lines.push("---", "");
	for (const inv of content.invocations) lines.push(formatInvocation(inv));
	if (content.trimmed) lines.push("", trimNotice());
	return `${lines.join("\n")}\n`;
}

/** One invocation detail row. Round-trips through {@link parseInvocationLine}. */
function formatInvocation(inv: SkillInvocation): string {
	const parts = [inv.at];
	// `args` is JSON-encoded, which is what makes the row parseable: the value is
	// host-supplied free text that can itself contain the ` · ` field separator or a
	// newline, and a JSON string literal has an unambiguous end quote to scan to.
	if (inv.args !== undefined && inv.args !== "") parts.push(`args: ${JSON.stringify(inv.args)}`);
	if (inv.bodyChars !== undefined) parts.push(`body: ${inv.bodyChars}`);
	if (!inv.ok) parts.push("failed");
	return `- ${parts.join(FIELD_SEPARATOR)}`;
}

/** Field separator for an invocation detail row. Never split on this blindly — see {@link parseInvocationLine}. */
const FIELD_SEPARATOR = " · ";

/**
 * Parse a skill markdown file back into {@link SkillFileContent}.
 * Returns null when the file is missing required frontmatter or is malformed —
 * a corrupt file must degrade to "no prior history", never throw into a hook.
 */
export function parseSkillMarkdownFromString(content: string): SkillFileContent | null {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	if (!match) return null;
	const [, frontmatter, body] = match;

	const scalars = new Map<string, unknown>();
	for (const line of frontmatter.split("\n")) {
		const sep = line.indexOf(": ");
		if (sep <= 0) continue;
		try {
			scalars.set(line.slice(0, sep), JSON.parse(line.slice(sep + 2)));
		} catch {
			// A single half-written frontmatter line must not void an otherwise
			// readable invocation history.
		}
	}

	const source = scalars.get("source");
	const skill = scalars.get("skill");
	if (typeof source !== "string" || typeof skill !== "string") return null;

	const invocations: SkillInvocation[] = [];
	for (const line of body.split("\n")) {
		const inv = parseInvocationLine(line);
		if (inv !== null) invocations.push(inv);
	}

	const plugin = scalars.get("plugin");
	const usage = scalars.get("usage");
	const usageBySession = scalars.get("usageBySession");
	const detection = scalars.get("detection");
	const entryPaths = scalars.get("entryPaths");
	const invocationCount = scalars.get("invocationCount");
	const firstUsedAt = scalars.get("firstUsedAt");
	const lastUsedAt = scalars.get("lastUsedAt");

	return {
		source: source as SkillSource,
		skill,
		...(typeof plugin === "string" ? { plugin } : {}),
		entryPaths: Array.isArray(entryPaths) ? (entryPaths as ReadonlyArray<SkillEntryPath>) : [],
		invocations,
		// Falling back to the retained length rather than 0 keeps a corrupt-frontmatter
		// file from reporting "never used" while its rows sit right there.
		invocationCount: typeof invocationCount === "number" ? invocationCount : invocations.length,
		firstUsedAt: typeof firstUsedAt === "string" ? firstUsedAt : "",
		lastUsedAt: typeof lastUsedAt === "string" ? lastUsedAt : "",
		...(isSkillUsage(usage) ? { usage } : {}),
		...(isUsageBySession(usageBySession) ? { usageBySession } : {}),
		...(detection === "heuristic" ? { detection: "heuristic" as const } : {}),
		trimmed: content.includes(SKILL_TRIM_SENTINEL),
	};
}

function parseInvocationLine(line: string): SkillInvocation | null {
	if (!line.startsWith("- ")) return null;
	const payload = line.slice(2);
	const firstSep = payload.indexOf(FIELD_SEPARATOR);
	const at = firstSep === -1 ? payload : payload.slice(0, firstSep);
	// The timestamp IS the invocation identity (see foldSkillUse); a row without one
	// cannot participate in dedupe, so it is not a row.
	if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) return null;

	let tail = firstSep === -1 ? "" : payload.slice(firstSep + FIELD_SEPARATOR.length);

	// Lift `args` out FIRST, matched as a JSON string literal, and excise it before
	// splitting on the separator. The value is host-supplied free text that can
	// legitimately contain ` · `, `body: 999`, or `failed`; splitting first would
	// tear the value in half and read its contents as sibling fields.
	let args: string | undefined;
	const argsMatch = /args: ("(?:[^"\\]|\\.)*")/.exec(tail);
	if (argsMatch !== null) {
		try {
			// The cast is sound ONLY because of the capture group above: `"(?:[^"\\]|\\.)*"`
			// can match nothing but a well-formed JSON string literal (the `[^"\\]` class
			// stops the greedy run at the first unescaped quote), so a parse that returns
			// at all returns a string, and a `typeof` re-check would be a branch no input
			// can take. Relaxing that regex invalidates this — restore the check if it
			// ever admits a bare number, object, or array.
			args = JSON.parse(argsMatch[1]) as string;
		} catch {
			// Unrecoverable args text is dropped; the invocation itself still counts.
		}
		tail = tail.slice(0, argsMatch.index) + tail.slice(argsMatch.index + argsMatch[0].length);
	}

	let bodyChars: number | undefined;
	let ok = true;
	for (const field of tail.split(FIELD_SEPARATOR)) {
		if (field.startsWith("body: ")) {
			const n = Number.parseInt(field.slice("body: ".length), 10);
			if (Number.isFinite(n)) bodyChars = n;
		} else if (field === "failed") {
			ok = false;
		}
	}
	return { at, ...(args !== undefined ? { args } : {}), ...(bodyChars !== undefined ? { bodyChars } : {}), ok };
}

function isUsageBySession(value: unknown): value is Readonly<Record<string, SkillUsage>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(isSkillUsage);
}

function isSkillUsage(value: unknown): value is SkillUsage {
	if (typeof value !== "object" || value === null) return false;
	const u = value as Record<string, unknown>;
	return typeof u.input === "number" && typeof u.output === "number" && typeof u.cached === "number";
}

/** Read and parse a skill markdown file. Null when missing or malformed. */
export async function readSkillMarkdown(sourcePath: string): Promise<SkillFileContent | null> {
	try {
		return parseSkillMarkdownFromString(await readFile(sourcePath, "utf-8"));
	} catch {
		return null;
	}
}

function minOf(values: ReadonlyArray<string>): string | undefined {
	return values.length === 0 ? undefined : values.reduce((a, b) => (a < b ? a : b));
}

function maxOf(values: ReadonlyArray<string>): string | undefined {
	return values.length === 0 ? undefined : values.reduce((a, b) => (a > b ? a : b));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
