import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeScreen, HomeView, type HomeViewState, OUTCOME_TTL_MS } from "./HomeScreen.js";
import type { HomeModel } from "./HomeSnapshot.js";
import { buildOnboardingModel } from "./OnboardingModel.js";
import type { TuiDeps } from "./TuiDeps.js";

const tick = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// Under fake timers a single advanceTimersByTimeAsync(0) doesn't reliably flush
// HomeScreen's multi-await initial load / action chains when other suites share
// the worker — pump many tiny (1ms) cycles instead. 25ms total stays well under
// the 2.5s poll interval and the OUTCOME_TTL_MS window, so timing math holds.
const pump = async (): Promise<void> => {
	for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(1);
};

// resolveLlmCredentialSource reads ANTHROPIC_API_KEY — pin it off so a dev
// machine's env can't flip canGenerate and change the layout under test.
const ORIGINAL = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = ORIGINAL;
});

function mkModel(over: Partial<HomeModel> = {}): HomeModel {
	return {
		repo: "jolli-verify",
		branch: "feat-x",
		enabled: true,
		lastSyncLabel: "3m ago",
		summaryLabel: "idle",
		ingestLabel: "idle",
		queueLabel: "drained",
		sources: [
			{ name: "Claude", on: true },
			{ name: "Codex", on: false },
		],
		hostsDetected: 2,
		hostsTotal: 7,
		skills: [
			{ name: "jolli-pr", on: true },
			{ name: "jolli-search", on: false },
		],
		plugins: [{ name: "@jolli.ai/site-cli", state: "absent", installHint: "npm i -g @jolli.ai/site-cli" }],
		signedIn: true,
		signInLabel: "signed in · app.jolli.ai",
		credentialLabel: "Jolli API key",
		onboarding: buildOnboardingModel({
			signedIn: true,
			config: { jolliApiKey: "sk-jol" },
			enabled: true,
			summaryCount: 3,
		}),
		...over,
	};
}

function wizardModel(over: Partial<HomeModel> = {}): HomeModel {
	return mkModel({
		enabled: false,
		signedIn: false,
		signInLabel: "not signed in",
		credentialLabel: "none",
		onboarding: buildOnboardingModel({ signedIn: false, config: {}, enabled: false, summaryCount: 0 }),
		...over,
	});
}

const S = (over: Partial<HomeViewState> = {}): HomeViewState => ({
	cursor: 0,
	capturingKind: null,
	inputValue: "",
	busyLabel: null,
	statusLine: null,
	pending: false,
	binding: null,
	offer: null,
	...over,
});

function fakeDeps(over: Partial<TuiDeps> = {}): TuiDeps {
	return {
		cwd: "/x",
		getIdentity: async () => ({ repo: "jolli-verify", branch: "feat-x" }),
		getStatus: async () => ({ enabled: true, summaryCount: 3, orphanBranch: "b", claudeDetected: true }) as never,
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

describe("HomeView — dashboard", () => {
	it("renders status + auth rows and the listening banner, without the Settings-owned overview rows", () => {
		const { lastFrame } = render(<HomeView model={mkModel()} state={S()} />);
		const out = lastFrame() ?? "";
		expect(out).toContain("jolli-verify · feat-x");
		expect(out).toContain("● enabled");
		expect(out).toContain("Summary");
		expect(out).toContain("drained");
		expect(out).toContain("Sign-in");
		// Credential detail lives in Settings (AI provider) — Home shows sign-in only.
		expect(out).not.toContain("Credential");
		expect(out).toContain("Jolli is listening");
		// The `/` command palette + key hints are owned by the shell now.
		expect(out).not.toContain("[/] commands");
		// These four overviews moved to Settings — Home no longer renders them.
		expect(out).not.toContain("AI sources");
		expect(out).not.toContain("MCP hosts");
		expect(out).not.toContain("Skills");
		expect(out).not.toContain("Plugins");
	});

	it("surfaces a failed action's error line on the dashboard (not just inside the busy spinner)", () => {
		const busy = render(<HomeView model={mkModel()} state={S({ busyLabel: "syncing…" })} />).lastFrame() ?? "";
		expect(busy).not.toContain("error:");
		const failed =
			render(<HomeView model={mkModel()} state={S({ statusLine: "error: sync failed" })} />).lastFrame() ?? "";
		expect(failed).toContain("error: sync failed");
		// A non-"error:" outcome (a success confirmation) also renders once the
		// spinner is gone — it's the feedback for an action with no visible row change.
		const ok =
			render(<HomeView model={mkModel()} state={S({ statusLine: "✓ Space re-checked" })} />).lastFrame() ?? "";
		expect(ok).toContain("✓ Space re-checked");
	});

	it("shows the Space binding status instead of a last-sync clock", () => {
		// Unbound → an honest 'not bound' + a bind affordance (no perpetual 'never').
		const unbound = render(<HomeView model={mkModel()} state={S()} />).lastFrame() ?? "";
		expect(unbound).toContain("not bound");
		expect(unbound).toContain("bind a Jolli Space");
		expect(unbound).not.toContain("never");
		// Bound & pushable.
		const bound =
			render(
				<HomeView model={mkModel()} state={S({ binding: { spaceName: "Acme Core", canPush: true } })} />,
			).lastFrame() ?? "";
		expect(bound).toContain('Space "Acme Core"');
		expect(bound).not.toContain("won't sync"); // normal case: no redundant suffix
		expect(bound).toContain("re-check binding");
		// Bound but read-only.
		const readOnly =
			render(
				<HomeView model={mkModel()} state={S({ binding: { spaceName: "Acme Core", canPush: false } })} />,
			).lastFrame() ?? "";
		expect(readOnly).toContain("read-only, won't sync");
	});

	it("renders the cold-start back-fill offer with [b]/[x] affordances", () => {
		const offer = {
			hasMemory: true,
			commits: [
				{ hash: "abc1234", subject: "Fix parser" },
				{ hash: "def5678", subject: "Add tests" },
			],
			capped: false,
		};
		const out = render(<HomeView model={mkModel()} state={S({ offer })} />).lastFrame() ?? "";
		expect(out).toContain("2 recent commits have no memory yet");
		expect(out).toContain("[b]");
		expect(out).toContain("[x]");

		// Empty-repo wording + capped note.
		const empty = { hasMemory: false, commits: [{ hash: "a", subject: "x" }], capped: true };
		const out2 = render(<HomeView model={mkModel()} state={S({ offer: empty })} />).lastFrame() ?? "";
		expect(out2).toContain("This repo has no memories yet");
		expect(out2).toContain("most recent 1");

		// Hidden while an action is in flight — the spinner shows progress instead.
		const busy =
			render(<HomeView model={mkModel()} state={S({ offer, busyLabel: "building memories…" })} />).lastFrame() ??
			"";
		expect(busy).not.toContain("no memory yet");
	});
});

describe("HomeView — wizard", () => {
	it("renders the welcome, progress, and the highlighted step's action", () => {
		const { lastFrame } = render(<HomeView model={wizardModel()} state={S()} />);
		const out = lastFrame() ?? "";
		expect(out).toContain("Welcome to Jolli Memory");
		expect(out).toContain("Step 1 of 2");
		expect(out).toContain("Connect an AI model");
		expect(out).toContain("[Enter] sign in to Jolli");
		// (↑↓ move / q later hints now live in the shell StatusBar, not the wizard body.)
	});

	it("masks a captured API key", () => {
		const { lastFrame } = render(
			<HomeView model={wizardModel()} state={S({ capturingKind: "anthropic", inputValue: "sk-ant-1234" })} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("Anthropic API Key:");
		expect(out).toContain("•".repeat("sk-ant-1234".length));
		expect(out).not.toContain("sk-ant-1234");
	});

	it("shows a spinner + status line while busy", () => {
		const { lastFrame } = render(
			<HomeView model={wizardModel()} state={S({ busyLabel: "signing in…", statusLine: "visit: https://x" })} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("signing in…");
		expect(out).toContain("visit: https://x");
	});

	it("surfaces a failed action's error once the spinner is gone (busyLabel cleared)", () => {
		const { lastFrame } = render(
			<HomeView model={wizardModel()} state={S({ busyLabel: null, statusLine: "error: invalid key" })} />,
		);
		expect(lastFrame() ?? "").toContain("error: invalid key");
	});
});

describe("HomeScreen — load & dashboard toggle", () => {
	it("shows loading, then the dashboard", async () => {
		const { lastFrame } = render(<HomeScreen deps={fakeDeps()} />);
		expect(lastFrame()).toContain("loading");
		await tick();
		expect(lastFrame()).toContain("jolli-verify · feat-x");
		expect(lastFrame()).toContain("Jolli is listening");
	});

	it("fetches the Space binding and renders it on the dashboard", async () => {
		const getSpaceBinding = vi.fn(async () => ({ spaceName: "Acme Core", canPush: true }));
		const { lastFrame } = render(<HomeScreen deps={fakeDeps({ getSpaceBinding })} />);
		await tick();
		expect(getSpaceBinding).toHaveBeenCalled();
		expect(lastFrame()).toContain('Space "Acme Core"');
	});

	it("shows an error when the initial read fails", async () => {
		const { lastFrame } = render(
			<HomeScreen
				deps={fakeDeps({
					getStatus: async () => {
						throw new Error("boom");
					},
				})}
			/>,
		);
		await tick();
		expect(lastFrame()).toContain("Failed to load: boom");
	});

	it("recovers from a transient load error on the next reload (reloadKey bump)", async () => {
		// First read throws → error page; a later reload (reloadKey change) succeeds
		// and must clear the error, not stay stuck on the red page forever.
		let calls = 0;
		const getStatus = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("boom");
			return { enabled: true, summaryCount: 3, orphanBranch: "b", claudeDetected: true } as never;
		});
		const deps = fakeDeps({ getStatus }); // same object across rerenders → only reloadKey drives the reload
		const { lastFrame, rerender } = render(<HomeScreen deps={deps} reloadKey={0} />);
		await tick();
		expect(lastFrame()).toContain("Failed to load: boom");
		rerender(<HomeScreen deps={deps} reloadKey={1} />); // bump → full reload
		await tick();
		expect(lastFrame()).not.toContain("Failed to load");
	});

	it("first-load failure shows a retry hint and `r` rebuilds the model", async () => {
		let calls = 0;
		const getStatus = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("index locked");
			return { enabled: true, summaryCount: 3, orphanBranch: "b", claudeDetected: true } as never;
		});
		const { stdin, lastFrame } = render(<HomeScreen deps={fakeDeps({ getStatus })} />);
		await tick();
		expect(lastFrame()).toContain("Failed to load: index locked");
		expect(lastFrame()).toContain("[r] retry");
		stdin.write("r"); // retry → second getStatus succeeds
		await tick();
		expect(lastFrame()).not.toContain("Failed to load");
	});

	it("self-heals hands-free: the 2.5s poll retries a null model after a failed first load", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const getStatus = vi.fn(async () => {
				calls += 1;
				if (calls === 1) throw new Error("index locked");
				return { enabled: true, summaryCount: 3, orphanBranch: "b" } as never;
			});
			const { lastFrame, unmount } = render(<HomeScreen deps={fakeDeps({ getStatus })} />);
			await pump();
			expect(lastFrame()).toContain("Failed to load");
			await vi.advanceTimersByTimeAsync(2500); // one poll tick → self-heal reload
			await pump();
			expect(lastFrame()).not.toContain("Failed to load");
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a → y disables; a → n cancels", async () => {
		const setEnabled = vi.fn(async () => {});
		const { stdin, lastFrame, rerender } = render(<HomeScreen deps={fakeDeps({ setEnabled })} />);
		await tick();
		stdin.write("a");
		await tick();
		expect(lastFrame()).toContain("Disable Jolli Memory for this repo? [y/n]");
		stdin.write("y");
		await tick();
		expect(setEnabled).toHaveBeenCalledWith(false);

		rerender(<HomeScreen deps={fakeDeps({ setEnabled: vi.fn(async () => {}) })} />);
		await tick();
		stdin.write("a");
		await tick();
		stdin.write("n");
		await tick();
		expect(lastFrame()).not.toContain("[y/n]");
	});

	it("dashboard [b] builds the offered commits and [x] dismisses the offer", async () => {
		const offer = {
			hasMemory: false,
			commits: [
				{ hash: "a1", subject: "x" },
				{ hash: "b2", subject: "y" },
			],
			capped: false,
		};
		const runColdStartBackfill = vi.fn(async () => ({ generated: 2, errors: 0 }));
		const build = render(
			<HomeScreen deps={fakeDeps({ getBackfillOffer: async () => offer, runColdStartBackfill })} />,
		);
		await tick();
		expect(build.lastFrame()).toContain("[b]");
		build.stdin.write("b");
		await tick();
		expect(runColdStartBackfill).toHaveBeenCalledWith(["a1", "b2"], expect.any(Function));

		const dismissBackfill = vi.fn(async () => {});
		const r2 = render(<HomeScreen deps={fakeDeps({ getBackfillOffer: async () => offer, dismissBackfill })} />);
		await tick();
		r2.stdin.write("x");
		await tick();
		expect(dismissBackfill).toHaveBeenCalled();
	});

	it("reports layout to onLayout (dashboard vs wizard)", async () => {
		const onLayout = vi.fn();
		render(<HomeScreen deps={fakeDeps()} onLayout={onLayout} />);
		await tick();
		expect(onLayout).toHaveBeenLastCalledWith("dashboard");

		const onLayout2 = vi.fn();
		render(
			<HomeScreen
				deps={fakeDeps({
					loadAuthToken: async () => undefined,
					loadConfig: async () => ({}),
					getStatus: async () => ({ enabled: false, summaryCount: 0, orphanBranch: "b" }) as never,
				})}
				onLayout={onLayout2}
			/>,
		);
		await tick();
		expect(onLayout2).toHaveBeenLastCalledWith("wizard");
	});
});

describe("HomeScreen — wizard actions", () => {
	// Not set up at all → credential step's primary action is sign-in.
	const freshDeps = (over: Partial<TuiDeps> = {}) =>
		fakeDeps({
			loadAuthToken: async () => undefined,
			loadConfig: async () => ({}),
			getStatus: async () => ({ enabled: false, summaryCount: 0, orphanBranch: "b" }) as never,
			...over,
		});

	it("Enter on the credential step signs in; s does the same", async () => {
		const signInWithBrowser = vi.fn(async () => {});
		const { stdin } = render(<HomeScreen deps={freshDeps({ signInWithBrowser })} />);
		await tick();
		stdin.write("\r"); // Enter on the highlighted credential step
		await tick();
		expect(signInWithBrowser).toHaveBeenCalledTimes(1);

		const signIn2 = vi.fn(async () => {});
		const r2 = render(<HomeScreen deps={freshDeps({ signInWithBrowser: signIn2 })} />);
		await tick();
		r2.stdin.write("s"); // letter accelerator
		await tick();
		expect(signIn2).toHaveBeenCalledTimes(1);
	});

	it("k on the credential step opens Jolli-key entry and saves it", async () => {
		const saveJolliApiKey = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<HomeScreen deps={freshDeps({ saveJolliApiKey })} />);
		await tick();
		stdin.write("k"); // secondary accelerator → paste a Jolli key
		await tick();
		expect(lastFrame()).toContain("Jolli API Key:");
		for (const c of "sk-jol-abc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(saveJolliApiKey).toHaveBeenCalledWith("sk-jol-abc");
	});

	it("switch-provider: Enter calls setAiProvider('jolli')", async () => {
		const setAiProvider = vi.fn(async () => {});
		const { stdin } = render(
			<HomeScreen
				deps={freshDeps({
					setAiProvider,
					loadAuthToken: async () => "tok",
					loadConfig: async () => ({ jolliApiKey: "sk-jol", aiProvider: "anthropic" }),
				})}
			/>,
		);
		await tick();
		stdin.write("\r");
		await tick();
		expect(setAiProvider).toHaveBeenCalledWith("jolli");
	});

	it("enter-anthropic-key: Enter opens a masked field, typing + Enter saves", async () => {
		const saveAnthropicKey = vi.fn(async () => {});
		const { stdin, lastFrame } = render(
			<HomeScreen
				deps={freshDeps({
					saveAnthropicKey,
					loadAuthToken: async () => "tok", // signed in, but no usable key
				})}
			/>,
		);
		await tick();
		stdin.write("\r"); // open the key field
		await tick();
		expect(lastFrame()).toContain("Anthropic API Key:");
		for (const c of "sk-ant-zzz") stdin.write(c);
		await tick();
		expect(lastFrame()).toContain("•".repeat("sk-ant-zzz".length));
		stdin.write("\r"); // submit
		await tick();
		expect(saveAnthropicKey).toHaveBeenCalledWith("sk-ant-zzz");
	});

	it("enable step: Enter enables when a credential already exists", async () => {
		const setEnabled = vi.fn(async () => {});
		// credential present (anthropic key) but repo not enabled → wizard, cursor
		// homes onto the enable step.
		const { stdin } = render(
			<HomeScreen
				deps={fakeDeps({
					setEnabled,
					loadAuthToken: async () => undefined,
					loadConfig: async () => ({ apiKey: "sk-ant-x", aiProvider: "anthropic" }),
					getStatus: async () => ({ enabled: false, summaryCount: 0, orphanBranch: "b" }) as never,
				})}
			/>,
		);
		await tick();
		stdin.write("\r"); // Enter on the enable step
		await tick();
		expect(setEnabled).toHaveBeenCalledWith(true);
	});

	it("wizard ↑ skips a satisfied step so Enter still hits the actionable one", async () => {
		// credential satisfied (anthropic key) but enable NOT → the only navigable
		// step is enable. ↑ must not park the cursor on the satisfied credential row
		// (there the marker vanishes and the step's action is a no-op).
		const UP = `${String.fromCharCode(27)}[A`;
		const setEnabled = vi.fn(async () => {});
		const { stdin } = render(
			<HomeScreen
				deps={fakeDeps({
					setEnabled,
					loadAuthToken: async () => undefined,
					loadConfig: async () => ({ apiKey: "sk-ant-x", aiProvider: "anthropic" }),
					getStatus: async () => ({ enabled: false, summaryCount: 0, orphanBranch: "b" }) as never,
				})}
			/>,
		);
		await tick();
		stdin.write(UP); // pre-fix: cursor → satisfied credential step (Enter = no-op)
		await tick();
		stdin.write("\r");
		await tick();
		expect(setEnabled).toHaveBeenCalledWith(true);
	});
});

describe("HomeScreen — live poll", () => {
	it("polls only the cheap sources every 2.5s (never re-runs getStatus)", async () => {
		vi.useFakeTimers();
		try {
			const getStatus = vi.fn(async () => ({ enabled: true, summaryCount: 3, orphanBranch: "b" }) as never);
			const getQueueStatus = vi.fn(async () => ({
				active: 0,
				ingestActive: 0,
				workerBusy: false,
				workerBlocking: false,
				drained: true,
				stale: 0,
			}));
			const { unmount } = render(<HomeScreen deps={fakeDeps({ getStatus, getQueueStatus })} />);
			await pump(); // flush the initial load
			expect(getStatus).toHaveBeenCalledTimes(1);
			const queueAfterLoad = getQueueStatus.mock.calls.length;
			await vi.advanceTimersByTimeAsync(2600); // one poll tick
			expect(getQueueStatus.mock.calls.length).toBeGreaterThan(queueAfterLoad);
			expect(getStatus).toHaveBeenCalledTimes(1); // heavy read NOT repeated
			unmount(); // stop the 2.5s interval leaking into later fake-timer tests
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("HomeScreen — Space re-check feedback", () => {
	it("[c] on a bound Space shows a confirmation that fades after OUTCOME_TTL_MS", async () => {
		vi.useFakeTimers();
		try {
			const runCloudSync = vi.fn(async () => ({
				kind: "bound" as const,
				spaceName: "Acme Core",
				canPush: true,
				rechecked: true,
			}));
			const getSpaceBinding = vi.fn(async () => ({ spaceName: "Acme Core", canPush: true }));
			// A jolliApiKey makes canSync true, so the `[c]` action is live (see OnboardingModel).
			const loadConfig = async () => ({ jolliApiKey: "sk-jol-x", aiProvider: "jolli" as const });
			const { stdin, lastFrame, unmount } = render(
				<HomeScreen deps={fakeDeps({ runCloudSync, getSpaceBinding, loadConfig })} />,
			);
			await pump(); // initial load
			expect(lastFrame()).toContain('Space "Acme Core"');
			stdin.write("c"); // re-check binding
			await pump(); // runCloudSync + reload settle
			expect(runCloudSync).toHaveBeenCalled();
			expect(lastFrame()).toContain("✓ Space re-checked"); // result is visible…
			await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS); // …then fades on its own
			expect(lastFrame()).not.toContain("✓ Space re-checked");
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a repeated [c] within the TTL keeps the second confirmation for its full window (no early clear)", async () => {
		vi.useFakeTimers();
		try {
			const runCloudSync = vi.fn(async () => ({
				kind: "bound" as const,
				spaceName: "Acme Core",
				canPush: true,
				rechecked: true,
			}));
			const getSpaceBinding = vi.fn(async () => ({ spaceName: "Acme Core", canPush: true }));
			const loadConfig = async () => ({ jolliApiKey: "sk-jol-x", aiProvider: "jolli" as const });
			const { stdin, lastFrame, unmount } = render(
				<HomeScreen deps={fakeDeps({ runCloudSync, getSpaceBinding, loadConfig })} />,
			);
			await pump(); // initial load
			stdin.write("c"); // first re-check → schedules a clear at +TTL
			await pump();
			expect(lastFrame()).toContain("✓ Space re-checked");
			await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS - 1000); // 3s into the first timer
			expect(lastFrame()).toContain("✓ Space re-checked");
			stdin.write("c"); // second re-check (same message) while the first timer is ~1s from firing
			await pump();
			expect(lastFrame()).toContain("✓ Space re-checked");
			// The first action's timer must NOT clear the second action's fresh line.
			await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS - 1000); // 3s after the 2nd press
			expect(lastFrame()).toContain("✓ Space re-checked"); // survived → early-clear race fixed
			await vi.advanceTimersByTimeAsync(1000); // the 2nd timer's full TTL now elapses
			expect(lastFrame()).not.toContain("✓ Space re-checked");
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	it("[c] on an unbound repo confirms the bind", async () => {
		vi.useFakeTimers();
		try {
			const runCloudSync = vi.fn(async () => ({
				kind: "bound" as const,
				spaceName: "New Space",
				canPush: true,
				rechecked: false,
			}));
			const loadConfig = async () => ({ jolliApiKey: "sk-jol-x", aiProvider: "jolli" as const });
			const { stdin, lastFrame, unmount } = render(
				<HomeScreen deps={fakeDeps({ runCloudSync, getSpaceBinding: async () => null, loadConfig })} />,
			);
			await pump();
			stdin.write("c");
			await pump();
			expect(runCloudSync).toHaveBeenCalled();
			expect(lastFrame()).toContain("✓ Space bound");
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	// The [c] action must report the ACTUAL outcome — a no-op sync (no Spaces,
	// several Spaces, or a failure) must never claim "✓ Space bound".
	it.each([
		[{ kind: "no-spaces" as const }, "none available", "✓ Space bound"],
		[{ kind: "multi-space" as const, count: 3 }, "jolli bind --space", "✓ Space bound"],
		[{ kind: "error" as const, message: "offline" }, "sync failed: offline", "✓ Space bound"],
		// A degraded (view-only / no-access) binding is bound but won't sync — no "✓ Space".
		[{ kind: "bound" as const, spaceName: "Acme", canPush: false, rechecked: true }, "read-only", "✓ Space"],
		[{ kind: "bound" as const, spaceName: null, canPush: false, rechecked: true }, "no access", "✓ Space"],
	])("[c] reports %o truthfully, not a false bound", async (outcome, expected, forbidden) => {
		vi.useFakeTimers();
		try {
			const runCloudSync = vi.fn(async () => outcome);
			const loadConfig = async () => ({ jolliApiKey: "sk-jol-x", aiProvider: "jolli" as const });
			const { stdin, lastFrame, unmount } = render(
				<HomeScreen deps={fakeDeps({ runCloudSync, getSpaceBinding: async () => null, loadConfig })} />,
			);
			await pump();
			stdin.write("c");
			await pump();
			expect(runCloudSync).toHaveBeenCalled();
			expect(lastFrame()).toContain(expected);
			expect(lastFrame()).not.toContain(forbidden);
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	// P1: a generate-capable but signed-out user (Anthropic key, no Jolli key) is on
	// the dashboard — where the credential step is satisfied and no longer offers
	// sign-in. The Space row's `[c]` must fall back to starting sign-in, or the user
	// has no dashboard route into the cloud/sync path at all.
	it("[c] starts sign-in when signed out with only an Anthropic key", async () => {
		vi.useFakeTimers();
		try {
			const signInWithBrowser = vi.fn(async () => {});
			const { stdin, lastFrame, unmount } = render(
				<HomeScreen
					deps={fakeDeps({
						signInWithBrowser,
						loadAuthToken: async () => undefined,
						loadConfig: async () => ({ apiKey: "sk-ant-x", aiProvider: "anthropic" }),
						getSpaceBinding: async () => null,
					})}
				/>,
			);
			await pump();
			expect(lastFrame()).toContain("[c]");
			expect(lastFrame()).toContain("sign in to Jolli");
			stdin.write("c");
			await pump();
			expect(signInWithBrowser).toHaveBeenCalledTimes(1);
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});
