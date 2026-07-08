/**
 * SourceDefinitionRegistry — loads, validates, and answers identity lookups
 * for the built-in `SourceDefinition`s.
 *
 * `match()` mirrors the identity-resolution logic that used to live
 * separately in `ClaudeEnvelopeParser`'s prefix table and `CodexEnvelopeParser`'s
 * namespace/invocation-tool tables:
 *   - claude: first definition whose `match.claude.prefixes` has a prefix the
 *     tool name starts with; if that definition also declares `acceptSuffix`,
 *     the tool name must end with it too (Notion's "notion-fetch" gate — a
 *     prefix match with the wrong suffix is not a match at all).
 *   - codex, with a namespace (function_call path): first definition whose
 *     `match.codex.namespaceSuffix` equals the namespace AND whose
 *     `functionCallNames` includes the tool name (disambiguates names like
 *     `_fetch` that are shared across sources).
 *   - codex, without a namespace (invocation-tool path): first definition
 *     whose `match.codex.invocationTools` includes the tool name.
 */

import { isObject } from "./guards.js";
import type { Op, SourceDefinition } from "./SourceDefinition.js";
import { TRANSFORM_NAMES } from "./SourceEngine.js";
import { BUILTIN_DEFINITIONS } from "./sources/definitions/index.js";

export type SourceAgent = "claude" | "codex";

const MAX_OPS_PER_PIPE = 64;
const MAX_NESTING_DEPTH = 8;

const OP_KINDS = new Set(["path", "coalesce", "regex", "template", "join", "const", "transform"]);

/** Mutable counter threaded through pipe validation; one instance per top-level pipe. */
interface ValidationCtx {
	opCount: number;
}

/**
 * Validates one op. Recurses into `coalesce`/`template` sub-pipes, tracking
 * nesting depth separately from the flat op-count cap so a wide-but-shallow
 * pipe and a narrow-but-deep pipe are each rejected for the right reason.
 */
function validateOp(op: unknown, depth: number, ctx: ValidationCtx): string | undefined {
	if (!isObject(op)) return "op must be an object";
	ctx.opCount++;
	if (ctx.opCount > MAX_OPS_PER_PIPE) return `pipe exceeds ${MAX_OPS_PER_PIPE} ops`;
	const kind = op.op;
	if (typeof kind !== "string" || !OP_KINDS.has(kind)) return `unknown op: ${String(kind)}`;

	switch (kind as Op["op"]) {
		case "path":
			return typeof op.path === "string" ? undefined : "path op requires a string 'path'";
		case "const":
			return typeof op.value === "string" ? undefined : "const op requires a string 'value'";
		case "join":
			return typeof op.sep === "string" ? undefined : "join op requires a string 'sep'";
		case "regex": {
			if (typeof op.pattern !== "string") return "regex op requires a string 'pattern'";
			if (op.extract !== undefined && typeof op.extract !== "string") return "regex.extract must be a string";
			if (op.lastMatch !== undefined && typeof op.lastMatch !== "boolean")
				return "regex.lastMatch must be a boolean";
			return undefined;
		}
		case "transform": {
			if (typeof op.fn !== "string") return "transform op requires a string 'fn'";
			return TRANSFORM_NAMES.has(op.fn) ? undefined : `unknown transform: ${op.fn}`;
		}
		case "coalesce": {
			if (depth + 1 > MAX_NESTING_DEPTH) return `nesting depth exceeds ${MAX_NESTING_DEPTH}`;
			if (!Array.isArray(op.of)) return "coalesce op requires an array 'of'";
			for (const branch of op.of) {
				const err = validatePipe(branch, depth + 1, ctx);
				if (err !== undefined) return err;
			}
			return undefined;
		}
		case "template": {
			if (depth + 1 > MAX_NESTING_DEPTH) return `nesting depth exceeds ${MAX_NESTING_DEPTH}`;
			if (typeof op.template !== "string") return "template op requires a string 'template'";
			if (!isObject(op.from)) return "template op requires an object 'from'";
			for (const sub of Object.values(op.from)) {
				const err = validatePipe(sub, depth + 1, ctx);
				if (err !== undefined) return err;
			}
			return undefined;
		}
	}
}

function validatePipe(pipe: unknown, depth: number, ctx: ValidationCtx): string | undefined {
	if (!Array.isArray(pipe)) return "pipe must be an array";
	for (const op of pipe as unknown[]) {
		const err = validateOp(op, depth, ctx);
		if (err !== undefined) return err;
	}
	return undefined;
}

/** Validates a single top-level `Pipe` field, with its own fresh op-count budget. */
function validateTopLevelPipe(pipe: unknown, label: string): string | undefined {
	const err = validatePipe(pipe, 0, { opCount: 0 });
	return err === undefined ? undefined : `${label}: ${err}`;
}

const FIELD_KEY_PATTERN = /^[\w-]+$/;

/**
 * Structurally validates an unknown value as a `SourceDefinition`.
 *
 * Checks required top-level keys, non-empty `id`/`label`/`icon`, the
 * `fields[].key` charset, and every `Pipe` reachable from the definition
 * (op vocabulary, `transform.fn` against the closed `TRANSFORMS` registry,
 * per-pipe op-count cap, and coalesce/template nesting depth cap).
 *
 * This does not (yet) deep-validate `match`/`storage`/`render` beyond
 * presence — those are internal wiring for built-ins today and gain no
 * safety from stricter checks until phase-2 lets users author `match` too.
 */
export function validateDefinition(def: unknown): { ok: true; def: SourceDefinition } | { ok: false; error: string } {
	if (!isObject(def)) return { ok: false, error: "definition must be an object" };

	if (typeof def.id !== "string" || def.id.length === 0) return { ok: false, error: "id must be a non-empty string" };
	if (typeof def.label !== "string" || def.label.length === 0) {
		return { ok: false, error: "label must be a non-empty string" };
	}
	if (typeof def.icon !== "string" || def.icon.length === 0) {
		return { ok: false, error: "icon must be a non-empty string" };
	}
	if (!isObject(def.match)) return { ok: false, error: "match must be an object" };
	if (!Array.isArray(def.wrapperKeys)) return { ok: false, error: "wrapperKeys must be an array" };
	if (!isObject(def.reference)) return { ok: false, error: "reference must be an object" };
	if (!Array.isArray(def.fields)) return { ok: false, error: "fields must be an array" };
	if (!isObject(def.storage)) return { ok: false, error: "storage must be an object" };
	if (!isObject(def.render)) return { ok: false, error: "render must be an object" };

	const reference = def.reference;
	for (const key of ["nativeId", "title", "url"] as const) {
		const spec = reference[key];
		if (!isObject(spec)) return { ok: false, error: `reference.${key} is required` };
		const err = validateTopLevelPipe(spec.pipe, `reference.${key}.pipe`);
		if (err !== undefined) return { ok: false, error: err };
	}
	if (reference.description !== undefined) {
		if (!isObject(reference.description)) return { ok: false, error: "reference.description must be an object" };
		const err = validateTopLevelPipe(reference.description.pipe, "reference.description.pipe");
		if (err !== undefined) return { ok: false, error: err };
	}
	if (reference.guard !== undefined) {
		if (!isObject(reference.guard)) return { ok: false, error: "reference.guard must be an object" };
		const err = validateTopLevelPipe(reference.guard.pipe, "reference.guard.pipe");
		if (err !== undefined) return { ok: false, error: err };
	}

	for (const [i, f] of (def.fields as unknown[]).entries()) {
		if (!isObject(f)) return { ok: false, error: `fields[${i}] must be an object` };
		if (typeof f.key !== "string" || !FIELD_KEY_PATTERN.test(f.key)) {
			return { ok: false, error: `fields[${i}].key must match ${FIELD_KEY_PATTERN}` };
		}
		if (typeof f.label !== "string" || f.label.length === 0) {
			return { ok: false, error: `fields[${i}].label must be a non-empty string` };
		}
		const err = validateTopLevelPipe(f.pipe, `fields[${i}].pipe`);
		if (err !== undefined) return { ok: false, error: err };
	}

	return { ok: true, def: def as unknown as SourceDefinition };
}

export class SourceDefinitionRegistry {
	private readonly definitions: ReadonlyArray<SourceDefinition>;

	constructor(definitions: ReadonlyArray<SourceDefinition>) {
		this.definitions = definitions;
	}

	all(): ReadonlyArray<SourceDefinition> {
		return this.definitions;
	}

	byId(id: string): SourceDefinition | undefined {
		return this.definitions.find((d) => d.id === id);
	}

	/**
	 * Resolves the definition that owns a tool invocation.
	 * - `agent === "claude"`: prefix + optional `acceptSuffix` match.
	 * - `agent === "codex"` with `namespace`: `namespaceSuffix` + `functionCallNames` match.
	 * - `agent === "codex"` without `namespace`: `invocationTools` match.
	 */
	match(agent: SourceAgent, toolName: string, namespace?: string): SourceDefinition | undefined {
		if (agent === "claude") {
			return this.definitions.find((d) => {
				const m = d.match.claude;
				if (m === undefined || !m.prefixes.some((prefix) => toolName.startsWith(prefix))) return false;
				return m.acceptSuffix === undefined || toolName.endsWith(m.acceptSuffix);
			});
		}

		if (namespace !== undefined) {
			return this.definitions.find((d) => {
				const m = d.match.codex;
				return m !== undefined && m.namespaceSuffix === namespace && m.functionCallNames.includes(toolName);
			});
		}
		return this.definitions.find((d) => d.match.codex?.invocationTools.includes(toolName));
	}
}

let singleton: SourceDefinitionRegistry | undefined;

/**
 * Returns the process-wide `SourceDefinitionRegistry`, built once from
 * `BUILTIN_DEFINITIONS` on first call. Fails fast: an invalid built-in
 * definition throws instead of silently dropping a source, since built-ins
 * ship with the package and an invalid one is a bug in this repo, not
 * untrusted input.
 *
 * Phase-2 seam (not implemented here): a future `loadUser()` will read
 * user-authored definitions from disk, run each through `validateDefinition`,
 * and — unlike this fail-fast built-in load — *skip* (with a warning) any
 * definition that fails validation, re-validating `transform.fn` against the
 * same closed `TRANSFORMS` registry so untrusted config can still only name
 * an allow-listed transform, never define one.
 */
export function getRegistry(): SourceDefinitionRegistry {
	if (singleton !== undefined) return singleton;

	const validated: SourceDefinition[] = [];
	for (const raw of BUILTIN_DEFINITIONS) {
		const result = validateDefinition(raw);
		if (!result.ok) throw new Error(`invalid built-in source definition '${raw.id}': ${result.error}`);
		validated.push(result.def);
	}
	singleton = new SourceDefinitionRegistry(validated);
	return singleton;
}
