/**
 * PinStore — per-branch "pinned" items for the Current Branch view.
 *
 * Persists to `<projectDir>/.jolli/jollimemory/pins.json`, grouped by
 * `<repoName>::<branchName>`. A pin is a lightweight reference to an existing
 * artifact (conversation / plan / note / committed memory / reference) the user
 * wants kept at the top of the Current Branch view; the id reuses that artifact's
 * stable identifier (conversationKey / plan slug / note id / commit hash /
 * reference mapKey).
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";

const log = createLogger("PinStore");
const PINS_FILE = "pins.json";
const PINS_VERSION = 1 as const;

export type PinKind = "conversation" | "plan" | "note" | "memory" | "reference";

export interface PinEntry {
	readonly kind: PinKind;
	readonly id: string;
	readonly title: string;
	readonly pinnedAt: number;
	/** Only populated for kind === 'conversation'. Identifies the transcript provider. */
	readonly source?: string;
	/** Only populated for kind === 'conversation'. Absolute path to the transcript file. */
	readonly transcriptPath?: string;
}

interface PersistedShape {
	readonly version: typeof PINS_VERSION;
	readonly groups: Record<string, PinEntry[]>;
}

export function pinGroupKey(repoName: string, branchName: string): string {
	return `${repoName}::${branchName}`;
}

function pinsPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, PINS_FILE);
}

const PIN_KINDS: ReadonlySet<string> = new Set<PinKind>(["conversation", "plan", "note", "memory", "reference"]);

/**
 * Coerces an unknown value into a valid PinEntry[]. Mirrors
 * CommitSelectionStore.asStringArray: a non-array (corruption, a hand-edit
 * that turned a group into an object/string/null) degrades to [] rather than
 * propagating a malformed group that would make addPin/removePin's `.filter`
 * throw a TypeError. Each element is shape-validated — a group of arbitrary
 * objects is filtered down to entries that actually carry the required
 * (kind, id, title, pinnedAt) fields, so a partially-corrupt group keeps its
 * good entries instead of being discarded wholesale.
 */
function asPinEntryArray(v: unknown): PinEntry[] {
	if (!Array.isArray(v)) return [];
	return v.filter((e): e is PinEntry => {
		if (!e || typeof e !== "object") return false;
		const p = e as Record<string, unknown>;
		return (
			typeof p.kind === "string" &&
			PIN_KINDS.has(p.kind) &&
			typeof p.id === "string" &&
			typeof p.title === "string" &&
			typeof p.pinnedAt === "number"
		);
	});
}

async function readAll(projectDir: string): Promise<PersistedShape> {
	try {
		const raw = await readFile(pinsPath(projectDir), "utf8");
		const parsed = JSON.parse(raw) as Partial<PersistedShape>;
		if (!parsed || typeof parsed !== "object" || typeof parsed.groups !== "object" || parsed.groups === null) {
			return { version: PINS_VERSION, groups: {} };
		}
		// Version gate (mirrors CommitSelectionStore): an unrecognized schema is
		// ignored loud-but-safe rather than read with stale assumptions. Today
		// PINS_VERSION is the only valid version; future migrations slot a
		// `parsed.version === <oldVersion>` arm in here.
		if (parsed.version !== PINS_VERSION) {
			log.warn(`pins.json version mismatch (got ${String(parsed.version)}) — treating as empty`);
			return { version: PINS_VERSION, groups: {} };
		}
		// Coerce every group: a non-array group (corruption / hand-edit) would
		// otherwise reach addPin/removePin's `.filter` and throw a TypeError.
		const groups: Record<string, PinEntry[]> = {};
		for (const [key, value] of Object.entries(parsed.groups)) {
			groups[key] = asPinEntryArray(value);
		}
		return { version: PINS_VERSION, groups };
	} catch (err) {
		if (!isEnoent(err)) log.warn(`pins.json unreadable, treating as empty: ${errMsg(err)}`);
		return { version: PINS_VERSION, groups: {} };
	}
}

async function writeAll(projectDir: string, data: PersistedShape): Promise<void> {
	await mkdir(join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
	// Atomic tmpfile + rename via the shared helper, which also carries the
	// Windows EPERM/EACCES direct-overwrite fallback the sidebar's rapid
	// fire-and-forget pin/unpin writes need (a file watcher or antivirus holding
	// pins.json would otherwise make the rename throw). Don't reintroduce a
	// private copy of this write path — see AtomicWrite.ts.
	await atomicWriteFile(pinsPath(projectDir), JSON.stringify(data, null, 2));
}

// In-process serialization queue keyed by projectDir. addPin / removePin share
// an unlocked read-modify-write pattern and the sidebar fires them fire-and-
// forget from rapid pin/unpin clicks. Without a queue two concurrent calls
// would read the same pre-state and silently lose one update. One chain per
// projectDir keeps cross-project work parallel. Mirrors CommitSelectionStore.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
	const prior = writeChains.get(projectDir) ?? Promise.resolve();
	const next = prior.then(work, work);
	writeChains.set(
		projectDir,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

export async function listPins(projectDir: string, repoName: string, branchName: string): Promise<PinEntry[]> {
	const all = await readAll(projectDir);
	return all.groups[pinGroupKey(repoName, branchName)] ?? [];
}

export async function addPin(projectDir: string, repoName: string, branchName: string, entry: PinEntry): Promise<void> {
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		const key = pinGroupKey(repoName, branchName);
		const list = (all.groups[key] ?? []).filter((p) => !(p.kind === entry.kind && p.id === entry.id));
		list.push(entry);
		all.groups[key] = list;
		await writeAll(projectDir, all);
	});
}

export async function removePin(
	projectDir: string,
	repoName: string,
	branchName: string,
	kind: PinKind,
	id: string,
): Promise<void> {
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		const key = pinGroupKey(repoName, branchName);
		const existing = all.groups[key];
		if (!existing) return;
		all.groups[key] = existing.filter((p) => !(p.kind === kind && p.id === id));
		await writeAll(projectDir, all);
	});
}
