/**
 * HomeSnapshot — the PURE data mapping behind the Home screen. Both the interactive `HomeScreen` (Ink) and the non-interactive `jolli --once`
 * path build the same `HomeModel` from here, so they can never drift. No Ink,
 * no I/O — just status/queue/plugin inputs → a flat view model (+ a plain-text
 * renderer for `--once`).
 */

import type { IngestPhaseLabel } from "../../core/LiveStatus.js";
import { resolveLlmCredentialSource } from "../../core/LlmClient.js";
import type { QueueStatus } from "../../core/QueueStatus.js";
import type { InstalledSkill } from "../../install/SkillInstaller.js";
import type { PluginDiagnostic } from "../../PluginLoader.js";
import type { JolliMemoryConfig, StatusInfo } from "../../Types.js";
import { buildOnboardingModel, credentialLabel, type OnboardingModel, siteHost } from "./OnboardingModel.js";
import type { TuiDeps, TuiIdentity } from "./TuiDeps.js";

/** The config subset the Home model needs (auth + provider + site). */
export type HomeConfig = Pick<JolliMemoryConfig, "apiKey" | "jolliApiKey" | "aiProvider" | "jolliUrl">;

export interface HomeSource {
	readonly name: string;
	readonly on: boolean;
}

export interface HomePlugin {
	readonly name: string;
	readonly state: PluginDiagnostic["state"];
	readonly installHint: string;
}

export interface HomeModel {
	readonly repo: string;
	readonly branch: string;
	readonly enabled: boolean;
	readonly lastSyncLabel: string;
	/** Status sub-items (merged from the former Queue view). */
	readonly summaryLabel: string;
	readonly ingestLabel: string;
	readonly queueLabel: string;
	readonly sources: HomeSource[];
	readonly hostsDetected: number;
	readonly hostsTotal: number;
	readonly skills: HomeSource[];
	readonly plugins: HomePlugin[];
	/** Auth / credential summary (new rows on the dashboard, and `--once`). */
	readonly signedIn: boolean;
	readonly signInLabel: string;
	readonly credentialLabel: string;
	/** Guided-setup model driving wizard vs dashboard and the step list. */
	readonly onboarding: OnboardingModel;
}

/** "3m ago" / "never" from an ISO timestamp. */
function relTimeAgo(iso: string | null, now: number): string {
	if (!iso) return "never";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "never";
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/** A source is "on" when its host is detected and not explicitly disabled. */
function srcOn(detected: boolean | undefined, enabled: boolean | undefined): boolean {
	return detected === true && enabled !== false;
}

/** Summary-generation state (worker lock + queue). */
function summaryLabel(q: QueueStatus): string {
	if (q.workerBusy) return q.active > 0 ? `generating (${q.active} queued)` : "generating";
	if (q.active > 0) return `queued (${q.active})`;
	return "idle";
}

/** Wiki/graph ingest state. */
function ingestLabel(ingest: { busy: boolean; phase: IngestPhaseLabel }): string {
	return ingest.busy ? `building ${ingest.phase ?? "wiki"}…` : "idle";
}

/** Git-op queue drain state. */
function queueDetail(q: QueueStatus): string {
	const base = q.drained ? "drained" : `${q.active} active`;
	return q.stale > 0 ? `${base} · ${q.stale} stale` : base;
}

export function buildHomeModel(
	identity: TuiIdentity,
	status: StatusInfo,
	queue: QueueStatus,
	plugins: PluginDiagnostic[],
	lastSyncAt: string | null = null,
	now: number = Date.now(),
	installedSkills: InstalledSkill[] = [],
	ingest: { busy: boolean; phase: IngestPhaseLabel } = { busy: false, phase: null },
	authToken: string | undefined = undefined,
	config: HomeConfig = {},
): HomeModel {
	// Copilot's single row covers CLI + Chat, so both the row and the count treat
	// it as detected when either signal is present (mirrors StatusCommand). Kept in
	// one variable so the row and the count can never disagree.
	const copilotDetected = (status.copilotDetected ?? false) || (status.copilotChatDetected ?? false);
	const sources: HomeSource[] = [
		{ name: "Claude", on: srcOn(status.claudeDetected, status.claudeEnabled) },
		{ name: "Codex", on: srcOn(status.codexDetected, status.codexEnabled) },
		{ name: "Gemini", on: srcOn(status.geminiDetected, status.geminiEnabled) },
		{ name: "Cursor", on: srcOn(status.cursorDetected, status.cursorEnabled) },
		{ name: "Copilot", on: srcOn(copilotDetected, status.copilotEnabled) },
		{ name: "OpenCode", on: srcOn(status.openCodeDetected, status.openCodeEnabled) },
	];
	// One entry per SOURCE ROW (6), so `hostsDetected/hostsTotal` matches the list.
	const detectedFlags = [
		status.claudeDetected,
		status.codexDetected,
		status.geminiDetected,
		status.cursorDetected,
		status.openCodeDetected,
		copilotDetected,
	];
	const hostsDetected = detectedFlags.filter((d) => d === true).length;
	const signedIn = Boolean(authToken);
	const host = siteHost(config.jolliUrl);
	const onboarding = buildOnboardingModel({
		signedIn,
		config,
		enabled: status.enabled === true,
		summaryCount: status.summaryCount,
	});
	return {
		repo: identity.repo || "(unknown)",
		branch: identity.branch || "(detached)",
		enabled: status.enabled === true,
		lastSyncLabel: relTimeAgo(lastSyncAt, now),
		summaryLabel: summaryLabel(queue),
		ingestLabel: ingestLabel(ingest),
		queueLabel: queueDetail(queue),
		sources,
		hostsDetected,
		hostsTotal: detectedFlags.length,
		skills: installedSkills.map((s) => ({ name: s.name, on: s.targets.length > 0 })),
		plugins: plugins.map((p) => ({ name: p.packageName, state: p.state, installHint: p.installHint })),
		signedIn,
		signInLabel: signedIn ? (host ? `signed in · ${host}` : "signed in") : "not signed in",
		credentialLabel: credentialLabel(resolveLlmCredentialSource(config)),
		onboarding,
	};
}

/**
 * Recomputes ONLY the live "activity" fields (summary / ingest / queue) from
 * cheap sources, keeping every other field of `prev` as-is. The Home screen's
 * ~2.5s poll uses this instead of a full `loadHomeModel`, which would re-run the
 * heavy `getStatus` (session DB scans, git subprocesses) on a timer.
 *
 * `lastSyncLabel` is deliberately NOT refreshed here: the interactive dashboard
 * never renders it (the Sync row shows the Space binding instead — see
 * HomeScreen's SpaceStatus), so polling `getLastSyncAt` every tick would be a
 * wasted disk read. It stays at its initial `loadHomeModel` value, which only
 * the `--once` snapshot consumes.
 */
export function applyLiveStatus(
	prev: HomeModel,
	queue: QueueStatus,
	ingest: { busy: boolean; phase: IngestPhaseLabel },
): HomeModel {
	return {
		...prev,
		summaryLabel: summaryLabel(queue),
		ingestLabel: ingestLabel(ingest),
		queueLabel: queueDetail(queue),
	};
}

/** Loads the four read sources and folds them into a HomeModel. Shared by the
 *  interactive HomeScreen and the `--once` snapshot path. */
export async function loadHomeModel(
	deps: Pick<
		TuiDeps,
		| "getIdentity"
		| "getStatus"
		| "getQueueStatus"
		| "getIngestPhase"
		| "inspectPlugins"
		| "getLastSyncAt"
		| "getInstalledSkills"
		| "loadAuthToken"
		| "loadConfig"
	>,
): Promise<HomeModel> {
	const [identity, status, queue, ingest, plugins, lastSyncAt, skills, authToken, config] = await Promise.all([
		deps.getIdentity(),
		deps.getStatus(),
		deps.getQueueStatus(),
		deps.getIngestPhase(),
		deps.inspectPlugins(),
		deps.getLastSyncAt(),
		deps.getInstalledSkills(),
		deps.loadAuthToken(),
		deps.loadConfig(),
	]);
	return buildHomeModel(identity, status, queue, plugins, lastSyncAt, Date.now(), skills, ingest, authToken, config);
}

/** Plain-text render for `jolli --once` (no ANSI; scriptable). */
export function renderHomeSnapshot(m: HomeModel): string {
	const mark = (on: boolean): string => (on ? "on" : "off");
	const lines: string[] = [];
	lines.push(`Jolli Memory · ${m.repo} · ${m.branch}`);
	lines.push(`Status    ${m.enabled ? "enabled" : "disabled"}   last sync ${m.lastSyncLabel}`);
	lines.push(`  Summary ${m.summaryLabel}   Ingest ${m.ingestLabel}   Queue ${m.queueLabel}`);
	lines.push(`Sign-in   ${m.signInLabel}`);
	lines.push(`Credential ${m.credentialLabel}`);
	lines.push(`Sources   ${m.sources.map((s) => `${s.name}:${mark(s.on)}`).join("  ")}`);
	lines.push(`Hosts     ${m.hostsDetected}/${m.hostsTotal} detected`);
	// `m.skills` always carries one row per MANAGED skill (installed or not), so the
	// snapshot reports which are actually installed — listing every managed skill as
	// `off` would read as "a skill set exists here". Filter to the installed ones;
	// `(none)` when nothing is installed.
	const installedSkills = m.skills.filter((s) => s.on);
	lines.push(`Skills    ${installedSkills.length === 0 ? "(none)" : installedSkills.map((s) => s.name).join("  ")}`);
	lines.push(
		`Plugins   ${m.plugins.length === 0 ? "(none known)" : m.plugins.map((p) => `${p.name}:${p.state}`).join("  ")}`,
	);
	return lines.join("\n");
}
