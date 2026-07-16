import { type LocalAgentBackend, LocalAgentSetupError } from "./Types.js";

const registry = new Map<string, LocalAgentBackend>();

/** Registers (or replaces) a backend under its `id`. */
export function registerBackend(backend: LocalAgentBackend): void {
	registry.set(backend.id, backend);
}

/**
 * Returns the backend for `id`, or throws a setup error listing what is
 * available. v1 registers only "claude-code" (see ClaudeCodeBackend); the
 * registry is the extension point for future tools (Codex, Cursor).
 */
export function getBackend(id: string): LocalAgentBackend {
	const backend = registry.get(id);
	if (!backend) {
		const known = [...registry.keys()].join(", ") || "(none registered)";
		throw new LocalAgentSetupError(`Unknown local agent tool "${id}". Available: ${known}.`);
	}
	return backend;
}
