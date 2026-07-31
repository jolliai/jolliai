import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces: every literal rebuild of a `PlansRegistry` carries EVERY artifact map.
 *
 * `PlansRegistry`'s artifact maps are all optional, so a writer that rebuilds the
 * object field-by-field and forgets one erases it on the next write — silently, and
 * with nothing failing to compile. That is not hypothetical: `finalizeReferenceArchive`
 * and the VS Code reference-removal path both omitted `skills`, so any commit that
 * archived a reference wiped the skill registry a step before skill archival read it.
 * The symptom (skills never archived) looked nothing like the cause (a reference
 * write), which is why this is a test rather than the doc-comment it used to be.
 *
 * A comment naming the current writers cannot hold: the list grows, and the fifth
 * writer is the one nobody updates. This scans instead, so adding a map to
 * `PlansRegistry` fails here until every rebuild accounts for it.
 *
 * **Spread rebuilds are exempt** — `{ ...registry, plans: … }` preserves maps it
 * never names, which is the safer idiom and the one to prefer.
 */

/** Artifact maps on PlansRegistry. Add here when a new one is introduced. */
const ARTIFACT_MAPS = ["plans", "notes", "references", "skills"] as const;

const ROOTS = [join(process.cwd(), "src"), join(process.cwd(), "..", "vscode", "src")];

async function tsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === "__fixtures__") continue;
			out.push(...(await tsFiles(p)));
		} else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
			out.push(p);
		}
	}
	return out;
}

/** The object literal starting at `open` (index of its `{`), by brace balance. */
function literalAt(src: string, open: number): string {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	return src.slice(open);
}

interface Offender {
	readonly file: string;
	readonly line: number;
	readonly missing: string[];
}

describe("PlansRegistry literal rebuilds", () => {
	it("name every artifact map, or spread the source registry", async () => {
		const offenders: Offender[] = [];

		for (const root of ROOTS) {
			for (const file of await tsFiles(root)) {
				const src = await readFile(file, "utf-8");
				// Only annotated rebuilds — an un-annotated object cannot be relied on to
				// be a whole-registry write, and `satisfies`/casts are not used here.
				const re = /:\s*PlansRegistry\s*=\s*\{/g;
				for (let m = re.exec(src); m !== null; m = re.exec(src)) {
					const open = src.indexOf("{", m.index);
					const literal = literalAt(src, open);
					// A spread of the prior registry carries unnamed maps forward.
					if (/\.\.\.\s*[A-Za-z_$][\w$]*/.test(literal)) continue;
					// Comments are stripped first so prose naming a map cannot satisfy the
					// check, and shorthand (`{ notes }`) counts as naming it — the codebase
					// uses both `notes: x` and bare `notes` inside conditional spreads.
					const code = literal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
					const missing = ARTIFACT_MAPS.filter((k) => !new RegExp(`\\b${k}\\b\\s*[:,}]`).test(code));
					if (missing.length > 0) {
						offenders.push({
							// Repo-relative, so a failure message is a clickable path rather
							// than a machine-specific absolute one.
							file: file.replace(join(process.cwd(), ".."), "").replace(/^[/\\]/, ""),
							line: src.slice(0, m.index).split("\n").length,
							missing: [...missing],
						});
					}
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it("scans a non-trivial number of files, so a broken walk cannot pass vacuously", async () => {
		// The assertion above is satisfied by an empty offender list, which an
		// accidentally-empty file walk also produces. This pins the walk itself.
		const counts = await Promise.all(ROOTS.map((r) => tsFiles(r).then((f) => f.length)));
		for (const n of counts) expect(n).toBeGreaterThan(50);
	});
});
