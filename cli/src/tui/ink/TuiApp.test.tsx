import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { CommandCatalogEntry } from "./CommandCatalog.js";
import { TuiApp } from "./TuiApp.js";
import type { TuiDeps } from "./TuiDeps.js";

// The real hook reads the live stdout height; override only `useTerminalSize`
// (keep the real `fitRows`). `mockRows` defaults to undefined so every existing
// test keeps the height-less inline behaviour; the fixed-height test sets it.
let mockRows: number | undefined;
vi.mock("./useTerminalSize.js", async (orig) => {
	const actual = await orig<typeof import("./useTerminalSize.js")>();
	return { ...actual, useTerminalSize: () => ({ columns: 80, rows: mockRows }) };
});

const tick = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Defaults to a fully set-up repo → dashboard layout (tab bar shown). */
function fakeDeps(over: Partial<TuiDeps> = {}): TuiDeps {
	return {
		cwd: "/x",
		getIdentity: async () => ({ repo: "repo", branch: "main" }),
		getStatus: async () =>
			({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 3,
				orphanBranch: "b",
			}) as never,
		getQueueStatus: async () => ({
			active: 0,
			ingestActive: 0,
			workerBusy: false,
			workerBlocking: false,
			drained: true,
			stale: 0,
		}),
		getIngestPhase: async () => ({ busy: false, phase: null }),
		getLastSyncAt: async () => null,
		getSpaceBinding: async () => null,
		getBackfillOffer: async () => null,
		dismissBackfill: async () => {},
		runColdStartBackfill: async () => ({ generated: 0, errors: 0 }),
		getInstalledSkills: async () => [],
		setSkillInstalled: async () => {},
		listMemories: async () => [],
		getMemoryDetail: async () => null,
		searchMemories: async () => [],
		listTopics: async () => [],
		getTopicDetail: async () => ({
			slug: "s",
			title: "T",
			content: "",
			relatedBranches: [],
			lastUpdatedAt: "",
			timeline: [],
		}),
		setEnabled: async () => {},
		loadAuthToken: async () => "tok",
		signInWithBrowser: async () => {},
		saveJolliApiKey: async () => {},
		saveAnthropicKey: async () => {},
		setAiProvider: async () => {},
		runCloudSync: async () => ({ kind: "bound", spaceName: "s", canPush: true, rechecked: true }),
		installPlugin: async () => {},
		inspectPlugins: async () => [],
		loadConfig: async () => ({ apiKey: "sk-ant-x", aiProvider: "anthropic" }),
		enableHost: async () => {},
		disableHost: async () => {},
		applySetting: async () => {},
		runCommand: async () => ({ output: "", exitCode: 0 }),
		...over,
	};
}

describe("TuiApp — cross-tab state persistence", () => {
	it("reopens Memory Bank on the topic the user left, not the first", async () => {
		const deps = fakeDeps({
			listTopics: async () => ["alpha", "beta", "gamma"],
			getTopicDetail: async (slug) => ({
				slug,
				title: slug,
				content: `body of ${slug}`,
				relatedBranches: [],
				lastUpdatedAt: "",
				timeline: [],
			}),
		});
		const { stdin, lastFrame } = render(<TuiApp deps={deps} />);
		await tick();
		stdin.write("3"); // → Memory Bank (topics)
		await tick();
		expect(lastFrame()).toContain("body of alpha");
		stdin.write("j"); // → beta
		await tick();
		expect(lastFrame()).toContain("body of beta");
		stdin.write("1"); // → Home (Memory Bank unmounts)
		await tick();
		stdin.write("3"); // → Memory Bank again
		await tick();
		// Persisted: still on beta, NOT snapped back to the first topic.
		expect(lastFrame()).toContain("body of beta");
	});

	it("reopens Settings on the section the user left, not general", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} />);
		await tick();
		stdin.write("4"); // → Settings (general)
		await tick();
		expect(lastFrame()).toContain("Global Instructions");
		stdin.write("[C"); // ► → sources
		await tick();
		expect(lastFrame()).toContain("Jolli API Key");
		stdin.write("1"); // → Home (Settings unmounts)
		await tick();
		stdin.write("4"); // → Settings again
		await tick();
		// Persisted: still on the sources section, not back on general.
		expect(lastFrame()).toContain("Jolli API Key");
		expect(lastFrame()).not.toContain("Global Instructions");
	});
});

describe("TuiApp — dashboard shell (set up)", () => {
	it("renders the 4-tab bar and starts on Home", async () => {
		const { lastFrame } = render(<TuiApp deps={fakeDeps()} />);
		await tick();
		const out = lastFrame() ?? "";
		for (const label of ["Home", "Current Branch", "Memory Bank", "Settings"]) {
			expect(out).toContain(label);
		}
		// Manage merged into Settings; Graph → a command; Commands tab → Home's `/` palette.
		expect(out).not.toContain("Manage");
		expect(out).not.toContain("Graph");
		expect(out).not.toContain("Commands");
		expect(out).toContain("[Tab] tabs");
	});

	it("pins the tab bar + bottom bar and clips the screen to the terminal height", async () => {
		// With a known short height, the root column is height-constrained and the
		// screen region clips its overflow — so the frame never exceeds `rows` and
		// the tab bar (top) can't be pushed out of view by a taller tab.
		mockRows = 12;
		try {
			const { lastFrame } = render(<TuiApp deps={fakeDeps()} />);
			await tick();
			const out = lastFrame() ?? "";
			expect(out).toContain("Home"); // tab bar still at the top
			expect(out).toContain("[Tab] tabs"); // bottom global hints still visible
			expect(out.split("\n").length).toBeLessThanOrEqual(12); // clipped to the height
		} finally {
			mockRows = undefined;
		}
	});

	it("jumps to a tab by digit (1-4)", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} />);
		await tick();
		stdin.write("4"); // Settings (general sub-view by default)
		await tick();
		expect(lastFrame()).toContain("Global Instructions");
		expect(lastFrame()).toContain("AI Agents │ AI Summary"); // Settings sub-nav
		stdin.write("3"); // Memory Bank (topics view)
		await tick();
		expect(lastFrame()).toContain("No topics yet.");
		stdin.write("2"); // Memories (browse)
		await tick();
		expect(lastFrame()).toContain("No committed memories"); // browse empty-state
	});

	it("cycles tabs with Tab and honors an initialTab", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} initialTab="settings" />);
		// Two waves: Home loads → reports layout → jump to Settings → Settings loads.
		await tick();
		await tick();
		expect(lastFrame()).toContain("Global Instructions");
		stdin.write("\t"); // settings (last) → home (wraps)
		await tick();
		expect(lastFrame()).toContain("Jolli is listening");
	});

	it("opens Memory Bank via --view (initialTab) on its topics view", async () => {
		const deps = fakeDeps({ listTopics: async () => ["alpha"] });
		const { lastFrame } = render(<TuiApp deps={deps} initialTab="memory-bank" />);
		// Home loads → reports dashboard → jump to Memory Bank → topics view.
		await tick();
		await tick();
		expect(lastFrame()).toContain("alpha"); // the topic list
	});
});

describe("TuiApp — global command palette", () => {
	const catalog: CommandCatalogEntry[] = [
		{ name: "doctor", description: "Diagnose the install", group: "Core", needsArgs: false },
	];

	it("opens as a bottom bar from any tab (screen stays) and gates digit keys into the palette", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} catalog={catalog} initialTab="memories" />);
		await tick();
		await tick(); // land on Memories
		expect(lastFrame()).toContain("No committed memories");
		stdin.write("/"); // open the palette from the Memories tab
		await tick();
		const opened = lastFrame() ?? "";
		expect(opened).toContain("[Esc] close"); // StatusBar palette hints
		expect(opened).toContain("No committed memories"); // bottom bar: the Memories body stays above
		stdin.write("2"); // filtered into the palette, NOT a tab jump
		await tick();
		expect(lastFrame()).toContain("/2");
	});

	it("keeps the previous output visible above the palette when `/` is reopened", async () => {
		const runCommand = vi.fn(async () => ({ output: "doctor output here", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r"); // run doctor → output shown
		await tick();
		expect(lastFrame()).toContain("doctor output here");
		stdin.write("/"); // reopen the palette
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("doctor output here"); // transcript STAYS visible above…
		expect(out).toContain("/"); // …with the palette input below it
	});

	it("Tab completes the typed command word to the highlighted entry (keeping args)", async () => {
		const many: CommandCatalogEntry[] = [
			{ name: "recall", description: "Recall context", group: "Core", needsArgs: false },
			{ name: "doctor", description: "Diagnose", group: "Core", needsArgs: false },
		];
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} catalog={many} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "rec") stdin.write(c);
		await tick();
		stdin.write("\t"); // Tab → complete "rec" → "recall "
		await tick();
		expect(lastFrame()).toContain("/recall");
	});

	it("cursor scrolls the whole list — entries past the visible window are reachable", async () => {
		// 8 matches, only ~6 render at once; Down must keep moving past the window so
		// the last entry (c7) — previously unreachable — can be selected and run.
		const many: CommandCatalogEntry[] = Array.from({ length: 8 }, (_, i) => ({
			name: `c${i}`,
			description: "diag",
			group: "Core",
			needsArgs: false,
		}));
		const runCommand = vi.fn(async () => ({ output: "", exitCode: 0 }));
		const { stdin } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={many} />);
		await tick();
		stdin.write("/");
		stdin.write("c"); // all 8 match
		await tick();
		for (let i = 0; i < 10; i++) stdin.write(`${String.fromCharCode(27)}[B`); // Down ×10
		await tick();
		stdin.write("\r");
		await tick();
		// Cursor clamps to the LAST entry (c7), not the last visible row — full-list scroll.
		expect(runCommand).toHaveBeenCalledWith(["c7"], expect.anything());
	});

	it("freezes the screen's keys while the palette owns input", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} catalog={catalog} initialTab="memories" />);
		await tick();
		await tick();
		stdin.write("/");
		await tick();
		stdin.write("r"); // Memories' `r` (→ recall) must NOT fire; it filters the palette
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("/r"); // the `r` went into the palette
		expect(out).toContain("No committed memories"); // Memories stayed on browse (its keys are paused)
	});

	it("pauses the global digit-jump while a screen field is capturing (focus=capture)", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} catalog={catalog} initialTab="memories" />);
		await tick();
		await tick();
		expect(lastFrame()).toContain("No committed memories"); // on Memories
		stdin.write("f"); // open the instant-search field → focus becomes "capture"
		await tick();
		stdin.write("2"); // must go INTO the search, NOT jump to the Settings tab
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("close search"); // still in Memories search mode (its StatusBar hint)
		expect(out).not.toContain("Global Instructions"); // Settings tab never opened
	});

	it("recovers from a render crash that happens while a field is capturing", async () => {
		// React logs the caught render error — silence it; we assert the recovery.
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		// A search hit missing `title` makes the hits list throw during render.
		const deps = fakeDeps({ searchMemories: async () => [{ id: "x" } as never] });
		const { stdin, lastFrame } = render(<TuiApp deps={deps} catalog={catalog} initialTab="memories" />);
		await tick();
		await tick();
		stdin.write("f"); // open instant-search → focus becomes "capture"
		await tick();
		stdin.write("a"); // type a char → hits load → render throws mid-capture
		await tick();
		expect(lastFrame()).toContain("Something went wrong rendering this view");
		// Regression: without releasing the stuck capture state, the global keys
		// stay paused and tab-switch / q are dead. The onError reset makes them live.
		stdin.write("1"); // jump to Home — must work now
		await tick();
		expect(lastFrame()).toContain("Home");
		expect(lastFrame()).not.toContain("Something went wrong");
		spy.mockRestore();
	});

	it("runs a command and shows captured output in-panel; Esc closes it", async () => {
		const runCommand = vi.fn(async () => ({ output: "doctor says OK", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(runCommand).toHaveBeenCalledWith(["doctor"], expect.anything());
		const out = lastFrame() ?? "";
		expect(out).toContain("$ jolli doctor");
		expect(out).toContain("doctor says OK");
		expect(out).not.toContain("exit 0"); // a successful run shows no exit footer
		stdin.write(String.fromCharCode(27)); // Esc closes the output panel
		await new Promise((r) => setTimeout(r, 150));
		expect(lastFrame()).not.toContain("$ jolli doctor");
	});

	it("reloads Home after a Home-affecting command finishes (auth logout flips Sign-in)", async () => {
		// `loadAuthToken` reads the on-disk creds; the command stands in for
		// `auth logout`, which clears them. Flip the fake inside runCommand to
		// mimic that side effect, then assert the Home Sign-in row follows.
		let token: string | undefined = "tok";
		const loadAuthToken = vi.fn(async () => token);
		const runCommand = vi.fn(async () => {
			token = undefined;
			return { output: "Logged out.", exitCode: 0 };
		});
		const authCatalog: CommandCatalogEntry[] = [
			{ name: "auth", description: "Auth", group: "Core", needsArgs: false },
		];
		const { stdin, lastFrame } = render(
			<TuiApp deps={fakeDeps({ loadAuthToken, runCommand })} catalog={authCatalog} />,
		);
		await tick();
		expect(lastFrame()).not.toContain("not signed in"); // pre-logout: signed in
		stdin.write("/");
		await tick();
		for (const c of "auth logout") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		const out = lastFrame() ?? "";
		expect(runCommand).toHaveBeenCalledWith(["auth", "logout"], expect.anything());
		expect(out).toContain("not signed in"); // Home reloaded → Sign-in flipped
	});

	it("does NOT reload Home after a read-only command (Sign-in row unchanged)", async () => {
		// A command outside HOME_AFFECTING_COMMANDS must not trigger the reload,
		// so even if the creds changed on disk the row stays until the next real
		// reload — proving the completion hook is scoped, not fire-on-every-command.
		let token: string | undefined = "tok";
		const loadAuthToken = vi.fn(async () => token);
		const runCommand = vi.fn(async () => {
			token = undefined; // creds changed, but `doctor` shouldn't force a reread
			return { output: "doctor says OK", exitCode: 0 };
		});
		const { stdin, lastFrame } = render(
			<TuiApp deps={fakeDeps({ loadAuthToken, runCommand })} catalog={catalog} />,
		);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("doctor says OK"); // command ran
		expect(out).not.toContain("not signed in"); // Home NOT reloaded → row stale (as intended)
	});

	it("reloads Home after `configure` (config-changing command re-reads the model)", async () => {
		// `configure` mutates apiKey/jolliApiKey/aiProvider — config the Home model
		// reads directly — so it must force a full reload (loadHomeModel → loadConfig).
		const loadConfig = vi.fn(async () => ({ apiKey: "sk-ant-x", aiProvider: "anthropic" as const }));
		const runCommand = vi.fn(async () => ({ output: "set", exitCode: 0 }));
		const configureCatalog: CommandCatalogEntry[] = [
			{ name: "configure", description: "Configure", group: "Core", needsArgs: false },
		];
		const { stdin } = render(<TuiApp deps={fakeDeps({ loadConfig, runCommand })} catalog={configureCatalog} />);
		await tick();
		const before = loadConfig.mock.calls.length; // initial load read it once
		stdin.write("/");
		await tick();
		for (const c of "configure") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		expect(runCommand).toHaveBeenCalledWith(["configure"], expect.anything());
		expect(loadConfig.mock.calls.length).toBeGreaterThan(before); // reload re-read config
	});

	it("reloads Home after `uninstall` (tears the install down)", async () => {
		const loadConfig = vi.fn(async () => ({ apiKey: "sk-ant-x", aiProvider: "anthropic" as const }));
		const runCommand = vi.fn(async () => ({ output: "removed", exitCode: 0 }));
		const uninstallCatalog: CommandCatalogEntry[] = [
			{ name: "uninstall", description: "Uninstall", group: "Core", needsArgs: false },
		];
		const { stdin } = render(<TuiApp deps={fakeDeps({ loadConfig, runCommand })} catalog={uninstallCatalog} />);
		await tick();
		const before = loadConfig.mock.calls.length;
		stdin.write("/");
		await tick();
		for (const c of "uninstall") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		expect(runCommand).toHaveBeenCalledWith(["uninstall"], expect.anything());
		expect(loadConfig.mock.calls.length).toBeGreaterThan(before); // Home re-read
	});

	it("keeps the wizard's input live after `/uninstall` collapses the dashboard", async () => {
		// `/uninstall` runs from the palette (output panel open), then Home reloads
		// and reports layout="wizard" — the tabs and command bar unmount. The runner
		// must be closed on that collapse, or focus stays pinned on the now-gone
		// output panel and the wizard's own keys are dead.
		let torn = false;
		const setEnabled = vi.fn(async () => {});
		const runCommand = vi.fn(async (argv: string[]) => {
			if (argv[0] === "uninstall") torn = true;
			return { output: "removed", exitCode: 0 };
		});
		const deps = fakeDeps({
			setEnabled,
			runCommand,
			loadAuthToken: async () => (torn ? "" : "tok"),
			loadConfig: async () => (torn ? {} : { apiKey: "sk-ant-x", aiProvider: "anthropic" as const }),
			getStatus: async () =>
				({
					enabled: !torn,
					claudeHookInstalled: !torn,
					gitHookInstalled: !torn,
					geminiHookInstalled: false,
					activeSessions: 0,
					mostRecentSession: null,
					summaryCount: 3,
					orphanBranch: "b",
				}) as never,
		});
		const uninstallCatalog: CommandCatalogEntry[] = [
			{ name: "uninstall", description: "Uninstall", group: "Core", needsArgs: false },
		];
		const { stdin } = render(<TuiApp deps={deps} catalog={uninstallCatalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "uninstall") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		await tick();
		// Now in the wizard. Press the enable step's accelerator ("a") — it fires
		// only if the wizard screen owns the keyboard, i.e. the stranded output
		// panel focus was released.
		stdin.write("a");
		await tick();
		expect(setEnabled).toHaveBeenCalledWith(true);
	});

	it("reloads the Settings tab after `/configure` (config rows re-read)", async () => {
		// getInstalledSkills is a Settings fetchAll read; on the Settings tab Home is
		// unmounted, so a fresh call after the command proves Settings itself reloaded.
		const getInstalledSkills = vi.fn(async () => []);
		const runCommand = vi.fn(async () => ({ output: "set", exitCode: 0 }));
		const configureCatalog: CommandCatalogEntry[] = [
			{ name: "configure", description: "Configure", group: "Core", needsArgs: false },
		];
		const { stdin } = render(
			<TuiApp
				deps={fakeDeps({ getInstalledSkills, runCommand })}
				catalog={configureCatalog}
				initialTab="settings"
			/>,
		);
		await tick();
		await tick(); // land on Settings
		const before = getInstalledSkills.mock.calls.length;
		stdin.write("/");
		await tick();
		for (const c of "configure") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		expect(runCommand).toHaveBeenCalledWith(["configure"], expect.anything());
		expect(getInstalledSkills.mock.calls.length).toBeGreaterThan(before); // Settings re-read
	});

	it("reloads the Memories list after `/backfill` (mutates memories off the queue worker)", async () => {
		const listMemories = vi.fn(async () => []);
		const runCommand = vi.fn(async () => ({ output: "generated", exitCode: 0 }));
		const backfillCatalog: CommandCatalogEntry[] = [
			{ name: "backfill", description: "Backfill", group: "Core", needsArgs: false },
		];
		const { stdin } = render(
			<TuiApp deps={fakeDeps({ listMemories, runCommand })} catalog={backfillCatalog} initialTab="memories" />,
		);
		await tick();
		await tick(); // land on Memories (Home loads → dashboard → jump)
		const before = listMemories.mock.calls.length; // initial list read
		stdin.write("/");
		await tick();
		for (const c of "backfill") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		await tick();
		expect(runCommand).toHaveBeenCalledWith(["backfill"], expect.anything());
		expect(listMemories.mock.calls.length).toBeGreaterThan(before); // Memories re-read
	});

	it("shows an error (not a stuck spinner) when runCommand rejects", async () => {
		// runCommand is meant not to throw, but a synchronous spawn failure rejects.
		const runCommand = vi.fn(async () => Promise.reject(new Error("spawn boom")));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("$ jolli doctor");
		expect(out).not.toContain("running…"); // spinner cleared
		expect(out).toContain("spawn boom"); // error surfaced in-panel
		expect(out).toContain("exit 1");
	});

	it("switching tab hides an open output panel", async () => {
		const runCommand = vi.fn(async () => ({ output: "hi", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame()).toContain("$ jolli doctor");
		stdin.write("2"); // jump to Memories → overlay closes
		await tick();
		const out = lastFrame() ?? "";
		expect(out).not.toContain("$ jolli doctor");
		expect(out).toContain("No committed memories");
	});

	it("output panel: ignores keys while running, Esc cancels the in-flight command", async () => {
		// A command that never resolves keeps the panel in the running state.
		const runCommand = vi.fn(() => new Promise<{ output: string; exitCode: number }>(() => {}));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame()).toContain("running…");
		stdin.write(`${String.fromCharCode(27)}[B`); // Down while running → ignored, still running
		await tick();
		expect(lastFrame()).toContain("running…");
		stdin.write(String.fromCharCode(27)); // Esc cancels the run
		await new Promise((r) => setTimeout(r, 150));
		expect(lastFrame()).not.toContain("running…");
	});

	it("output panel: aborts the in-flight child when the TUI unmounts (Ctrl-C quit)", async () => {
		// Ink's Ctrl-C handler calls app.exit() and unmounts regardless of our input
		// gating; the runner's unmount cleanup must abort so the child isn't orphaned.
		let captured: AbortSignal | undefined;
		const runCommand = vi.fn((_argv: string[], signal?: AbortSignal) => {
			captured = signal;
			return new Promise<{ output: string; exitCode: number }>(() => {}); // never resolves
		});
		const { stdin, unmount } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(captured?.aborted).toBe(false);
		unmount();
		await tick();
		expect(captured?.aborted).toBe(true);
	});

	it("output panel: auto-scrolls to the newest output, ↑↓ scrolls, `/` reopens the palette", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const runCommand = vi.fn(async () => ({ output: lines, exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		// Terminal-like: on completion the panel is scrolled to the BOTTOM (newest),
		// so the last output line is visible and older lines are hidden ABOVE (▲).
		expect(lastFrame()).toContain("line 39");
		expect(lastFrame()).toContain("▲");
		stdin.write(`${String.fromCharCode(27)}[A`); // Up → scroll toward the top (▼ appears)
		await tick();
		expect(lastFrame()).toContain("▼");
		stdin.write("/"); // `/` reopens the palette BELOW the still-visible transcript
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("line "); // transcript stays visible (some output line still shown)
		expect(out).toContain("Diagnose the install"); // palette listing appears below it
	});

	it("palette: Enter with no matching command is a no-op (stays open)", async () => {
		const runCommand = vi.fn(async () => ({ output: "", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "zzzz") stdin.write(c); // matches nothing in the catalog
		await tick();
		stdin.write("\r");
		await tick();
		expect(runCommand).not.toHaveBeenCalled();
		expect(lastFrame()).toContain("/zzzz"); // palette still open, unchanged
	});

	it("palette: bare Enter on empty input does NOT run the top command", async () => {
		// An empty query lists the WHOLE catalog (relevantCount = catalog.length),
		// so without the empty-input guard a reflexive Enter right after `/` would
		// run the highlighted top command by accident.
		const runCommand = vi.fn(async () => ({ output: "", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		stdin.write("\r"); // Enter with nothing typed and nothing ↑↓-picked
		await tick();
		expect(runCommand).not.toHaveBeenCalled();
		expect(lastFrame()).toContain("[↑↓] select"); // palette stays open
	});

	it("palette: backspace deletes chars, then closes the palette when emptied", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps()} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		stdin.write("d");
		await tick();
		expect(lastFrame()).toContain("/d");
		stdin.write("\x7f"); // backspace → "/"
		await tick();
		stdin.write("\x7f"); // backspace on empty input → closes the palette
		await tick();
		const out = lastFrame() ?? "";
		// Palette closed: back to the persistent collapsed bar, no live cursor echo.
		expect(out).toContain("type a command — ");
	});

	it("appends a second command's output below the first (terminal-like, no clear)", async () => {
		const outputs = ["first output", "second output"];
		let n = 0;
		const runCommand = vi.fn(async () => ({ output: outputs[n++] ?? "", exitCode: 0 }));
		const many: CommandCatalogEntry[] = [
			{ name: "doctor", description: "Diagnose the install", group: "Core", needsArgs: false },
			{ name: "status", description: "Show status", group: "Core", needsArgs: false },
		];
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={many} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doctor") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame()).toContain("first output");
		stdin.write("/"); // reopen palette over the retained transcript
		await tick();
		for (const c of "status") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		const out = lastFrame() ?? "";
		// BOTH runs are present — the second appended below the first, not replacing it.
		expect(out).toContain("$ jolli doctor");
		expect(out).toContain("$ jolli status");
		expect(out).toContain("second output");
	});

	it("Esc hides the panel but keeps the transcript (reappears on the next run); Ctrl-L clears it", async () => {
		const runCommand = vi.fn(async () => ({ output: "hello", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame()).toContain("$ jolli doctor");
		stdin.write(String.fromCharCode(27)); // Esc → hide the panel (keep history)
		await new Promise((r) => setTimeout(r, 150)); // ESC is buffered longer than a tick
		expect(lastFrame()).not.toContain("$ jolli doctor");
		// Run again — the hidden history is retained, so BOTH runs now show (proves Esc
		// only hid the panel, didn't clear the transcript).
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame()?.match(/\$ jolli doctor/g)?.length).toBe(2);
		stdin.write("\f"); // Ctrl-L → clear everything
		await tick();
		expect(lastFrame()).not.toContain("$ jolli doctor");
		expect(lastFrame()).toContain("type a command — "); // back to the collapsed bar
	});

	it("/clear pseudo-command clears the transcript without spawning a child", async () => {
		const runCommand = vi.fn(async () => ({ output: "hello", exitCode: 0 }));
		const { stdin, lastFrame } = render(<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} />);
		await tick();
		stdin.write("/");
		await tick();
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(runCommand).toHaveBeenCalledTimes(1);
		stdin.write("/");
		await tick();
		for (const c of "clear") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(runCommand).toHaveBeenCalledTimes(1); // /clear never spawned a child
		expect(lastFrame()).not.toContain("$ jolli doctor"); // transcript cleared
	});

	it("pauses global keys while a command runs (Tab/q can't abort a write command)", async () => {
		let resolveRun: (v: { output: string; exitCode: number }) => void = () => {};
		const runCommand = vi.fn(
			() =>
				new Promise<{ output: string; exitCode: number }>((res) => {
					resolveRun = res;
				}),
		);
		const { stdin, lastFrame } = render(
			<TuiApp deps={fakeDeps({ runCommand })} catalog={catalog} initialTab="memories" />,
		);
		await tick();
		await tick();
		stdin.write("/");
		await tick(); // let the palette open (activate its input) before typing
		for (const c of "doc") stdin.write(c);
		await tick();
		stdin.write("\r"); // start the (still-pending) command
		await tick();
		expect(lastFrame()).toContain("running…");
		stdin.write("\t"); // Tab while running → must NOT switch tab or abort
		await tick();
		expect(lastFrame()).toContain("running…"); // still running, still on the panel
		resolveRun({ output: "done", exitCode: 0 });
		await tick();
		expect(lastFrame()).toContain("done");
	});
});

describe("TuiApp — wizard shell (not set up)", () => {
	const wizardDeps = () =>
		fakeDeps({
			loadAuthToken: async () => undefined,
			loadConfig: async () => ({}),
			getStatus: async () => ({ enabled: false, summaryCount: 0, orphanBranch: "b" }) as never,
		});

	it("hides the tab bar and locks to the Home wizard", async () => {
		const { lastFrame } = render(<TuiApp deps={wizardDeps()} initialTab="settings" />);
		await tick();
		const out = lastFrame() ?? "";
		expect(out).toContain("Welcome to Jolli Memory");
		expect(out).toContain("Step 1 of 2");
		// No tab chrome while in the wizard, even though initialTab was "settings".
		expect(out).not.toContain("[Tab] tabs");
		expect(out).not.toContain("AI provider");
	});

	it("ignores digit/Tab switching in the wizard", async () => {
		const { stdin, lastFrame } = render(<TuiApp deps={wizardDeps()} />);
		await tick();
		stdin.write("3"); // would be Settings if tabs were active
		await tick();
		expect(lastFrame()).toContain("Welcome to Jolli Memory");
		expect(lastFrame()).not.toContain("Global Instructions");
	});
});
