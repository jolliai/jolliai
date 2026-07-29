import { describe, expect, it, vi } from "vitest";
import { ALLOWED_JOLLI_HOSTS } from "../../../cli/src/core/JolliApiUtils.js";
import { LOCAL_AGENT_TOOLS } from "../../../cli/src/core/localagent/ToolMeta.js";
import { buildSettingsScript } from "./SettingsScriptBuilder.js";

// ── Minimal fake-DOM harness for behaviorally executing the generated script ──
//
// No jsdom dependency exists anywhere in this monorepo (checked: neither a
// devDependency nor hoisted). Rather than adding one, this stubs just enough
// of `window` / `document` / `acquireVsCodeApi` for `buildSettingsScript()`'s
// output to run unmodified under `new Function(...)` in Node's own global
// scope (which already provides `atob`, `URL`, `setTimeout`, etc. that the
// script also references). `document.getElementById` lazily fabricates a
// generic element for any id the script asks for, so the ~40 unrelated DOM
// refs the script declares up front never need to be enumerated by hand —
// only the handful this suite actually drives or inspects get a typed,
// pre-seeded element (the two `<select>`s, the status line, the Apply button).

interface FakeClassList {
	add(...classes: string[]): void;
	remove(...classes: string[]): void;
	toggle(cls: string, force?: boolean): boolean;
	contains(cls: string): boolean;
}

type Listener = () => void;

interface FakeElement {
	value: string;
	textContent: string;
	checked: boolean;
	disabled: boolean;
	readonly selectedIndex: number;
	readonly options: ReadonlyArray<{ readonly value: string; readonly textContent: string }>;
	readonly classList: FakeClassList;
	addEventListener(type: string, cb: Listener): void;
	fire(type: string): void;
}

function createClassList(): FakeClassList {
	const classes = new Set<string>();
	return {
		add: (...cs) => {
			for (const c of cs) classes.add(c);
		},
		remove: (...cs) => {
			for (const c of cs) classes.delete(c);
		},
		toggle: (cls, force) => {
			const shouldHave = force === undefined ? !classes.has(cls) : force;
			if (shouldHave) classes.add(cls);
			else classes.delete(cls);
			return shouldHave;
		},
		contains: (cls) => classes.has(cls),
	};
}

function createElement(optionValues?: readonly string[], labels?: Record<string, string>): FakeElement {
	const listeners: Record<string, Listener[]> = {};
	let currentValue = optionValues?.[0] ?? "";
	const options = (optionValues ?? []).map((v) => ({ value: v, textContent: labels?.[v] ?? v }));
	return {
		get value() {
			return currentValue;
		},
		set value(v: string) {
			currentValue = v;
		},
		textContent: "",
		checked: false,
		disabled: false,
		get selectedIndex() {
			return (optionValues ?? []).indexOf(currentValue);
		},
		options,
		classList: createClassList(),
		addEventListener(type, cb) {
			if (!listeners[type]) listeners[type] = [];
			listeners[type].push(cb);
		},
		fire(type) {
			for (const cb of listeners[type] ?? []) cb();
		},
	};
}

interface ScriptHandles {
	readonly aiProviderSelect: FakeElement;
	readonly localAgentToolSelect: FakeElement;
	readonly localAgentStatus: FakeElement;
	readonly applyBtn: FakeElement;
	readonly posted: ReadonlyArray<Record<string, unknown>>;
	/** Lazily-fabricated access to any other element by id (e.g. `saveFeedback`,
	 * `rebuildKbBtn`, `syncNowBtn`) — for tests that need to read text or fire
	 * an event on one of the ~40 refs not pre-seeded above. */
	element(id: string): FakeElement;
	receive(msg: Record<string, unknown>): void;
	setProvider(value: string): void;
	selectTool(value: string): void;
}

/** Executes `scriptSource` (the output of `buildSettingsScript()`) against a
 * fresh fake DOM and returns handles for driving it. Each call gets isolated
 * state — `new Function` creates a distinct closure per invocation. */
function runScript(scriptSource: string): ScriptHandles {
	const elements = new Map<string, FakeElement>();
	const messageListeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
	const posted: Array<Record<string, unknown>> = [];

	const toolIds = Object.keys(LOCAL_AGENT_TOOLS);
	const toolLabels: Record<string, string> = {};
	for (const id of toolIds) {
		toolLabels[id] = LOCAL_AGENT_TOOLS[id as keyof typeof LOCAL_AGENT_TOOLS].label;
	}

	function get(id: string): FakeElement {
		let el = elements.get(id);
		if (!el) {
			el = createElement();
			elements.set(id, el);
		}
		return el;
	}

	elements.set("aiProvider", createElement(["anthropic", "jolli", "local-agent"]));
	elements.set("localAgentTool", createElement(toolIds, toolLabels));
	const aiProviderSelect = get("aiProvider");
	const localAgentToolSelect = get("localAgentTool");
	const localAgentStatus = get("localAgentStatus");
	const applyBtn = get("applyBtn");

	const documentStub = {
		getElementById: (id: string) => get(id),
		querySelectorAll: () => ({ forEach: () => {} }),
		querySelector: () => null,
		addEventListener: () => {},
	};

	const windowStub = {
		addEventListener: (type: string, cb: (event: { data: Record<string, unknown> }) => void) => {
			if (type === "message") messageListeners.push(cb);
		},
	};

	function acquireVsCodeApi() {
		return { postMessage: (m: Record<string, unknown>) => posted.push(m) };
	}

	const run = new Function("window", "document", "acquireVsCodeApi", scriptSource) as (
		w: unknown,
		d: unknown,
		a: unknown,
	) => void;
	run(windowStub, documentStub, acquireVsCodeApi);

	return {
		aiProviderSelect,
		localAgentToolSelect,
		localAgentStatus,
		applyBtn,
		posted,
		element: (id) => get(id),
		receive(msg) {
			for (const cb of messageListeners) cb({ data: msg });
		},
		setProvider(value) {
			aiProviderSelect.value = value;
			aiProviderSelect.fire("change");
		},
		selectTool(value) {
			localAgentToolSelect.value = value;
			localAgentToolSelect.fire("change");
		},
	};
}

/** Dispatches a `settingsLoaded` message so `captureInitialState()` runs and
 * the form reaches its normal post-load baseline (isDirty=false, hasErrors=
 * false) before a test starts driving it. */
function loadSettings(handles: ScriptHandles, settingsOverrides: Record<string, unknown> = {}): void {
	handles.receive({
		command: "settingsLoaded",
		maskedApiKey: "",
		maskedJolliApiKey: "",
		settings: {
			model: "sonnet",
			maxTokens: null,
			aiProvider: "anthropic",
			localAgentTool: "claude-code",
			claudeEnabled: true,
			codexEnabled: false,
			geminiEnabled: false,
			openCodeEnabled: false,
			cursorEnabled: false,
			devinEnabled: false,
			copilotEnabled: false,
			clineEnabled: false,
			antigravityEnabled: false,
			globalInstructions: false,
			localFolder: "",
			excludePatterns: "",
			compileExcludeFolders: "",
			dcoSignoff: false,
			...settingsOverrides,
		},
	});
}

describe("SettingsScriptBuilder", () => {
	const script = buildSettingsScript();

	it("returns a non-empty string", () => {
		expect(script).toBeTruthy();
		expect(typeof script).toBe("string");
		expect(script.length).toBeGreaterThan(0);
	});

	it("acquires the VS Code API", () => {
		expect(script).toContain("acquireVsCodeApi()");
	});

	it("contains loadSettings message handler", () => {
		expect(script).toContain("loadSettings");
	});

	it("contains applySettings message handler", () => {
		expect(script).toContain("applySettings");
	});

	it("contains settingsLoaded handler", () => {
		expect(script).toContain("settingsLoaded");
	});

	it("contains settingsSaved handler", () => {
		expect(script).toContain("settingsSaved");
	});

	it("does not contain scope switching logic", () => {
		expect(script).not.toContain("scopeSelect");
		expect(script).not.toContain("currentScope");
		expect(script).not.toContain("initialScope");
	});

	it("contains validation logic for API key prefixes", () => {
		expect(script).toContain("sk-ant-");
		expect(script).toContain("sk-jol-");
	});

	it("inlines the CLI's ALLOWED_JOLLI_HOSTS verbatim, not a copy", () => {
		// The webview's origin validator runs in a browser context and can't
		// import the Node module, so SettingsScriptBuilder embeds the array as
		// JSON at extension build time. Pinning the exact embedded form keeps
		// this from drifting back into a copy-pasted literal — adding a host
		// to JolliApiUtils now flows here automatically, and the IntelliJ
		// Kotlin port stays the only remaining lockstep sibling to update.
		expect(script).toContain(
			`var ALLOWED_JOLLI_HOSTS = ${JSON.stringify(ALLOWED_JOLLI_HOSTS)};`,
		);
		// Sanity: the current host set is still represented in the embedded JSON.
		for (const host of ALLOWED_JOLLI_HOSTS) {
			expect(script).toContain(`"${host}"`);
		}
	});

	it("contains dirty tracking logic", () => {
		expect(script).toContain("isDirty");
	});

	it("contains masking detection logic", () => {
		expect(script).toContain("maskedApiKey");
		expect(script).toContain("maskedJolliApiKey");
	});

	it("validates at least one integration must be enabled", () => {
		expect(script).toContain("integrations-error");
		expect(script).toContain("At least one integration must be enabled");
		expect(script).toContain("openCodeEnabled");
		expect(script).toContain("cursorEnabled");
	});

	it("references the copilotEnabled DOM input", () => {
		expect(script).toContain("getElementById('copilotEnabled')");
	});

	it("includes copilotEnabled in validation guard", () => {
		expect(script).toMatch(/!copilotEnabledInput\.checked/);
	});

	it("ships copilotEnabled in save payload", () => {
		expect(script).toContain("copilotEnabled: copilotEnabledInput.checked");
	});

	it("loads copilotEnabled from host message", () => {
		expect(script).toContain(
			"copilotEnabledInput.checked = msg.settings.copilotEnabled",
		);
	});

	it("references the clineEnabled DOM input", () => {
		expect(script).toContain("getElementById('clineEnabled')");
	});

	it("includes clineEnabled in validation guard", () => {
		expect(script).toMatch(/!clineEnabledInput\.checked/);
	});

	it("ships clineEnabled in save payload", () => {
		expect(script).toContain("clineEnabled: clineEnabledInput.checked");
	});

	it("loads clineEnabled from host message", () => {
		expect(script).toContain(
			"clineEnabledInput.checked = msg.settings.clineEnabled",
		);
	});

	it("references the devinEnabled DOM input", () => {
		expect(script).toContain("getElementById('devinEnabled')");
	});

	it("includes devinEnabled in validation guard", () => {
		expect(script).toMatch(/!devinEnabledInput\.checked/);
	});

	it("ships devinEnabled in save payload", () => {
		expect(script).toContain("devinEnabled: devinEnabledInput.checked");
	});

	it("loads devinEnabled from host message", () => {
		expect(script).toContain(
			"devinEnabledInput.checked = msg.settings.devinEnabled",
		);
	});

	it("does not reference a separate cursorCliEnabled input (shares the Cursor toggle)", () => {
		expect(script).not.toContain("cursorCliEnabled");
	});

	// ── DCO sign-off toggle ──

	it("references the dcoSignoff DOM input", () => {
		expect(script).toContain("getElementById('dcoSignoff')");
	});

	it("ships dcoSignoff in the save payload", () => {
		expect(script).toContain("dcoSignoff: dcoSignoffInput.checked");
	});

	it("loads dcoSignoff from host message and coerces to boolean", () => {
		expect(script).toContain(
			"dcoSignoffInput.checked = !!msg.settings.dcoSignoff",
		);
	});

	it("includes dcoSignoff in dirty tracking", () => {
		expect(script).toContain(
			"dcoSignoffInput.checked !== initialState.dcoSignoff",
		);
	});

	// ── Tab switching ──

	it("wires .tab-button clicks to .tab-active toggle and panel show/hide", () => {
		expect(script).toContain(".tab-button");
		expect(script).toContain("tab-active");
		expect(script).toContain("data-tab");
		expect(script).toContain("data-panel");
		// Show/hide should go through the shared .hidden class — see CLAUDE.md
		// memory: "vscode webview 用 .hidden class 切显隐".
		expect(script).toContain("classList.toggle('hidden'");
	});

	// ── Provider card switching ──

	it("ships syncProviderCard logic gated by aiProvider, signedIn, hasJolliKey", () => {
		expect(script).toContain("syncProviderCard");
		expect(script).toContain("aiProviderSelect");
		expect(script).toContain("'jolli-ok'");
		expect(script).toContain("'jolli-nokey'");
		expect(script).toContain("'jolli-signin'");
		expect(script).toContain("'anthropic'");
	});

	it("ships syncSyncCard for the Sync tab", () => {
		expect(script).toContain("syncSyncCard");
		expect(script).toContain("'signed-in'");
		expect(script).toContain("'signed-out'");
	});

	// ── Sign-in / Sign-out ──

	it("posts signIn / signOut messages on the auth buttons", () => {
		expect(script).toContain("'signIn'");
		expect(script).toContain("'signOut'");
		expect(script).toContain("summarySignInBtn");
		expect(script).toContain("syncSignInBtn");
		expect(script).toContain("syncSignOutBtn");
	});

	it("handles authStateChanged messages from the host", () => {
		expect(script).toContain("authStateChanged");
	});

	it("syncs aiProviderSelect when authStateChanged carries an aiProvider", () => {
		// Without this sync, a sign-in flips aiProvider on disk but the open
		// form keeps stale dropdown state — and the next Apply silently
		// overwrites disk with whatever the user last had selected. The
		// closure must (a) accept the value, (b) re-baseline initialState so
		// it doesn't show as a phantom user edit, and (c) recompute dirty so
		// the Apply button reflects the merged state.
		expect(script).toContain("aiProviderSelect.value = msg.aiProvider");
		expect(script).toContain("initialState.aiProvider = msg.aiProvider");
	});

	// ── aiProvider in payload ──

	it("ships aiProvider in the save payload", () => {
		expect(script).toContain("aiProvider: aiProviderSelect.value");
	});

	it("loads aiProvider from settings (with anthropic fallback)", () => {
		expect(script).toContain("msg.settings.aiProvider");
	});

	it("gates the local-agent card and round-trips the agent tool", () => {
		expect(script).toContain("provider === 'local-agent'");
		expect(script).toContain("localAgentTool: localAgentToolSelect.value");
		expect(script).toContain("localAgentToolSelect.value = msg.settings.localAgentTool");
	});

	// ── Local agent tool availability check ──
	//
	// This suite is source-text (regex) based, like the rest of this file — it
	// asserts the generated script *contains* the right shape, not that a live
	// DOM behaves correctly. It's still useful for pinning the exact predicate
	// text and wiring shape, but it cannot catch a behaviorally different
	// expression that happens to match the regex (an inverted operator, a
	// widened `&&`→`||`, a dropped negation). The three scoping/timing rules
	// (provider scoping, in-flight never blocking, stale-reply rejection) get
	// real behavioral coverage below, in the "local agent tool availability
	// (behavioral)" block, which executes this exact generated script against a
	// fake DOM and drives it like a live webview would.
	describe("local agent tool availability", () => {
		it("models availability as three states, not a boolean", () => {
			// null = unknown/in-flight; only a confirmed `false` may block Apply —
			// a boolean would collapse "unknown" into either "blocks" or
			// "doesn't", both wrong for a pending probe.
			expect(script).toContain("let localAgentAvailable = null;");
			expect(script).toContain("localAgentAvailable = null;");
			expect(script).toContain("localAgentAvailable = !!msg.available;");
		});

		it("scopes the block to aiProvider === 'local-agent' (rule 1)", () => {
			expect(script).toContain("function localAgentBlocks()");
			expect(script).toMatch(
				/function localAgentBlocks\(\) {\s*return aiProviderSelect\.value === 'local-agent' && localAgentAvailable === false;/,
			);
		});

		it("feeds localAgentBlocks() into the existing applyBtn.disabled seam, not a parallel gate", () => {
			expect(script).toContain(
				"applyBtn.disabled = !isDirty || hasErrors || localAgentBlocks();",
			);
		});

		it("only a confirmed-unavailable probe result arms the block (rule 2)", () => {
			// probeLocalAgent() resets to null (unknown) before posting — an
			// in-flight probe must never read as available === false.
			expect(script).toMatch(
				/function probeLocalAgent\(\) {[\s\S]*localAgentAvailable = null;[\s\S]*vscode\.postMessage\(\{ command: 'probeLocalAgent', tool: tool \}\);/,
			);
		});

		it("tracks which tool the in-flight probe was for and ignores stale replies (rule 3)", () => {
			expect(script).toContain("let localAgentProbeTool = null;");
			expect(script).toContain("localAgentProbeTool = tool;");
			expect(script).toMatch(/case 'localAgentProbeResult':[\s\S]*if \(msg\.tool !== localAgentProbeTool\) break;/);
		});

		it("probes on tool-select change, on switching the provider to local-agent, and on panel open", () => {
			expect(script).toMatch(
				/localAgentToolSelect\.addEventListener\('change', function\(\) {\s*checkDirty\(\); clearSaveFeedback\(\); probeLocalAgent\(\);/,
			);
			expect(script).toMatch(
				/aiProviderSelect\.addEventListener\('change', function\(\) {[\s\S]*if \(aiProviderSelect\.value === 'local-agent'\) probeLocalAgent\(\);/,
			);
			expect(script).toMatch(
				/case 'settingsLoaded':[\s\S]*if \(aiProviderSelect\.value === 'local-agent'\) probeLocalAgent\(\);[\s\S]*captureInitialState\(\);/,
			);
		});

		it("gates the on-open probe on the provider — the card is hidden for every other one", () => {
			// An unconditional probe on open spends a 161-1772 ms subprocess to
			// render a status line inside a `.hidden` card panel.
			const onOpen = /case 'settingsLoaded':[\s\S]*?captureInitialState\(\);/.exec(script)?.[0] ?? "";
			expect(onOpen).toContain("if (aiProviderSelect.value === 'local-agent') probeLocalAgent();");
			expect(onOpen).not.toMatch(/(?<!'local-agent'\) )probeLocalAgent\(\);/);
		});

		it("posts probeLocalAgent with the selected tool id", () => {
			expect(script).toContain(
				"vscode.postMessage({ command: 'probeLocalAgent', tool: tool });",
			);
		});

		it("renders a not-found message and toggles the .error class via classList (no inline style)", () => {
			expect(script).toContain("not found on this machine. Install it, or pick another tool.");
			expect(script).toContain("localAgentStatus.classList.toggle('error', !msg.available);");
		});
	});

	// ── Local agent tool availability check (behavioral) ──
	//
	// Executes the actual generated script (via `runScript` — see the fake-DOM
	// harness at the top of this file) against a fake DOM and drives it exactly
	// as a live webview would: dispatching `change` events on the real select
	// elements and `message` events carrying host replies, then reading back
	// `applyBtn.disabled` / `localAgentStatus.textContent`. Unlike the regex
	// suite above, these tests fail on a behaviorally wrong predicate even if
	// its source text would still match a loose regex.
	describe("local agent tool availability (behavioral)", () => {
		it("blocks Apply when the selected tool is confirmed unavailable and aiProvider is local-agent", () => {
			const h = runScript(script);
			loadSettings(h);
			h.setProvider("local-agent");
			h.selectTool("cursor-agent");
			h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: false });

			expect(h.applyBtn.disabled).toBe(true);
			expect(h.localAgentStatus.textContent).toContain("not found");
		});

		it("rule 1: does NOT block Apply for the same unavailable tool when aiProvider is not local-agent", () => {
			const h = runScript(script);
			loadSettings(h); // aiProvider defaults to 'anthropic'
			h.selectTool("cursor-agent");
			h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: false });

			expect(h.applyBtn.disabled).toBe(false);
		});

		it("rule 1: re-enables Apply when the provider switches away from local-agent", () => {
			const h = runScript(script);
			loadSettings(h);
			h.setProvider("local-agent");
			h.selectTool("cursor-agent");
			h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: false });
			expect(h.applyBtn.disabled).toBe(true);

			h.setProvider("anthropic");

			expect(h.applyBtn.disabled).toBe(false);
		});

		it("rule 2: does NOT block Apply while the probe is in flight (no reply yet)", () => {
			const h = runScript(script);
			loadSettings(h);
			h.setProvider("local-agent");
			h.selectTool("cursor-agent"); // dispatches the probe; no reply delivered

			expect(h.applyBtn.disabled).toBe(false);
			expect(h.localAgentStatus.textContent).toContain("Checking");
		});

		it("rule 3: ignores a stale reply for a tool the user has already moved off", () => {
			const h = runScript(script);
			loadSettings(h);
			h.setProvider("local-agent");
			h.selectTool("cursor-agent"); // probe A dispatched
			h.selectTool("codex"); // probe B dispatched; probe A is now stale
			h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: false }); // A's (stale) reply

			// codex's probe is still unresolved (unknown), and the stale cursor-agent
			// reply must not have been applied — so Apply stays enabled.
			expect(h.applyBtn.disabled).toBe(false);
		});
	});

	// ── Apply held behind an in-flight probe ──
	//
	// Rule 2 keeps Apply ENABLED while a probe is in flight (a single global
	// button must not gray out for an unrelated tab's edit), which leaves a
	// 161-1772 ms window — the measured single-tool probe cost, DetectAgents.ts —
	// where a click would persist `aiProvider: 'local-agent'` against a tool
	// nobody verified. The race is closed at the save chokepoint instead: the
	// click is HELD, and the probe reply decides it.
	describe("apply held behind an in-flight local-agent probe", () => {
		/** Drives the form to "provider = local-agent, probe in flight, form dirty". */
		function armInFlightProbe(tool = "cursor-agent"): ScriptHandles {
			const h = runScript(script);
			loadSettings(h);
			h.setProvider("local-agent");
			h.selectTool(tool); // probe dispatched; no reply delivered
			return h;
		}

		const appliesOf = (h: ScriptHandles) => h.posted.filter((m) => m.command === "applySettings");

		it("holds the save instead of posting it, and says so", () => {
			const h = armInFlightProbe();

			// Rule 2 is intact: the button itself never goes disabled mid-probe.
			expect(h.applyBtn.disabled).toBe(false);
			h.applyBtn.fire("click");

			expect(appliesOf(h)).toHaveLength(0);
			expect(h.element("saveFeedback").textContent).toContain("Checking");
			expect(h.element("saveFeedback").classList.contains("error")).toBe(false);
		});

		it("posts the held save once the probe confirms the tool is available", () => {
			const h = armInFlightProbe();
			h.applyBtn.fire("click");
			expect(appliesOf(h)).toHaveLength(0);

			h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: true });

			const applied = appliesOf(h);
			expect(applied).toHaveLength(1);
			expect(applied[0]?.settings).toMatchObject({
				aiProvider: "local-agent",
				localAgentTool: "cursor-agent",
			});
		});

		it("never posts the held save when the probe confirms the tool is unavailable", () => {
			const h = armInFlightProbe();
			h.applyBtn.fire("click");

			h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: false });

			expect(appliesOf(h)).toHaveLength(0);
			// Falls into submitApplySettings()'s existing localAgentBlocks() branch,
			// so the user gets the actionable wording, not the neutral 'Checking…'.
			expect(h.element("saveFeedback").textContent).toContain("isn't available on this machine");
			expect(h.element("saveFeedback").classList.contains("error")).toBe(true);
		});

		it("drops the held save when the user switches tools mid-hold", () => {
			const h = armInFlightProbe("cursor-agent");
			h.applyBtn.fire("click"); // held against cursor-agent

			h.selectTool("codex"); // form moved; the held click is now stale
			h.receive({ command: "localAgentProbeResult", tool: "codex", available: true });

			// The codex probe resolving must not retroactively fire a click the user
			// made while looking at cursor-agent.
			expect(appliesOf(h)).toHaveLength(0);
		});

		it("a stale reply neither posts nor releases the held save", () => {
			const h = armInFlightProbe("cursor-agent");
			h.applyBtn.fire("click");

			// A reply for a tool that is no longer the probe target is dropped by the
			// rule-3 guard before the resume site is ever reached.
			h.receive({ command: "localAgentProbeResult", tool: "codex", available: true });

			expect(appliesOf(h)).toHaveLength(0);
			expect(h.element("saveFeedback").textContent).toContain("Checking");
		});

		it("watchdog: reports a failure and saves nothing when no reply ever arrives", () => {
			vi.useFakeTimers();
			try {
				const h = armInFlightProbe();
				h.applyBtn.fire("click");

				vi.advanceTimersByTime(8000);

				expect(appliesOf(h)).toHaveLength(0);
				expect(h.element("saveFeedback").textContent).toContain("Couldn't verify");
				expect(h.element("saveFeedback").classList.contains("error")).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("a late reply after the watchdog fired does not resurrect the save", () => {
			vi.useFakeTimers();
			try {
				const h = armInFlightProbe();
				h.applyBtn.fire("click");
				vi.advanceTimersByTime(8000);

				h.receive({ command: "localAgentProbeResult", tool: "cursor-agent", available: true });

				expect(appliesOf(h)).toHaveLength(0);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// ── Advanced toggle ──

	it("wires the Advanced links to data-advanced-panel siblings", () => {
		expect(script).toContain("advanced-link");
		expect(script).toContain("data-advanced-panel");
		expect(script).toContain("Hide Advanced");
	});

	// ── Migrate-when-dirty confirmation ──
	//
	// The Migrate to Memory Bank command on the host reads localFolder from
	// disk. If the user edited Folder Path but didn't Apply, naively firing the
	// migrate posts to the *old* folder while the form shows the new one. The
	// webview must (a) detect that dirty state, (b) defer to a host-side modal,
	// (c) chain Apply → Migrate when the user confirms, and (d) abort the chain
	// on settingsError. These assertions pin the pieces that, if removed, would
	// silently revert to the old (misleading) behavior.

	it("checks localFolder dirtiness before firing rebuildKnowledgeBase", () => {
		expect(script).toContain("localFolderDirty");
		expect(script).toContain(
			"localFolderInput.value !== initialState.localFolder",
		);
	});

	it("posts confirmDirtyMigrate to the host when Migrate is clicked with dirty Folder Path", () => {
		expect(script).toContain("'confirmDirtyMigrate'");
	});

	it("handles the host's confirmDirtyMigrateResult to chain Apply → Migrate or abort", () => {
		expect(script).toContain("confirmDirtyMigrateResult");
		expect(script).toContain("pendingMigrateAfterApply");
		// Apply path must be reused (not re-implemented) so the payload stays
		// in lockstep with the Apply button click.
		expect(script).toContain("submitApplySettings");
	});

	it("chains into startRebuild on settingsSaved when the migrate-after-apply flag is set", () => {
		expect(script).toMatch(
			/case 'settingsSaved':[\s\S]*pendingMigrateAfterApply[\s\S]*startRebuild\(\)/,
		);
	});

	it("aborts the migrate-after-apply and sync-after-apply chains on settingsError", () => {
		// Without this, a server-side rejection (e.g. invalid jolli key) would
		// leave the migrate to run anyway against unsaved settings. Both links are
		// asserted because the clearing moved behind abortApplyChains() — shared
		// with the probe-hold paths, which need the same disarm — so checking only
		// the call site would pass even if the helper stopped clearing a flag.
		expect(script).toMatch(/case 'settingsError':[\s\S]*abortApplyChains\(\)/);
		expect(script).toMatch(
			/function abortApplyChains\(\) {[\s\S]*pendingMigrateAfterApply = false;[\s\S]*pendingSyncAfterApply = false;/,
		);
	});

	describe("Memory Bank state line", () => {
		it("renders on BOTH entry paths (fresh load and post-save)", () => {
			// A lazy display channel needs a trigger on every path that can change
			// it: settingsLoaded seeds it, and settingsSaved is the only message the
			// webview gets after Apply — where localFolder may just have changed.
			expect(script).toMatch(/case 'settingsLoaded':[\s\S]*renderMemoryBankState\(msg\.settings\.memoryBank\)/);
			expect(script).toMatch(/case 'settingsSaved':[\s\S]*renderMemoryBankState\(msg\.memoryBank\)/);
		});

		/**
		 * Evaluates just `renderMemoryBankState` against fake elements. The three
		 * elements it touches are closure variables in the real script, so they are
		 * injected as parameters here — cheaper than standing up the whole webview,
		 * and it exercises real behavior instead of asserting on source text.
		 *
		 * The `new Function` input is `buildSettingsScript()`'s own output — a
		 * literal in this repo, with no runtime or user data reaching it. Same
		 * technique the SidebarScriptBuilder tests use to parse built scripts.
		 */
		function loadRenderer() {
			const src = script.match(/function renderMemoryBankState\(display\) \{[\s\S]*?\n {2}\}/)?.[0];
			if (!src) throw new Error("renderMemoryBankState not found in built script");
			const makeEl = () => {
				const classes = new Set<string>(["status-off", "hidden"]);
				return {
					textContent: "",
					classList: {
						add: (...c: string[]): void => {
							for (const name of c) classes.add(name);
						},
						remove: (...c: string[]): void => {
							for (const name of c) classes.delete(name);
						},
						has: (c: string) => classes.has(c),
					},
				};
			};
			const root = makeEl();
			const icon = makeEl();
			const text = makeEl();
			const fn = new Function(
				"memoryBankState",
				"memoryBankStateIcon",
				"memoryBankStateText",
				`${src}; return renderMemoryBankState;`,
			)(root, icon, text) as (d: unknown) => void;
			return { fn, root, icon, text };
		}

		it("shows the path with an ok icon when writes are landing", () => {
			const { fn, root, icon, text } = loadRenderer();
			fn({ severity: "ok", text: "/bank/widgets" });
			expect(root.classList.has("hidden")).toBe(false);
			expect(root.classList.has("status-ok")).toBe(true);
			expect(root.classList.has("status-off")).toBe(false);
			expect(icon.textContent).toBe("✓");
			expect(text.textContent).toBe("/bank/widgets");
		});

		it("swaps the severity class rather than accumulating them", () => {
			// Re-render after a settingsSaved that flipped the verdict: a stale
			// status-ok left alongside status-warn would win or blend unpredictably.
			const { fn, root } = loadRenderer();
			fn({ severity: "ok", text: "/bank/widgets" });
			fn({ severity: "warn", text: "Not writing — …" });
			expect(root.classList.has("status-warn")).toBe(true);
			expect(root.classList.has("status-ok")).toBe(false);
		});

		it("stays hidden when the host sent nothing", () => {
			// An older host that doesn't send the field must not leave an empty
			// coloured strip under the folder input.
			const { fn, root } = loadRenderer();
			fn(undefined);
			expect(root.classList.has("hidden")).toBe(true);
		});

		it("falls back to the off severity for an unrecognized value", () => {
			const { fn, root, icon } = loadRenderer();
			fn({ severity: "explode", text: "x" });
			expect(root.classList.has("status-off")).toBe(true);
			expect(icon.textContent).toBe("○");
		});

		it("writes the path via textContent, never innerHTML", () => {
			// The payload carries a filesystem path straight from config.
			expect(script).toContain("memoryBankStateText.textContent = display.text");
			expect(script).not.toContain("memoryBankStateText.innerHTML");
		});
	});
});
