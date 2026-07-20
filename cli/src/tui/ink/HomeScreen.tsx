/**
 * HomeScreen — the unified front door. Loads the HomeModel via TuiDeps and
 * renders one of two shells driven by `onboarding.layout`:
 *
 *   - wizard    — a required item is missing (fresh repo, or a returning user
 *                 who logged out + wiped config / disabled). Full-screen, no
 *                 tabs (TuiApp gates that off `onLayout`); ↑↓ moves between the
 *                 required steps, Enter runs the highlighted step's action.
 *   - dashboard — setup complete. Full status + auth rows + live activity line.
 *
 * The pure `HomeView` (model + view-state → Ink tree) is split out so every
 * visual state — wizard step, masked key entry, spinner, dashboard — is
 * snapshot-testable without async. Async actions (sign-in, save key, enable,
 * sync) go through injected TuiDeps so tests stub them; sign-in/sync progress
 * is routed into `statusLine` (never stdout — that would corrupt the Ink frame).
 */
import { Box, Text, useInput } from "ink";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { SpaceSyncOutcome } from "../../commands/SpaceSyncStep.js";
import { applyLiveStatus, type HomeModel, loadHomeModel } from "./HomeSnapshot.js";
import type { SetupStep, SetupStepAction } from "./OnboardingModel.js";
import type { BackfillOffer, SpaceBinding, TuiDeps } from "./TuiDeps.js";

const SPINNER = "⠋";
/** How long a success outcome line lingers before auto-clearing (ms). Actions
 *  whose result isn't otherwise visible (e.g. re-checking an unchanged Space
 *  binding) show a brief confirmation that then fades on its own. */
export const OUTCOME_TTL_MS = 4000;

/** View-state the pure HomeView needs beyond the model. (The command palette +
 *  output panel moved to the shell-level `useCommandRunner`; Home is now just
 *  the wizard / dashboard.) */
export interface HomeViewState {
	readonly cursor: number;
	readonly capturingKind: "jolli" | "anthropic" | null;
	readonly inputValue: string;
	readonly busyLabel: string | null;
	readonly statusLine: string | null;
	readonly pending: boolean;
	/** This repo's cached Space binding (Sync row); null when unbound / unknown. */
	readonly binding: SpaceBinding | null;
	/** Cold-start back-fill offer (dashboard `[b] build` affordance); null = none. */
	readonly offer: BackfillOffer | null;
}

const REQUIRED = (m: HomeModel): SetupStep[] => m.onboarding.steps.filter((s) => s.cls === "required");

/** Wizard ↑/↓: land only on UNSATISFIED required steps, skipping satisfied rows
 *  — those render no cursor marker and their Enter action is a no-op, so parking
 *  on one made the selection vanish and Enter do nothing. Falls back to the
 *  nearest navigable row if the cursor somehow sits on a satisfied one; returns
 *  the cursor unchanged when nothing is navigable. */
function moveWizardCursor(steps: SetupStep[], cur: number, dir: -1 | 1): number {
	const navigable = steps.flatMap((s, i) => (s.satisfied ? [] : [i]));
	if (navigable.length === 0) return cur;
	const pos = navigable.indexOf(cur);
	if (pos === -1) {
		return dir === 1
			? (navigable.find((i) => i > cur) ?? navigable[navigable.length - 1])
			: (navigable.filter((i) => i < cur).pop() ?? navigable[0]);
	}
	return navigable[Math.min(navigable.length - 1, Math.max(0, pos + dir))];
}

/** Truthful one-line result for a cloud-sync attempt — deliberately never a
 *  blanket "bound", so no-spaces / multi-space / conflict / error can't read as
 *  success. Returns null (no line) only for the impossible-from-the-wizard
 *  no-credential case (the step isn't offered without a key). */
function spaceSyncLine(o: SpaceSyncOutcome): string | null {
	switch (o.kind) {
		case "bound":
			// A degraded binding (no `spaces.view`, or view-only without push) is
			// bound but won't sync — must not read as a healthy "✓".
			if (o.spaceName === null) return "⚠ bound but no access to the Space — won't sync";
			if (o.canPush === false) return `⚠ bound read-only to "${o.spaceName}" — won't sync`;
			return o.rechecked ? "✓ Space re-checked" : "✓ Space bound";
		case "no-spaces":
			return "No Jolli Space bound — none available to you";
		case "multi-space":
			return `${o.count} Spaces available — run \`jolli bind --space <id>\``;
		case "conflict":
			return "⚠ already bound to a different Space — not changed";
		case "no-credential":
			return null;
		case "error":
			return `sync failed: ${o.message}`;
	}
}

export function HomeScreen({
	deps,
	onCapture,
	onLayout,
	onHints,
	active = true,
	reloadKey = 0,
}: {
	deps: TuiDeps;
	onCapture?: (capturing: boolean) => void;
	onLayout?: (layout: "wizard" | "dashboard") => void;
	onHints?: (hints: string) => void;
	/** When false (a shell overlay is open), this screen's keys are paused. */
	active?: boolean;
	/** Bumped by the shell when a palette command finishes; each change forces a
	 *  full reload so a command like `auth login/logout` is reflected here. */
	reloadKey?: number;
}): ReactElement {
	const [model, setModel] = useState<HomeModel | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [cursor, setCursor] = useState(0);
	const [capturingKind, setCapturingKind] = useState<"jolli" | "anthropic" | null>(null);
	const [inputValue, setInputValue] = useState<string | null>(null);
	const [busyLabel, setBusyLabel] = useState<string | null>(null);
	const [statusLine, setStatusLine] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [binding, setBinding] = useState<SpaceBinding | null>(null);
	const [offer, setOffer] = useState<BackfillOffer | null>(null);
	const alive = useRef(true);
	// The pending success-line auto-clear timer. Held so a new action cancels the
	// prior one — otherwise an earlier action's timer clears a later action's
	// fresh confirmation early when both use the same message (repeated retries).
	const outcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const capturing = inputValue !== null;
	const busy = busyLabel !== null;
	// Kept current for the 2.5s poll's closure: it must see the LATEST model to
	// decide whether to self-heal from a null (failed first load), not the stale
	// value captured when the interval effect last ran.
	const modelRef = useRef(model);
	modelRef.current = model;

	async function reload(): Promise<void> {
		const [m, b] = await Promise.all([loadHomeModel(deps), deps.getSpaceBinding()]);
		if (alive.current) {
			setModel(m);
			setBinding(b);
			// Clear any prior load error — a later success must recover the screen,
			// not stay stuck on the red error page (the render hard-returns on error).
			setError(null);
		}
		// The cold-start offer refreshes on every reload (mount / reloadKey / after an
		// action like a build or dismiss), but OFF the awaited critical path: it is a
		// best-effort onboarding nudge, and keeping it out of the Promise.all above
		// means it never delays an action's outcome line + auto-clear timer. Loaded
		// here rather than in the 2.5s poll because listMissingCommits runs `git log`,
		// too heavy for a timer.
		void deps
			.getBackfillOffer()
			.then((o) => {
				if (alive.current) setOffer(o);
			})
			.catch(() => {
				/* best-effort nudge — never surface a detection failure */
			});
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount/deps-change/reloadKey load; reload closes over deps
	useEffect(() => {
		alive.current = true;
		void reload().catch((e) => {
			if (alive.current) setError((e as Error).message);
		});
		return () => {
			alive.current = false;
			if (outcomeTimer.current) clearTimeout(outcomeTimer.current);
		};
	}, [deps, reloadKey]);

	// Tell the shell which layout to render (tab bar on/off) and whether a text
	// field is capturing (pause global shortcuts). Mirrors MemoriesScreen.
	useEffect(() => {
		if (model) onLayout?.(model.onboarding.layout);
	}, [model, onLayout]);
	// Report capture while a text field is open OR a [y/n] confirm is pending, so
	// the shell pauses its global keys — otherwise Tab / 1-4 / q would switch tab
	// or quit mid-confirm, silently abandoning the disable prompt.
	useEffect(() => {
		onCapture?.(capturing || pending);
	}, [capturing, pending, onCapture]);

	// Report the screen's context-specific key hints to the shell StatusBar.
	useEffect(() => {
		if (!model) return onHints?.("");
		if (capturingKind) return onHints?.("[Enter] save · [Esc] cancel");
		if (pending) return onHints?.("[y/n] confirm");
		if (model.onboarding.layout === "wizard") return onHints?.("↑↓ move · Enter do it · q later");
		const base = `[a] ${model.enabled ? "disable" : "enable"}`;
		return onHints?.(offer ? `${base} · [b] build memories · [x] dismiss` : base);
	}, [model, capturingKind, pending, offer, onHints]);

	// Keep the cursor on the first unsatisfied required step, but only re-home it
	// when the missing set actually changes — NOT on every 2.5s live-status poll
	// (which would fight the user's ↑↓ navigation).
	const missingSig = model ? model.onboarding.missingRequired.map((s) => s.id).join(",") : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-home only on missing-set change
	useEffect(() => {
		if (model?.onboarding.layout !== "wizard") return;
		const steps = REQUIRED(model);
		const firstUnsatisfied = steps.findIndex((s) => !s.satisfied);
		setCursor(firstUnsatisfied < 0 ? 0 : firstUnsatisfied);
	}, [missingSig]);

	// Periodic refresh of ONLY the cheap live-activity fields. A full
	// loadHomeModel would re-run the heavy getStatus on a timer; instead poll
	// queue/ingest/binding and patch via the pure applyLiveStatus. Skip while
	// busy / capturing / confirming so we never clobber in-flight state.
	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	useEffect(() => {
		const id = setInterval(() => {
			if (busy || capturing || pending) return;
			// Self-heal: if the FIRST load failed (model still null), the shell has no
			// tabs/palette and nothing else can trigger a reload — so the poll retries
			// the full build. A transient failure (e.g. index.lock held by a concurrent
			// commit at startup) then recovers on its own within one tick.
			if (modelRef.current === null) {
				void reloadRef.current().catch(() => {
					/* keep showing the error page; try again next tick */
				});
				return;
			}
			void Promise.all([deps.getQueueStatus(), deps.getIngestPhase(), deps.getSpaceBinding()])
				.then(([queue, ingest, spaceBinding]) => {
					if (!alive.current) return;
					setModel((m) => (m && !busy && !capturing && !pending ? applyLiveStatus(m, queue, ingest) : m));
					if (!busy && !capturing && !pending) setBinding(spaceBinding);
				})
				.catch(() => {
					/* transient read error — keep the last-good model, no red screen */
				});
		}, 2500);
		return () => clearInterval(id);
	}, [deps, busy, capturing, pending]);

	function runAsync<T>(
		label: string,
		fn: () => Promise<T>,
		// A string for a fixed result line, or a function mapping the resolved
		// value to a truthful line (used by cloud-sync, whose outcome varies).
		successLine?: string | ((result: T) => string | null),
	): void {
		// Cancel any still-pending auto-clear from a previous action so it can't
		// clear this action's forthcoming line (the value guard alone isn't enough
		// when two actions share the same successLine).
		if (outcomeTimer.current) {
			clearTimeout(outcomeTimer.current);
			outcomeTimer.current = null;
		}
		setBusyLabel(label);
		setStatusLine(null);
		void fn()
			.then(async (result) => {
				await reload();
				return result;
			})
			.then((result) => {
				if (!alive.current) return;
				// Success: for most actions the reloaded rows (Sign-in / Space / Status)
				// are the feedback, so drop the transient progress line. An action whose
				// result isn't otherwise visible (e.g. re-checking a Space binding that
				// doesn't change) passes a successLine — shown briefly, then auto-cleared
				// after OUTCOME_TTL_MS so it doesn't linger. The clear is guarded on the
				// value so a newer action's line (or error) is never clobbered.
				const line = typeof successLine === "function" ? successLine(result) : (successLine ?? null);
				setStatusLine(line);
				if (line)
					outcomeTimer.current = setTimeout(() => {
						outcomeTimer.current = null;
						if (alive.current) setStatusLine((cur) => (cur === line ? null : cur));
					}, OUTCOME_TTL_MS);
			})
			.catch((e) => {
				// Failure: keep the message. Once busyLabel clears, the spinner that
				// showed statusLine is gone, so HomeView renders it as a standalone
				// error line (see WizardView / DashboardView) — otherwise the failure
				// would be invisible.
				if (alive.current) setStatusLine(`error: ${(e as Error).message}`);
			})
			.finally(() => {
				if (alive.current) setBusyLabel(null);
			});
	}

	function runAction(a: SetupStepAction): void {
		switch (a.kind) {
			case "none":
				return;
			case "enter-anthropic-key":
				setCapturingKind("anthropic");
				setInputValue("");
				return;
			case "enter-jolli-key":
				setCapturingKind("jolli");
				setInputValue("");
				return;
			case "signin":
				runAsync("signing in…", () => deps.signInWithBrowser((m) => alive.current && setStatusLine(m)));
				return;
			case "switch-provider":
				runAsync("switching provider…", () => deps.setAiProvider(a.provider));
				return;
			case "enable":
				runAsync("enabling…", () => deps.setEnabled(true));
				return;
			case "cloud-sync":
				// Report the ACTUAL outcome — a re-check leaves rows unchanged (so a line
				// confirms it ran), but no-spaces / multi-space / conflict / error must NOT
				// masquerade as "✓ Space bound" (see spaceSyncLine).
				runAsync("syncing…", () => deps.runCloudSync((m) => alive.current && setStatusLine(m)), spaceSyncLine);
				return;
		}
	}
	function runStep(step: SetupStep): void {
		runAction(step.action);
	}
	/** `[b]` on the dashboard's cold-start offer: build memories for the offered
	 *  commits, live progress → statusLine. The reload after it recomputes the
	 *  offer (gaps now filled), so the row disappears when the backlog is cleared. */
	function runBackfillOffer(): void {
		if (!offer || offer.commits.length === 0) return;
		const hashes = offer.commits.map((c) => c.hash);
		runAsync(
			"building memories…",
			() => deps.runColdStartBackfill(hashes, (m) => alive.current && setStatusLine(m)),
			(r) =>
				`✓ built ${r.generated} ${r.generated === 1 ? "memory" : "memories"}${r.errors > 0 ? ` · ${r.errors} failed` : ""}`,
		);
	}
	/** `[x]` on the offer: sticky per-repo opt-out. Reload drops the row. */
	function dismissBackfillOffer(): void {
		runAsync("dismissing…", () => deps.dismissBackfill());
	}
	/** Resolve a key press to a step's primary or secondary action. */
	function actionForKey(ch: string): SetupStepAction | undefined {
		if (!model) return undefined;
		for (const s of model.onboarding.steps) {
			if (s.actionKey === ch && s.action.kind !== "none") return s.action;
			if (s.altActionKey === ch && s.altAction) return s.altAction;
		}
		return undefined;
	}

	function submitKey(): void {
		const value = inputValue ?? "";
		const kind = capturingKind;
		setInputValue(null);
		setCapturingKind(null);
		if (!value) return; // empty = cancel
		runAsync("saving key…", () => (kind === "jolli" ? deps.saveJolliApiKey(value) : deps.saveAnthropicKey(value)));
	}

	useInput(
		(ch, key) => {
			if (!model) {
				// First load failed / still loading: `r` retries the full build so a
				// transient failure isn't a dead end (there are no tabs/palette here to
				// trigger a reload otherwise). The 2.5s poll also self-heals hands-free.
				if ((ch === "r" || key.return) && !busy) {
					setError(null);
					void reload().catch((e) => alive.current && setError((e as Error).message));
				}
				return;
			}

			// Text capture (masked API key) — reuses the MemoriesScreen search pattern.
			if (capturing) {
				if (key.escape) {
					setInputValue(null);
					setCapturingKind(null);
				} else if (key.return) {
					submitKey();
				} else if (key.backspace || key.delete) {
					setInputValue((v) => (v ?? "").slice(0, -1));
				} else if (ch && !key.ctrl && !key.meta && !key.tab) {
					setInputValue((v) => (v ?? "") + ch);
				}
				return;
			}

			if (busy) return; // ignore keys during an async action

			// Dashboard disable confirmation.
			if (pending) {
				if (ch === "y") {
					setPending(false);
					runAsync("applying…", () => deps.setEnabled(false));
				} else if (ch === "n" || key.escape) {
					setPending(false);
				}
				return;
			}

			const ob = model.onboarding;
			if (ob.layout === "wizard") {
				const steps = REQUIRED(model);
				if (key.upArrow) return setCursor((c) => moveWizardCursor(steps, c, -1));
				if (key.downArrow) return setCursor((c) => moveWizardCursor(steps, c, 1));
				if (key.return) {
					const s = steps[Math.min(cursor, steps.length - 1)];
					// Only act on an unsatisfied step — a satisfied one has a `none` action
					// and shows no cursor, so Enter there must stay a silent no-op.
					if (s && !s.satisfied) runStep(s);
					return;
				}
				// Letter accelerators (s / k / a / c) map to a step's primary OR
				// secondary action (e.g. k → paste a Jolli key on the sign-in step).
				const a = actionForKey(ch);
				if (a) runAction(a);
				return;
			}

			// Dashboard: [a] toggles enable (confirm before disabling); [b]/[x] act on
			// the cold-start offer when shown; other accelerators dispatch to their
			// step's action. (`/` command palette is owned by the shell.)
			if (ch === "a" && model.enabled) {
				setPending(true);
				return;
			}
			if (offer) {
				if (ch === "b") return runBackfillOffer();
				if (ch === "x") return dismissBackfillOffer();
			}
			const a = actionForKey(ch);
			if (a) runAction(a);
		},
		{ isActive: active },
	);

	if (error)
		return (
			<Box flexDirection="column">
				<Text color="red">Failed to load: {error}</Text>
				<Text dimColor>[r] retry · [q] quit — retrying automatically…</Text>
			</Box>
		);
	if (!model) return <Text dimColor>loading…</Text>;
	return (
		<HomeView
			model={model}
			state={{
				cursor,
				capturingKind,
				inputValue: inputValue ?? "",
				busyLabel,
				statusLine,
				pending,
				binding,
				offer,
			}}
		/>
	);
}

/** Pure model + view-state → Ink tree. Snapshot-tested directly. */
export function HomeView({ model, state }: { model: HomeModel; state: HomeViewState }): ReactElement {
	return model.onboarding.layout === "wizard" ? (
		<WizardView model={model} state={state} />
	) : (
		<DashboardView model={model} state={state} />
	);
}

function CaptureLine({ kind, value }: { kind: "jolli" | "anthropic"; value: string }): ReactElement {
	return (
		<Text>
			{"   "}
			{kind === "jolli" ? "Jolli" : "Anthropic"} API Key: {"•".repeat(value.length)}
			<Text color="cyan">▏</Text>
			{"   "}
			<Text dimColor>[Enter] save · [Esc] cancel</Text>
		</Text>
	);
}

function Spinner({ label, statusLine }: { label: string; statusLine: string | null }): ReactElement {
	return (
		<Box flexDirection="column">
			<Text color="yellow">
				{"   "}
				{SPINNER} {label}
			</Text>
			{statusLine && (
				<Text dimColor>
					{"   "}
					{statusLine}
				</Text>
			)}
		</Box>
	);
}

/** The last action's outcome line, rendered only once the spinner is gone
 *  (`busyLabel` cleared). While busy it lives inside the Spinner; after an action
 *  completes it is an `error: …` string on failure (red) or a `✓ …` confirmation
 *  on a success whose result isn't otherwise visible (green, auto-fading) — so
 *  this is the path that surfaces a failed OR silent sign-in / key save / sync. */
function OutcomeLine({ state }: { state: HomeViewState }): ReactElement | null {
	if (state.busyLabel || !state.statusLine) return null;
	const isError = state.statusLine.startsWith("error:");
	return (
		<Box marginTop={1}>
			<Text color={isError ? "red" : "green"}>
				{"   "}
				{state.statusLine}
			</Text>
		</Box>
	);
}

function WizardView({ model, state }: { model: HomeModel; state: HomeViewState }): ReactElement {
	const required = model.onboarding.steps.filter((s) => s.cls === "required");
	const done = required.filter((s) => s.satisfied).length;
	const stepNo = Math.min(done + 1, required.length);
	const tagline = stepNo < required.length ? "let's get you set up" : "almost there";
	const passive = model.onboarding.steps.find((s) => s.cls === "passive");
	const optional = model.onboarding.steps.find((s) => s.cls === "optional");

	return (
		<Box flexDirection="column">
			<Text>
				<Text bold>Welcome to Jolli Memory</Text>
				<Text dimColor> · </Text>
				{model.repo} <Text dimColor>·</Text> {model.branch}
			</Text>
			<Box marginTop={1}>
				<Text dimColor>
					Step {stepNo} of {required.length} — {tagline}
				</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{required.map((s, i) => {
					const isCursor = i === state.cursor && !s.satisfied;
					const marker = s.satisfied ? "✓" : isCursor ? "▸" : " ";
					return (
						<Box key={s.id} flexDirection="column">
							<Text>
								{"   "}
								<Text color={s.satisfied ? "green" : isCursor ? "cyan" : undefined}>
									{marker} {s.label}
								</Text>
								{s.satisfied && s.detail ? <Text dimColor> · {s.detail}</Text> : null}
							</Text>
							{!s.satisfied && (
								<Text dimColor>
									{"       "}
									{s.detail}
								</Text>
							)}
							{isCursor && state.busyLabel ? (
								<Spinner label={state.busyLabel} statusLine={state.statusLine} />
							) : isCursor && state.capturingKind ? (
								<CaptureLine kind={state.capturingKind} value={state.inputValue} />
							) : isCursor && s.actionKey ? (
								<Text>
									{"       "}
									<Text color="cyan">[Enter] {actionVerb(s)}</Text>
									{s.altHint ? <Text dimColor> · {s.altHint}</Text> : null}
								</Text>
							) : null}
						</Box>
					);
				})}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>
					{passive ? `next: ${passive.detail}` : ""}
					{optional ? ` · optional: ${optional.label}` : ""}
				</Text>
			</Box>
			<OutcomeLine state={state} />
			{/* Key hints (↑↓ move · Enter do it · q later) live in the shell StatusBar. */}
		</Box>
	);
}

/** Short imperative for a step's Enter action, for the "[Enter] …" hint. */
function actionVerb(step: SetupStep): string {
	switch (step.action.kind) {
		case "signin":
			return "sign in to Jolli";
		case "enter-anthropic-key":
			return "enter an Anthropic key";
		case "switch-provider":
			return "switch to Jolli";
		case "enable":
			return "enable";
		case "cloud-sync":
			return "check / bind Jolli Space";
		default:
			return "";
	}
}

/** Fixed label column so every value lines up at the same x, whatever the label
 *  length — the dashboard read as ragged/messy before this. */
const LABEL_W = 10;
function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<Box>
			<Box width={LABEL_W}>
				<Text dimColor>{label}</Text>
			</Box>
			<Text>{children}</Text>
		</Box>
	);
}

/** The Sync row's binding status. Reads the local Space-binding cache (via
 *  `state.binding`); there is no reliable "last sync" timestamp to show (the
 *  push path records none), so the row reports the binding — which the `[c]`
 *  action actually changes — instead of a perpetually-"never" clock. A bound,
 *  pushable Space syncs automatically (on commit and pre-push), so that normal
 *  case needs no suffix; only the read-only exception is called out. */
function SpaceStatus({ binding }: { binding: SpaceBinding | null }): ReactElement {
	if (!binding) return <Text dimColor>not bound</Text>;
	return (
		<>
			<Text>Space "{binding.spaceName}"</Text>
			{binding.canPush === false && <Text dimColor> · read-only, won't sync</Text>}
		</>
	);
}

function DashboardView({ model, state }: { model: HomeModel; state: HomeViewState }): ReactElement {
	// The Space row's `[c]` action is dual-purpose: `cloud-sync` binds / re-checks
	// when a Jolli key exists, `signin` starts browser login when it doesn't (a
	// generate-capable but signed-out user — otherwise the dashboard offers no way
	// to reach the cloud/sync path at all). Both render the `[c]` affordance.
	const syncActionKind = model.onboarding.steps.find((s) => s.id === "cloud-sync")?.action.kind;
	const canSync = syncActionKind === "cloud-sync" || syncActionKind === "signin";
	const listening =
		model.onboarding.steps.find((s) => s.id === "first-memory")?.satisfied === true
			? "Jolli is listening — last memory saved."
			: "Jolli is listening — your next commit is your first memory";
	return (
		<Box flexDirection="column">
			<Field label="Repo">
				{model.repo} <Text dimColor>·</Text> {model.branch}
			</Field>
			<Field label="Status">
				<Text color={model.enabled ? "green" : "red"}>{model.enabled ? "● enabled" : "○ disabled"}</Text>
			</Field>
			<Field label="Sign-in">
				<Text color={model.signedIn ? "green" : "red"}>
					{model.signedIn ? "✓ " : "✗ "}
					{model.signInLabel}
				</Text>
			</Field>
			{/* Space sits with Sign-in: both are cloud-account state (Space binding
			    depends on being signed in), distinct from the local live-activity row. */}
			<Field label="Space">
				<SpaceStatus binding={state.binding} />
				{canSync && (
					<>
						<Text dimColor> · </Text>
						<Text color="cyan">[c]</Text>
						<Text dimColor>
							{" "}
							{syncActionKind === "signin"
								? "sign in to Jolli"
								: state.binding
									? "re-check binding"
									: "bind a Jolli Space"}
						</Text>
					</>
				)}
			</Field>
			<Box marginTop={1} flexDirection="column">
				<Field label="Activity">
					<Text dimColor>Summary </Text>
					{model.summaryLabel}
					<Text dimColor> · Ingest </Text>
					{model.ingestLabel}
					<Text dimColor> · Queue </Text>
					{model.queueLabel}
				</Field>
			</Box>
			{state.busyLabel ? (
				<Box marginTop={1}>
					<Spinner label={state.busyLabel} statusLine={state.statusLine} />
				</Box>
			) : (
				<Box marginTop={1}>
					<Text color="green">✓ {listening}</Text>
				</Box>
			)}
			{/* Cold-start offer: only while idle (a live build already shows the spinner
			    above). The TUI-native successor to the old front-door backfill prompt. */}
			{!state.busyLabel && state.offer && <BackfillOfferRow offer={state.offer} />}
			{state.pending && <Text color="yellow">Disable Jolli Memory for this repo? [y/n]</Text>}
			<OutcomeLine state={state} />
			{/* Command palette + key hints are owned by the shell (StatusBar `[/] cmds`). */}
		</Box>
	);
}

/** The cold-start back-fill offer row: N recent commits lack a memory, with the
 *  `[b] build` / `[x] don't ask` affordances (keys handled in HomeScreen). */
function BackfillOfferRow({ offer }: { offer: BackfillOffer }): ReactElement {
	const n = offer.commits.length;
	const noun = n === 1 ? "commit" : "commits";
	return (
		<Box marginTop={1} flexDirection="column">
			<Text>
				<Text color="magenta">✨ </Text>
				{offer.hasMemory
					? `${n} recent ${noun} ${n === 1 ? "has" : "have"} no memory yet`
					: `This repo has no memories yet — ${n} recent ${noun} can become ${n === 1 ? "one" : "memories"}`}
				{offer.capped ? <Text dimColor> (most recent {n})</Text> : null}
			</Text>
			<Text>
				{"   "}
				<Text color="cyan">[b]</Text>
				<Text dimColor> build {noun}</Text>
				<Text dimColor> · </Text>
				<Text color="cyan">[x]</Text>
				<Text dimColor> don't ask again</Text>
			</Text>
		</Box>
	);
}
