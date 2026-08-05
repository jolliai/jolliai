/**
 * DocIdReuse — the env-key document-id reuse gate.
 *
 * Extracted from `JolliMemoryPushOrchestrator` (which re-exports it, so callers and
 * tests keep importing it from there) so the generic push engine can use it without
 * importing the orchestrator, which would close a cycle through the kind definitions.
 * The implementation is unchanged.
 */

import { deriveJolliEnvKey } from "../JolliApiUtils.js";

/**
 * A stored `jolliDocId` may be reused as an update target only when the article
 * URL it was minted with points at the current push env. The env is NOT stored
 * separately — the doc URL's origin already IS it, so `deriveJolliEnvKey(storedUrl)`
 * recovers the backend the id belongs to. A URL from a different origin means the
 * id lives on another backend, so we drop it and let the server create a fresh doc.
 *
 * A missing URL is legacy / never-pushed data (nothing to conflict with) →
 * reuse allowed, preserving the pre-tagging always-reuse behavior. An unparseable
 * URL is likewise treated as env-agnostic rather than throwing.
 */
export function canReuseDocId(storedDocUrl: string | undefined, currentEnv: string): boolean {
	if (!storedDocUrl) return true;
	try {
		return deriveJolliEnvKey(storedDocUrl) === currentEnv;
	} catch {
		return true;
	}
}
