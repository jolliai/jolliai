// Data-only declarative schema for one MCP reference source. Evaluated by SourceEngine.
// No functions live here — the only "code" reference is a transform NAME resolved
// against SourceEngine's closed TRANSFORMS registry.

/** A single extraction op. Closed vocabulary of 7. */
export type Op =
	| { readonly op: "path"; readonly path: string }
	| { readonly op: "coalesce"; readonly of: ReadonlyArray<Pipe> }
	| { readonly op: "regex"; readonly pattern: string; readonly extract?: string; readonly lastMatch?: boolean }
	| { readonly op: "template"; readonly template: string; readonly from: Readonly<Record<string, Pipe>> }
	| { readonly op: "join"; readonly sep: string }
	| { readonly op: "const"; readonly value: string }
	| { readonly op: "transform"; readonly fn: string };

/** An ordered op list producing one value from a payload (or a threaded scalar). */
export type Pipe = ReadonlyArray<Op>;

export interface FieldSpec {
	readonly pipe: Pipe;
	/** Regex the produced value must match, else the whole Reference is voided. */
	readonly require?: string;
	/** Optional flags for `require` (e.g. "i" for case-insensitive host matching). */
	readonly requireFlags?: string;
	/** When true, a missing/empty value is dropped (not a void). */
	readonly optional?: boolean;
}

export interface BagFieldSpec {
	readonly key: string; // constrained ^[\w-]+$
	readonly label: string;
	readonly icon?: string;
	readonly pipe: Pipe;
}

export interface MatchClaude {
	readonly prefixes: ReadonlyArray<string>;
	/** Optional suffix accept (e.g. Notion "notion-fetch"). */
	readonly acceptSuffix?: string;
	/**
	 * After a prefix match (and any `acceptSuffix`), reject if the tool name ends
	 * with any of these. Enumeration tools (`list_issues` / `search_issues`)
	 * bulk-capture their whole result array — one reference per element — flooding
	 * Working Memory → Context, so they are excluded from reference extraction.
	 */
	readonly denySuffixes?: ReadonlyArray<string>;
	/**
	 * Exact tool-name allow-list applied after the prefix match. When present, the
	 * tool name must EQUAL one of these entries.
	 *
	 * Needed when a namespace hosts several wanted tools AND an unwanted tool whose
	 * name EXTENDS a wanted one, which prefix + suffix rules cannot express:
	 * matching is `startsWith`, so a prefix of `mcp__ns__search` also captures
	 * `mcp__ns__search_remote_articles`. `denySuffixes` could enumerate today's
	 * unwanted siblings, but a denylist silently starts miscapturing the moment a
	 * new sibling appears — an allow-list cannot drift that way. Absent for every
	 * source that owns its whole namespace.
	 */
	readonly exact?: ReadonlyArray<string>;
}
export interface MatchCodex {
	readonly namespaceSuffix: string;
	readonly functionCallNames: ReadonlyArray<string>;
	readonly invocationTools: ReadonlyArray<string>;
	/**
	 * MCP server name that an `mcp_tool_call_end` event must report for its
	 * `invocationTools` to be consulted at all. Compared against the event's
	 * `invocation.server`.
	 *
	 * Needed the moment a definition's `invocationTools` are BARE, un-namespaced
	 * tool names. The invocation-path lookup is one flat scan across every
	 * definition with no other server qualifier, so a bare generic name like
	 * `search` would otherwise match any locally-registered MCP server's
	 * same-named tool and persist a foreign lookup under this source. Every
	 * connector-app source instead carries a server-qualified entry
	 * (`asana.get_task`, `atlassian_rovo.fetch`, …), which is self-scoping — those
	 * omit this field and keep the unqualified behaviour.
	 */
	readonly invocationServer?: string;
}
export interface SourceMatch {
	readonly claude?: MatchClaude;
	readonly codex?: MatchCodex;
}

export interface RenderSpec {
	readonly wrapperTag: string;
	readonly itemTag: string;
	/** Body tag: "description" (Linear/Jira/GitHub) or "content" (Notion). */
	readonly bodyTag: string;
	/** When false, bag fields are NOT rendered as item attributes (Notion). Default true. */
	readonly fieldAttrs?: boolean;
	readonly maxCharsPerReference: number;
	readonly maxTotalChars: number;
}

export interface StorageSpec {
	/** true → identity path (guarded); false → [^\w.-]→- + sha8 (github). */
	readonly nativeIdPathSafe: boolean;
}

export interface SourceDefinition {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	/**
	 * Track-only: the reference is captured, archived into CommitSummary.references,
	 * and shown in every reference listing (detail page, PR, push, timeline), but is
	 * EXCLUDED from the {{references}} block fed to the memory-decision LLM. Absent
	 * (falsy) for every existing source.
	 */
	readonly trackOnly?: boolean;
	/**
	 * Arguments-derived: the reference is built from the tool-call arguments, not the
	 * result, so a non-JSON (prose) result is expected. Both transcript parsers pass an
	 * empty payload to this source's normalizer on JSON-parse failure instead of
	 * dropping the call. Absent (falsy) for every existing (JSON-result) source.
	 */
	readonly argumentsDerived?: boolean;
	/**
	 * Accumulating body: when several extracted references share a `mapKey`, their
	 * bodies are MERGED rather than the newest overwriting the rest.
	 *
	 * The default (overwrite) is right for an entity — fetching Linear ENG-1 twice
	 * describes one ticket, and the later read wins. It is wrong for a source whose
	 * identity is an ACT rather than an entity: two different memory queries are two
	 * different facts, and keeping only the last one discards the record. Absent
	 * (falsy) for every entity-shaped source.
	 */
	readonly accumulateBody?: boolean;
	/**
	 * Regex (as a string, like every `require`) matching a title this source SYNTHESIZES
	 * when the real one could not be recovered from the transcript. When the incoming
	 * title matches it and the title of the record it supersedes does NOT, that record's
	 * **title, url, display fields and body** are all kept (`ReferenceStore
	 * .restorePriorHarvest`, applied at both collapse points — the markdown write and
	 * extraction-time dedupe).
	 *
	 * The title is the DETECTOR, not the whole subject: a synthesized title is the
	 * observable signal that this source's out-of-band lookup missed, and every value fed
	 * by that lookup is a casualty of the same miss — which is why all four move together
	 * rather than the title alone. Declaring the pattern therefore asserts that the
	 * source's title AND url both come from that lookup — true for figma, the first source
	 * to declare it. A future source with a harvested title but a payload-derived url must
	 * declare that difference rather than have this widened.
	 *
	 * The body is exempt for an `accumulateBody` source, and only there: its body is
	 * MERGED rather than replaced, so nothing is lost and restoring would discard the
	 * merge.
	 *
	 * sentry is that second declarer, and it states the difference rather than widening the
	 * rule: its title is harvested from a prose result while its url is a pure function of
	 * the nativeId, which IS the merge key — so the stored and incoming urls are necessarily
	 * identical and keeping the stored one is a NO-OP, not a regression it has to accept.
	 * A source whose url is genuinely payload-derived and can differ between two
	 * observations of one key still may not use this as-is.
	 *
	 * Only a source whose title comes from somewhere OTHER than the tool payload needs
	 * this. figma's name is harvested from role:user text across the whole transcript, so a
	 * later session that pastes a slug-less deep link (`…/design/KEY?node-id=…`, which
	 * every `figma.com/file/KEY` form also is) — or pastes none at all, which is what a
	 * resumed session does — re-derives the same reference with the fallback label and the
	 * fallback link. Because `upsertReferenceEntry` overwrites a row wholesale, measured:
	 * `小程序--Copy-` + `/design/<key>/<slug>` reverted to `Figma file bJRNYiLo` +
	 * `/file/<key>` in plans.json, in the per-reference markdown, and in the archived
	 * `CommitSummary.references` (the archiver re-reads that markdown).
	 *
	 * Deliberately a *pattern* rather than a `preferPriorHarvest` boolean: a file that was
	 * genuinely RENAMED must still update, url included — a rename yields a new slug, so
	 * the two would otherwise disagree. The narrow cost is that a real name shaped exactly
	 * like the fallback is read as one — for figma that needs a file literally named
	 * "Figma file <8 word chars>" AND a hand-written `%20` slug (Figma slugifies spaces to
	 * `-`, and `decodeSlug` deliberately does not guess them back), and the failure is
	 * "keeps the older correct title and link".
	 *
	 * Absent for every other source: a payload-derived title is not recoverable-or-not,
	 * it is simply there, and the newest read is the right answer.
	 */
	readonly titleFallbackPattern?: string;
	/**
	 * The POOREST title in {@link titleFallbackPattern}'s family — the shape this source
	 * synthesizes when the out-of-band lookup recovered nothing at all.
	 *
	 * Only meaningful alongside that pattern, and only for a source whose fallbacks are
	 * not all equally poor. sentry's are not: `Issue <shortId>` means the prose heading
	 * WAS harvested (a stable, per-issue handle) while `Issue <machineId>` means nothing
	 * was. Both match the fallback pattern, so the two-sided keep-the-prior test saw them
	 * as interchangeable and let the machine-id form supersede the short-id row — taking
	 * its `issue-id`, project and culprit with it, since the harvested set moves
	 * wholesale. Declaring the poorest form makes a poorest-form observation yield to a
	 * richer stored fallback while a richer one still supersedes a poorer stored one.
	 *
	 * Deliberately NOT a fix by narrowing `titleFallbackPattern` to the poorest form
	 * instead: an `issueId` argument is not always the machine id (a model routinely
	 * passes a short id), so the poorest shape is reachable with a short-id-looking value
	 * and must still read as a fallback against a genuinely harvested title.
	 *
	 * Absent for figma: its one fallback shape is the only one it can synthesize.
	 */
	readonly titleFallbackPoorestPattern?: string;
	readonly match: SourceMatch;
	readonly wrapperKeys: ReadonlyArray<string>;
	readonly reference: {
		readonly nativeId: FieldSpec;
		readonly title: FieldSpec;
		/**
		 * Absent ONLY for a source with no external destination at all — one whose
		 * referenced system is this repo's own memory rather than a remote service.
		 *
		 * Distinct from a spec that is present but produces nothing, which VOIDS the
		 * reference (Slack: a thread whose permalink could not be resolved is dropped,
		 * because the link exists and we simply failed to find it). Absent means there
		 * is no link to fail at. The two must not collapse: consumers that offer an
		 * open-in-browser affordance key off `Reference.url` being present.
		 */
		readonly url?: FieldSpec;
		readonly description?: FieldSpec;
		/**
		 * Optional gate evaluated before any field is read; if it produces no value
		 * (or fails its `require`), the whole Reference is voided. A plain `FieldSpec`
		 * — the same predicate every field uses — so an exact-match gate is expressed
		 * as `{ pipe, require: "^page$" }` rather than a bespoke `equals`.
		 */
		readonly guard?: FieldSpec;
	};
	readonly fields: ReadonlyArray<BagFieldSpec>;
	readonly storage: StorageSpec;
	readonly render: RenderSpec;
}
