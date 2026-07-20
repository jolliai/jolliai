/**
 * TuiApp — the control-center tab shell. Owns the active tab, the global keys
 * (Tab / Shift-Tab cycle, 1-4 jump, q / Ctrl-C quit, `/` command palette), the
 * global command runner (palette + captured output, usable from ANY tab), and
 * the single bottom StatusBar. Screens own only their own navigation keys and
 * report their context-specific hints up via `onHints`.
 *
 * Input model: the shell and the active screen each run their own `useInput`;
 * Ink dispatches every keypress to all active handlers. A single derived `focus`
 * value (palette | capture | output | screen — see the computation below) is the
 * ONE source of truth for which handlers are live this frame, so the gating rule
 * lives in one place instead of scattered booleans. (The shell deliberately does
 * NOT centralize into a single dispatcher: screens keep their own `useInput` so
 * each is testable in isolation with `ink-testing-library` + stdin.) Screens must
 * avoid binding any RESERVED_GLOBALS key for navigation, since in "screen" focus
 * the shell's global handler and the screen's handler both receive the key.
 *
 * Overlay model: while the palette or output panel is open, its `node` is
 * anchored as a bottom command bar; the active screen stays mounted (so its
 * navigation state and in-flight loads survive) but its input is paused via
 * `screenInputActive`. The tab bar stays visible; switching tab closes the
 * overlay. Cross-tab navigation state is preserved in a shell-owned store (see
 * TuiState), and row budgets adapt to terminal height (see useTerminalSize).
 *
 * The tab bar + globals apply only in the `dashboard` layout; while Home reports
 * `wizard` (setup incomplete) the shell locks to Home with no tabs and no `/`.
 */
import { Box, Text, useApp, useInput } from "ink";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { type CommandCatalogEntry, orderCatalogForContext } from "./CommandCatalog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { HomeScreen } from "./HomeScreen.js";
import { MemoriesScreen } from "./MemoriesScreen.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { StatusBar } from "./StatusBar.js";
import type { TuiDeps } from "./TuiDeps.js";
import type { TuiStateStore } from "./TuiState.js";
import { useCommandRunner } from "./useCommandRunner.js";
import { useTerminalSize } from "./useTerminalSize.js";

export const TABS = ["home", "memories", "memory-bank", "settings"] as const;
export type Tab = (typeof TABS)[number];

/** Who owns the keyboard this frame — the single gate every input predicate is
 *  derived from (see the `focus` computation in TuiApp). */
export type Focus = "palette" | "capture" | "output" | "screen";

/** The keys the shell reserves globally in "screen"/"output" focus (see the
 *  focus model). Screens run their own `useInput` alongside the shell's — Ink
 *  dispatches each keypress to every active handler — so a screen MUST NOT bind
 *  any key in this set for navigation, or it would fire the global action too.
 *  Documented here (not runtime-enforced) as the contract for screen authors. */
export const RESERVED_GLOBALS = ["/", "Tab", "1", "2", "3", "4", "q", "Ctrl-C"] as const;

const LABELS: Record<Tab, string> = {
	home: "Home",
	memories: "Current Branch",
	"memory-bank": "Memory Bank",
	settings: "Settings",
};

/** Top-level command names (argv[0]) whose completion changes Home-visible
 *  account/setup state the periodic poll doesn't cover (the poll only patches
 *  queue/ingest/last-sync/Space, never the config-derived credential + wizard
 *  rows). `auth` → Sign-in + credentials; `bind` → Space binding; `configure` →
 *  apiKey / jolliApiKey / aiProvider / jolliUrl, which the onboarding + dashboard
 *  read directly (see HomeSnapshot / OnboardingModel), so a `/configure --set`
 *  or `--remove` must re-read the full model or the wizard/dashboard, credential
 *  rows, and cloud-sync availability show stale until the next auth/bind or a
 *  restart; `uninstall` tears the install down (enabled → wizard) and is runnable
 *  from the palette (not in PALETTE_EXCLUDE), so without a reload the dashboard
 *  keeps showing a healthy enabled setup until restart. Keep minimal: most
 *  commands are read-only or already polled. */
const HOME_AFFECTING_COMMANDS = new Set(["auth", "bind", "configure", "uninstall"]);

/** Top-level command names whose completion changes STORED MEMORIES the Memories
 *  tab reads. `backfill` generates summaries and `compile` regenerates the wiki /
 *  topic pages — both run OUTSIDE the post-commit queue worker, so MemoriesScreen's
 *  busy→idle poll never sees them; they need an explicit reload signal. */
const MEMORY_AFFECTING_COMMANDS = new Set(["backfill", "compile"]);

/** Top-level command names whose completion changes what the SETTINGS tab reads
 *  (getStatus host flags, config values, installed skills). `configure` rewrites
 *  the config rows; `auth` changes the AI Summary credential rows; `uninstall`
 *  tears down hooks/MCP/skills. The palette is prioritized toward these on the
 *  Settings tab (see CommandCatalog), so without a reload the config/host/skill
 *  rows stay stale until the user switches tabs. */
const SETTINGS_AFFECTING_COMMANDS = new Set(["auth", "configure", "uninstall"]);

function cycle(current: Tab, dir: 1 | -1): Tab {
	const next = (TABS.indexOf(current) + dir + TABS.length) % TABS.length;
	return TABS[next];
}

export function TuiApp({
	deps,
	initialTab = "home",
	catalog = [],
}: {
	deps: TuiDeps;
	initialTab?: Tab;
	catalog?: CommandCatalogEntry[];
}): ReactElement {
	const app = useApp();
	const [tab, setTab] = useState<Tab>("home");
	// A screen with a text input (Memories `f` search, Home key entry, Settings
	// folder edit) sets this so the global shortcuts below pause and don't eat
	// typed characters.
	const [capturing, setCapturing] = useState(false);
	// The active screen's context-specific key hints, shown in the StatusBar.
	const [screenHints, setScreenHints] = useState("");
	// Home reports the layout; undefined until its first load. Tabs + `/` show
	// only in "dashboard". `wizard` (or unknown) locks to Home with no tab bar.
	const [layout, setLayout] = useState<"wizard" | "dashboard" | undefined>(undefined);
	const jumped = useRef(false);
	// Shell-owned store so each screen's navigation state survives tab switches
	// (screens unmount when inactive; see TuiState). Ref → outlives every screen.
	const stateStore = useRef<TuiStateStore>(new Map()).current;
	// Live terminal height drives the fixed-height layout: the root column is
	// pinned to `rows`, the screen region flex-grows into the leftover and CLIPS
	// its overflow, so the tab bar (top) and bottom bars stay put no matter how
	// tall the active screen's content is. `rows` is undefined under the test
	// renderer / height-less pipes → no height is set → inline auto-height (the
	// pre-existing behaviour), so component tests are unaffected.
	const { rows } = useTerminalSize();

	const showTabs = layout === "dashboard";
	const active: Tab = showTabs ? tab : "home";

	// Bumped when a palette command finishes that changes state a screen reads but
	// its periodic poll doesn't cover. Two independent keys so each screen reloads
	// only for its own commands (the reload re-runs a heavy read — don't fan it out
	// to screens that don't care). Keyed on argv[0] — `auth login`/`auth logout`
	// both arrive as "auth". See HOME_/MEMORY_AFFECTING_COMMANDS above.
	const [reloadKey, setReloadKey] = useState(0);
	const [memoriesReloadKey, setMemoriesReloadKey] = useState(0);
	const [settingsReloadKey, setSettingsReloadKey] = useState(0);

	// The global command palette + captured-output overlay, usable from any tab.
	// The catalog is reordered for the active tab so the palette leads with the
	// commands most relevant there — memory commands on Memories, config/install
	// commands on Settings; Home keeps the natural catalog order.
	// Memory Bank shares the Memories command priority (recall / search / …).
	const catalogContext = active === "memory-bank" ? "memories" : active;
	const runner = useCommandRunner(deps, orderCatalogForContext(catalog, catalogContext), (argv) => {
		if (HOME_AFFECTING_COMMANDS.has(argv[0])) setReloadKey((n) => n + 1);
		if (MEMORY_AFFECTING_COMMANDS.has(argv[0])) setMemoriesReloadKey((n) => n + 1);
		if (SETTINGS_AFFECTING_COMMANDS.has(argv[0])) setSettingsReloadKey((n) => n + 1);
	});

	// Focus — the single source of truth for who owns the keyboard this frame.
	// Every input gate below is derived from it (previously each was an ad-hoc
	// boolean expression, easy to get subtly out of sync). Precedence matters:
	//   palette  — modal: the command palette captures ALL keys.
	//   capture  — a screen text field is being typed into (search / key entry /
	//              inline edit); the shell's global keys pause so they aren't eaten.
	//   output   — the command output panel is open; NON-modal (globals still work,
	//              so Tab/q/1-4 switch or quit; the runner handles ↑↓/Esc/`/`).
	//   screen   — the normal case: the active screen owns its nav keys and the
	//              shell owns the global keys simultaneously (see RESERVED_GLOBALS).
	const focus: Focus = runner.paletteOpen
		? "palette"
		: capturing
			? "capture"
			: runner.outputOpen
				? "output"
				: "screen";
	// The screen renders behind palette/output but its input is paused there.
	const overlayOpen = focus === "palette" || focus === "output";
	// The active screen handles keys in "screen" (nav) and "capture" (its field).
	const screenInputActive = focus === "screen" || focus === "capture";
	// The shell's global keys are live in "screen" and "output" (never while the
	// palette is modal or a screen field is capturing typed characters). While a
	// command is actually RUNNING, globals pause too — otherwise Tab/q would
	// silently abort a write command (e.g. `/backfill --generate`); only Esc
	// (handled by the runner) cancels. Globals return the moment it finishes.
	const globalKeysActive = focus === "screen" || (focus === "output" && !runner.running);

	// When setup first completes, honour the requested initial tab.
	useEffect(() => {
		if (layout === "dashboard" && !jumped.current) {
			jumped.current = true;
			if (initialTab !== "home") setTab(initialTab);
		}
	}, [layout, initialTab]);

	// A command run from the palette can collapse the dashboard back into the
	// onboarding wizard (e.g. `/uninstall` removes the config, so HomeScreen
	// reports layout="wizard" on the reload). The wizard has no tabs and no
	// command bar, so the output panel is unmounted — but the runner's
	// `outputOpen` would otherwise stay true and pin focus on the vanished
	// panel, freezing the wizard's own input. Close the runner so focus returns
	// to the screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: react only to the layout collapse; runner.close is a stable no-op when nothing is open
	useEffect(() => {
		if (layout === "wizard") runner.close();
	}, [layout]);

	useInput(
		(input, key) => {
			if (input === "q" || (key.ctrl && input === "c")) {
				app.exit();
				return;
			}
			if (!showTabs) return; // wizard: nowhere to switch to, no palette
			// `/` opens the command palette from any tab. (While the OUTPUT panel is
			// open the runner's own useInput handles `/`, so skip it here.)
			if (input === "/" && !runner.outputOpen) {
				runner.open();
				return;
			}
			if (key.tab) {
				runner.close(); // switching tab hides any open overlay
				setTab((t) => cycle(t, key.shift ? -1 : 1));
				return;
			}
			if (/^[1-4]$/.test(input)) {
				runner.close();
				setTab(TABS[Number(input) - 1]);
			}
		},
		{ isActive: globalKeysActive },
	);

	return (
		<Box flexDirection="column" height={rows}>
			{showTabs && (
				<Box flexShrink={0}>
					{TABS.map((t) => (
						<Text key={t} bold={t === active} color={t === active ? "cyan" : "gray"}>
							{" "}
							{LABELS[t]}{" "}
						</Text>
					))}
				</Box>
			)}
			{/* The active screen's input is paused while an overlay is open; the
			    command UI is anchored as a bottom command bar below. Each screen is
			    wrapped in an ErrorBoundary keyed by tab, so a render-time crash shows
			    a notice instead of tearing down Ink, and switching tab recovers.
			    flexGrow + overflow:hidden — this region absorbs the leftover height and
			    clips any overflow, so a tall screen can't push the pinned bars away. */}
			<Box marginTop={showTabs ? 1 : 0} flexDirection="column" flexGrow={1} overflow="hidden">
				{/* On a render crash, release any stuck capture state so the fallback's
				    tab-switch / `q` recovery keys are live — the crashed screen can no
				    longer call onCapture(false) itself (see the focus/globalKeys gate). */}
				<ErrorBoundary key={active} onError={() => setCapturing(false)}>
					{active === "home" && (
						<HomeScreen
							deps={deps}
							onCapture={setCapturing}
							onLayout={setLayout}
							onHints={setScreenHints}
							active={screenInputActive}
							reloadKey={reloadKey}
						/>
					)}
					{active === "memories" && (
						<MemoriesScreen
							deps={deps}
							variant="memories"
							onCapture={setCapturing}
							onHints={setScreenHints}
							active={screenInputActive}
							store={stateStore}
							reloadKey={memoriesReloadKey}
						/>
					)}
					{active === "memory-bank" && (
						<MemoriesScreen
							deps={deps}
							variant="memory-bank"
							onCapture={setCapturing}
							onHints={setScreenHints}
							active={screenInputActive}
							store={stateStore}
							reloadKey={memoriesReloadKey}
						/>
					)}
					{active === "settings" && (
						<SettingsScreen
							deps={deps}
							onCapture={setCapturing}
							onHints={setScreenHints}
							active={screenInputActive}
							store={stateStore}
							reloadKey={settingsReloadKey}
						/>
					)}
				</ErrorBoundary>
			</Box>
			{/* Persistent command bar: anchored on every dashboard tab so command
			    entry is always visible (collapsed by default; `/` focuses it into
			    the palette, and a running command's output replaces it here). The
			    wizard layout has no tabs and no command bar. */}
			{showTabs && (
				<Box marginTop={1} flexDirection="column" flexShrink={0}>
					{runner.node}
				</Box>
			)}
			<Box flexShrink={0}>
				{overlayOpen ? (
					<StatusBar screenHints={runner.statusHints} showGlobals={false} />
				) : (
					// Advertise the global keys only when they're actually live: in "screen"
					// focus on a dashboard tab. In "capture" they're paused (don't advertise).
					<StatusBar screenHints={screenHints} showGlobals={showTabs && focus === "screen"} />
				)}
			</Box>
		</Box>
	);
}
