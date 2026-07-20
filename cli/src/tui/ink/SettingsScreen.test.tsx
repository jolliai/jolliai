import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen.js";
import type { TuiDeps } from "./TuiDeps.js";

const tick = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;

/** Move to a sub-view by pressing ► `n` times from the default (agents). */
async function toSub(stdin: { write: (s: string) => void }, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		stdin.write(RIGHT);
		await tick();
	}
}
/** Move the cursor down `n` rows. */
async function down(stdin: { write: (s: string) => void }, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		stdin.write(DOWN);
		await tick();
	}
}

function fakeDeps(over: Partial<TuiDeps> = {}): TuiDeps {
	return {
		cwd: "/x",
		getIdentity: async () => ({ repo: "r", branch: "b" }),
		getStatus: async () =>
			({
				enabled: true,
				summaryCount: 0,
				orphanBranch: "b",
				claudeDetected: true,
				codexDetected: true,
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
		getInstalledSkills: async () => [
			{ name: "jolli-pr", targets: ["claude-code", "agents-std"] },
			{ name: "jolli-search", targets: [] },
		],
		inspectPlugins: async () => [
			{ id: "s", packageName: "@jolli.ai/site-cli", installHint: "npm i -g @jolli.ai/site-cli", state: "absent" },
		],
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
		loadAuthToken: async () => undefined,
		signInWithBrowser: async () => {},
		saveJolliApiKey: async () => {},
		saveAnthropicKey: async () => {},
		setAiProvider: async () => {},
		runCloudSync: async () => ({ kind: "bound", spaceName: "s", canPush: true, rechecked: true }),
		installPlugin: async () => {},
		loadConfig: async () => ({}),
		enableHost: async () => {},
		disableHost: async () => {},
		applySetting: async () => {},
		runCommand: async () => ({ output: "", exitCode: 0 }),
		...over,
	};
}

describe("SettingsScreen — sub-nav (mirrors VSCode tabs)", () => {
	it("opens on AI Agents; ◄► walks the VSCode-aligned tabs; ◄ returns", async () => {
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps()} />);
		await tick();
		let out = lastFrame() ?? "";
		// AI Agents: host toggles + Global Instructions.
		expect(out).toContain("AI Agents │ AI Summary │ Memory Bank │ Others");
		expect(out).toContain("[✓] Claude Code");
		// Host rows describe session tracking/discovery (mirrors the VSCode "AI
		// Agents" tab); the toggle no longer manages MCP, so no ".mcp.json" text.
		expect(out).toContain("Session tracking via Stop hook");
		expect(out).toContain("Session discovery via Cursor's local SQLite store");
		expect(out).not.toContain(".cursor/mcp.json");
		expect(out).toContain("Global Instructions");
		expect(out).toContain("machine-wide");
		await toSub(stdin, 1); // → AI Summary
		out = lastFrame() ?? "";
		for (const label of ["Provider", "API Key", "Model", "Max Output Tokens", "Jolli API Key"]) {
			expect(out).toContain(label);
		}
		await toSub(stdin, 1); // → Memory Bank
		out = lastFrame() ?? "";
		for (const label of ["Folder Path", "Include transcripts", "Compile Exclude Folders"]) {
			expect(out).toContain(label);
		}
		await toSub(stdin, 1); // → Others
		out = lastFrame() ?? "";
		expect(out).toContain("Sign commits with DCO");
		expect(out).toContain("Exclude Patterns");
		await toSub(stdin, 1); // → skills
		expect(lastFrame()).toContain("[✓] jolli-pr");
		await toSub(stdin, 1); // → plugins
		expect(lastFrame()).toContain("npm i -g @jolli.ai/site-cli");
		stdin.write(LEFT); // plugins → skills
		await tick();
		expect(lastFrame()).toContain("claude-code, agents-std");
	});

	it("Esc from a later tab returns to AI Agents", async () => {
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps()} />);
		await tick();
		await toSub(stdin, 2); // → Memory Bank
		expect(lastFrame()).toContain("Folder Path");
		stdin.write(ESC);
		await new Promise((r) => setTimeout(r, 150));
		expect(lastFrame()).toContain("[✓] Claude Code"); // back on AI Agents
	});
});

describe("SettingsScreen — AI Agents", () => {
	it("Space confirms; y disables the selected host", async () => {
		const disableHost = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ disableHost })} />);
		await tick();
		stdin.write(" "); // Claude Code (on) → disable
		await tick();
		expect(lastFrame()).toContain("Disable Claude Code? [y/n]");
		stdin.write("y");
		await tick();
		expect(disableHost).toHaveBeenCalledWith("claude");
	});

	it("n cancels the pending toggle", async () => {
		const disableHost = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ disableHost })} />);
		await tick();
		stdin.write(" ");
		await tick();
		stdin.write("n");
		await tick();
		expect(disableHost).not.toHaveBeenCalled();
		expect(lastFrame()).not.toContain("Disable Claude Code?");
	});

	it("down to a disabled host enables it", async () => {
		const enableHost = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ enableHost })} />);
		await tick();
		await down(stdin, 2); // Claude → Codex → Gemini (off)
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("Enable Gemini CLI? [y/n]");
		stdin.write("y");
		await tick();
		expect(enableHost).toHaveBeenCalledWith("gemini");
	});

	it("Global Instructions (last row) cycles in place, no confirm", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await down(stdin, 6); // past the 6 host rows → Global Instructions
		stdin.write(" ");
		await tick();
		expect(lastFrame()).not.toContain("? [y/n]");
		expect(applySetting).toHaveBeenCalledWith("globalInstructions", "enabled");
	});
});

describe("SettingsScreen — AI Summary", () => {
	it("cycles the Provider enum in place (no confirm)", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 1); // → AI Summary (cursor on Provider)
		stdin.write(" ");
		await tick();
		expect(lastFrame()).not.toContain("? [y/n]");
		expect(applySetting).toHaveBeenCalledWith("aiProvider", "jolli");
	});

	it("cycles the Provider enum to local-agent (jolli → local-agent)", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(
			<SettingsScreen deps={fakeDeps({ applySetting, loadConfig: async () => ({ aiProvider: "jolli" }) })} />,
		);
		await tick();
		await toSub(stdin, 1); // → AI Summary (cursor on Provider, reads "jolli")
		stdin.write(" ");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("aiProvider", "local-agent");
	});

	it("cycles the Model enum (default sonnet → opus)", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 2); // Provider → API Key → Model
		stdin.write(" ");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("model", "opus");
	});

	it("enters an Anthropic API key inline (masked; saves via saveAnthropicKey → switches provider)", async () => {
		const saveAnthropicKey = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ saveAnthropicKey })} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 1); // → API Key
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("sk-ant-…"); // placeholder in the empty editor
		for (const c of "sk-ant-xyz") stdin.write(c);
		await tick();
		expect(lastFrame()).not.toContain("sk-ant-xyz"); // masked, never echoed
		stdin.write("\r");
		await tick();
		// Saving a key routes through saveAnthropicKey (which also pins provider to
		// "anthropic"), NOT a bare applySetting("apiKey") — so the key takes effect.
		expect(saveAnthropicKey).toHaveBeenCalledWith("sk-ant-xyz");
	});

	it("parses Max Output Tokens to a number", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 3); // → Max Output Tokens
		stdin.write(" ");
		await tick();
		for (const c of "4096") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("maxTokens", 4096);
	});

	it("rejects malformed Max Output Tokens (Number(), not parseInt) — no save", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 3); // → Max Output Tokens
		stdin.write(" ");
		await tick();
		for (const c of "8192abc") stdin.write(c); // parseInt would accept 8192; Number() rejects
		await tick();
		stdin.write("\r");
		await tick();
		expect(applySetting).not.toHaveBeenCalled();
		expect(lastFrame()).toContain("Failed");
	});

	it("clearing Max Output Tokens (blank) unsets the cap", async () => {
		const applySetting = vi.fn(async () => {});
		const deps = fakeDeps({ applySetting, loadConfig: async () => ({ maxTokens: 4096 }) });
		const { stdin } = render(<SettingsScreen deps={deps} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 3); // → Max Output Tokens (prefilled "4096")
		stdin.write(" ");
		await tick();
		for (let i = 0; i < 4; i++) stdin.write("\x7f"); // erase the prefilled value
		await tick();
		stdin.write("\r");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("maxTokens", undefined);
	});

	it("saves a Jolli API key via the validating saver", async () => {
		const saveJolliApiKey = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ saveJolliApiKey })} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 4); // → Jolli API Key
		stdin.write(" ");
		await tick();
		for (const c of "sk-jol-abc") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(saveJolliApiKey).toHaveBeenCalledWith("sk-jol-abc");
	});

	it("empty Enter on a secret field leaves the stored key untouched (never clears)", async () => {
		const saveAnthropicKey = vi.fn(async () => {});
		const applySetting = vi.fn(async () => {});
		const deps = fakeDeps({ saveAnthropicKey, applySetting, loadConfig: async () => ({ apiKey: "stored" }) });
		const { stdin } = render(<SettingsScreen deps={deps} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 1); // → API Key (reads "configured")
		stdin.write(" ");
		await tick();
		stdin.write("\r"); // empty submit
		await tick();
		expect(saveAnthropicKey).not.toHaveBeenCalled();
		expect(applySetting).not.toHaveBeenCalled();
	});

	it("Ctrl+X clears the stored Anthropic key (via applySetting apiKey→undefined)", async () => {
		const applySetting = vi.fn(async () => {});
		const saveAnthropicKey = vi.fn(async () => {});
		const deps = fakeDeps({ applySetting, saveAnthropicKey, loadConfig: async () => ({ apiKey: "stored" }) });
		const { stdin, lastFrame } = render(<SettingsScreen deps={deps} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 1); // → API Key
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("[Ctrl+X] clear"); // gesture advertised for secrets
		stdin.write("\x18"); // Ctrl+X
		await tick();
		expect(applySetting).toHaveBeenCalledWith("apiKey", undefined);
		expect(saveAnthropicKey).not.toHaveBeenCalled(); // clear ≠ save
		expect(lastFrame()).toContain("API Key → cleared");
	});

	it("Ctrl+X clears the stored Jolli API key without hitting the validating saver", async () => {
		const applySetting = vi.fn(async () => {});
		const saveJolliApiKey = vi.fn(async () => {});
		const deps = fakeDeps({ applySetting, saveJolliApiKey, loadConfig: async () => ({ jolliApiKey: "stored" }) });
		const { stdin } = render(<SettingsScreen deps={deps} />);
		await tick();
		await toSub(stdin, 1);
		await down(stdin, 4); // → Jolli API Key
		stdin.write(" ");
		await tick();
		stdin.write("\x18"); // Ctrl+X
		await tick();
		expect(applySetting).toHaveBeenCalledWith("jolliApiKey", undefined);
		expect(saveJolliApiKey).not.toHaveBeenCalled(); // validating saver rejects "" — clear must bypass it
	});

	it("Ctrl+X on a non-secret free-text field does nothing (no accidental clear)", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 3); // → Others
		await down(stdin, 1); // → Exclude Patterns (free-text, not secret)
		stdin.write(" ");
		await tick();
		stdin.write("\x18"); // Ctrl+X
		await tick();
		expect(applySetting).not.toHaveBeenCalled();
	});
});

describe("SettingsScreen — Memory Bank & Others", () => {
	it("edits the Folder Path inline (prefilled)", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin, lastFrame } = render(
			<SettingsScreen deps={fakeDeps({ applySetting, loadConfig: async () => ({ localFolder: "/old" }) })} />,
		);
		await tick();
		await toSub(stdin, 2); // → Memory Bank (cursor on Folder Path)
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("[Enter] save");
		for (const c of "/new") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("localFolder", "/old/new");
	});

	it("rejects a relative Folder Path (must be absolute, no '..') — no save", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 2); // → Memory Bank (cursor on Folder Path)
		stdin.write(" ");
		await tick();
		for (const c of "relative/path") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(applySetting).not.toHaveBeenCalled();
		expect(lastFrame()).toContain("Failed");
	});

	it("cycles Include transcripts to a boolean", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 2);
		await down(stdin, 1); // → Include transcripts
		stdin.write(" ");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("syncTranscripts", true);
	});

	it("cycles Sign commits with DCO to a boolean", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 3); // → Others (cursor on DCO)
		stdin.write(" ");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("dcoSignoff", true);
	});

	it("shows a placeholder example in an empty editor, then hides it once typing", async () => {
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps()} />);
		await tick();
		await toSub(stdin, 3);
		await down(stdin, 1); // → Exclude Patterns (empty by default)
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("node_modules, *.log");
		stdin.write("a");
		await tick();
		expect(lastFrame()).not.toContain("node_modules, *.log");
	});

	it("edits Exclude Patterns into a string[]", async () => {
		const applySetting = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ applySetting })} />);
		await tick();
		await toSub(stdin, 3);
		await down(stdin, 1); // → Exclude Patterns
		stdin.write(" ");
		await tick();
		for (const c of "a, b ,c") stdin.write(c);
		await tick();
		stdin.write("\r");
		await tick();
		expect(applySetting).toHaveBeenCalledWith("excludePatterns", ["a", "b", "c"]);
	});
});

describe("SettingsScreen — skills & plugins", () => {
	it("skills: Space toggles a skill (install/remove)", async () => {
		const setSkillInstalled = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ setSkillInstalled })} />);
		await tick();
		await toSub(stdin, 4); // → skills
		stdin.write(" "); // jolli-pr (installed) → remove
		await tick();
		expect(lastFrame()).toContain("Remove skill jolli-pr? [y/n]");
		stdin.write("y");
		await tick();
		expect(setSkillInstalled).toHaveBeenCalledWith("jolli-pr", false);
	});

	it("plugins: Space confirms and installs via npm", async () => {
		const installPlugin = vi.fn(async () => {});
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ installPlugin })} />);
		await tick();
		await toSub(stdin, 5); // → plugins
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("Install plugin @jolli.ai/site-cli (npm install -g)? [y/n]");
		stdin.write("y");
		await tick();
		expect(installPlugin).toHaveBeenCalledWith("@jolli.ai/site-cli");
	});
});

describe("SettingsScreen — editor & lifecycle", () => {
	it("Esc cancels a text edit without saving (and reports capture on/off)", async () => {
		const applySetting = vi.fn(async () => {});
		const onCapture = vi.fn();
		const { stdin, lastFrame } = render(<SettingsScreen deps={fakeDeps({ applySetting })} onCapture={onCapture} />);
		await tick();
		await toSub(stdin, 3);
		await down(stdin, 1); // → Exclude Patterns (free-text)
		stdin.write(" ");
		await tick();
		expect(lastFrame()).toContain("[Enter] save");
		expect(onCapture).toHaveBeenLastCalledWith(true);
		stdin.write(ESC);
		await new Promise((r) => setTimeout(r, 150)); // lone ESC is held briefly by the parser
		expect(lastFrame()).not.toContain("[Enter] save");
		expect(applySetting).not.toHaveBeenCalled();
		expect(onCapture).toHaveBeenLastCalledWith(false);
	});

	it("pauses input while a shell overlay is open (active=false)", async () => {
		const disableHost = vi.fn(async () => {});
		const { stdin } = render(<SettingsScreen deps={fakeDeps({ disableHost })} active={false} />);
		await tick();
		stdin.write(" "); // would open the Claude toggle if active
		await tick();
		expect(disableHost).not.toHaveBeenCalled();
	});

	it("re-reads status/config on a reloadKey bump (Settings-mutating palette command)", async () => {
		// `/configure`, `/auth`, `/uninstall` change config/host/skill rows; the shell
		// signals via a reloadKey bump so the rows don't stay stale until a tab switch.
		const loadConfig = vi.fn(async () => ({ aiProvider: "anthropic" as const }));
		const deps = fakeDeps({ loadConfig }); // same object → only reloadKey drives the re-read
		const { rerender } = render(<SettingsScreen deps={deps} reloadKey={0} />);
		await tick();
		const before = loadConfig.mock.calls.length;
		rerender(<SettingsScreen deps={deps} reloadKey={1} />); // shell bump
		await tick();
		expect(loadConfig.mock.calls.length).toBeGreaterThan(before);
	});

	it("recovers from a transient load error on the next reloadKey bump", async () => {
		// First read throws → red error page; a later reload (reloadKey bump) succeeds
		// and must clear the error, not stay stuck on "Failed to load settings…".
		let calls = 0;
		const getStatus = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("status boom");
			return { enabled: true, summaryCount: 0, orphanBranch: "b", claudeDetected: true } as never;
		});
		const deps = fakeDeps({ getStatus }); // same object → only reloadKey drives the reload
		const { lastFrame, rerender } = render(<SettingsScreen deps={deps} reloadKey={0} />);
		await tick();
		expect(lastFrame()).toContain("Failed to load settings: status boom");
		rerender(<SettingsScreen deps={deps} reloadKey={1} />); // bump → full reload
		await tick();
		expect(lastFrame()).not.toContain("Failed to load settings");
		expect(lastFrame()).toContain("Global Instructions"); // dashboard rendered
	});

	it("shows an error notice (not a stuck 'loading…') when the initial load fails", async () => {
		const { lastFrame } = render(
			<SettingsScreen deps={fakeDeps({ getStatus: async () => Promise.reject(new Error("status boom")) })} />,
		);
		await tick();
		expect(lastFrame()).toContain("Failed to load settings: status boom");
		expect(lastFrame()).not.toContain("loading…");
	});
});
