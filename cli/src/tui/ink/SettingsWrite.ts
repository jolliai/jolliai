/**
 * SettingsWrite — the config write path for the Settings screen, with the
 * side-effect map the plan calls for. Most fields are a plain `saveConfig`
 * partial update, but some require a follow-up action to actually take effect —
 * e.g. `globalInstructions` must re-run `syncGlobalInstructions()` or the host
 * instruction files stay stale (mirrors ConfigureCommand's `--set` handler).
 *
 * Audited against ConfigureCommand: `globalInstructions` is the only `--set`
 * key with a post-save action today. Add new entries here when a field grows a
 * side effect, so the TUI and CLI can't diverge.
 */
import { saveConfig } from "../../core/SessionTracker.js";
import { syncGlobalInstructions } from "../../install/Installer.js";
import type { JolliMemoryConfig } from "../../Types.js";

const SIDE_EFFECTS: Partial<Record<keyof JolliMemoryConfig, () => Promise<void>>> = {
	globalInstructions: () => syncGlobalInstructions(),
};

/** Persist one config field, then run its side effect (if any). */
export async function applySetting<K extends keyof JolliMemoryConfig>(
	key: K,
	value: JolliMemoryConfig[K],
): Promise<void> {
	await saveConfig({ [key]: value } as Partial<JolliMemoryConfig>);
	const effect = SIDE_EFFECTS[key];
	if (effect) await effect();
}
