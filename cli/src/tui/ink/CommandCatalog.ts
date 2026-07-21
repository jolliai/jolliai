/**
 * CommandCatalog — turns the Commander program into a flat, grouped list for the
 * Commands tab. Pure over the `program` object (no I/O), so it is unit-testable
 * with a hand-built fake program. Grouping reuses the same `getHelpGroup` tag
 * the `--help` formatter reads, so a command lands in the same section either
 * way; everything untagged is "Core".
 */

import type { Command } from "commander";
import { getHelpGroup } from "../../commands/HelpGroups.js";

export interface CommandCatalogEntry {
	readonly name: string;
	readonly description: string;
	readonly group: string;
	/** True when a bare run can't succeed (required positional OR mandatory
	 *  option): the palette blocks it and shows the `usage` hint so the user can
	 *  type the missing parts on the command line. */
	readonly needsArgs: boolean;
	/** The tokens the user must type after the command name for a valid run —
	 *  e.g. `bind` → `--space <idOrSlug>`, `convert` → `<file>`. Used to gate the
	 *  needs-args block. Undefined when the bare command already runs. */
	readonly usage?: string;
	/** Full invocation shape after the command name, for the palette hint so the
	 *  user can type a correct command: positionals (`<req>` / `[opt]`), mandatory
	 *  option flags, a `<sub|sub>` list for subcommand-bearing commands, and an
	 *  `[options]` marker when optional flags exist. "" when the bare name runs. */
	readonly signature?: string;
	/** Visible option flags the user may add (excludes the ubiquitous `--cwd`) —
	 *  shown as a dim `options:` line under the selected command. */
	readonly optionFlags?: readonly string[];
	/** Subcommand names (e.g. `auth` → login/logout/status) — shown as a dim
	 *  `subcommands:` line so the user knows what to type after the name. */
	readonly subcommands?: readonly string[];
	/** TUI-context default argv appended when the command is run bare from the
	 *  palette — for commands whose bare CLI form isn't useful (e.g. `graph`
	 *  errors without --export; from the TUI the obvious intent is "export this
	 *  repo's graph and open it"). */
	readonly defaultArgs?: readonly string[];
	/** Destructive commands (clean / uninstall) that REFUSE to run
	 *  non-interactively without confirmation. The runner's child has no stdin,
	 *  so the palette blocks a bare run and requires the user to type `--yes`
	 *  (execute) or `--dry-run` (safe preview) — never auto-injected. */
	readonly requiresConfirm?: boolean;
}

/** Bare-run defaults, keyed by command name. Keep entries minimal and obvious.
 *  Audited over every visible command (2026-07): all other bare forms are
 *  useful as-is (options-only, or an optional positional with a sane default
 *  like recall → current branch). */
const TUI_DEFAULT_ARGS: Record<string, readonly string[]> = {
	// Bare `--export` (no dir) → the export defaults to the user's personal
	// ~/Documents dir, NOT the repo cwd (which would dirty the
	// working tree — see GraphExport). `--open` then opens it.
	graph: ["--export", "--open"],
	// Bare `auth` just prints commander help; `auth status` is the read-only
	// intent. `auth login` etc. can still be typed after the name.
	auth: ["status"],
	// Bare `/backfill` defaults to the SAFE dry-run (report only, no LLM) — real
	// generation needs an explicit `/backfill --generate` etc. Preserves the old
	// Memories backfill sub-view's "safe preview" default now that it's a command.
	backfill: ["--dry-run"],
	// Bare `/clean` defaults to the SAFE dry-run (reports what would be removed, no
	// deletion). The real delete needs `/clean --yes` — clean's own prompt can't
	// run in the palette (the runner's child has no stdin), so the dry-run keeps
	// `/clean` executable instead of blocked while never deleting unattended.
	clean: ["--dry-run"],
};

/** Commands whose positional is optional in Commander but whose bare run is
 *  useless (search → `{"type":"error","message":"A query is required."}`).
 *  Forces the palette's needs-args gate despite `registeredArguments`. */
const TUI_REQUIRES_ARGS = new Set(["search"]);

/** Usage hints for the forced (TUI_REQUIRES_ARGS) commands, whose required
 *  tokens can't be derived from Commander (the positional is declared optional).
 *  Derivable commands (required positional / mandatory option) get their hint
 *  from {@link usageHint}. */
const TUI_ARG_HINT: Record<string, string> = {
	// Variadic `[words...]` — the query is one or more space-separated words, not a
	// single quoted argument, so the hint reads `<words...>` to match the real arity.
	search: "<words...>",
};

/** Commands that must not appear in the palette at all:
 *  - `mcp` starts a blocking stdio server for AI agents — it would just hang.
 *  - `enable` / `disable` are interactive (enable runs the setup prompt flow)
 *    AND already have native Home UI (`[a]` toggle with confirm), so the palette
 *    (which captures output and has no live stdin) must not surface them.
 *  - `uninstall` removes Jolli entirely — irrelevant to daily use and dangerous
 *    to surface in a command browser; run `jolli uninstall` from the shell. */
const PALETTE_EXCLUDE = new Set(["mcp", "enable", "disable", "uninstall"]);

/** Destructive commands that refuse to run without `--yes` in a non-interactive
 *  shell. `clean` is NOT here: its bare run is gated by a TUI default of
 *  `--dry-run` (a safe report — see TUI_DEFAULT_ARGS), so `/clean` always
 *  executes and `/clean --yes` deletes. The palette runner's child has no stdin,
 *  so a truly-destructive bare run would just print "Refusing to delete…". */
const TUI_REQUIRES_CONFIRM = new Set<string>([]);

/** A synthetic, TUI-only catalog entry that clears the command-output transcript
 *  (handled locally by the runner — never spawns a child). Listed so `/clear` is
 *  discoverable in the palette; the `cls` alias is handled by the runner. */
const CLEAR_ENTRY: CommandCatalogEntry = {
	name: "clear",
	description: "Clear the command output",
	group: "TUI",
	needsArgs: false,
};

/** Mirror of Api.ts's `isHiddenCommand` — probes both the documented and internal flags. */
function isHidden(cmd: Command): boolean {
	const internal = cmd as unknown as { _hidden?: boolean; hidden?: boolean };
	return Boolean(internal._hidden ?? internal.hidden);
}

function groupOf(cmd: Command): string {
	switch (getHelpGroup(cmd)) {
		case "site":
			return "Jolli Site";
		case "space":
			return "Jolli Space";
		default:
			return "Core";
	}
}

/** A command "needs args" if a bare run can't succeed: a required positional
 *  argument, OR a mandatory option (Commander `requiredOption`, e.g. `bind
 *  --space`). Without the latter, `bind` ran bare and errored on the missing
 *  `--space` instead of showing the palette's needs-args hint. */
function needsArgs(cmd: Command): boolean {
	const args = (cmd as unknown as { registeredArguments?: ReadonlyArray<{ required?: boolean }> })
		.registeredArguments;
	const hasRequiredPositional = Array.isArray(args) && args.some((a) => a.required === true);
	const opts = (cmd as unknown as { options?: ReadonlyArray<{ mandatory?: boolean }> }).options;
	const hasMandatoryOption = Array.isArray(opts) && opts.some((o) => o.mandatory === true);
	return hasRequiredPositional || hasMandatoryOption;
}

// ── Commander-internals accessors (kept in one place; typed loosely on purpose) ──
type ArgLike = { required?: boolean; name?: () => string; _name?: string };
type OptLike = { mandatory?: boolean; hidden?: boolean; flags?: string; long?: string };
const argsOf = (cmd: Command): ArgLike[] => {
	const a = (cmd as unknown as { registeredArguments?: ArgLike[] }).registeredArguments;
	return Array.isArray(a) ? a : [];
};
const optionsOf = (cmd: Command): OptLike[] => {
	const o = (cmd as unknown as { options?: OptLike[] }).options;
	return Array.isArray(o) ? o : [];
};
const argName = (a: ArgLike): string | undefined => (typeof a.name === "function" ? a.name() : a._name);
/** Visible subcommand names (login/logout/status …). */
const subcommandsOf = (cmd: Command): string[] => cmd.commands.filter((c) => !isHidden(c)).map((c) => c.name());
/** Visible option flags a user might add — excludes the ubiquitous `--cwd`. */
const optionFlagsOf = (cmd: Command): string[] =>
	optionsOf(cmd)
		.filter((o) => o.hidden !== true && Boolean(o.flags) && o.long !== "--cwd")
		.map((o) => o.flags as string);

/** The tokens a user must type after the command name for a valid run: required
 *  positionals (`<name>`) then mandatory-option flags (`--space <idOrSlug>`),
 *  read straight off Commander so it can't drift from the real signature. Falls
 *  back to a hand-authored hint for the forced (optional-positional) commands. */
function usageHint(cmd: Command): string | undefined {
	const parts: string[] = [];
	for (const a of argsOf(cmd)) {
		if (a.required !== true) continue;
		const n = argName(a);
		if (n) parts.push(`<${n}>`);
	}
	for (const o of optionsOf(cmd)) if (o.mandatory === true && o.flags) parts.push(o.flags);
	return parts.length > 0 ? parts.join(" ") : TUI_ARG_HINT[cmd.name()];
}

/** Full invocation shape after the command name — so the palette hint reads as a
 *  command the user can actually type. Subcommand-bearing commands show
 *  `<a|b|c>`; others show positionals (required + optional) then mandatory option
 *  flags; an `[options]` marker is appended when optional flags exist. */
function commandSignature(cmd: Command): string {
	const optionalOpts = optionsOf(cmd).filter((o) => o.hidden !== true && o.mandatory !== true && o.long !== "--cwd");
	const optsMarker = optionalOpts.length > 0 ? "[options]" : "";
	const subs = subcommandsOf(cmd);
	if (subs.length > 0) return [`<${subs.join("|")}>`, optsMarker].filter(Boolean).join(" ");
	const parts: string[] = [];
	for (const a of argsOf(cmd)) {
		const n = argName(a);
		if (n) parts.push(a.required === true ? `<${n}>` : `[${n}]`);
	}
	for (const o of optionsOf(cmd)) if (o.mandatory === true && o.hidden !== true && o.flags) parts.push(o.flags);
	if (parts.length === 0 && TUI_ARG_HINT[cmd.name()]) parts.push(TUI_ARG_HINT[cmd.name()]);
	if (optsMarker) parts.push(optsMarker);
	return parts.join(" ");
}

/** Commands most relevant to each dashboard tab, in the order they should
 *  surface. When the command palette is opened from that tab, these float to the
 *  top (in this order) so the browse list — and every tie in a filtered result —
 *  leads with what the user most likely wants there; everything else follows in
 *  catalog order. Names absent from the catalog are ignored. Curated by hand
 *  (like {@link TUI_DEFAULT_ARGS} / {@link PALETTE_EXCLUDE}) because commands
 *  carry no tab-affinity tag. */
const CONTEXT_PRIORITY: Record<"memories" | "settings", readonly string[]> = {
	// Memories tab: recall / browse / search / generate + share memories.
	memories: [
		"recall",
		"search",
		"view",
		"backfill",
		"graph",
		"compile",
		"export",
		"heal-folder",
		"pr-description",
		"queue-status",
		"push",
		"sync-memory-bank",
		"spaces",
		"bind",
	],
	// Settings tab: configuration + install/health management. `uninstall` is
	// deliberately absent — floating it here would pull it out of its sunk
	// end-of-list slot (see TUI_TRAILING); the most destructive command stays last.
	settings: ["configure", "doctor", "clean", "telemetry", "auth", "status"],
};

/** Reorder the catalog so the active tab's most-relevant commands lead, without
 *  dropping any. `home` (and any unknown context) returns the catalog unchanged.
 *  Stable: prioritized commands take the curated order; the remainder keep their
 *  original relative order. Pure — safe to call on every render. */
export function orderCatalogForContext(
	catalog: CommandCatalogEntry[],
	context: "home" | "memories" | "settings",
): CommandCatalogEntry[] {
	const priority = context === "home" ? undefined : CONTEXT_PRIORITY[context];
	if (!priority) return catalog;
	const rank = new Map(priority.map((name, i) => [name, i]));
	const front: CommandCatalogEntry[] = [];
	const rest: CommandCatalogEntry[] = [];
	for (const e of catalog) (rank.has(e.name) ? front : rest).push(e);
	front.sort((a, b) => (rank.get(a.name) as number) - (rank.get(b.name) as number));
	return [...front, ...rest];
}

/** Build the catalog from a Commander program, skipping hidden/internal commands.
 *  Appends the synthetic `clear` entry so `/clear` is discoverable in the palette. */
export function buildCommandCatalog(program: Command): CommandCatalogEntry[] {
	const entries = program.commands
		.filter((c) => !isHidden(c) && !PALETTE_EXCLUDE.has(c.name()))
		.map((c): CommandCatalogEntry => {
			const usage = usageHint(c);
			const signature = commandSignature(c);
			const optionFlags = optionFlagsOf(c);
			const subcommands = subcommandsOf(c);
			return {
				name: c.name(),
				description: c.description(),
				group: groupOf(c),
				needsArgs: needsArgs(c) || TUI_REQUIRES_ARGS.has(c.name()),
				...(usage ? { usage } : {}),
				...(signature ? { signature } : {}),
				...(optionFlags.length > 0 ? { optionFlags } : {}),
				...(subcommands.length > 0 ? { subcommands } : {}),
				...(TUI_DEFAULT_ARGS[c.name()] ? { defaultArgs: TUI_DEFAULT_ARGS[c.name()] } : {}),
				...(TUI_REQUIRES_CONFIRM.has(c.name()) ? { requiresConfirm: true } : {}),
			};
		});
	return [...entries, CLEAR_ENTRY];
}
