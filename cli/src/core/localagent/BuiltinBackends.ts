/**
 * Registers the five shipped local-agent backends.
 *
 * Importing this module for its side effect is the ONLY supported way to
 * populate the registry. It exists because registration used to live at module
 * scope in LlmClient, which made a populated registry an invisible consequence
 * of importing an unrelated module: any other consumer calling `getBackend()`
 * first saw an empty registry and threw "Unknown local agent tool". Both
 * LlmClient and DetectAgents import this instead.
 *
 * Registration order is irrelevant here — `registerBackend` keys by id, and the
 * ordering authority for anything user-facing is LOCAL_AGENT_TOOLS, not this
 * file.
 */
import { registerBackend } from "./BackendRegistry.js";
import { ClaudeCodeBackend } from "./ClaudeCodeBackend.js";
import { CodexBackend } from "./CodexBackend.js";
import { CursorAgentBackend } from "./CursorAgentBackend.js";
import { KimiCodeBackend } from "./KimiCodeBackend.js";
import { OpenCodeBackend } from "./OpenCodeBackend.js";

registerBackend(new ClaudeCodeBackend());
registerBackend(new CursorAgentBackend());
registerBackend(new CodexBackend());
registerBackend(new OpenCodeBackend());
registerBackend(new KimiCodeBackend());
