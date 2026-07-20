/**
 * runInkTui — real-seam bootstrap for the Ink control-center TUI. Initializes
 * storage + logging (bare `jolli` reaches here directly, so this is the only
 * place that guarantees reads go through the active storage provider), then
 * mounts TuiApp once and stays mounted for the whole session. Palette commands
 * no longer unmount/remount Ink or write to the raw terminal — HomeScreen runs
 * them CAPTURED (via `deps.runCommand`) and shows the output in an in-TUI panel.
 * That eliminated the old "界面变成三段/五段" stacking (which came from unmount →
 * inherited-stdio child → remount). Only `q` / Ctrl-C exit.
 *
 * This whole file is v8-ignored: it is the real Ink render + raw stdin seam.
 * Screen behavior is covered via ink-testing-library component tests with a fake
 * TuiDeps; this bootstrap is trivial glue.
 */
import { render } from "ink";
import { createStorage } from "../../core/StorageFactory.js";
import { setActiveStorage } from "../../core/SummaryStore.js";
import { setLogDir } from "../../Logger.js";
import type { CommandCatalogEntry } from "./CommandCatalog.js";
import { type Tab, TuiApp } from "./TuiApp.js";
import { buildTuiDeps } from "./TuiDeps.js";

/* v8 ignore start -- real Ink render + raw stdin seam; covered via component tests */

export async function runInkTui(
	cwd: string,
	initialTab: Tab = "home",
	catalog: CommandCatalogEntry[] = [],
): Promise<void> {
	setLogDir(cwd);
	setActiveStorage(await createStorage(cwd, cwd));
	const deps = buildTuiDeps(cwd);

	// `alternateScreen: true` lets Ink own the whole viewport as a fixed-height
	// layout (tab bar + bottom bars pinned, only inner lists scroll — see TuiApp),
	// so switching to a taller tab can no longer push the header out of view. Ink
	// enters the alternate screen in its constructor and restores the primary
	// buffer on unmount AND via its signalExit handler — so a crash or signal can't
	// strand the terminal on the blank alt screen (a hand-written `?1049h/l` around
	// waitUntilExit could, if render() itself threw). Only `q` / Ctrl-C exit.
	const instance = render(<TuiApp deps={deps} initialTab={initialTab} catalog={catalog} />, {
		alternateScreen: true,
	});
	await instance.waitUntilExit();
}
/* v8 ignore stop */
