import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { toForwardSlash } from "./PathUtils.js";

/**
 * Pins every place that still reaches for the orphan branch directly.
 *
 * The cutover protocol makes SQLite a repo's ONLY system of record once the
 * branch is fenced. Routing for that lives in `CutoverRouter` + `StorageFactory`
 * + `ReadStorageResolver`, but a call site that bypasses the router — by
 * constructing `OrphanBranchStorage` itself, or by naming `ORPHAN_BRANCH` in a
 * raw git read/write — keeps treating the frozen branch as the truth. Every
 * such site fails SILENTLY past the fence: stale data, or a fresh clone judged
 * to have "no memories", with nothing thrown and nothing logged.
 *
 * The allowlist below is the whole point. It is BIDIRECTIONAL: a new file that
 * reaches for the branch fails, and an allowlisted file that stops matching
 * fails too. That second direction is what makes the migration measurable —
 * finishing a call site means deleting its row here, in the same commit.
 *
 * The known-bad set this guard was created to burn down is now empty: every
 * remaining row carries a reason for why touching the branch is CORRECT there —
 * the cutover machinery has to, the routers' own un-cutover arms have to, two
 * surfaces merely report the branch's name, and the rest are gated on the repo
 * still being un-cutover. A new row is therefore a claim that needs defending
 * in review, not a placeholder; if the honest answer is "not migrated yet", say
 * so in the reason so the next reader can tell the two apart.
 *
 * Two scope caveats. It only knows these two spellings: a hard-coded branch
 * string, or code that assumes orphan-is-truth without naming either symbol,
 * passes untouched. And it matches raw text, so a COMMENT that quotes either
 * spelling trips it — deliberately left that way rather than parsed around,
 * since prose naming the constructor in a new file is worth a second look, and
 * a comment stripper is one more thing that can be quietly wrong.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SCANNED_ROOTS = ["cli/src", "vscode/src"] as const;

/**
 * Direct construction of the orphan backend — bypasses `StorageFactory` /
 * `ReadStorageResolver`, so the cutover route never gets consulted.
 */
const CONSTRUCTION_ALLOWLIST: ReadonlyMap<string, string> = new Map([
	["cli/src/core/ReadStorageResolver.ts", "the router's own un-cutover arm"],
	["cli/src/core/StorageFactory.ts", "the router's own un-cutover arm"],
	["cli/src/core/SotStorageResolver.ts", "the system-of-record resolver's own un-cutover arm"],
	[
		"cli/src/core/SummaryStore.ts",
		// Both resolvers now route through `resolveSotBackend`. What is left is the
		// `blocked` degradation, and it cannot reach a frozen branch: the resolver
		// only reports blocked for a fenced repo, and `OrphanBranchStorage.writeFiles`
		// re-reads the fence and throws before writing. Degrading here keeps reads
		// working and moves the failure to the one operation that must not silently
		// succeed — better than making a never-fail resolver start throwing.
		"the blocked-state degradation in sotFallback",
	],
]);

/**
 * Naming the branch at all — raw `git show` / ref reads, watch paths, and the
 * "does this branch exist" predicates that stand in for "are there memories".
 */
const BRANCH_NAME_ALLOWLIST: ReadonlyMap<string, string> = new Map([
	["cli/src/Logger.ts", "the constant is declared here"],
	["cli/src/core/OrphanBranchStorage.ts", "the backend itself"],
	["cli/src/core/GitRefStorage.ts", "the backend itself"],
	[
		"cli/src/core/JolliRefs.ts",
		// The opposite of a system-of-record decision: it names the constant in a
		// `@see` so a reader of the ref-namespace rule can find the branch it
		// derives from, and its whole job is telling git to IGNORE that namespace.
		"names the constant in a doc cross-reference; reads and writes nothing",
	],
	["cli/src/dashboard/CutoverEngine.ts", "the cutover machinery: tips, fence, CAS"],
	["cli/src/dashboard/SotImport.ts", "the orphan → SQLite importer"],
	["cli/src/dashboard/Recovery.ts", "reads the fenced root's tip"],
	["cli/src/dashboard/DbBackfill.ts", "reads the orphan tip"],
	["cli/src/backfill/CommitTargetIndex.ts", "`--not` excludes the summaries branch's own commits; unrelated to SoT"],
	["cli/src/core/SchemaV5Migration.ts", "captures the rollback SHA only while the branch IS the system of record"],
	["cli/src/core/SummaryMigration.ts", "the v1-era raw branch writes, refused by route on any non-uncutover repo"],
	[
		"cli/src/daemon/DaemonServer.ts",
		"names the branch in the ref target's comment; the DB target beside it covers post-cutover",
	],
	["cli/src/install/Installer.ts", "reports the branch NAME on StatusInfo; the summary count no longer gates on it"],
	[
		"cli/src/commands/DoctorCommand.ts",
		"names the branch in the informational row beside the system-of-record check",
	],
	["vscode/src/Extension.ts", "watches the orphan ref AND the database — either side of the fence pushes a refresh"],
	[
		"vscode/src/JolliMemoryBridge.ts",
		"reports the branch NAME on StatusInfo, same as Installer; no data decision rides on it",
	],
]);

function collectSourceFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (entry.name.endsWith(".d.ts")) continue;
			// Test files may name either symbol freely — they are where the
			// un-migrated behaviour still has to be asserted.
			if (entry.name.includes(".test.")) continue;
			out.push(full);
		}
	};
	walk(join(repoRoot, root));
	return out;
}

function filesMatching(pattern: RegExp): string[] {
	const hits: string[] = [];
	for (const root of SCANNED_ROOTS) {
		for (const file of collectSourceFiles(root)) {
			if (pattern.test(readFileSync(file, "utf8"))) {
				hits.push(toForwardSlash(relative(repoRoot, file)));
			}
		}
	}
	return hits.sort();
}

describe("orphan-as-SoT guard", () => {
	it("only the allowlisted files construct OrphanBranchStorage directly", () => {
		expect(filesMatching(/new OrphanBranchStorage\(/)).toEqual([...CONSTRUCTION_ALLOWLIST.keys()].sort());
	});

	it("only the allowlisted files name ORPHAN_BRANCH", () => {
		// Word-bounded on purpose: `ORPHAN_BRANCH_V1` is the legacy v1 constant
		// and a plain substring test would fold it into the v3 result.
		expect(filesMatching(/\bORPHAN_BRANCH\b/)).toEqual([...BRANCH_NAME_ALLOWLIST.keys()].sort());
	});

	it("every allowlist entry carries a reason", () => {
		for (const [file, reason] of [...CONSTRUCTION_ALLOWLIST, ...BRANCH_NAME_ALLOWLIST]) {
			expect(reason, `${file} needs a reason`).not.toBe("");
		}
	});
});
