import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { labelLeadsWithNativeId } from "./ReferenceDisplay.js";
import { NEUTRAL_SOURCE_COLOR, SOURCE_META } from "./SourceLabels.js";
import { BUILTIN_DEFINITIONS } from "./sources/definitions/index.js";

/**
 * Pins the IntelliJ mirror of {@link SOURCE_META} to the table itself.
 *
 * `SourceDisplay.kt` calls itself a "byte-for-byte mirror" of this table and
 * `ReferenceTypes.kt` restates which sources are `nativeIdPathSafe: false`, but
 * until this file both claims rested on a comment — and every way they can be
 * wrong is SILENT on the JVM side:
 *
 *   - An id missing from the `SourceId` enum decodes to `null` (Gson's default
 *     for an unknown constant), so `CommitsPanel` DROPS that reference row
 *     outright (`val src = ref.source ?: return@forEach`) and the CONTEXT panel
 *     degrades it to a neutral `R`.
 *   - A letter, label or hex that drifts renders the same reference as a
 *     different-looking chip in the IDE than in VS Code and the dashboard —
 *     which is the exact complaint that made `SourceLabels.ts` the one table.
 *   - A source missing from `PATH_UNSAFE_SOURCES` reads the identity file stem
 *     while the CLI wrote the sanitized+sha8 one, so every archived body of
 *     that source comes back null.
 *
 * ## Why the gap list, rather than a flat "they must be equal"
 *
 * `intellij/` is an independent Gradle build that the root `npm run all` does
 * not run, and the registry's own header (`sources/definitions/index.ts`)
 * records the resulting policy: a new source lands in the CLI/VS Code PR, and
 * the two lines of Kotlin follow in their own. A flat equality test would
 * reverse that decision by making every CLI-side source addition red until the
 * Kotlin lands with it.
 *
 * {@link KNOWN_JVM_SOURCE_GAPS} keeps the policy and removes the "silent" part:
 * a new source is either mirrored or written down here, in one review-visible
 * line. The list is checked in BOTH directions — the `checkNoDirectLlmHttp`
 * idiom — so an entry that has since been mirrored also fails, forcing the list
 * to shrink in the PR that closes the gap instead of accumulating stale
 * exemptions.
 *
 * Everything the JVM host DOES declare is held to strict equality regardless.
 * A gap is permission to be absent, never permission to disagree.
 */

/**
 * Sources in {@link SOURCE_META} whose IntelliJ mirror has not landed yet.
 *
 * EMPTY, and that is the steady state — an entry here is a temporary record of
 * a follow-up PR that is still open, not a place to park a source. Add the id
 * with a one-line reason when the Kotlin genuinely has to ship separately;
 * delete it in the PR that adds the enum entry (this test fails on a stale
 * one).
 */
const KNOWN_JVM_SOURCE_GAPS: ReadonlyArray<string> = [];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const readKotlin = (rel: string): string =>
	readFileSync(join(repoRoot, "intellij", "src", "main", "kotlin", "ai", "jolli", "jollimemory", rel), "utf8");

const referenceTypesKt = readKotlin(join("core", "references", "ReferenceTypes.kt"));
const sourceDisplayKt = readKotlin(join("core", "references", "SourceDisplay.kt"));
const summaryHtmlBuilderKt = readKotlin(join("toolwindow", "views", "SummaryHtmlBuilder.kt"));

/** One `SourceId` constant: its Kotlin identifier and the wire string it serializes as. */
interface KotlinEnumEntry {
	readonly kotlinName: string;
	readonly wire: string;
}

/**
 * The `SourceId` constants, in declaration order.
 *
 * Throws on a line it cannot parse rather than skipping it: a silently ignored
 * constant is a constant this file claims to have checked and did not.
 */
function parseSourceIdEnum(src: string): ReadonlyArray<KotlinEnumEntry> {
	const body = /enum class SourceId \{([\s\S]*?)\n\}/.exec(src)?.[1];
	if (body === undefined) throw new Error("no `enum class SourceId` block in ReferenceTypes.kt");
	const entries: KotlinEnumEntry[] = [];
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
		const m = /^(?:@SerializedName\("([^"]+)"\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*,?$/.exec(line);
		if (m === null) throw new Error(`unparsed SourceId enum line: ${line}`);
		entries.push({ kotlinName: m[2], wire: m[1] ?? m[2] });
	}
	return entries;
}

/** One `SourceDisplay.Style` constant. `color` is the light half; the dark half is asserted equal. */
interface KotlinStyle {
	readonly tag: string;
	readonly color: string;
	readonly darkColor: string;
	readonly label: string;
}

function parseStyles(src: string): ReadonlyMap<string, KotlinStyle> {
	const re =
		/private val ([A-Z][A-Z0-9_]*) = Style\("([^"]*)",\s*JBColor\(0x([0-9A-Fa-f]{6}),\s*0x([0-9A-Fa-f]{6})\),\s*"([^"]*)"\)/g;
	const out = new Map<string, KotlinStyle>();
	for (const m of src.matchAll(re)) {
		out.set(m[1], { tag: m[2], color: `#${m[3]}`, darkColor: `#${m[4]}`, label: m[5] });
	}
	if (out.size === 0) throw new Error("no `private val … = Style(…)` constants in SourceDisplay.kt");
	return out;
}

/** `SourceId.<name> -> <STYLE_CONST>` branches of `SourceDisplay.of`, plus the `null ->` fallback. */
function parseOfBranches(src: string): { branches: ReadonlyMap<string, string>; fallback: string } {
	const start = src.indexOf("fun of(source: SourceId?)");
	if (start === -1) throw new Error("no `fun of(source: SourceId?)` in SourceDisplay.kt");
	const nullBranch = /null\s*->\s*([A-Z][A-Z0-9_]*)/.exec(src.slice(start));
	if (nullBranch === null) throw new Error("`SourceDisplay.of` has no `null ->` branch");
	const body = src.slice(start, start + (nullBranch.index ?? 0));
	const branches = new Map<string, string>();
	for (const m of body.matchAll(/SourceId\.([A-Za-z0-9_]+)\s*->\s*([A-Z][A-Z0-9_]*)/g)) branches.set(m[1], m[2]);
	return { branches, fallback: nullBranch[1] };
}

/** The `SourceId.<name>` constants named inside a `setOf(…)` / expression starting at `anchor`. */
function idsNamedAfter(src: string, anchor: string, end: string): ReadonlyArray<string> {
	const start = src.indexOf(anchor);
	if (start === -1) throw new Error(`no \`${anchor}\` in the Kotlin source`);
	const stop = src.indexOf(end, start);
	const segment = src.slice(start, stop === -1 ? undefined : stop);
	return [...segment.matchAll(/SourceId\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

const enumEntries = parseSourceIdEnum(referenceTypesKt);
const enumByWire = new Map(enumEntries.map((e) => [e.wire, e]));
const styles = parseStyles(sourceDisplayKt);
const { branches, fallback } = parseOfBranches(sourceDisplayKt);

const metaIds = Object.keys(SOURCE_META);
/** The ids the JVM host is expected to carry — everything but a recorded gap. */
const mirroredIds = metaIds.filter((id) => !KNOWN_JVM_SOURCE_GAPS.includes(id));

describe("SOURCE_META and its IntelliJ mirror stay in lockstep", () => {
	it("every recorded JVM gap is a real source that is really still missing", () => {
		// Bidirectional, like `checkNoDirectLlmHttp`'s allowlist: an id that is not
		// in the table at all is a typo that exempts nothing, and one the enum has
		// since gained is a stale exemption that must go in the PR that closed it.
		for (const id of KNOWN_JVM_SOURCE_GAPS) {
			expect(metaIds, `${id} is not a SOURCE_META id`).toContain(id);
			expect(enumByWire.has(id), `${id} is mirrored now — drop it from KNOWN_JVM_SOURCE_GAPS`).toBe(false);
		}
	});

	it("the SourceId enum covers every source the CLI ships", () => {
		// Absence is not a degradation on this host: Gson decodes an unknown
		// constant to null and `CommitsPanel` skips the row entirely. Named as a
		// list of what is missing so the failure says which source, not which index.
		expect(mirroredIds.filter((id) => !enumByWire.has(id))).toEqual([]);
	});

	it("the SourceId enum declares nothing the CLI does not ship", () => {
		// The other direction: a constant with no `SOURCE_META` entry would render
		// from `SourceDisplay` alone, so the two surfaces could disagree with
		// nothing above to compare against.
		for (const entry of enumEntries) expect(metaIds, `SourceId.${entry.kotlinName}`).toContain(entry.wire);
	});

	it("a hyphenated wire name is carried by @SerializedName, wireName AND parse", () => {
		// Three independent spellings of the same fact, and each one is load-bearing
		// on its own path: Gson uses the annotation, `SummaryReader` / `ReferenceStore`
		// build orphan-branch paths from `wireName`, and `parse` is what the
		// markdown reader and `PinnedPanel` call. A missing branch in `parse` reads
		// the reference as an unknown source; a missing one in `wireName` looks in
		// `references/zoom_doc/` for a file the CLI wrote to `references/zoom-doc/`.
		for (const entry of enumEntries) {
			if (entry.wire === entry.kotlinName) continue;
			expect(referenceTypesKt).toContain(`@SerializedName("${entry.wire}") ${entry.kotlinName}`);
			expect(referenceTypesKt).toContain(`SourceId.${entry.kotlinName} -> "${entry.wire}"`);
			expect(referenceTypesKt).toContain(`"${entry.wire}" -> SourceId.${entry.kotlinName}`);
		}
	});

	it("every declared source has its own SourceDisplay.Style", () => {
		for (const entry of enumEntries) {
			const styleName = branches.get(entry.kotlinName);
			expect(styleName, `SourceDisplay.of has no branch for SourceId.${entry.kotlinName}`).toBeDefined();
			expect(styleName, `SourceId.${entry.kotlinName} falls back to the unknown placeholder`).not.toBe(fallback);
			expect(styles.has(styleName as string)).toBe(true);
		}
	});

	it("each Style's letter, label and hue are the SOURCE_META row", () => {
		for (const entry of enumEntries) {
			const style = styles.get(branches.get(entry.kotlinName) as string) as KotlinStyle;
			const meta = SOURCE_META[entry.wire as keyof typeof SOURCE_META];
			expect({ tag: style.tag, label: style.label, color: style.color.toLowerCase() }, entry.wire).toEqual({
				tag: meta.letter,
				label: meta.label,
				color: meta.color.toLowerCase(),
			});
			// `SOURCE_META` carries ONE hue per source, so a JBColor whose two halves
			// differ would be a theme-dependent brand color the table cannot express.
			expect(style.darkColor.toLowerCase(), entry.wire).toBe(style.color.toLowerCase());
		}
	});

	it("the unknown-source placeholder is the table's neutral fallback", () => {
		const unknown = styles.get(fallback) as KotlinStyle;
		expect(unknown.color.toLowerCase()).toBe(NEUTRAL_SOURCE_COLOR.toLowerCase());
	});

	it("PATH_UNSAFE_SOURCES is exactly the definitions declaring nativeIdPathSafe: false", () => {
		// Read off the definitions rather than restated here, so the CLI stays the
		// single declaration. A source the JVM omits reads the wrong file stem and
		// every archived body of it comes back null.
		const cliUnsafe = BUILTIN_DEFINITIONS.filter((d) => !d.storage.nativeIdPathSafe)
			.map((d) => d.id)
			.filter((id) => enumByWire.has(id))
			.map((id) => (enumByWire.get(id) as KotlinEnumEntry).kotlinName);
		// Anchored on the DECLARATION, not on the name: `pathKey` reads the set a
		// few lines above it, so a bare-name anchor lands on the use site.
		const kotlinUnsafe = idsNamedAfter(referenceTypesKt, "private val PATH_UNSAFE_SOURCES", ")");
		expect([...kotlinUnsafe].sort()).toEqual([...cliUnsafe].sort());
	});

	it("labelLeadsWithNativeId agrees on which sources lead with their nativeId", () => {
		const cliLeading = metaIds.filter((id) => labelLeadsWithNativeId(id)).filter((id) => enumByWire.has(id));
		const kotlinLeading = idsNamedAfter(sourceDisplayKt, "fun labelLeadsWithNativeId(", "\n\n");
		expect([...kotlinLeading].sort()).toEqual(
			[...cliLeading].sort().map((id) => (enumByWire.get(id) as KotlinEnumEntry).kotlinName),
		);
	});
});

describe("the IntelliJ summary HTML derives its reference section from the mirror", () => {
	it("orders by the enum itself, so a new source cannot be dropped from the section", () => {
		// `referencesBySourceOrder` renders by walking this list, so an id missing
		// from it is not sorted last — it is silently absent from the section. A
		// hand-written list did exactly that to ten of the fifteen sources.
		expect(summaryHtmlBuilderKt).toMatch(/val SOURCE_ORDER\b[^\n]*=\s*SourceId\.entries/);
	});

	it("labels rows from SourceDisplay rather than a second title table", () => {
		// A local map that fell behind printed the bare enum name ("monday",
		// "zoom_doc") in the row's buttons next to the sidebar's "monday.com".
		expect(summaryHtmlBuilderKt).toContain("SourceDisplay.of(e.source).label");
		expect(summaryHtmlBuilderKt).not.toContain("SOURCE_TITLES");
	});
});
