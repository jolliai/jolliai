import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { CommandCatalogEntry } from "./CommandCatalog.js";
import { CommandPaletteView, filterCatalog, paletteArgv, relevantCount } from "./CommandPalette.js";

const CATALOG: CommandCatalogEntry[] = [
	{ name: "doctor", description: "Diagnose the install", group: "Core", needsArgs: false },
	{
		name: "pr-description",
		description: "Build a PR body",
		group: "Core",
		needsArgs: true,
		usage: "--base <branch>",
	},
	{ name: "build", description: "Build the site", group: "Jolli Site", needsArgs: false },
];

describe("filterCatalog (ranks the whole catalog, never hides)", () => {
	it("returns the full catalog unchanged for an empty input", () => {
		expect(filterCatalog(CATALOG, "")).toEqual(CATALOG);
		expect(filterCatalog(CATALOG, "/  ")).toEqual(CATALOG);
	});

	it("floats name-prefix then substring matches to the top, rest appended in order", () => {
		// "b" prefixes "build"; "pr-description"'s description contains "Build a PR body";
		// "doctor" matches nothing but is still present, appended last.
		expect(filterCatalog(CATALOG, "B").map((e) => e.name)).toEqual(["build", "pr-description", "doctor"]);
	});

	it("matches on description substrings, non-matches still appended", () => {
		expect(filterCatalog(CATALOG, "diagnose").map((e) => e.name)).toEqual(["doctor", "pr-description", "build"]);
	});

	it("only the first token ranks — args don't narrow the list", () => {
		expect(filterCatalog(CATALOG, "doctor --verbose").map((e) => e.name)).toEqual([
			"doctor",
			"pr-description",
			"build",
		]);
	});

	it("keeps every entry on no match (full catalog, original order)", () => {
		expect(filterCatalog(CATALOG, "zzz").map((e) => e.name)).toEqual(["doctor", "pr-description", "build"]);
	});
});

describe("relevantCount (where the 'other commands' divider goes)", () => {
	it("equals the catalog length for empty input (no divider)", () => {
		expect(relevantCount(CATALOG, "")).toBe(CATALOG.length);
	});
	it("counts prefix + substring matches", () => {
		expect(relevantCount(CATALOG, "B")).toBe(2); // build (prefix) + pr-description (substring)
		expect(relevantCount(CATALOG, "diagnose")).toBe(1); // doctor
	});
	it("is 0 when nothing matches", () => {
		expect(relevantCount(CATALOG, "zzz")).toBe(0);
	});
});

describe("paletteArgv", () => {
	const doctor = CATALOG[0];
	const pr = CATALOG[1];

	it("runs a no-arg command bare", () => {
		expect(paletteArgv(doctor, "doctor")).toEqual(["doctor"]);
	});

	it("bare run applies TUI defaultArgs (e.g. graph → --export --open)", () => {
		const graph: CommandCatalogEntry = {
			name: "graph",
			description: "Export the knowledge graph",
			group: "Core",
			needsArgs: false,
			defaultArgs: ["--export", "--open"],
		};
		expect(paletteArgv(graph, "graph")).toEqual(["graph", "--export", "--open"]);
		expect(paletteArgv(graph, "graph --export /tmp")).toEqual(["graph", "--export", "/tmp"]);
	});

	it("blocks a needsArgs command typed bare", () => {
		expect(paletteArgv(pr, "pr")).toBeNull();
	});

	it("passes typed args through for a needsArgs command", () => {
		expect(paletteArgv(pr, "pr --base main")).toEqual(["pr-description", "--base", "main"]);
	});

	it("passes extra args through for a no-arg command", () => {
		expect(paletteArgv(doctor, "/doc --json")).toEqual(["doctor", "--json"]);
	});

	it("blocks a requiresConfirm command unless --yes / -y / --dry-run is typed", () => {
		const clean: CommandCatalogEntry = {
			name: "clean",
			description: "Remove local state",
			group: "Core",
			needsArgs: false,
			requiresConfirm: true,
		};
		expect(paletteArgv(clean, "clean")).toBeNull();
		expect(paletteArgv(clean, "clean --force")).toBeNull();
		expect(paletteArgv(clean, "clean --yes")).toEqual(["clean", "--yes"]);
		expect(paletteArgv(clean, "clean -y")).toEqual(["clean", "-y"]);
		expect(paletteArgv(clean, "clean --dry-run")).toEqual(["clean", "--dry-run"]);
	});

	it("keeps a double-quoted argument as a single token (spaces preserved)", () => {
		expect(paletteArgv(doctor, 'doctor "one two three"')).toEqual(["doctor", "one two three"]);
	});

	it("keeps a single-quoted argument as a single token", () => {
		expect(paletteArgv(pr, "pr --base 'feature branch'")).toEqual(["pr-description", "--base", "feature branch"]);
	});

	it("preserves an interior quoted span while splitting the rest on whitespace", () => {
		expect(paletteArgv(doctor, 'doctor --out "/tmp/my dir/x" --json')).toEqual([
			"doctor",
			"--out",
			"/tmp/my dir/x",
			"--json",
		]);
	});

	it("collapses whitespace runs and still ranks on the first token when quoted", () => {
		// A quoted FIRST token still ranks correctly (first token = command name).
		expect(filterCatalog(CATALOG, '"doc"').map((e) => e.name)[0]).toBe("doctor");
	});
});

describe("CommandPaletteView", () => {
	it("renders the input echo, entries with cursor, group suffix, and needs-args marker", () => {
		const { lastFrame } = render(
			<CommandPaletteView
				entries={CATALOG}
				input="x"
				cursor={1}
				blocked={false}
				relevantCount={CATALOG.length}
			/>,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("/x");
		expect(out).toContain("▸ pr-description");
		expect(out).toContain("(needs args)");
		expect(out).toContain("· Core");
		expect(out).toContain("· Jolli Site");
	});

	it("hang-indents a wrapped description under the description column, not column 0", () => {
		const long: CommandCatalogEntry = {
			name: "recall",
			description: "Recall development context for a branch default short summary for humans",
			group: "Core",
			needsArgs: false,
		};
		// Constrain the width so the long description must wrap.
		const { lastFrame } = render(
			<Box width={48}>
				<CommandPaletteView entries={[long]} input="" cursor={0} blocked={false} relevantCount={1} />
			</Box>,
		);
		const lines = (lastFrame() ?? "").split("\n");
		// The name and the start of the description share the first row.
		expect(lines.some((l) => /recall\s+Recall/.test(l))).toBe(true);
		// A wrapped continuation line (contains later words, not the name) is indented
		// to the description column — it must NOT start at column 0.
		const cont = lines.find((l) => l.includes("humans") && !l.includes("recall"));
		expect(cont).toBeDefined();
		expect((cont as string).match(/^ */)?.[0].length ?? 0).toBeGreaterThanOrEqual(10);
	});

	it("keeps a gap after a long command name so it never butts against the description", () => {
		// A name longer than a short fixed pad must NOT touch the description — the
		// name column widens to the longest name. Regression: `local-run-workflows`
		// used to render as `local-run-workflowsList…` with no gap.
		const entries: CommandCatalogEntry[] = [
			{ name: "view", description: "View commit summaries", group: "Core", needsArgs: false },
			{ name: "local-run-workflows", description: "List the workflows", group: "Core", needsArgs: false },
		];
		const { lastFrame } = render(
			<CommandPaletteView entries={entries} input="" cursor={0} blocked={false} relevantCount={2} />,
		);
		const out = lastFrame() ?? "";
		// At least one space separates the longest name from its description.
		expect(out).toMatch(/local-run-workflows\s+List the workflows/);
		// The short name's description starts at the SAME column as the long one's
		// (fixed name column), i.e. `view` is followed by a run of spaces before text.
		expect(out).toMatch(/view\s{5,}View commit summaries/);
	});

	it("renders a '(needs --yes)' marker for a confirm-gated command", () => {
		const clean: CommandCatalogEntry = {
			name: "clean",
			description: "Remove local state",
			group: "Core",
			needsArgs: false,
			requiresConfirm: true,
		};
		const { lastFrame } = render(
			<CommandPaletteView entries={[clean]} input="clean" cursor={0} blocked={false} relevantCount={1} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("(needs --yes)");
		expect(out).toContain("type: jolli clean --yes");
	});

	it("shows the empty state when the catalog is empty", () => {
		const { lastFrame } = render(
			<CommandPaletteView entries={[]} input="zzz" cursor={0} blocked={false} relevantCount={0} />,
		);
		expect(lastFrame()).toContain("no commands");
	});

	it("draws the 'other commands' divider where matches end", () => {
		const entries = filterCatalog(CATALOG, "doc"); // [doctor] relevant, then pr-description, build
		const { lastFrame } = render(
			<CommandPaletteView
				entries={entries}
				input="doc"
				cursor={0}
				blocked={false}
				relevantCount={relevantCount(CATALOG, "doc")}
			/>,
		);
		expect(lastFrame()).toContain("── other commands ──");
	});

	it("shows the full 'type:' hint (with usage) for the selected needs-args command", () => {
		const { lastFrame } = render(
			<CommandPaletteView entries={CATALOG} input="pr" cursor={1} blocked={false} relevantCount={1} />,
		);
		expect(lastFrame()).toContain("type: jolli pr-description --base <branch>");
	});

	it("emphasises the hint and prompts to complete it when blocked", () => {
		const { lastFrame } = render(
			<CommandPaletteView entries={[CATALOG[1]]} input="pr" cursor={0} blocked={true} relevantCount={1} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("type: jolli pr-description --base <branch>");
		expect(out).toContain("type the rest, then Enter");
	});

	it("shows a 'runs:' hint for a bare-runnable command (no args needed)", () => {
		const { lastFrame } = render(
			<CommandPaletteView entries={CATALOG} input="doc" cursor={0} blocked={false} relevantCount={1} />,
		);
		expect(lastFrame()).toContain("runs: jolli doctor");
	});

	it("lists subcommands under the selected command so the user knows what to type", () => {
		const auth: CommandCatalogEntry = {
			name: "auth",
			description: "Sign in to Jolli",
			group: "Core",
			needsArgs: false,
			defaultArgs: ["status"],
			signature: "<login|logout|status>",
			subcommands: ["login", "logout", "status"],
		};
		const { lastFrame } = render(
			<CommandPaletteView entries={[auth]} input="auth" cursor={0} blocked={false} relevantCount={1} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("runs: jolli auth status");
		expect(out).toContain("subcommands: login · logout · status");
	});

	it("lists option flags (capped at 4 with an ellipsis) for the selected command", () => {
		const push: CommandCatalogEntry = {
			name: "push",
			description: "Push memories",
			group: "Core",
			needsArgs: false,
			signature: "[options]",
			optionFlags: ["--all", "--branch <b>", "--dry-run", "--force", "--verbose"],
		};
		const { lastFrame } = render(
			<CommandPaletteView entries={[push]} input="push" cursor={0} blocked={false} relevantCount={1} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("runs: jolli push [options]");
		expect(out).toContain("options: --all · --branch <b> · --dry-run · --force · …");
	});

	it("windows a long list around the cursor with ▲/▼ affordances (no hard cap)", () => {
		const many: CommandCatalogEntry[] = Array.from({ length: 9 }, (_, i) => ({
			name: `cmd-${i}`,
			description: `d${i}`,
			group: "Core",
			needsArgs: false,
		}));
		// cursor at the top → first window + a "▼ N more" affordance.
		const top = render(
			<CommandPaletteView
				entries={many}
				input=""
				cursor={0}
				blocked={false}
				relevantCount={many.length}
				height={6}
			/>,
		);
		const topOut = top.lastFrame() ?? "";
		expect(topOut).toContain("cmd-0");
		expect(topOut).toContain("more"); // ▼ N more
		// cursor at the bottom → the last entry is now reachable/visible.
		const bottom = render(
			<CommandPaletteView
				entries={many}
				input=""
				cursor={8}
				blocked={false}
				relevantCount={many.length}
				height={6}
			/>,
		);
		expect(bottom.lastFrame() ?? "").toContain("cmd-8");
	});
});
