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
}
export interface MatchCodex {
	readonly namespaceSuffix: string;
	readonly functionCallNames: ReadonlyArray<string>;
	readonly invocationTools: ReadonlyArray<string>;
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
	readonly match: SourceMatch;
	readonly wrapperKeys: ReadonlyArray<string>;
	readonly reference: {
		readonly nativeId: FieldSpec;
		readonly title: FieldSpec;
		readonly url: FieldSpec;
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
