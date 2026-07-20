/**
 * useCommandRunner — the shell-level command layer, lifted out of HomeScreen so
 * the `/` command palette + captured-output panel work from ANY tab (not just
 * Home). It is a hook (TuiApp needs an imperative `open()`, the `paletteOpen` /
 * `outputOpen` / `running` flags to drive the input-gating matrix), plus a
 * `node` it renders into the shell's body area.
 *
 * Model:
 *   - `/` opens the palette; typing ranks (never hides) the catalog, ↑↓ selects
 *     across the WHOLE list, Enter runs, Esc closes.
 *   - Running a command captures its output (deps.runCommand, no live terminal)
 *     and APPENDS it to a persistent transcript (terminal-like): each run adds a
 *     `$ jolli …` header + output + `exit N`, so a second `/`-run stacks below
 *     the first instead of replacing it. ↑↓ scrolls the whole transcript.
 *   - `Esc` hides the panel but KEEPS the transcript (reopen shows history).
 *     Clearing is explicit: `Ctrl-L` or the `/clear` (alias `/cls`) pseudo-command.
 * Key HINTS are NOT rendered here — the shell StatusBar shows them (single
 * source of truth). This hook only owns the input echo / output content.
 */
import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import type { CommandCatalogEntry } from "./CommandCatalog.js";
import {
	CommandBarCollapsed,
	CommandPaletteView,
	filterCatalog,
	paletteArgv,
	relevantCount,
} from "./CommandPalette.js";
import { scrollWindow } from "./Scrollable.js";
import type { TuiDeps } from "./TuiDeps.js";
import { fillRows, useTerminalSize } from "./useTerminalSize.js";

const SPINNER = "⠋";
/** Default (max) output-panel window; shrinks to fit a short terminal. */
export const OUTPUT_VISIBLE_ROWS = 16;
/** Non-output rows around the panel (tab bar, divider, title, exit line, status). */
const OUTPUT_CHROME = 8;
/** Palette window chrome (input box border ×2, hint lines). */
const PALETTE_CHROME = 10;
/** Cap the accumulated transcript so a long-lived session can't grow unbounded. */
const MAX_TRANSCRIPT = 1000;

/** One rendered line of the command-output transcript. */
interface TranscriptLine {
	readonly text: string;
	/** Colour for `exit N` lines (green ok / red failure). */
	readonly tone?: "green" | "red";
	/** Bold for the `$ jolli …` command headers. */
	readonly bold?: boolean;
}

const cap = (lines: TranscriptLine[]): TranscriptLine[] =>
	lines.length > MAX_TRANSCRIPT ? lines.slice(-MAX_TRANSCRIPT) : lines;

export interface CommandRunnerHandle {
	/** Palette input box is open (modal: captures all input). */
	readonly paletteOpen: boolean;
	/** Output panel is showing (non-modal once idle: Tab/q still switch/quit). */
	readonly outputOpen: boolean;
	/** A command is in flight (modal: the shell pauses globals so Tab/q can't
	 *  silently abort a write command — see TuiApp's globalKeysActive). */
	readonly running: boolean;
	/** Open the palette (bound to `/` by the shell). */
	open(): void;
	/** Close whatever overlay is open (used when the shell switches tab). */
	close(): void;
	/** Context keys for the shell StatusBar while an overlay is open. */
	readonly statusHints: string;
	/** The command UI to anchor at the bottom of the shell body: the output
	 *  panel or focused palette when open, otherwise the always-visible collapsed
	 *  command bar. Never null — the bar is persistent (press `/` to focus it). */
	readonly node: ReactElement;
}

/** True when the palette input's first token is the local `clear`/`cls` command. */
function isClearInput(input: string): boolean {
	const first = input.replace(/^\//, "").trim().split(/\s+/)[0]?.toLowerCase();
	return first === "clear" || first === "cls";
}

export function useCommandRunner(
	deps: Pick<TuiDeps, "runCommand" | "cwd">,
	catalog: CommandCatalogEntry[],
	/** Fired with the finished command's argv once it completes (any exit code),
	 *  so the shell can decide whether to refresh screens whose state the command
	 *  may have changed — e.g. `auth login/logout` flipping the Home Sign-in row.
	 *  NOT fired on user-abort. */
	onComplete?: (argv: string[]) => void,
): CommandRunnerHandle {
	const [paletteInput, setPaletteInput] = useState<string | null>(null);
	const [paletteCursor, setPaletteCursor] = useState(0);
	const [paletteBlocked, setPaletteBlocked] = useState(false);
	// Whether the user has moved the cursor since typing. Guards the "typo footgun":
	// when the query matches nothing, the top entry is just the first appended
	// command — Enter must NOT run it until the user deliberately ↑↓-picks one.
	const [paletteTouched, setPaletteTouched] = useState(false);
	// Persistent, append-only command output — survives `open()` and `Esc` so
	// consecutive `/`-runs stack (terminal-like); only Ctrl-L / /clear empties it.
	const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
	const [scroll, setScroll] = useState(0);
	const [running, setRunning] = useState<{ argv: string[] } | null>(null);
	// The panel is shown independently of transcript content, so `Esc` can hide it
	// while KEEPING the history (reopening on the next run shows the full stack).
	const [panelVisible, setPanelVisible] = useState(false);
	// Windows shrink to fit a short terminal (unchanged on a roomy one).
	const { rows } = useTerminalSize();
	// Both panels GROW to fill a tall terminal (command output uses the whole
	// height; the palette shows the full catalog so end-of-list commands like
	// `uninstall` are visible without scrolling) and shrink on a short one — see
	// fillRows. The palette is additionally clamped to the catalog length so it
	// never reserves blank rows past the last command. rows unknown (tests/pipes)
	// falls back to the old fixed budgets. The flex-grow screen region above
	// absorbs the extra height (TuiApp), so a taller panel never overflows.
	const outputRows = fillRows(rows, OUTPUT_CHROME, OUTPUT_VISIBLE_ROWS);
	const paletteRows = Math.min(catalog.length, fillRows(rows, PALETTE_CHROME, 6));
	const runAbort = useRef<AbortController | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			// Kill any in-flight child on unmount — Ink's Ctrl-C handler calls
			// app.exit() regardless of our `useInput` gating, so this is the only
			// place a running capture gets torn down when the user quits mid-command.
			// Without it the (non-detached) `jolli` child is reparented to init and
			// keeps running invisibly, still holding the repo.
			runAbort.current?.abort();
		};
	}, []);

	const paletteOpen = paletteInput !== null;
	const outputOpen = running !== null || (transcript.length > 0 && panelVisible);

	function open(): void {
		// Only open the palette — never touch the transcript (that's the whole point
		// of the append model). The panel re-shows when the next command runs.
		setPaletteInput("");
		setPaletteCursor(0);
		setPaletteBlocked(false);
		setPaletteTouched(false);
	}
	function closePalette(): void {
		setPaletteInput(null);
		setPaletteCursor(0);
		setPaletteBlocked(false);
	}
	function clearTranscript(): void {
		setTranscript([]);
		setScroll(0);
		setPanelVisible(false);
	}
	function appendLines(lines: TranscriptLine[]): void {
		setTranscript((t) => cap([...t, ...lines]));
	}
	// Auto-scroll to the bottom (newest output) whenever the transcript grows or
	// clears. Kept OUT of the setTranscript updater (updaters must stay pure);
	// depends on the transcript only, so a bare terminal resize doesn't yank a
	// user who scrolled up back to the bottom. The CLAMPED offset (not a huge
	// number) is stored so a single ↑ scrolls up by exactly one row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll on transcript change only, using the current outputRows
	useEffect(() => {
		setScroll(Math.max(0, transcript.length - outputRows));
	}, [transcript]);
	function runCommandInPanel(argv: string[]): void {
		runAbort.current?.abort();
		const controller = new AbortController();
		runAbort.current = controller;
		setPanelVisible(true);
		setRunning({ argv });
		appendLines([{ text: `$ jolli ${argv.join(" ")}`, bold: true }]);
		void deps
			.runCommand(argv, controller.signal)
			.then(({ output, exitCode }) => {
				if (!alive.current || controller.signal.aborted) return;
				const trimmed = output.replace(/\n+$/, "");
				const outLines: TranscriptLine[] =
					trimmed === "" ? [{ text: "(no output)" }] : trimmed.split("\n").map((text) => ({ text }));
				appendLines([...outLines, { text: `exit ${exitCode}`, tone: exitCode === 0 ? "green" : "red" }]);
				setRunning(null);
				onComplete?.(argv);
			})
			.catch((e) => {
				// runCommand is meant not to throw, but a synchronous spawn failure can
				// still reject. Land in a finished error state instead of a stuck spinner.
				if (!alive.current || controller.signal.aborted) return;
				appendLines([{ text: (e as Error).message }, { text: "exit 1", tone: "red" }]);
				setRunning(null);
				onComplete?.(argv);
			});
	}
	function abortRun(): void {
		runAbort.current?.abort();
		runAbort.current = null;
		if (running) appendLines([{ text: "(interrupted)", tone: "red" }]);
		setRunning(null);
	}
	function close(): void {
		// Tab-switch: stop any in-flight command and hide the overlay, but keep the
		// transcript so returning to a tab still shows the history.
		abortRun();
		setPanelVisible(false);
		closePalette();
	}

	useInput(
		(ch, key) => {
			// Output panel: while running Esc cancels; once done ↑↓ scroll, Esc hides
			// (keeps history), Ctrl-L clears, `/` runs another.
			if (running) {
				if (key.escape) abortRun();
				return;
			}
			if (outputOpen && paletteInput === null) {
				if (key.ctrl && ch === "l") return clearTranscript();
				if (key.escape) return setPanelVisible(false);
				if (ch === "/") return open();
				if (key.upArrow) return setScroll((s) => Math.max(0, s - 1));
				if (key.downArrow)
					return setScroll((s) => Math.min(Math.max(0, transcript.length - outputRows), s + 1));
				return;
			}
			// Palette input.
			if (paletteInput !== null) {
				const filtered = filterCatalog(catalog, paletteInput);
				if (key.escape) {
					closePalette();
				} else if (key.return) {
					// `/clear` / `/cls` (typed OR the highlighted synthetic entry) clears
					// the transcript locally — never spawns a child.
					const sel = filtered[Math.min(paletteCursor, filtered.length - 1)];
					if (isClearInput(paletteInput) || sel?.name === "clear") {
						closePalette();
						clearTranscript();
						return;
					}
					// Typo guard: don't run the highlighted top entry when the user hasn't
					// ↑↓-picked and either nothing matches the query OR the query is empty.
					// (For an empty query relevantCount is the WHOLE catalog, not 0, so a
					// bare Enter right after opening `/` would otherwise run the top command
					// by accident.) Nudge them to pick one instead.
					if (!paletteTouched && (paletteInput.trim() === "" || relevantCount(catalog, paletteInput) === 0)) {
						setPaletteBlocked(true);
						return;
					}
					if (!sel) return;
					const argv = paletteArgv(sel, paletteInput);
					if (argv) {
						closePalette();
						runCommandInPanel(argv);
					} else {
						setPaletteBlocked(true);
					}
				} else if (key.upArrow) {
					setPaletteTouched(true);
					setPaletteCursor((c) => Math.max(0, c - 1));
				} else if (key.downArrow) {
					// Full-list scroll: the view windows around the cursor, so the cursor
					// may range over every entry (not just the first visible page).
					setPaletteTouched(true);
					setPaletteCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1));
				} else if (key.tab) {
					// Tab completes the command word to the highlighted entry, keeping any
					// args already typed after it (e.g. `/rec my-b` + Tab → `/recall my-b`).
					const sel = filtered[Math.min(paletteCursor, filtered.length - 1)];
					if (sel) {
						const rest = (paletteInput ?? "")
							.replace(/^\//, "")
							.trim()
							.split(/\s+/)
							.filter(Boolean)
							.slice(1);
						setPaletteInput(rest.length > 0 ? `${sel.name} ${rest.join(" ")}` : `${sel.name} `);
						setPaletteCursor(0);
						setPaletteBlocked(false);
						setPaletteTouched(false);
					}
				} else if (key.backspace || key.delete) {
					if (paletteInput === "") return closePalette();
					setPaletteInput((v) => (v ?? "").slice(0, -1));
					setPaletteCursor(0);
					setPaletteBlocked(false);
					setPaletteTouched(false);
				} else if (ch && !key.ctrl && !key.meta && !key.tab) {
					setPaletteInput((v) => (v ?? "") + ch);
					setPaletteCursor(0);
					setPaletteBlocked(false);
					setPaletteTouched(false);
				}
			}
		},
		{ isActive: paletteOpen || outputOpen },
	);

	const statusHints = running
		? "[Esc] cancel"
		: paletteInput !== null
			? "[↑↓] select · [Tab] complete · [Enter] run · [Esc] close"
			: "[↑↓] scroll · [Ctrl-L] clear · [Esc] close · [/] run another · [Tab] tabs · [q]uit";

	// Palette commands run as a child bound to the TUI's repo, NOT the shell's cwd
	// (see TuiDeps.runCommand) — surface it so `search`/`recall` results are never
	// mistaken for the terminal's working dir.
	const repo = basename(deps.cwd);
	// Terminal-like stacking: the transcript (scrollback) stays visible while the
	// palette is open below it — opening `/` must NOT hide the previous output.
	// When both show, shrink the transcript window so the pair fits the bottom area.
	const showTranscript = transcript.length > 0 && panelVisible;
	const transcriptHeight = paletteInput !== null ? Math.max(3, outputRows - paletteRows) : outputRows;
	const node = (
		<Box flexDirection="column">
			{showTranscript && (
				<OutputPanel
					transcript={transcript}
					height={transcriptHeight}
					offset={scroll}
					running={running}
					repo={repo}
				/>
			)}
			{paletteInput !== null ? (
				<CommandPaletteView
					entries={filterCatalog(catalog, paletteInput)}
					input={paletteInput}
					cursor={paletteCursor}
					blocked={paletteBlocked}
					relevantCount={relevantCount(catalog, paletteInput)}
					height={paletteRows}
				/>
			) : showTranscript ? null : (
				<CommandBarCollapsed />
			)}
		</Box>
	);

	return { paletteOpen, outputOpen, running: running !== null, open, close, statusHints, node };
}

/** In-panel transcript — a windowed view of the accumulated `$ jolli …` runs,
 *  with the in-flight command's spinner pinned at the bottom. No key hints here
 *  (the shell StatusBar shows them). Keeps per-line colour (green/red `exit N`,
 *  bold headers), so it renders the window itself rather than via ScrollView. */
function OutputPanel({
	transcript,
	height,
	offset,
	running,
	repo,
}: {
	transcript: TranscriptLine[];
	height: number;
	offset: number;
	running: { argv: string[] } | null;
	repo: string;
}): ReactElement {
	const { start, above, below } = scrollWindow(transcript.length, height, offset);
	const shown = transcript.slice(start, start + height);
	return (
		<Box flexDirection="column">
			<Text dimColor>{`command output · ${repo}`}</Text>
			{above > 0 && (
				<Text dimColor>
					{"   "}▲ {above} more
				</Text>
			)}
			{shown.map((l, i) => (
				<Text key={`${start + i}-${l.text.slice(0, 16)}`} bold={l.bold} color={l.tone}>
					{l.text === "" ? " " : l.text}
				</Text>
			))}
			{below > 0 && (
				<Text dimColor>
					{"   "}▼ {below} more
				</Text>
			)}
			{running && (
				<Text color="yellow">
					{"   "}
					{SPINNER} running…
				</Text>
			)}
		</Box>
	);
}
