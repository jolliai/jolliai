import { type LocalAgentBackend, LocalAgentSetupError } from "./Types.js";

const registry = new Map<string, LocalAgentBackend>();

/** Registers (or replaces) a backend under its `id`. */
export function registerBackend(backend: LocalAgentBackend): void {
	registry.set(backend.id, backend);
}

/**
 * Returns the backend for `id`, or throws a setup error listing what is
 * available. The registry is the extension point for local-agent tools
 * (claude-code, codex, cursor-agent, opencode all register at module load
 * in LlmClient); UI/CLI tool lists are derived from LOCAL_AGENT_TOOLS.
 */
export function getBackend(id: string): LocalAgentBackend {
	const backend = registry.get(id);
	if (!backend) {
		const known = [...registry.keys()].join(", ") || "(none registered)";
		throw new LocalAgentSetupError(`Unknown local agent tool "${id}". Available: ${known}.`);
	}
	return backend;
}
