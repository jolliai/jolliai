/**
 * CommandPalette — the Home dashboard's `/` command entry (the old Commands
 * tab folded into Home). Pure exports only: the filter, the argv builder, and
 * the view. Key handling lives in the shell's single `useInput`
 * (useCommandRunner) so this file never competes for Ink input focus.
 *
 * Input model: everything the user typed after `/`. The first whitespace token
 * filters/ranks the catalog; any further tokens become the command's arguments,
 * so `/recall my-branch` runs `jolli recall my-branch`. A command with a
 * required positional argument (`needsArgs`) or a confirm-gated destructive
 * command (`requiresConfirm`) is blocked from running bare — the view shows a
 * hint instead.
 *
 * Ranking (not filtering): the palette shows the WHOLE catalog, always, so ↑↓
 * can reach any command. The typed query only reorders it — name-prefix matches
 * first, then name/description substrings, then everything else in catalog
 * order — with a dim `── other commands ──` divider marking where the relevant
 * ones end (see `relevantCount`).
 */
import { Box, Text } from "ink";
import { Fragment, type ReactElement } from "react";
import type { CommandCatalogEntry } from "./CommandCatalog.js";
import { cursorWindow } from "./Scrollable.js";

/** Default (max) suggestion rows — the palette sits under a dense dashboard.
 *  The visible window scrolls with the cursor so the full catalog is reachable. */
const PALETTE_MAX_ROWS = 6;

/** Split palette input into tokens, honoring single/double quotes so a single
 *  argument may contain spaces (`search "two words"` → ["search", "two words"]).
 *  Runs of whitespace separate tokens; a quoted section is kept verbatim (its
 *  quotes stripped) even when empty; an unclosed quote still yields its content.
 *  Backslash is NOT special — Windows paths use it literally. */
const tokensOf = (input: string): string[] => {
	const tokens: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	let started = false; // a token is being built (so a quoted "" is preserved)
	for (const ch of input.replace(/^\//, "")) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) {
				tokens.push(cur);
				cur = "";
				started = false;
			}
		} else {
			cur += ch;
			started = true;
		}
	}
	if (started) tokens.push(cur);
	return tokens;
};

/** Prefix + substring matches for the input's first token (order preserved). */
function rankMatches(
	catalog: CommandCatalogEntry[],
	query: string,
): {
	prefix: CommandCatalogEntry[];
	substring: CommandCatalogEntry[];
} {
	const prefix = catalog.filter((e) => e.name.toLowerCase().startsWith(query));
	const substring = catalog.filter(
		(e) =>
			!prefix.includes(e) &&
			(e.name.toLowerCase().includes(query) || e.description.toLowerCase().includes(query)),
	);
	return { prefix, substring };
}

/** The WHOLE catalog, reordered by relevance to the input's first token:
 *  name-prefix matches first, then name/description substrings, then everything
 *  else in catalog order. Never drops entries (so ↑↓ can reach any command).
 *  Empty input → full catalog unchanged. */
export function filterCatalog(catalog: CommandCatalogEntry[], input: string): CommandCatalogEntry[] {
	const query = (tokensOf(input)[0] ?? "").toLowerCase();
	if (query === "") return [...catalog];
	const { prefix, substring } = rankMatches(catalog, query);
	const matched = new Set<CommandCatalogEntry>([...prefix, ...substring]);
	const others = catalog.filter((e) => !matched.has(e));
	return [...prefix, ...substring, ...others];
}

/** How many leading entries of {@link filterCatalog} are actual matches for the
 *  query — i.e. where the `── other commands ──` divider goes. Equal to the
 *  catalog length for empty input (no divider). */
export function relevantCount(catalog: CommandCatalogEntry[], input: string): number {
	const query = (tokensOf(input)[0] ?? "").toLowerCase();
	if (query === "") return catalog.length;
	const { prefix, substring } = rankMatches(catalog, query);
	return prefix.length + substring.length;
}

/** argv for running `entry` with the args typed after the first token, or
 *  `null` when the command is blocked: it requires args and none were typed, or
 *  it is confirm-gated (destructive) and neither `--yes`/`-y` nor `--dry-run`
 *  was typed. */
export function paletteArgv(entry: CommandCatalogEntry, input: string): string[] | null {
	const rest = tokensOf(input).slice(1);
	if (rest.length === 0) {
		// Bare run: apply the TUI default argv when the command has one (e.g.
		// `graph` → export this repo + open); block genuinely-needs-args commands.
		if (entry.defaultArgs) return [entry.name, ...entry.defaultArgs];
		if (entry.needsArgs) return null;
	}
	// Destructive commands (clean / uninstall) refuse to run non-interactively
	// without confirmation, and the runner's child has no stdin — so require the
	// user to type `--yes` (execute) or `--dry-run` (safe preview) explicitly.
	if (entry.requiresConfirm && !rest.some((r) => r === "--yes" || r === "-y" || r === "--dry-run")) return null;
	return [entry.name, ...rest];
}

/** The always-visible, unfocused command bar. It anchors the bottom of every
 *  dashboard tab so the command entry is discoverable without first pressing
 *  `/`; pressing `/` focuses it into the full {@link CommandPaletteView}. Kept
 *  visually distinct from the focused state (dim placeholder, no live cursor)
 *  so the two are never confused. */
export function CommandBarCollapsed(): ReactElement {
	// Bordered so it reads as an (unfocused) input field, not a stray hint line —
	// dim border/placeholder keeps it visually distinct from the focused state.
	return (
		<Box borderStyle="round" borderColor="gray" paddingX={1} alignSelf="flex-start" minWidth={44}>
			<Text>
				<Text color="cyan">/ </Text>
				<Text dimColor>type a command — press </Text>
				<Text color="cyan">/</Text>
				<Text dimColor> to focus</Text>
			</Text>
		</Box>
	);
}

export function CommandPaletteView({
	entries,
	input,
	cursor,
	blocked,
	relevantCount: relevant,
	height = PALETTE_MAX_ROWS,
}: {
	entries: CommandCatalogEntry[];
	input: string;
	cursor: number;
	blocked: boolean;
	/** Index where matches end and "other commands" begin (for the divider). */
	relevantCount: number;
	/** Visible window height (shrinks to fit a short terminal). */
	height?: number;
}): ReactElement {
	const sel = Math.min(Math.max(0, cursor), Math.max(0, entries.length - 1));
	const selected = entries[sel];
	const { start, above, below } = cursorWindow(entries.length, height, sel);
	const shown = entries.slice(start, start + height);
	// Fixed name-column width so EVERY description starts at the same column (and a
	// wrapped description hang-indents to it): the longest command name + 1-space
	// gap, capped so a pathological plugin name can't shove descriptions off-screen.
	// A name longer than the cap is truncated with `…` (the full name still shows in
	// the hint line below). +3 for the ` ▸ ` / `   ` cursor prefix.
	const nameLen = Math.min(24, Math.max(12, ...entries.map((e) => e.name.length)));
	const nameColWidth = 3 + nameLen + 1;
	const showDivider = relevant > 0 && relevant < entries.length;
	const noMatch = relevant === 0 && input.replace(/^\//, "").trim() !== "";
	return (
		<Box flexDirection="column">
			{/* Input echo only — the [↑↓]/[Enter]/[Esc] keys live in the shell StatusBar.
			    Bordered (cyan) so the focused field is unmistakably an editable input. */}
			<Box borderStyle="round" borderColor="cyan" paddingX={1} alignSelf="flex-start" minWidth={44}>
				<Text>
					/{input}
					<Text color="cyan">▏</Text>
				</Text>
			</Box>
			{noMatch && <Text dimColor>{"   "}no direct match — ↑↓ to pick a command</Text>}
			{entries.length === 0 ? (
				<Text dimColor>{"   "}no commands</Text>
			) : (
				<>
					{above > 0 && (
						<Text dimColor>
							{"   "}▲ {above} more
						</Text>
					)}
					{shown.map((entry, i) => {
						const gi = start + i;
						return (
							<Fragment key={entry.name}>
								{showDivider && gi === relevant && <Text dimColor>{"   "}── other commands ──</Text>}
								{/* Two columns: a FIXED-width name column and a flex description
								    column. Every description starts at the same column, and a long
								    description wraps WITHIN its own column so continuation lines
								    hang-indent under the description (never back to column 0). */}
								<Box>
									<Box width={nameColWidth} flexShrink={0}>
										<Text color={gi === sel ? "cyan" : undefined} wrap="truncate-end">
											{gi === sel ? " ▸ " : "   "}
											{entry.name}
										</Text>
									</Box>
									<Box flexGrow={1}>
										<Text>
											<Text dimColor>{entry.description}</Text>
											{entry.needsArgs && !entry.defaultArgs && (
												<Text color="yellow"> (needs args)</Text>
											)}
											{entry.requiresConfirm && <Text color="yellow"> (needs --yes)</Text>}
											<Text dimColor> · {entry.group}</Text>
										</Text>
									</Box>
								</Box>
							</Fragment>
						);
					})}
					{below > 0 && (
						<Text dimColor>
							{"   "}▼ {below} more
						</Text>
					)}
				</>
			)}
			{/* Full runnable form of the highlighted command — so the user always
			    knows exactly what to type / what will run before pressing Enter. */}
			{selected && <CommandHint entry={selected} blocked={blocked} />}
		</Box>
	);
}

/** How-to-run hint for the selected entry, so the user can type a correct
 *  command. Line 1 is the full invocation:
 *   • requiresConfirm → `type: jolli clean --yes` (yellow — destructive)
 *   • defaultArgs → `runs: jolli graph --export --open`
 *   • needsArgs   → `type: jolli bind --space <idOrSlug>` (yellow — user completes it)
 *   • otherwise   → `runs: jolli recall [branch] [options]`
 *  Dim follow-up lines list the command's subcommands and option flags. */
function CommandHint({ entry, blocked }: { entry: CommandCatalogEntry; blocked: boolean }): ReactElement {
	const needsInput = (entry.needsArgs && !entry.defaultArgs) || Boolean(entry.requiresConfirm);
	const sig = entry.signature ?? entry.usage ?? "";
	const argv = entry.requiresConfirm
		? `jolli ${entry.name} --yes`
		: entry.defaultArgs
			? `jolli ${entry.name} ${entry.defaultArgs.join(" ")}`
			: needsInput && sig === ""
				? `jolli ${entry.name} …`
				: `jolli ${entry.name}${sig ? ` ${sig}` : ""}`;
	const opts = entry.optionFlags ?? [];
	const shownOpts = opts.slice(0, 4);
	return (
		<Box flexDirection="column">
			<Text>
				{"   "}
				<Text color={needsInput ? "yellow" : "gray"}>{needsInput ? "type: " : "runs: "}</Text>
				<Text color={needsInput ? "yellow" : "gray"}>{argv}</Text>
				{needsInput && blocked && (
					<Text color="yellow">
						{" "}
						— {entry.requiresConfirm ? "add --yes to confirm" : "type the rest"}, then Enter
					</Text>
				)}
			</Text>
			{entry.subcommands && entry.subcommands.length > 0 && (
				<Text dimColor>
					{"      "}subcommands: {entry.subcommands.join(" · ")}
				</Text>
			)}
			{shownOpts.length > 0 && (
				<Text dimColor>
					{"      "}options: {shownOpts.join(" · ")}
					{opts.length > shownOpts.length ? " · …" : ""}
				</Text>
			)}
		</Box>
	);
}
