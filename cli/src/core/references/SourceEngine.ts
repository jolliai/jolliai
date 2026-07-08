/**
 * SourceEngine — pure evaluator for the declarative `SourceDefinition` DSL.
 *
 * Everything here is a pure function of (definition, payload); there is no
 * source-specific code. The 7 closed ops (`path`, `coalesce`, `regex`,
 * `template`, `join`, `const`, `transform`) are evaluated by `evalPipe`, and
 * `extractRef` / `renderBlock` compose those pipes into the two behaviours a
 * hand-written adapter used to implement individually: building a
 * `Reference` and rendering the prompt-XML block.
 *
 * `transform` is the one op that can name code: it resolves against the
 * closed `TRANSFORMS` registry below. Config may only *select* a registered
 * transform by name — it can never define one — so untrusted phase-2 config
 * still cannot execute arbitrary code.
 */

import type { Reference, ReferenceField } from "../../Types.js";
import { escapeForAttr, escapeForText } from "../PromptXmlEscape.js";
import { isObject } from "./guards.js";
import { truncate } from "./RenderUtils.js";
import type { FieldSpec, Op, Pipe, SourceDefinition } from "./SourceDefinition.js";
import { decodeHtmlEntities } from "./sources/HtmlEntities.js";

/**
 * Compiled-regex cache. Every `pattern`/`require` is a static `SourceDefinition`
 * constant, but `walkPayload` invokes the engine once per payload node (O(nodes ×
 * fields) on the post-commit and 60s-tick paths), so recompiling per call is pure
 * waste. Keyed by `flags\u0000pattern` (a NUL that cannot appear in either half).
 */
const REGEX_CACHE = new Map<string, RegExp>();
function compileRegex(pattern: string, flags?: string): RegExp {
	const key = `${flags ?? ""}\u0000${pattern}`;
	let re = REGEX_CACHE.get(key);
	if (re === undefined) {
		re = new RegExp(pattern, flags);
		REGEX_CACHE.set(key, re);
	}
	return re;
}

/** Closed transform registry. Phase-2 config may only NAME these — never define new ones. */
export const TRANSFORMS: Readonly<Record<string, (s: string) => string>> = {
	decodeHtmlEntities,
	lowercase: (s) => s.toLowerCase(),
};

/**
 * Own-key names of {@link TRANSFORMS}. Membership check goes through this set so
 * a prototype-chain name (`toString`, `constructor`) can never pass as a valid
 * transform — the closed-registry security boundary. Set built from `Object.keys`
 * (own enumerable keys only); avoids `Object.hasOwn`, which needs an ES2022 lib.
 */
export const TRANSFORM_NAMES: ReadonlySet<string> = new Set(Object.keys(TRANSFORMS));

/** Read a dotted path. Returns the raw value (may be array/number/string/object). */
function readPath(path: string, payload: unknown): unknown {
	let cur: unknown = payload;
	for (const seg of path.split(".")) {
		if (!isObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/** Coerce a scalar leaf to string; arrays and objects stay as-is for join/template. */
function toScalar(v: unknown): string | undefined {
	if (typeof v === "string") return v.length > 0 ? v : undefined;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return undefined;
}

function expand(tpl: string, m: RegExpExecArray): string {
	return tpl.replace(/\$(\d+)/g, (_x, d: string) => m[Number(d)] ?? "");
}

// Evaluation threads an intermediate value (unknown) through ops; final result coerced to string.
function applyOp(op: Op, input: unknown, payload: unknown, first: boolean): unknown {
	switch (op.op) {
		case "path":
			// The FIRST op in a pipe reads from the root payload; a `path` op anywhere
			// else reads the value threaded from the previous op. Detecting "first" via
			// `input === undefined` was wrong: a non-first `path` following an op that
			// yielded `undefined` (e.g. `[coalesce, path]`) would silently re-read the
			// root payload instead of staying `undefined`, pulling a value from the wrong
			// object.
			return readPath(op.path, first ? payload : input);
		case "const":
			return op.value;
		case "coalesce": {
			for (const branch of op.of) {
				const r = evalPipeRaw(branch, payload);
				// A branch is "found" only when it yields a non-empty STRING. Everything
				// else falls through to the next branch:
				//   - objects (e.g. a `{ name: "Urgent" }` priority shape) so a later branch
				//     can read the sub-field (`priority.name`);
				//   - non-string scalars (numbers, booleans) because these fields are
				//     string-or-`{name}` by contract — a bare numeric priority/milestone/type
				//     is not a display value and must be dropped, matching the pre-migration
				//     adapters' `readObjectName`/`readPriority` (see GoldenParity numeric cases).
				if (typeof r === "string" && r.length > 0) return r;
			}
			return undefined;
		}
		case "join": {
			if (!Array.isArray(input)) return undefined;
			const parts = input.filter((x): x is string => typeof x === "string" && x.length > 0);
			return parts.length > 0 ? parts.join(op.sep) : undefined;
		}
		case "template": {
			const values: Record<string, string> = {};
			for (const [name, sub] of Object.entries(op.from)) {
				const v = evalPipe(sub, payload);
				if (v === undefined) return undefined; // any missing slot voids the template
				values[name] = v;
			}
			return op.template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k]);
		}
		case "regex": {
			const s = toScalar(input);
			if (s === undefined) return undefined;
			if (op.lastMatch) {
				// Keep only the last match instead of materializing the whole iterator.
				// `matchAll` copies the regex internally, so the cached instance is safe to reuse.
				let last: RegExpExecArray | undefined;
				for (const m of s.matchAll(compileRegex(op.pattern, "g"))) last = m;
				if (last === undefined) return undefined;
				return op.extract ? expand(op.extract, last) : (last[1] ?? last[0]);
			}
			const m = compileRegex(op.pattern).exec(s);
			if (m === null) return undefined;
			// No `extract`: prefer the first capture group, else the whole match — kept
			// identical to the `lastMatch` branch above so a maintainer's mental model
			// ("a capture group yields that group") holds regardless of `lastMatch`.
			return op.extract ? expand(op.extract, m) : (m[1] ?? m[0]);
		}
		case "transform": {
			if (!TRANSFORM_NAMES.has(op.fn)) throw new Error(`unknown transform: ${op.fn}`);
			const fn = TRANSFORMS[op.fn];
			const s = toScalar(input);
			return s === undefined ? undefined : fn(s);
		}
	}
}

/** Evaluate a pipe, returning the raw threaded value (array/number/string). */
function evalPipeRaw(pipe: Pipe, payload: unknown): unknown {
	let acc: unknown;
	let first = true;
	for (const op of pipe) {
		acc = applyOp(op, acc, payload, first);
		first = false;
	}
	return acc;
}

/** Public: evaluate a pipe to a final display string (or undefined). */
export function evalPipe(pipe: Pipe, payload: unknown): string | undefined {
	const raw = evalPipeRaw(pipe, payload);
	if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
	return toScalar(raw);
}

// ---------------------------------------------------------------------------
// extractRef
// ---------------------------------------------------------------------------

function evalField(spec: FieldSpec, payload: unknown): { ok: true; value: string | undefined } | { ok: false } {
	const v = evalPipe(spec.pipe, payload);
	if (v === undefined || v === "") {
		if (spec.optional) return { ok: true, value: undefined };
		return { ok: false }; // required-but-missing → void
	}
	if (spec.require !== undefined) {
		const re = compileRegex(spec.require, spec.requireFlags);
		re.lastIndex = 0; // defensive: a cached regex with a global flag carries state across calls
		if (re.exec(v) === null) return { ok: false };
	}
	return { ok: true, value: v };
}

export function extractRef(
	def: SourceDefinition,
	payload: unknown,
	toolName: string,
	referencedAt: string,
): Reference | null {
	if (!isObject(payload)) return null;

	// The guard is a FieldSpec that must produce a value (and pass its `require`) —
	// the same predicate mechanism every other field uses, not a bespoke gate.
	const guard = def.reference.guard;
	if (guard !== undefined) {
		const g = evalField(guard, payload);
		if (!g.ok || g.value === undefined) return null;
	}

	const nativeIdR = evalField(def.reference.nativeId, payload);
	const titleR = evalField(def.reference.title, payload);
	const urlR = evalField(def.reference.url, payload);
	if (!nativeIdR.ok || !titleR.ok || !urlR.ok) return null;
	if (nativeIdR.value === undefined || titleR.value === undefined) return null;
	// url may be undefined only when the definition marks it optional (Slack);
	// evalField already voided a required-but-missing url via urlR.ok === false.

	const descR = def.reference.description
		? evalField(def.reference.description, payload)
		: { ok: true as const, value: undefined };
	if (!descR.ok) return null;

	const fields: ReferenceField[] = [];
	for (const f of def.fields) {
		const val = evalPipe(f.pipe, payload);
		if (val === undefined || val === "") continue;
		fields.push({ key: f.key, label: f.label, value: val, ...(f.icon !== undefined ? { icon: f.icon } : {}) });
	}

	return {
		mapKey: `${def.id}:${nativeIdR.value}`,
		source: def.id,
		nativeId: nativeIdR.value,
		title: titleR.value,
		...(urlR.value !== undefined ? { url: urlR.value } : {}),
		...(descR.value !== undefined ? { description: descR.value } : {}),
		...(fields.length > 0 ? { fields } : {}),
		toolName,
		referencedAt,
	};
}

// ---------------------------------------------------------------------------
// renderBlock
// ---------------------------------------------------------------------------

function renderOne(def: SourceDefinition, ref: Reference): string {
	const attrs: string[] = [`id="${escapeForAttr(ref.nativeId)}"`];
	if (def.render.fieldAttrs !== false && ref.fields) {
		for (const f of ref.fields) attrs.push(`${f.key}="${escapeForAttr(f.value)}"`);
	}
	const lines = [`<${def.render.itemTag} ${attrs.join(" ")}>`];
	lines.push(`  <title>${escapeForText(ref.title)}</title>`);
	if (ref.url !== undefined && ref.url.length > 0) lines.push(`  <url>${escapeForText(ref.url)}</url>`);
	if (ref.description !== undefined && ref.description.length > 0) {
		lines.push(`  <${def.render.bodyTag}>`);
		lines.push(escapeForText(truncate(ref.description, def.render.maxCharsPerReference)));
		lines.push(`  </${def.render.bodyTag}>`);
	}
	lines.push(`</${def.render.itemTag}>`);
	return lines.join("\n");
}

export function renderBlock(def: SourceDefinition, refs: ReadonlyArray<Reference>): string {
	if (refs.length === 0) return "";
	const sorted = [...refs].sort((a, b) => a.referencedAt.localeCompare(b.referencedAt)).reverse();
	// Render once and keep the string; `skip` (not `break`) so one large newest
	// reference cannot starve smaller older ones that still fit the budget.
	const selected: Array<{ ref: Reference; rendered: string }> = [];
	let total = 0;
	for (const r of sorted) {
		const rendered = renderOne(def, r);
		if (total + rendered.length > def.render.maxTotalChars) continue;
		selected.push({ ref: r, rendered });
		total += rendered.length;
	}
	if (selected.length === 0) return "";
	selected.reverse();
	const body = selected.map((s) => s.rendered).join("\n");
	return `<${def.render.wrapperTag}>\n${body}\n</${def.render.wrapperTag}>`;
}
