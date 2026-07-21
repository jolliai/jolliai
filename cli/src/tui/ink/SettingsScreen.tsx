/**
 * SettingsScreen — "configure this install", split into a `◄►` sub-nav that
 * MIRRORS the VSCode extension's Settings tabs so the two surfaces read the same
 * (see vscode `SettingsHtmlBuilder`): `AI Agents · AI Summary · Memory Bank ·
 * Others`, plus the TUI-only `skills · plugins`. Each sub-view is a focused,
 * windowed list with a single ↑↓ cursor; `Space` acts on the selected row:
 *   • AI Agents  → host rows toggle the source (confirmed y/n); the last row is
 *                  the Global Instructions enum (cycled in place)
 *   • AI Summary → Provider/Model enums cycle; API Key / Jolli API Key / Max
 *                  Output Tokens open an inline editor (keys masked)
 *   • Memory Bank / Others → enums cycle, free-text opens an inline editor
 *   • skills   → install/remove the skill across both targets, confirmed y/n
 *   • plugins  → install the plugin (`npm i -g`), confirmed y/n
 * Config writes go through TuiDeps.applySetting (which runs the settings
 * side-effect map, e.g. globalInstructions → syncGlobalInstructions); the two
 * credential fields reuse TuiDeps.saveJolliApiKey (validates `sk-jol-…`) and
 * applySetting("apiKey") — all land in the same machine-global config file.
 * Global MCP hosts stay read-only (machine-wide). Key hints go to the StatusBar.
 */
import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { InstalledSkill } from "../../install/SkillInstaller.js";
import type { JolliMemoryConfig } from "../../Types.js";
import { buildPluginRows, buildSourceRows, type PluginRow, type SourceRow } from "./ManageModel.js";
import { cursorWindow, More } from "./Scrollable.js";
import {
	ALL_CONFIG_ROWS,
	configRowsFor,
	type GeneralRow,
	GLOBAL_INSTRUCTIONS_ROW,
	nextInCycle,
	type SettingsSubView,
} from "./SettingsModel.js";
import type { TuiDeps } from "./TuiDeps.js";
import { type TuiStateStore, useKeptState } from "./TuiState.js";
import { fitRows, useTerminalSize } from "./useTerminalSize.js";

const SUBVIEWS: readonly SettingsSubView[] = ["agents", "summary", "memory", "others", "skills", "plugins"];
/** Sub-nav labels — the four config tabs match the VSCode Settings tabs. */
const SUBNAV_LABEL: Record<SettingsSubView, string> = {
	agents: "AI Agents",
	summary: "AI Summary",
	memory: "Memory Bank",
	others: "Others",
	skills: "skills",
	plugins: "plugins",
};
const ROWS = 10; // default (max) windowed rows per sub-view; shrinks on a short terminal
const SET_CHROME = 9; // non-list rows around a sub-view (tabs, sub-nav, command bar, status)
const LABEL_W = 21; // fixed label column so values line up
const HOST_LABEL_W = 12; // widest host label ("Claude Code")

interface Pending {
	readonly label: string;
	readonly run: () => Promise<void>;
}

export function SettingsScreen({
	deps,
	onCapture,
	onHints,
	active = true,
	store,
	reloadKey = 0,
}: {
	deps: TuiDeps;
	onCapture?: (capturing: boolean) => void;
	onHints?: (hints: string) => void;
	/** When false (a shell overlay is open), this screen's keys are paused. */
	active?: boolean;
	/** Shell store so the section + cursor survive tab switches (see TuiState). */
	store?: TuiStateStore;
	/** Bumped by the shell when a palette command that changes Settings-visible
	 *  state finishes (`/configure`, `/auth`, `/uninstall`) — re-reads status /
	 *  config / skills so the rows don't stay stale until a tab switch. */
	reloadKey?: number;
}): ReactElement {
	// Section + cursor kept in the shell store so returning to Settings reopens
	// the same section/row (see TuiState). Data + transient edit state stay local.
	const [sub, setSub] = useKeptState<SettingsSubView>(store, "settings.sub", "agents");
	const [cursor, setCursor] = useKeptState(store, "settings.cursor", 0);
	const [sources, setSources] = useState<SourceRow[] | null>(null);
	const [skills, setSkills] = useState<InstalledSkill[]>([]);
	const [plugins, setPlugins] = useState<PluginRow[]>([]);
	const [pending, setPending] = useState<Pending | null>(null);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [config, setConfig] = useState<JolliMemoryConfig>({});
	const [error, setError] = useState<string | null>(null);
	// Inline editor for a free-text setting; `editKey` is the row being edited.
	const [editKey, setEditKey] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");

	// List budget shrinks to fit a short terminal (unchanged on a roomy one).
	const { rows: termRows } = useTerminalSize();
	const listRows = fitRows(termRows, SET_CHROME, ROWS);

	// Single fetch/apply pair shared by the mount load and post-action reloads —
	// so the four reads and their mapping never drift between the two paths.
	async function fetchAll() {
		const [status, plugs, sk, cfg] = await Promise.all([
			deps.getStatus(),
			deps.inspectPlugins(),
			deps.getInstalledSkills(),
			deps.loadConfig(),
		]);
		return { sources: buildSourceRows(status), plugins: buildPluginRows(plugs), skills: sk, config: cfg };
	}
	function applyLoaded(d: Awaited<ReturnType<typeof fetchAll>>): void {
		setSources(d.sources);
		setPlugins(d.plugins);
		setSkills(d.skills);
		setConfig(d.config);
		// Clear any prior load error — a later success (mount reload, reloadKey bump,
		// or post-action reload) must recover the screen, not stay on the red page
		// (render hard-returns while `error` is set).
		setError(null);
	}
	async function reload(): Promise<void> {
		applyLoaded(await fetchAll());
	}

	// Mount + deps-change load, and re-load on a shell reloadKey bump (a
	// Settings-mutating palette command — `/configure`, `/auth`, `/uninstall` —
	// finished; see the prop docstring).
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount/deps/reloadKey load; fetchAll/applyLoaded close over deps
	useEffect(() => {
		let live = true;
		void fetchAll()
			.then((d) => {
				if (live) applyLoaded(d);
			})
			.catch((e) => {
				if (live) setError((e as Error).message);
			});
		return () => {
			live = false;
		};
	}, [deps, reloadKey]);

	// AI Agents = host toggles + one Global Instructions row appended below.
	const agentRowCount = (sources?.length ?? 0) + 1;
	const rowCount =
		sub === "agents"
			? agentRowCount
			: sub === "skills"
				? skills.length
				: sub === "plugins"
					? plugins.length
					: configRowsFor(sub).length;

	// Report capture while an inline editor is open OR a [y/n] confirm is pending,
	// so the shell pauses its global keys — otherwise Tab / 1-4 / q would switch
	// tab or quit mid-confirm, silently abandoning the toggle/install prompt.
	useEffect(() => {
		onCapture?.(editKey !== null || pending !== null);
	}, [editKey, pending, onCapture]);

	// Report context-specific key hints to the shell StatusBar.
	useEffect(() => {
		if (editKey !== null) {
			const row = ALL_CONFIG_ROWS.find((r) => r.key === editKey);
			const clearable = row?.kind === "text" && row.secret === true;
			return onHints?.(`[Enter] save · ${clearable ? "[Ctrl+X] clear · " : ""}[Esc] cancel`);
		}
		if (pending) return onHints?.("[y/n] confirm");
		const toggles = sub === "agents" || sub === "skills" || sub === "plugins";
		const act = toggles ? "[Space] toggle" : "[Space] change";
		onHints?.(`[↑↓] move · ${act} · [◄►] section${sub === "agents" ? "" : " · [esc] AI Agents"}`);
	}, [editKey, pending, sub, onHints]);

	function cycleSub(dir: 1 | -1): void {
		// Functional update so rapid ◄►◄► presses compose instead of reading a
		// stale `sub` from the closure.
		setSub((cur) => SUBVIEWS[(SUBVIEWS.indexOf(cur) + dir + SUBVIEWS.length) % SUBVIEWS.length]);
		setCursor(0);
		setNote(null);
	}

	useInput(
		(input, key) => {
			if (busy || !sources) return;
			// Inline free-text editor — Enter saves, Esc cancels.
			if (editKey !== null) {
				if (key.escape) {
					setEditKey(null);
				} else if (key.ctrl && input === "x") {
					// Explicit clear gesture for a secret: empty-Enter deliberately means
					// "leave the stored key as-is" (so you can open the editor to inspect
					// without wiping it), so removing a credential needs its own key.
					const row = ALL_CONFIG_ROWS.find((r) => r.key === editKey);
					setEditKey(null);
					if (row && row.kind === "text" && row.secret) void applyText(row, "");
				} else if (key.return) {
					const row = ALL_CONFIG_ROWS.find((r) => r.key === editKey);
					const value = editValue.trim();
					setEditKey(null);
					// Secret fields save only on non-empty input (empty Enter = leave as-is;
					// use Ctrl+X to clear); other text fields save whenever the value changed.
					if (row && row.kind === "text") {
						const changed = row.secret ? value !== "" : value !== row.read(config);
						if (changed) void applyText(row, value);
					}
				} else if (key.backspace || key.delete) {
					setEditValue((v) => v.slice(0, -1));
				} else if (input && !key.ctrl && !key.meta && !key.tab) {
					setEditValue((v) => v + input);
				}
				return;
			}
			if (pending) {
				if (input === "y") void apply(pending);
				else if (input === "n" || key.escape) setPending(null);
				return;
			}
			if (key.escape && sub !== "agents") {
				setSub("agents");
				setCursor(0);
				return;
			}
			if (key.leftArrow) return cycleSub(-1);
			if (key.rightArrow) return cycleSub(1);
			if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
			else if (key.downArrow || input === "j") setCursor((c) => Math.min(Math.max(0, rowCount - 1), c + 1));
			else if (input === " ") activate();
		},
		{ isActive: active },
	);

	function activate(): void {
		if (!sources) return;
		if (sub === "agents") {
			// Host rows first, then the Global Instructions enum as the last row.
			if (cursor < sources.length) {
				const s = sources[cursor];
				if (!s) return;
				setPending({
					label: `${s.on ? "Disable" : "Enable"} ${s.label}`,
					run: () => (s.on ? deps.disableHost(s.host) : deps.enableHost(s.host)),
				});
			} else {
				void cycleEnum(GLOBAL_INSTRUCTIONS_ROW);
			}
		} else if (sub === "skills") {
			const sk = skills[cursor];
			if (!sk) return;
			const on = sk.targets.length > 0;
			setPending({
				label: `${on ? "Remove" : "Install"} skill ${sk.name}`,
				run: () => deps.setSkillInstalled(sk.name, !on),
			});
		} else if (sub === "plugins") {
			const p = plugins[cursor];
			if (!p) return;
			if (p.state === "ok") {
				setNote(`${p.name} is already installed.`);
				return;
			}
			setPending({ label: `Install plugin ${p.name} (npm install -g)`, run: () => deps.installPlugin(p.name) });
		} else {
			const row = configRowsFor(sub)[cursor];
			if (!row) return;
			if (row.kind === "enum") void cycleEnum(row);
			else {
				// Secrets start empty (never prefill the stored key); others prefill.
				setEditValue(row.secret ? "" : row.read(config));
				setEditKey(row.key);
			}
		}
	}

	async function applyText(row: GeneralRow, value: string): Promise<void> {
		setBusy(true);
		setNote(null);
		try {
			await row.write(deps, value);
			setConfig(await deps.loadConfig());
			// Never echo a secret back into the note (report save vs. clear instead).
			const shown = row.kind === "text" && row.secret ? (value ? "saved" : "cleared") : value || "(unset)";
			setNote(`${row.label} → ${shown}`);
		} catch (e) {
			setNote(`Failed: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	}

	async function cycleEnum(row: Extract<GeneralRow, { kind: "enum" }>): Promise<void> {
		setBusy(true);
		setNote(null);
		try {
			await row.write(deps, nextInCycle(row.values, row.read(config)));
			setConfig(await deps.loadConfig());
		} catch (e) {
			setNote(`Failed: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	}

	async function apply(p: Pending): Promise<void> {
		setPending(null);
		setBusy(true);
		setNote(null);
		try {
			await p.run();
			await reload();
			setNote(`${p.label} — done.`);
		} catch (e) {
			setNote(`Failed: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	}

	if (error) return <Text color="red">Failed to load settings: {error}</Text>;
	if (!sources) return <Text dimColor>loading…</Text>;

	return (
		<Box flexDirection="column">
			<SubNav sub={sub} />
			<Box marginTop={1} flexDirection="column">
				{sub === "agents" && <AgentsView sources={sources} config={config} cursor={cursor} rows={listRows} />}
				{(sub === "summary" || sub === "memory" || sub === "others") && (
					<ConfigView
						rows={configRowsFor(sub)}
						config={config}
						cursor={cursor}
						editKey={editKey}
						editValue={editValue}
					/>
				)}
				{sub === "skills" && <SkillsView skills={skills} cursor={cursor} rows={listRows} />}
				{sub === "plugins" && <PluginsView plugins={plugins} cursor={cursor} rows={listRows} />}
			</Box>
			{pending && <Text color="yellow">{pending.label}? [y/n]</Text>}
			{busy && <Text dimColor>applying…</Text>}
			{note && <Text dimColor>{note}</Text>}
			{/* Key hints live in the shell StatusBar (reported via onHints). */}
		</Box>
	);
}

function SubNav({ sub }: { sub: SettingsSubView }): ReactElement {
	return (
		<Box>
			{SUBVIEWS.map((v, i) => (
				<Text key={v} color={v === sub ? "cyan" : "gray"} bold={v === sub}>
					{i > 0 ? " │ " : ""}
					{SUBNAV_LABEL[v]}
				</Text>
			))}
		</Box>
	);
}

const marker = (i: number, cursor: number): string => (i === cursor ? "❯ " : "  ");
const rowColor = (i: number, cursor: number): string | undefined => (i === cursor ? "cyan" : undefined);

/** One config row (enum value / free-text / masked secret), possibly in-edit. */
function ConfigRow({
	row,
	index,
	cursor,
	config,
	editKey,
	editValue,
}: {
	row: GeneralRow;
	index: number;
	cursor: number;
	config: JolliMemoryConfig;
	editKey: string | null;
	editValue: string;
}): ReactElement {
	const editing = editKey === row.key;
	const secret = row.kind === "text" && row.secret === true;
	const isText = row.kind === "text";
	const label = `${row.label}:`.padEnd(LABEL_W);
	// Active edit: a single-line, background-highlighted field (obvious input, but
	// inline with the label — no wrapping to a multi-line box).
	if (editing) {
		const shown = secret ? "•".repeat(editValue.length) : editValue;
		const filled = shown === "" && row.kind === "text" && row.placeholder ? row.placeholder : shown;
		return (
			<Text color="cyan">
				{marker(index, cursor)}
				{label}
				<Text backgroundColor="blue" color="white">
					{` ${filled}▏ `}
				</Text>
				<Text dimColor>{`  [Enter] save · ${secret ? "[Ctrl+X] clear · " : ""}[Esc] cancel`}</Text>
			</Text>
		);
	}
	const value = row.read(config) || "(unset)";
	const color = rowColor(index, cursor);
	return (
		<Text color={color}>
			{marker(index, cursor)}
			{label}
			{isText ? (
				// Editable free-text: bracketed so it reads as an input even when idle
				// (enum rows render bare — they cycle in place, they're not typed).
				<Text color={color ?? "gray"}>
					[ <Text bold>{value}</Text> ]
				</Text>
			) : (
				<Text bold>{value}</Text>
			)}
			{row.detail ? <Text dimColor> — {row.detail}</Text> : null}
		</Text>
	);
}

function ConfigView({
	rows,
	config,
	cursor,
	editKey,
	editValue,
}: {
	rows: readonly GeneralRow[];
	config: JolliMemoryConfig;
	cursor: number;
	editKey: string | null;
	editValue: string;
}): ReactElement {
	return (
		<Box flexDirection="column">
			{rows.map((row, i) => (
				<ConfigRow
					key={row.key}
					row={row}
					index={i}
					cursor={cursor}
					config={config}
					editKey={editKey}
					editValue={editValue}
				/>
			))}
		</Box>
	);
}

/** AI Agents: the host toggles, then the Global Instructions enum row. */
function AgentsView({
	sources,
	config,
	cursor,
	rows,
}: {
	sources: SourceRow[];
	config: JolliMemoryConfig;
	cursor: number;
	rows: number;
}): ReactElement {
	// Window only the host list; keep the cursor inside it when a host is selected.
	const hostCursor = Math.min(cursor, sources.length - 1);
	const w = cursorWindow(sources.length, rows, hostCursor);
	return (
		<Box flexDirection="column">
			<More n={w.above} up />
			{sources.slice(w.start, w.start + rows).map((s, k) => {
				const i = w.start + k;
				return (
					<Text key={s.host} color={rowColor(i, cursor)}>
						{marker(i, cursor)}
						{s.on ? "[✓]" : "[ ]"} {s.label.padEnd(HOST_LABEL_W)}
						<Text dimColor>{s.detail}</Text>
					</Text>
				);
			})}
			<More n={w.below} up={false} />
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Global preferences</Text>
				<ConfigRow
					row={GLOBAL_INSTRUCTIONS_ROW}
					index={sources.length}
					cursor={cursor}
					config={config}
					editKey={null}
					editValue=""
				/>
				<Box marginTop={1}>
					<Text dimColor>
						Global MCP hosts (Codex/Gemini/OpenCode/Copilot) are machine-wide — managed by `jolli enable`.
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

function SkillsView({
	skills,
	cursor,
	rows,
}: {
	skills: InstalledSkill[];
	cursor: number;
	rows: number;
}): ReactElement {
	if (skills.length === 0) return <Text dimColor>No managed skills.</Text>;
	const w = cursorWindow(skills.length, rows, cursor);
	return (
		<Box flexDirection="column">
			<More n={w.above} up />
			{skills.slice(w.start, w.start + rows).map((sk, k) => {
				const i = w.start + k;
				return (
					<Text key={sk.name} color={rowColor(i, cursor)}>
						{marker(i, cursor)}
						{sk.targets.length > 0 ? "[✓]" : "[ ]"} {sk.name.padEnd(13)}
						<Text dimColor>→ {sk.targets.length > 0 ? sk.targets.join(", ") : "not installed"}</Text>
					</Text>
				);
			})}
			<More n={w.below} up={false} />
		</Box>
	);
}

function PluginsView({ plugins, cursor, rows }: { plugins: PluginRow[]; cursor: number; rows: number }): ReactElement {
	if (plugins.length === 0) return <Text dimColor>(none known)</Text>;
	const w = cursorWindow(plugins.length, rows, cursor);
	return (
		<Box flexDirection="column">
			<More n={w.above} up />
			{plugins.slice(w.start, w.start + rows).map((p, k) => {
				const i = w.start + k;
				return (
					<Text key={p.name} color={rowColor(i, cursor)}>
						{marker(i, cursor)}
						{p.state === "ok" ? "[✓]" : "[ ]"} {p.name}
						{p.state !== "ok" ? <Text dimColor> — {p.installHint}</Text> : null}
					</Text>
				);
			})}
			<More n={w.below} up={false} />
		</Box>
	);
}
