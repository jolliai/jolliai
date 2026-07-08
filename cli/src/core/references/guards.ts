/**
 * Shared structural type guards for the references layer.
 *
 * Canonical home for `isObject` — the "is this a plain, non-null, non-array
 * object" predicate the DSL engine, the registry validator, and every envelope
 * parser need. Lives at the references/ root (not under `bindings/`) so the
 * engine and sources can import it without inverting the bindings→sources
 * dependency direction.
 */

/** True for a non-null, non-array `object` (a plain record we can index by string key). */
export function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
