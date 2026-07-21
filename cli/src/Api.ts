/// <reference types="node" />
/**
 * Jolli Memory CLI — Programmatic API.
 *
 * Houses `main()` and any other exports intended for downstream consumption
 * (other packages that bundle or extend the CLI). The bin entry [`Cli.ts`](Cli.ts)
 * is a thin shim that imports from here.
 */

import { Command, Help, Option } from "commander";
import { registerAuthCommands } from "./commands/AuthCommand.js";
import { registerBackfillCommand } from "./commands/BackfillCommand.js";
import { registerCleanCommand } from "./commands/CleanCommand.js";
import { checkVersionMismatch, resolveProjectDir, VERSION } from "./commands/CliUtils.js";
import { registerCompileCommand } from "./commands/CompileCommand.js";
import { registerConfigureCommand } from "./commands/ConfigureCommand.js";
import { registerDoctorCommand } from "./commands/DoctorCommand.js";
import { registerDisableCommand, registerEnableCommand } from "./commands/EnableCommand.js";
import { registerExportCommand, registerExportPromptCommand } from "./commands/ExportCommand.js";
import { registerGraphCommand } from "./commands/GraphCommand.js";
import { registerHealFolderCommand } from "./commands/HealFolderCommand.js";
import { getHelpGroup } from "./commands/HelpGroups.js";
import { registerBindCommand, registerPushCommand, registerSpacesCommand } from "./commands/JolliCloudCommands.js";
import { registerLocalRunOfferCommand } from "./commands/LocalRunOfferCommand.js";
import { registerMcpCommand } from "./commands/McpCommand.js";
import { registerMigrateCommand } from "./commands/MigrateCommand.js";
import { registerOpenUrlCommand } from "./commands/OpenUrlCommand.js";
import { registerPrDescriptionCommand } from "./commands/PrDescriptionCommand.js";
import { registerQueueStatusCommand } from "./commands/QueueStatusCommand.js";
import { registerRecallCommand } from "./commands/RecallCommand.js";
import { registerSearchCommand } from "./commands/SearchCommand.js";
import { registerStatusCommand } from "./commands/StatusCommand.js";
import { registerSyncCommand } from "./commands/SyncCommand.js";
import { registerTelemetryCommand } from "./commands/TelemetryCommand.js";
import { registerUninstallCommand } from "./commands/UninstallCommand.js";
import { registerVerifyPublishBranchCommand } from "./commands/VerifyPublishBranchCommand.js";
import { registerViewCommand } from "./commands/ViewCommand.js";
import { registerWorkflowRunStatusCommand } from "./commands/WorkflowRunStatusCommand.js";
import { registerWorkflowRunsCommand } from "./commands/WorkflowRunsCommand.js";
// _parseJolliApiKey / _parseBaseUrl: re-exposed at the bottom of this file.
// See the `parseJolliApiKey` export for the rationale (Vite tree-shaker drops
// pure re-exports from the entry bundle when nothing inside the entry
// consumes them).
import { parseBaseUrl as _parseBaseUrl, parseJolliApiKey as _parseJolliApiKey } from "./core/JolliApiUtils.js";
import { createStorage } from "./core/StorageFactory.js";
import { setActiveStorage } from "./core/SummaryStore.js";
import { installCommandTelemetryHooks } from "./core/TelemetryCommandHook.js";
import { CLI_PACKAGE_NAME, REFRESH_COMMAND, refreshUpdateCache } from "./core/UpdateCheck.js";
import { type Logger, setLogDir } from "./Logger.js";
import { loadPlugins, registerMissingStubs } from "./PluginLoader.js";
import { buildCommandCatalog } from "./tui/ink/CommandCatalog.js";
import { loadHomeModel, renderHomeSnapshot } from "./tui/ink/HomeSnapshot.js";
import type { Tab } from "./tui/ink/TuiApp.js";
import { buildTuiDeps } from "./tui/ink/TuiDeps.js";

/**
 * Runtime context handed to a plugin's `register()` function.
 *
 * Plugins must not import `commander` at runtime — they receive their
 * Command instance via `program` and use it directly. Otherwise the
 * plugin's bundled commander becomes a separate copy from the host's,
 * which breaks `instanceof` checks and prototype-based behavior.
 *
 * Public API surface — adding optional fields is non-breaking, removing
 * or renaming fields is a breaking change.
 *
 * Plugins should pin `"@jolli.ai/cli": ">=0.99.2"` in their
 * `peerDependencies`. 0.99.2 is the first host that ships the plugin
 * loader; the `>=` form (rather than `^`) keeps the plugin compatible
 * across future host minor bumps, since the loader's `semver.satisfies`
 * check would otherwise clamp `^0.99.x` to `<0.100.0`. A future breaking
 * change to this interface will bump the host major, at which point
 * plugins re-pin.
 */
export interface PluginContext {
	/**
	 * The root commander program. Plugins call `program.command(...)` to add commands.
	 *
	 * To hide a subcommand from the host's `--help` output (e.g. for an
	 * internal / experimental command), pass `{ hidden: true }` as the
	 * second argument:
	 *
	 *   ctx.program.command("plugin-internal", { hidden: true })
	 *     .description("…")
	 *     .action(…);
	 *
	 * Equivalent for `addCommand`:
	 *
	 *   ctx.program.addCommand(new Command("plugin-internal"), { hidden: true });
	 *
	 * The host's help formatter honors Commander's standard `hidden` option,
	 * so plugins do not need to touch any private state.
	 */
	program: Command;
	/** The host CLI's version (e.g. "0.100.0"). Plugins may gate features by this. */
	cliVersion: string;
	/** Logger scoped to the plugin. Lines flow through the CLI's normal log pipeline. */
	logger: Logger;
}

/**
 * Plugin entry point signature.
 *
 * A plugin module must export `register` (named export) matching this type.
 * It may return a Promise; the host awaits it before processing CLI args.
 *
 * Important: `register()` runs on **every** CLI invocation — including
 * `jolli --help` and `jolli --version` — because commands must be
 * registered before commander can parse the args. Keep `register()` cheap
 * (no file I/O, no subprocess, no network); defer real work to the
 * action handlers attached to the commands you register. Anything heavier
 * adds latency to commands the user may not even be running.
 */
export type PluginRegister = (ctx: PluginContext) => void | Promise<void>;

/**
 * Re-exported Jolli API-key parser. Plugins call this to derive the tenant
 * URL from a `sk-jol-…` auth token without re-implementing the base64url +
 * JWT-segment-scan logic. The host's allowlist check
 * (`assertJolliOriginAllowed` in `core/JolliApiUtils.ts`) already runs at
 * token save-time, so the `u` field returned here is known-valid for the
 * host's allowlist; plugins with a wider allowlist (e.g. localhost-also
 * accepted) should still run their own boundary check.
 *
 * Returns `null` for any input it cannot decode — never throws.
 *
 * Implementation note: Vite's lib-mode tree-shaker drops pure
 * `export { … } from "…"` re-exports from the entry bundle when nothing
 * inside the entry consumes them (the function body still lands in the
 * shared chunk; just the entry's export statement is elided). Going
 * through an `import` binding + a named `export` block keeps it in the
 * entry's public surface.
 */
export type { JolliApiKeyMeta, ParsedBaseUrl } from "./core/JolliApiUtils.js";
export const parseJolliApiKey = _parseJolliApiKey;
export const parseBaseUrl = _parseBaseUrl;

// ── Help-grouping configuration ─────────────────────────────────────────────
// These shape `jolli --help`: anything in HIDDEN_COMMANDS is filtered out by
// `visibleCommands`. The Memory builtins are bucketed by name (MEMORY_COMMAND_NAMES
// below). The Site / Space sections are bucketed by *provenance* instead — each
// plugin (or its stub) tags the commands it registers via `setHelpGroup`, and
// the formatter reads that tag with `getHelpGroup`. Tagging by origin rather
// than by name keeps a plugin that registers a generic command name (e.g.
// `init`, `sync`) from being mis-classified into another plugin's section.
// Commands that are neither a Memory builtin nor tagged fall through to "Other
// commands:" — `Api.test.ts` has a regression test that fails if a new builtin
// lands without being categorized, so this list cannot silently drift.

/** Internal commands hidden from `--help` (still callable by name). */
const HIDDEN_COMMANDS = new Set(["migrate", "export-prompt"]);

/**
 * Read Commander's per-command hidden flag without locking into a specific
 * internal field name. Commander v13 stores it as `_hidden`; older or future
 * versions may use `hidden`. Both are checked so a rename doesn't silently
 * un-hide commands that opted out of `--help`.
 */
function isHiddenCommand(c: Command): boolean {
	const internal = c as unknown as { _hidden?: boolean; hidden?: boolean };
	return Boolean(internal._hidden ?? internal.hidden);
}

/** Commands grouped under "Jolli Memory" in `--help`. */
const MEMORY_COMMAND_NAMES = new Set([
	"enable",
	"disable",
	"uninstall",
	"status",
	"configure",
	"clean",
	"doctor",
	"view",
	"recall",
	"search",
	"backfill",
	"pr-description",
	"queue-status",
	"local-run-workflows",
	"open-url",
	"verify-publish-branch",
	"workflow-run-status",
	"workflow-runs",
	"compile",
	"graph",
	"export",
	"auth",
	"heal-folder",
	"sync-memory-bank",
	"mcp",
	"telemetry",
	"push",
	"spaces",
	"bind",
]);

const MEMORY_DESCRIPTION = `Auto-documents your AI-assisted development. Lightweight git and AI-agent
hooks turn each commit into a structured summary (intent, decisions,
progress) stored on a git orphan branch, so you can recall context across
branches, machines, and teammates.`;

const SITE_DESCRIPTION = `Generates a docs site from a content folder of Markdown/MDX and OpenAPI
specs. Scaffold a new project, build a static site with full-text search,
or run a hot-reload dev server while you write.`;

const SPACE_DESCRIPTION = `Sync your Markdown docs with a Jolli Space, map source repositories, and
run documentation impact analysis on your changes — plus an interactive AI
agent. Provided by the @jolli.ai/space-cli plugin.`;

/**
 * Main CLI entry point.
 * Exported for testability — can be called with custom args.
 */
/**
 * Maps the `--view` value (incl. legacy `dashboard`/`queue`/`backfill`/
 * `memory-bank` aliases) to a TUI tab. Exported for unit testing. Migrated from
 * the removed WatchCommand — `jolli` is now the sole TUI entry point.
 */
export function toInitialTab(view: string | undefined): Tab {
	switch (view) {
		case "memories":
		case "browse":
			// The current-branch committed-memories tab (browse).
			return "memories";
		case "settings":
			return "settings";
		case "manage":
			// The old Manage tab merged with Settings; Settings is the survivor.
			return "settings";
		case "recall":
		case "timeline":
		case "memory-bank":
			// The repo-wide Memory Bank tab (recall + timeline sub-views).
			return "memory-bank";
		case "graph":
		case "backfill":
			// graph/backfill are now `/` commands, not views; the legacy `--view`
			// values land on the current-branch Memories tab.
			return "memories";
		default:
			// "home", legacy "dashboard"/"commands" (the Commands tab became the
			// `/` palette), and legacy "queue" (queue status now lives on Home's
			// Status sub-items) land on Home.
			return "home";
	}
}

export async function main(args?: ReadonlyArray<string>): Promise<void> {
	const program = new Command();
	// Positional options: the root's own options (--once/--view/--cwd/--format)
	// are valid only BEFORE a subcommand, so subcommands keep their own
	// same-named options (e.g. `jolli compile --cwd …`) instead of the root
	// swallowing them.
	program.enablePositionalOptions();
	program
		.name("jolli")
		.description("Auto-document AI development sessions and generate documentation sites")
		.version(VERSION)
		// Bare `jolli` is the control-center TUI + guided front door (default
		// action below). These top-level options tune that entry point; they
		// replace the removed `jolli watch` command.
		// No eager default — resolveProjectDir() runs a synchronous `git rev-parse`,
		// so it is deferred to the default action below (this option is only read
		// there) instead of firing on every `jolli <subcommand>` / `--version`.
		.option("--cwd <dir>", "Project directory (default: git repo root)")
		.addOption(
			new Option("--view <view>", "Initial tab").choices([
				"home",
				"memories",
				"browse",
				"recall",
				"timeline",
				"manage",
				"settings",
				"graph",
				"commands",
				"dashboard",
				"queue",
				"backfill",
				"memory-bank",
			]),
		)
		.option("--once", "Print a single status snapshot and exit (no resident TUI)")
		.addOption(new Option("--format <fmt>", "Output format for --once").choices(["json"]));

	const formatGroupedHelp = (cmd: Command, helper: Help): string => {
		// Grouping by Memory/Site only makes sense at the root program. For
		// subcommand help (e.g. `jolli auth --help`), defer to Commander's
		// default formatter — visibleCommands is still applied so hidden
		// commands stay filtered.
		if (cmd.parent !== null) {
			return Help.prototype.formatHelp.call(helper, cmd, helper);
		}

		const itemIndent = "  ";
		const visibleCmds = helper.visibleCommands(cmd);
		const visibleOpts = helper.visibleOptions(cmd);

		// Compute a single column width across all rendered terms so options and
		// both command groups line up consistently.
		const allTerms = [
			...visibleOpts.map((o) => helper.optionTerm(o)),
			...visibleCmds.map((c) => helper.subcommandTerm(c)),
		];
		const termWidth = allTerms.reduce((max, t) => Math.max(max, t.length), 0);

		const formatRow = (term: string, description: string): string =>
			helper.formatItem(term, termWidth, description, helper);

		const renderSectionDescription = (text: string): string =>
			text
				.split("\n")
				.map((line) => `${itemIndent}${line}`)
				.join("\n");

		const memoryCmds = visibleCmds.filter((c) => MEMORY_COMMAND_NAMES.has(c.name()));
		const siteCmds = visibleCmds.filter((c) => getHelpGroup(c) === "site");
		const spaceCmds = visibleCmds.filter((c) => getHelpGroup(c) === "space");
		// Anything that isn't a Memory builtin and carries no plugin group tag —
		// e.g. a third-party plugin's command — falls through to "Other commands:".
		const otherCmds = visibleCmds.filter(
			(c) => !MEMORY_COMMAND_NAMES.has(c.name()) && getHelpGroup(c) === undefined,
		);

		const lines: string[] = [];
		lines.push(`Usage: ${helper.commandUsage(cmd)}`, "");

		// The Memory/Site/options conditionals below have unreachable empty
		// arms when invoked on the root program (description is always set,
		// --version/--help are always present, every BUILTIN command falls
		// into Memory or Site). The empty arms exist for defensive parity
		// with Commander's default formatter; they are wrapped in v8 ignore
		// blocks so the dead branches don't drag down the file's branch
		// coverage. The `otherCmds` arm, by contrast, IS reachable in
		// production once plugins are loaded — a plugin command that isn't
		// in either built-in set lands there — so it is intentionally not
		// v8-ignored and is exercised by the "Other commands:" test in
		// Api.test.ts.
		const description = helper.commandDescription(cmd);
		/* v8 ignore start -- root program always has a description (set via .description() above) */
		if (description) lines.push(description, "");
		/* v8 ignore stop */

		/* v8 ignore start -- root program always has visible options (--help, --version) */
		if (visibleOpts.length > 0) {
			/* v8 ignore stop */
			lines.push("Options:");
			for (const opt of visibleOpts) {
				lines.push(formatRow(helper.optionTerm(opt), helper.optionDescription(opt)));
			}
			lines.push("");
		}

		/* v8 ignore start -- root program always registers Jolli Memory commands */
		if (memoryCmds.length > 0) {
			/* v8 ignore stop */
			lines.push("Jolli Memory — Auto-document AI development sessions");
			lines.push(renderSectionDescription(MEMORY_DESCRIPTION), "");
			lines.push("Commands:");
			for (const c of memoryCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		/* v8 ignore start -- root program always registers Jolli Site commands */
		if (siteCmds.length > 0) {
			/* v8 ignore stop */
			lines.push("Jolli Site — Generate a docs site from your content folder");
			lines.push(renderSectionDescription(SITE_DESCRIPTION), "");
			lines.push("Commands:");
			for (const c of siteCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		/* v8 ignore start -- root program always registers Jolli Space commands (real plugin or stubs) */
		if (spaceCmds.length > 0) {
			/* v8 ignore stop */
			lines.push("Jolli Space — Sync docs, map sources, and analyze documentation impact");
			lines.push(renderSectionDescription(SPACE_DESCRIPTION), "");
			lines.push("Commands:");
			for (const c of spaceCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		if (otherCmds.length > 0) {
			lines.push("Other commands:");
			for (const c of otherCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		lines.push("Run `jolli <command> --help` for command-specific options.");
		return `${lines.join("\n")}\n`;
	};

	program.configureHelp({
		visibleCommands(cmd) {
			// Honor commander's per-command hidden flag too, so plugins can mark
			// their own subcommands as plugin-mode-hidden without the host needing
			// to know each name. `HIDDEN_COMMANDS` remains the host-owned list.
			//
			// `{ hidden: true }` is Commander's documented public option; the
			// internal field that backs it has been `_hidden` in v13, but the
			// name isn't part of the documented API. Probe both `_hidden` and
			// `hidden` so a future rename doesn't silently un-hide plugin
			// commands that opted out of help.
			return cmd.commands.filter((c) => !HIDDEN_COMMANDS.has(c.name()) && !isHiddenCommand(c));
		},
		formatHelp: formatGroupedHelp,
	});

	registerEnableCommand(program);
	registerDisableCommand(program);
	registerUninstallCommand(program);
	registerStatusCommand(program);
	registerConfigureCommand(program);
	registerCleanCommand(program);
	registerDoctorCommand(program);
	registerViewCommand(program);
	registerRecallCommand(program);
	registerSearchCommand(program);
	registerBackfillCommand(program);
	registerPrDescriptionCommand(program);
	registerPushCommand(program);
	registerSpacesCommand(program);
	registerBindCommand(program);
	registerQueueStatusCommand(program);
	registerLocalRunOfferCommand(program);
	registerOpenUrlCommand(program);
	registerVerifyPublishBranchCommand(program);
	registerWorkflowRunStatusCommand(program);
	registerWorkflowRunsCommand(program);
	registerCompileCommand(program);
	registerGraphCommand(program);
	registerMigrateCommand(program);
	registerHealFolderCommand(program);
	registerExportPromptCommand(program);
	registerExportCommand(program);
	registerAuthCommands(program);
	registerSyncCommand(program);
	registerMcpCommand(program);
	registerTelemetryCommand(program);

	// Auto-emit `command_invoked` for every command (built-in, plugin, future).
	// No-op until telemetry is bootstrapped (Cli.ts), so harmless in tests.
	installCommandTelemetryHooks(program);

	// Plugin-provided command surface. `loadPlugins` discovers and registers
	// installed plugins (returning the set of IDs it loaded); whatever's left
	// in `KnownPlugins.ts` with a `registerStub` fallback gets its stubs
	// registered by `registerMissingStubs` so the commands stay visible in
	// `--help` and emit an install hint when invoked. Both calls are
	// non-throwing — a broken plugin / stub never blocks the CLI.
	const { loaded: loadedPluginIds, diagnostics: pluginDiagnostics } = await loadPlugins(program, VERSION);
	registerMissingStubs(program, loadedPluginIds);

	// Hidden subcommand spawned by checkVersionMismatch's detached refresh:
	// queries npm for the latest version of the CLI + the given plugins and
	// rewrites update-check.json. Never user-invoked directly.
	program
		.command(REFRESH_COMMAND, { hidden: true })
		.argument("[packages...]", "package names to refresh")
		.action(async (packages: string[]) => {
			await refreshUpdateCache(packages.length > 0 ? packages : [CLI_PACKAGE_NAME]);
		});

	// Reuse the plugin diagnostics loadPlugins already computed, so the version
	// check doesn't trigger a second discovery walk on the startup hot path.
	await checkVersionMismatch({ pluginDiagnostics });

	// Default action (no subcommand) — the sole TUI entry point. `jolli` opens
	// the Ink control center (guided front door when setup is incomplete);
	// `--once`/`--format json` print a scriptable snapshot; a non-interactive
	// bare `jolli` (piped / CI) prints help. Ink/react are pulled in only on the
	// interactive branch via dynamic import, keeping them off every other path.
	program.action(async (opts: { cwd?: string; view?: string; once?: boolean; format?: string }) => {
		const cwd = opts.cwd ?? resolveProjectDir();
		// Ink needs a TTY on BOTH stdin and stdout; a snapshot request also forces
		// the non-interactive path. (isInteractive() checks stdin only, so we test
		// stdout explicitly — mirrors the old bare-`jolli` guard.)
		const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
		const nonInteractive = opts.once === true || opts.format === "json" || !interactive;
		if (nonInteractive) {
			if (opts.once !== true && opts.format !== "json") {
				program.outputHelp();
				return;
			}
			// A snapshot must fail cleanly (one-line error, non-zero exit) rather
			// than dumping a Node stack trace — this path is meant to be scripted.
			try {
				setLogDir(cwd);
				setActiveStorage(await createStorage(cwd, cwd));
				const model = await loadHomeModel(buildTuiDeps(cwd));
				console.log(
					opts.format === "json" ? JSON.stringify({ type: "home", ...model }) : renderHomeSnapshot(model),
				);
			} catch (err) {
				console.error(`jolli: could not read status — ${(err as Error).message}`);
				process.exitCode = 1;
			}
			return;
		}
		const { runInkTui } = await import("./tui/ink/runInkTui.js");
		await runInkTui(cwd, toInitialTab(opts.view), buildCommandCatalog(program));
	});

	// The root `--cwd` exists for the bare-`jolli` TUI, but positional options mean
	// `jolli --cwd <dir> status` parses it at the root and the subcommand would
	// otherwise ignore it — silently running against the current directory (a
	// dangerous "wrong repo looks successful" footgun). Forward it to any subcommand
	// that has its own `--cwd` the user did NOT set explicitly. Commander reports the
	// source as "default" for subcommands whose `--cwd` carries a default value
	// (`status`, `backfill`, …) and `undefined` for those declaring `--cwd` with no
	// default (`graph`, `compile`) — both mean "unset", so both must inherit the root
	// value. An explicit `status --cwd <dir>` (source "cli"/"env") wins, and the bare
	// TUI (actionCommand === program) reads the root value itself.
	program.hook("preAction", (_thisCommand, actionCommand) => {
		const rootCwd = program.opts().cwd as string | undefined;
		if (rootCwd === undefined || actionCommand === program) {
			return;
		}
		const hasCwdOption = actionCommand.options.some((o) => o.attributeName() === "cwd");
		const source = actionCommand.getOptionValueSource("cwd");
		if (hasCwdOption && (source === "default" || source === undefined)) {
			actionCommand.setOptionValue("cwd", rootCwd);
		}
	});

	/* v8 ignore start - process.argv branch only used when running as script, not in tests */
	await program.parseAsync(args !== undefined ? ["node", "jolli", ...args] : process.argv);
	/* v8 ignore stop */
}
