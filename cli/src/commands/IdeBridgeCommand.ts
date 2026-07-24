/**
 * Hidden JSON bridge used by IDE hosts that cannot import the TypeScript core.
 *
 * VS Code imports `cli/src/**` in-process. IntelliJ runs on the JVM, so it sends
 * one JSON request to `jolli ide-bridge <action>` and reads one JSON response.
 * Keeping every action here makes the CLI implementation the single source of
 * truth while the IntelliJ side remains a process/DTO adapter.
 */

import type { LiveSharePatch, LiveSharePayload } from "../core/JolliShareClient.js";
import { computeWatchTargets } from "../daemon/DaemonServer.js";
import { DaemonWatcher } from "../daemon/DaemonWatcher.js";
import { setLogDir } from "../Logger.js";
import type { ConflictUi, Tier3Pick } from "../sync/ConflictResolver.js";
import type { FileWrite, JolliMemoryConfig, TranscriptSource } from "../Types.js";
import { TRANSCRIPT_SOURCES as ALL_TRANSCRIPT_SOURCES } from "../Types.js";
import { readStdin } from "./CliUtils.js";

type JsonObject = Record<string, unknown>;

// Derived from the SINGLE source of truth in Types.ts so a new transcript
// source (Cline / Devin / Antigravity) becomes acceptable here automatically —
// the pre-fix inline list drifted 7-vs-12 and made transcript/overlay actions
// reject valid sources the aggregator was already emitting.
const TRANSCRIPT_SOURCES: ReadonlySet<TranscriptSource> = new Set(ALL_TRANSCRIPT_SOURCES);

function parseRequest(raw: string): JsonObject {
	if (raw.trim().length === 0) return {};
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Bridge request must be a JSON object.");
	}
	return parsed as JsonObject;
}

// Custom errors carry structured detail (AmbiguousHashError.prefix,
// SyncBackendError.status, ...) that IDE hosts render as part of the failure
// message. The one-shot and long-lived error envelopes both forward primitive
// extras so the two shapes stay identical, but the copier MUST NOT leak a
// credential a caller has stashed on the Error — nothing on the CLI side stops
// a future author from writing `err.jolliApiKey = cfg.jolliApiKey` for context.
// Two barriers below, either drops the field:
//   1. key name matches a common secret naming pattern
//      (api-key / token / secret / password / credential / authorization),
//   2. string value looks like a Jolli API key or a JWT.
// Non-string primitives are safe from #2 but still pass #1.
const SENSITIVE_ERROR_KEY_PATTERN = /api[-_]?key|token|secret|password|passwd|credential|authorization|bearer/i;
const SENSITIVE_ERROR_VALUE_PATTERN = /^(?:sk-jol-|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$)/;

function copyPrimitiveErrorFields(error: unknown, data: Record<string, unknown>): void {
	if (typeof error !== "object" || error === null) return;
	for (const [key, value] of Object.entries(error)) {
		if (key === "name" || key === "message" || key === "stack") continue;
		if (SENSITIVE_ERROR_KEY_PATTERN.test(key)) continue;
		if (typeof value === "string") {
			if (SENSITIVE_ERROR_VALUE_PATTERN.test(value)) continue;
			data[key] = value;
		} else if (typeof value === "number" || typeof value === "boolean") {
			data[key] = value;
		}
	}
}

function stringField(request: JsonObject, key: string): string {
	const value = request[key];
	if (typeof value !== "string") throw new Error(`Request field "${key}" must be a string.`);
	return value;
}

function optionalString(request: JsonObject, key: string): string | undefined {
	const value = request[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`Request field "${key}" must be a string.`);
	return value;
}

function stringArrayField(request: JsonObject, key: string): string[] {
	const value = request[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Request field "${key}" must be an array of strings.`);
	}
	return value;
}

function numberField(request: JsonObject, key: string): number {
	const value = request[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Request field "${key}" must be a finite number.`);
	}
	return value;
}

function optionalNumberField(request: JsonObject, key: string, fallback: number): number {
	const value = request[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Request field "${key}" must be a finite number.`);
	}
	return value;
}

export interface IdeBridgeConflictDetail {
	readonly path: string;
	readonly ours: string | null;
	readonly theirs: string | null;
}

/** Conflict UI that records prompt data for the IDE and replays IDE-selected choices on the next bridge call. */
export class IdeBridgeConflictUi implements ConflictUi {
	readonly details: IdeBridgeConflictDetail[] = [];
	private readonly seen = new Set<string>();

	constructor(private readonly choices: Readonly<Record<string, "mine" | "theirs">>) {}

	async promptBinaryPick(path: string, ours: string | null, theirs: string | null): Promise<Tier3Pick> {
		const choice = this.choices[path];
		if (choice === "mine" || choice === "theirs") return choice;
		if (!this.seen.has(path)) {
			this.seen.add(path);
			this.details.push({ path, ours, theirs });
		}
		return "skip";
	}
}

function conflictChoices(request: JsonObject): Record<string, "mine" | "theirs"> {
	const raw = request.conflictChoices;
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error('Request field "conflictChoices" must be an object.');
	}
	const choices: Record<string, "mine" | "theirs"> = {};
	for (const [path, value] of Object.entries(raw)) {
		if (value !== "mine" && value !== "theirs") {
			throw new Error(`Conflict choice for "${path}" must be "mine" or "theirs".`);
		}
		choices[path] = value;
	}
	return choices;
}

async function runStorageAction(cwd: string, request: JsonObject): Promise<unknown> {
	const { createStorage } = await import("../core/StorageFactory.js");
	const storage = await createStorage(cwd, cwd);
	const operation = stringField(request, "operation");
	switch (operation) {
		case "read":
			return { content: await storage.readFile(stringField(request, "path")) };
		case "list":
			return { paths: await storage.listFiles(stringField(request, "prefix")) };
		case "exists":
			return { exists: await storage.exists() };
		case "ensure":
			await storage.ensure();
			return { ok: true };
		case "write": {
			const files = request.files;
			if (!Array.isArray(files)) throw new Error('Request field "files" must be an array.');
			await storage.writeFiles(files as FileWrite[], stringField(request, "message"));
			return { ok: true };
		}
		default:
			throw new Error(`Unknown storage operation "${operation}".`);
	}
}

async function runConversationOverlayAction(cwd: string, request: JsonObject): Promise<unknown> {
	const source = stringField(request, "source") as TranscriptSource;
	if (!TRANSCRIPT_SOURCES.has(source)) throw new Error(`Unknown transcript source "${source}".`);
	const sessionId = stringField(request, "sessionId");
	const operation = stringField(request, "operation");
	if (operation === "hide") {
		const { hideConversation } = await import("../core/HiddenConversationsStore.js");
		await hideConversation(cwd, source, sessionId);
		return { ok: true };
	}
	const overlayStore = await import("../core/ConversationOverlayStore.js");
	const key = { projectDir: cwd, source, sessionId };
	if (operation === "view") {
		if (!Array.isArray(request.entries)) throw new Error('Request field "entries" must be an array.');
		const entries = request.entries as Parameters<typeof overlayStore.applyOverlay>[0];
		const overlay = await overlayStore.loadOverlay(key);
		return {
			overlay,
			displayed: overlayStore.applyOverlay(entries, overlay),
			rawWithDeletesOnly: overlayStore.applyDeletes(entries, overlay),
		};
	}
	if (operation === "merge-save") {
		if (!Array.isArray(request.deletes) || !Array.isArray(request.edits)) {
			throw new Error('Request fields "deletes" and "edits" must be arrays.');
		}
		const existing = await overlayStore.loadOverlay(key);
		const merged = overlayStore.mergeOverlay(existing, {
			deletes: request.deletes as Parameters<typeof overlayStore.mergeOverlay>[1]["deletes"],
			edits: request.edits as Parameters<typeof overlayStore.mergeOverlay>[1]["edits"],
		});
		return overlayStore.saveOverlay(key, merged);
	}
	throw new Error(`Unknown conversation-overlay operation "${operation}".`);
}

async function runSessionStateAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const tracker = await import("../core/SessionTracker.js");
	switch (operation) {
		case "global-config-dir":
			return { path: tracker.getGlobalConfigDir() };
		case "notes-dir": {
			const { join } = await import("node:path");
			const { getJolliMemoryDir } = await import("../Logger.js");
			return { path: join(getJolliMemoryDir(cwd), "notes") };
		}
		case "config-load": {
			const dir = optionalString(request, "dir");
			return dir ? tracker.loadConfigFromDir(dir) : tracker.loadConfig();
		}
		case "config-save": {
			const config = request.config as Partial<JolliMemoryConfig> | undefined;
			if (!config || typeof config !== "object") throw new Error('Request field "config" must be an object.');
			const dir = optionalString(request, "dir") ?? tracker.getGlobalConfigDir();
			await tracker.saveConfigScoped(config, dir);
			return { ok: true };
		}
		case "plans-load":
			return tracker.loadPlansRegistry(cwd);
		case "plans-save":
			await tracker.savePlansRegistry(request.registry as Parameters<typeof tracker.savePlansRegistry>[0], cwd);
			return { ok: true };
		case "worker-busy": {
			const { getWorkerBusyState } = await import("../core/Locks.js");
			return getWorkerBusyState(cwd);
		}
		case "acquire-lock": {
			// Hold `plans.lock` on behalf of a two-phase IDE caller (Kotlin
			// TranscriptReferenceDiscovery does load → mutate → save across three
			// bridge calls and needs a shared mutex against the CLI's own
			// StopHook / QueueWorker / Codex-tick writers, which all wrap their
			// RMW in `withPlansLock`). The daemon process (this bridge) becomes
			// the PID recorded in the lock file, so releaseIfOwned in the
			// paired release-lock call correctly matches ownership.
			//
			// Concurrent acquire-lock calls to the SAME daemon+cwd serialize:
			// `isPidAlive` short-circuits when the recorded PID is the daemon's
			// own, so the second caller polls until the first releases (or the
			// caller-supplied timeout fires). That is the intended behaviour —
			// the same rule as `withPlansLock`'s "MUST NOT be nested".
			const { join } = await import("node:path");
			const { mkdir } = await import("node:fs/promises");
			const { getJolliMemoryDir } = await import("../Logger.js");
			const { acquireWithPoll } = await import("../core/LockPrimitives.js");
			const { PLANS_LOCK_FILE, DEFAULT_PLANS_LOCK_TIMEOUT_MS, DEFAULT_PLANS_LOCK_POLL_MS } = await import(
				"../core/Locks.js"
			);
			const dir = getJolliMemoryDir(cwd);
			await mkdir(dir, { recursive: true });
			const lockPath = join(dir, PLANS_LOCK_FILE);
			const timeoutMs = optionalNumberField(request, "timeoutMs", DEFAULT_PLANS_LOCK_TIMEOUT_MS);
			const pollMs = optionalNumberField(request, "pollMs", DEFAULT_PLANS_LOCK_POLL_MS);
			const acquired = await acquireWithPoll(lockPath, { timeoutMs, pollMs });
			return { acquired };
		}
		case "release-lock": {
			// PID-checked release — the paired acquire-lock recorded this
			// daemon's PID, so releaseIfOwned matches and removes the file.
			// A stray release from a caller that never acquired (or whose
			// acquire returned false) becomes a safe no-op because a
			// different-PID owner short-circuits the delete.
			const { join } = await import("node:path");
			const { getJolliMemoryDir } = await import("../Logger.js");
			const { releaseIfOwned } = await import("../core/LockPrimitives.js");
			const { PLANS_LOCK_FILE } = await import("../core/Locks.js");
			const lockPath = join(getJolliMemoryDir(cwd), PLANS_LOCK_FILE);
			await releaseIfOwned(lockPath, PLANS_LOCK_FILE);
			return { ok: true };
		}
		case "save-plugin-source":
			await tracker.savePluginSource(cwd);
			return { ok: true };
		case "save-squash-pending":
			await tracker.saveSquashPending(
				stringArrayField(request, "sourceHashes"),
				stringField(request, "expectedParentHash"),
				cwd,
			);
			return { ok: true };
		default:
			throw new Error(`Unknown session-state operation "${operation}".`);
	}
}

async function runAuthAction(request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const auth = await import("../auth/AuthConfig.js");
	switch (operation) {
		case "site-url":
			return { url: auth.getJolliUrl() };
		case "is-signed-in":
			return { signedIn: Boolean(await auth.loadAuthToken()) };
		case "parse-api-key": {
			const { parseJolliApiKey } = await import("../core/JolliApiUtils.js");
			return { meta: parseJolliApiKey(stringField(request, "apiKey")) };
		}
		case "validate-api-key": {
			const { validateJolliApiKey } = await import("../core/JolliApiUtils.js");
			validateJolliApiKey(stringField(request, "apiKey"));
			return { ok: true };
		}
		case "assert-origin": {
			const { assertJolliOriginAllowed } = await import("../core/JolliApiUtils.js");
			assertJolliOriginAllowed(stringField(request, "origin"));
			return { ok: true };
		}
		case "should-request-fresh":
			return {
				fresh: auth.shouldRequestFreshApiKey(
					optionalString(request, "existingKey"),
					stringField(request, "jolliUrl"),
				),
			};
		case "build-login-url": {
			const url = new URL("/login", stringField(request, "jolliUrl"));
			url.searchParams.set("cli_callback", stringField(request, "callbackUrl"));
			url.searchParams.set("client", "intellij");
			url.searchParams.set("client_version", stringField(request, "clientVersion"));
			if (request.generateApiKey === true) url.searchParams.set("generate_api_key", "true");
			const installId = optionalString(request, "installId");
			if (installId) url.searchParams.set("install_id", installId);
			return { url: url.toString() };
		}
		case "exchange-and-save": {
			const jolliUrl = stringField(request, "jolliUrl");
			const { exchangeCliCode } = await import("../auth/CliExchange.js");
			const exchanged = await exchangeCliCode(jolliUrl, stringField(request, "code"));
			await auth.saveAuthCredentials({
				token: exchanged.token,
				jolliUrl: auth.resolveSignInJolliUrl(exchanged.jolliApiKey, jolliUrl),
				...(exchanged.jolliApiKey ? { jolliApiKey: exchanged.jolliApiKey } : {}),
			});
			return exchanged;
		}
		case "save-legacy-credentials": {
			const jolliUrl = stringField(request, "jolliUrl");
			const apiKey = optionalString(request, "jolliApiKey");
			await auth.saveAuthCredentials({
				token: stringField(request, "token"),
				jolliUrl: auth.resolveSignInJolliUrl(apiKey, jolliUrl),
				...(apiKey ? { jolliApiKey: apiKey } : {}),
			});
			return { ok: true };
		}
		case "sign-out":
			await auth.clearAuthCredentials();
			return { ok: true };
		default:
			throw new Error(`Unknown auth operation "${operation}".`);
	}
}

async function runJolliApiAction(_cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	if (operation === "serialize-summary") {
		const { serializeSummaryJson } = await import("../core/JolliMemoryPushOrchestrator.js");
		return { json: serializeSummaryJson(request.summary as Parameters<typeof serializeSummaryJson>[0]) ?? null };
	}
	const apiKey = stringField(request, "apiKey");
	const baseUrl = optionalString(request, "baseUrl");
	const { JolliMemoryPushClient } = await import("../core/JolliMemoryPushClient.js");
	const client = new JolliMemoryPushClient({ baseUrlOverride: baseUrl, apiKeyProvider: async () => apiKey });
	switch (operation) {
		case "push":
			return client.push(request.payload as Parameters<typeof client.push>[0]);
		case "delete":
			await client.deleteDoc(numberField(request, "docId"));
			return { ok: true };
		case "list-spaces":
			return client.listSpaces();
		case "create-binding":
			return client.createBinding({
				repoUrl: stringField(request, "repoUrl"),
				repoName: stringField(request, "repoName"),
				jmSpaceId: numberField(request, "jmSpaceId"),
			});
		case "create-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return new JolliShareClient(apiKey, baseUrl).create(request.payload as LiveSharePayload);
		}
		case "update-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return new JolliShareClient(apiKey, baseUrl).update(
				stringField(request, "shareId"),
				request.patch as LiveSharePatch,
			);
		}
		case "revoke-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			await new JolliShareClient(apiKey, baseUrl).revoke(stringField(request, "shareId"));
			return { ok: true };
		}
		case "invite-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return new JolliShareClient(apiKey, baseUrl).invite(
				stringField(request, "shareId"),
				stringArrayField(request, "recipients"),
				optionalString(request, "message"),
			);
		}
		case "list-org-members": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return { members: await new JolliShareClient(apiKey, baseUrl).listOrgMembers() };
		}
		default:
			throw new Error(`Unknown Jolli API operation "${operation}".`);
	}
}

async function currentPinGroup(cwd: string): Promise<{ repoName: string; branch: string }> {
	const [{ getCanonicalRepoUrl, deriveRepoNameFromUrl }, { getCurrentBranch, getProjectRootDir }, path] =
		await Promise.all([import("../core/GitRemoteUtils.js"), import("../core/GitOps.js"), import("node:path")]);
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const root = await getProjectRootDir(cwd).catch(() => cwd);
	return {
		repoName: repoUrl ? deriveRepoNameFromUrl(repoUrl) : path.basename(root),
		branch: await getCurrentBranch(cwd),
	};
}

function pinKind(kind: string): "conversation" | "plan" | "note" | "memory" | "reference" {
	const normalized =
		(
			{
				conversations: "conversation",
				plans: "plan",
				notes: "note",
				memories: "memory",
				references: "reference",
			} as const
		)[kind as "conversations" | "plans" | "notes" | "memories" | "references"] ?? kind;
	if (["conversation", "plan", "note", "memory", "reference"].includes(normalized)) {
		return normalized as "conversation" | "plan" | "note" | "memory" | "reference";
	}
	throw new Error(`Unknown pin kind "${kind}".`);
}

async function runSharedStoreAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	if (operation.startsWith("pins-")) {
		const pins = await import("../core/PinStore.js");
		const group = await currentPinGroup(cwd);
		if (operation === "pins-read") return { pins: await pins.listPins(cwd, group.repoName, group.branch) };
		const kind = pinKind(stringField(request, "kind"));
		const id = stringField(request, "key");
		if (operation === "pins-add") {
			const badge = optionalString(request, "badge");
			// Prefer an explicit "source" from the caller; fall back to the badge for
			// conversation pins so IntelliJ hosts that only pass a source-derived
			// badge keep populating PinEntry.source without extra plumbing.
			const source = optionalString(request, "source") ?? (kind === "conversation" ? badge : undefined);
			const transcriptPath = optionalString(request, "transcriptPath");
			await pins.addPin(cwd, group.repoName, group.branch, {
				kind,
				id,
				title: stringField(request, "title"),
				pinnedAt: Date.now(),
				...(badge !== undefined ? { badge } : {}),
				...(source !== undefined ? { source } : {}),
				...(transcriptPath !== undefined ? { transcriptPath } : {}),
			});
			return { ok: true };
		}
		if (operation === "pins-remove") {
			await pins.removePin(cwd, group.repoName, group.branch, kind, id);
			return { ok: true };
		}
	}
	if (operation.startsWith("selection-")) {
		const selection = await import("../core/CommitSelectionStore.js");
		if (operation === "selection-read") {
			const value = await selection.readExclusions(cwd);
			return {
				conversations: [...value.conversations],
				plans: [...value.plans],
				notes: [...value.notes],
				references: [...value.references],
			};
		}
		if (operation === "selection-key") {
			return {
				key: selection.conversationKey(
					stringField(request, "source") as TranscriptSource,
					stringField(request, "sessionId"),
				),
			};
		}
		const kind = stringField(request, "kind") as Parameters<typeof selection.setExcluded>[1];
		if (operation === "selection-set") {
			await selection.setExcluded(cwd, kind, stringField(request, "key"), request.excluded === true);
			return { ok: true };
		}
		if (operation === "selection-set-all") {
			await selection.setAllExcluded(cwd, kind, stringArrayField(request, "keys"), request.excluded === true);
			return { ok: true };
		}
	}
	if (operation.startsWith("branch-share-")) {
		const shares = await import("../core/BranchShareStore.js");
		const branch = stringField(request, "branch");
		const commitHash = optionalString(request, "commitHash");
		if (operation === "branch-share-put") {
			await shares.putBranchShare(
				cwd,
				branch,
				request.record as Parameters<typeof shares.putBranchShare>[2],
				commitHash,
			);
			return { ok: true };
		}
		if (operation === "branch-share-remove") {
			await shares.removeShare(cwd, branch, commitHash);
			return { ok: true };
		}
		if (operation === "branch-share-get") {
			const [{ loadConfig }, { deriveJolliBackendKey, parseJolliApiKey }] = await Promise.all([
				import("../core/SessionTracker.js"),
				import("../core/JolliApiUtils.js"),
			]);
			const key = (await loadConfig()).jolliApiKey;
			const backendKey = deriveJolliBackendKey(key ? parseJolliApiKey(key)?.u : undefined);
			return { record: (await shares.getShare(cwd, branch, backendKey, commitHash)) ?? null };
		}
	}
	if (operation === "push-pending-hashes") {
		const { loadPushPending } = await import("../core/PushPendingStore.js");
		return { hashes: Object.keys((await loadPushPending(cwd)).entries) };
	}
	if (operation === "repo-profile-read") {
		const { readRepoProfile } = await import("../core/RepoProfile.js");
		return { profile: await readRepoProfile(cwd) };
	}
	if (operation === "repo-profile-set-backfill-dismissed") {
		if (typeof request.dismissed !== "boolean") {
			throw new Error('Request field "dismissed" must be a boolean.');
		}
		const { updateRepoProfile } = await import("../core/RepoProfile.js");
		await updateRepoProfile(cwd, { backfillDismissed: request.dismissed });
		return { ok: true };
	}
	if (operation === "summary-markdown") {
		const { buildMarkdown } = await import("../core/SummaryMarkdownBuilder.js");
		return { markdown: buildMarkdown(request.summary as Parameters<typeof buildMarkdown>[0]) };
	}
	if (operation === "summary-pr-markdown") {
		const { buildPrMarkdown } = await import("../core/SummaryPrMarkdownBuilder.js");
		return { markdown: buildPrMarkdown(request.summary as Parameters<typeof buildPrMarkdown>[0]) };
	}
	if (operation === "pr-wrap-markdown") {
		const { wrapWithMarkers } = await import("../core/PrDescription.js");
		return { markdown: wrapWithMarkers(stringField(request, "markdown")) };
	}
	if (operation === "pr-replace-markdown") {
		const { replaceSummaryInBody } = await import("../core/PrDescription.js");
		return {
			body: replaceSummaryInBody(stringField(request, "currentBody"), stringField(request, "markdown")),
		};
	}
	if (operation === "reference-push-presentation") {
		if (typeof request.reference !== "object" || request.reference === null || Array.isArray(request.reference)) {
			throw new Error('Request field "reference" must be an object.');
		}
		const [{ buildReferencePushTitle }, { buildReferencePushMarkdown }, references] = await Promise.all([
			import("../core/SummaryFormat.js"),
			import("../core/SummaryMarkdownBuilder.js"),
			import("../core/references/ReferenceStore.js"),
		]);
		const reference = request.reference as Parameters<typeof buildReferencePushMarkdown>[0];
		const storedMarkdown = optionalString(request, "storedMarkdown");
		const description = storedMarkdown
			? (references.readReferenceMarkdownFromString(storedMarkdown)?.description ?? undefined)
			: undefined;
		return {
			title: buildReferencePushTitle(reference),
			markdown: buildReferencePushMarkdown(reference, description),
		};
	}
	throw new Error(`Unknown shared-store operation "${operation}".`);
}

async function runSummaryStoreAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const [summaries, { createStorage }] = await Promise.all([
		import("../core/SummaryStore.js"),
		import("../core/StorageFactory.js"),
	]);
	const storage = await createStorage(cwd, cwd);
	switch (operation) {
		case "index":
			return summaries.getIndex(cwd, storage);
		case "get":
			return summaries.getSummary(stringField(request, "commitHash"), cwd, storage);
		case "list":
			return summaries.listSummaries(optionalNumberField(request, "count", 10), cwd, storage);
		case "count":
			return { count: await summaries.getSummaryCount(cwd, storage) };
		case "find-root": {
			const index = await summaries.getIndex(cwd, storage);
			if (!index) return { hash: null };
			const requested = stringField(request, "commitHash");
			const resolved = index.commitAliases?.[requested] ?? requested;
			const entries = new Map(index.entries.map((entry) => [entry.commitHash, entry]));
			let current = entries.get(resolved);
			if (!current) return { hash: null };
			while (current.parentCommitHash !== null && current.parentCommitHash !== undefined) {
				const parent = entries.get(current.parentCommitHash);
				if (!parent) break;
				current = parent;
			}
			return { hash: current.commitHash };
		}
		case "filter-hashes": {
			const index = await summaries.getIndex(cwd, storage);
			const available = new Set(index?.entries.map((entry) => entry.commitHash) ?? []);
			for (const alias of Object.keys(index?.commitAliases ?? {})) available.add(alias);
			return { hashes: stringArrayField(request, "hashes").filter((hash) => available.has(hash)) };
		}
		case "scan-aliases":
			return {
				changed: await summaries.scanTreeHashAliases(
					stringArrayField(request, "hashes"),
					cwd,
					storage,
					storage,
				),
			};
		case "resolve-alias": {
			const hash = stringField(request, "commitHash");
			const index = await summaries.getIndex(cwd, storage);
			return { hash: index?.commitAliases?.[hash] ?? hash };
		}
		case "store-summary": {
			const summary = request.summary as Parameters<typeof summaries.storeSummary>[0];
			if (!summary || typeof summary !== "object") throw new Error('Request field "summary" must be an object.');
			const transcript = request.transcript;
			const planProgress = request.planProgress;
			const referenceFiles = request.referenceFiles;
			await summaries.storeSummary(
				summary,
				cwd,
				request.force === true,
				{
					...(transcript && typeof transcript === "object"
						? {
								transcript: {
									id: summary.commitHash,
									data: transcript as Parameters<
										typeof summaries.saveTranscriptsBatch
									>[0][number]["data"],
								},
							}
						: {}),
					...(Array.isArray(planProgress)
						? {
								planProgress: planProgress as NonNullable<
									Parameters<typeof summaries.storeSummary>[3]
								>["planProgress"],
							}
						: {}),
					...(Array.isArray(referenceFiles) ? { referenceFiles: referenceFiles as FileWrite[] } : {}),
				},
				storage,
			);
			return { ok: true };
		}
		case "read-plan-progress":
			return summaries.readPlanProgress(stringField(request, "slug"), cwd, storage);
		case "store-files": {
			const files = request.files;
			if (!Array.isArray(files)) throw new Error('Request field "files" must be an array.');
			await storage.writeFiles(files as FileWrite[], stringField(request, "message"));
			return { ok: true };
		}
		case "read-plan":
			return { content: await summaries.readPlanFromBranch(stringField(request, "slug"), cwd, storage) };
		case "write-plan":
			await summaries.storePlans(
				[{ slug: stringField(request, "slug"), content: stringField(request, "content") }],
				stringField(request, "message"),
				cwd,
				undefined,
				storage,
			);
			return { ok: true };
		case "read-reference":
			return {
				content: await summaries.readReferenceFromBranch(
					stringField(request, "source"),
					stringField(request, "archivedKey"),
					cwd,
					storage,
				),
			};
		case "write-reference":
			await summaries.storeReferences(
				[
					{
						source: stringField(request, "source"),
						archivedKey: stringField(request, "archivedKey"),
						content: stringField(request, "content"),
					},
				],
				stringField(request, "message"),
				cwd,
				undefined,
				storage,
			);
			return { ok: true };
		case "transcript-hashes":
			return { hashes: [...(await summaries.getTranscriptHashes(cwd, storage))] };
		case "read-transcript":
			return summaries.readTranscript(stringField(request, "commitHash"), cwd, storage);
		case "write-transcript-batch": {
			const rawWrites = request.writes;
			if (typeof rawWrites !== "object" || rawWrites === null || Array.isArray(rawWrites)) {
				throw new Error('Request field "writes" must be an object.');
			}
			const writes = Object.entries(rawWrites).map(([hash, data]) => ({
				hash,
				data: data as Parameters<typeof summaries.saveTranscriptsBatch>[0][number]["data"],
			}));
			await summaries.saveTranscriptsBatch(writes, stringArrayField(request, "deletes"), cwd, storage);
			return { ok: true };
		}
		default:
			throw new Error(`Unknown summary-store operation "${operation}".`);
	}
}

async function runSummaryTreeAction(request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const summary = request.summary;
	if (!summary || typeof summary !== "object") throw new Error('Request field "summary" must be an object.');
	const tree = await import("../core/SummaryTree.js");
	type Summary = Parameters<typeof tree.aggregateStats>[0];
	const value = summary as Summary;
	const nestedTopics = (topics: ReturnType<typeof tree.collectAllTopics>) =>
		topics.map(({ commitDate, generatedAt: _generatedAt, treeIndex, ...topic }) => ({
			topic,
			commitDate,
			treeIndex,
		}));
	switch (operation) {
		case "analyze":
			return {
				unified: tree.isUnifiedHoistFormat(value),
				allTopics: nestedTopics(tree.collectAllTopics(value)),
				displayTopics: nestedTopics(tree.collectDisplayTopics(value)),
				stats: tree.aggregateStats(value),
				turns: tree.aggregateTurns(value),
				tokens: tree.aggregateConversationTokens(value),
				breakdown: tree.aggregateConversationTokenBreakdown(value),
				estimatedCost: tree.aggregateEstimatedCost(value),
				topicCount: tree.countTopics(value),
				sourceNodes: tree.collectSourceNodes(value),
				leaf: tree.isLeafNode(value),
				durationDays: tree.computeDurationDays(value),
				durationLabel: tree.formatDurationLabel(value),
				// v5-compatible transcript-ID resolution (summary.transcripts with a
				// v3/v4 commit-hash fallback) owned here so IDE clients share one
				// implementation instead of porting the fallback rules per surface.
				transcriptIds: tree.getTranscriptIds(value),
			};
		case "update-topic":
			return tree.updateTopicInTree(
				value,
				numberField(request, "globalIndex"),
				(request.updates ?? {}) as Parameters<typeof tree.updateTopicInTree>[2],
			);
		case "delete-topic":
			return tree.deleteTopicInTree(value, numberField(request, "globalIndex"));
		default:
			throw new Error(`Unknown summary-tree operation "${operation}".`);
	}
}

async function runPlanGroupingAction(request: JsonObject): Promise<unknown> {
	const plans = await import("../core/JolliMemoryPushOrchestrator.js");
	switch (stringField(request, "operation")) {
		case "base-key":
			return { key: plans.planBaseKey(stringField(request, "slug")) };
		case "base-keys":
			return Object.fromEntries(
				stringArrayField(request, "slugs").map((slug) => [slug, plans.planBaseKey(slug)]),
			);
		case "latest": {
			if (!Array.isArray(request.plans)) throw new Error('Request field "plans" must be an array.');
			return plans.latestPlanPerName(request.plans as Parameters<typeof plans.latestPlanPerName>[0]);
		}
		default:
			throw new Error("Unknown plan-grouping operation.");
	}
}

async function runReferenceStoreAction(request: JsonObject): Promise<unknown> {
	const references = await import("../core/references/ReferenceStore.js");
	switch (stringField(request, "operation")) {
		case "read":
			return references.readReferenceMarkdown(stringField(request, "sourcePath"));
		case "parse":
			return references.readReferenceMarkdownFromString(stringField(request, "content"));
		default:
			throw new Error("Unknown reference-store operation.");
	}
}

async function runKbAction(request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const paths = await import("../core/KBPathResolver.js");
	switch (operation) {
		case "resolve":
			return {
				path: paths.resolveKBPath(
					stringField(request, "repoName"),
					optionalString(request, "remoteUrl") ?? null,
					optionalString(request, "customPath"),
				),
			};
		case "initialize":
			paths.initializeKBFolder(
				stringField(request, "kbRoot"),
				stringField(request, "repoName"),
				optionalString(request, "remoteUrl") ?? null,
			);
			return { ok: true };
		case "find-repo-folders":
			return {
				paths: paths.findRepoFolders(
					stringField(request, "repoName"),
					optionalString(request, "remoteUrl") ?? null,
					optionalString(request, "customPath"),
				),
			};
		case "find-fresh":
			return {
				path: paths.findFreshKBPath(stringField(request, "repoName"), optionalString(request, "customPath")),
			};
		case "archive":
			return {
				path: paths.archiveKBFolder(stringField(request, "kbRoot"), optionalString(request, "customPath")),
			};
		case "extract-repo-name":
			return { value: paths.extractRepoName(stringField(request, "projectPath")) };
		case "get-remote-url":
			return { value: paths.getRemoteUrl(stringField(request, "projectPath")) };
		case "discover": {
			const { discoverRepos } = await import("../core/KBRepoDiscoverer.js");
			return {
				repos: discoverRepos(
					optionalString(request, "currentRepoName") ?? null,
					optionalString(request, "currentRemoteUrl") ?? null,
					optionalString(request, "customParent"),
				),
			};
		}
	}
	const { MetadataManager } = await import("../core/MetadataManager.js");
	const manager = new MetadataManager(stringField(request, "jolliDir"));
	switch (operation) {
		case "metadata-ensure":
			manager.ensure();
			return { ok: true };
		case "metadata-read-manifest":
			return manager.readManifest();
		case "metadata-read-index":
			return manager.readIndex();
		case "metadata-read-config":
			return manager.readConfig();
		case "metadata-find-by-path":
			return { entry: manager.findByPath(stringField(request, "path")) ?? null };
		case "metadata-update-path":
			return { changed: manager.updatePath(stringField(request, "fileId"), stringField(request, "newPath")) };
		case "metadata-rename-branch-folder":
			return {
				count: manager.renameBranchFolder(stringField(request, "oldFolder"), stringField(request, "newFolder")),
			};
		case "metadata-remove-branch-folder":
			return { count: manager.removeBranchFolder(stringField(request, "folder")) };
		case "metadata-remove-manifest":
			return { changed: manager.removeFromManifest(stringField(request, "fileId")) };
		case "metadata-reconcile":
			return { count: manager.reconcile(stringField(request, "kbRoot")) };
		case "metadata-save-migration":
			manager.saveMigrationState(request.state as Parameters<typeof manager.saveMigrationState>[0]);
			return { ok: true };
		default:
			throw new Error(`Unknown KB operation "${operation}".`);
	}
}

export async function runIdeBridgeAction(action: string, cwd: string, request: JsonObject): Promise<unknown> {
	switch (action) {
		case "active-conversations": {
			const { listActiveConversationsWithDiagnostics } = await import("../core/ActiveSessionAggregator.js");
			const windowMs = typeof request.windowMs === "number" ? request.windowMs : 2 * 24 * 60 * 60 * 1000;
			return listActiveConversationsWithDiagnostics({ cwd, windowMs });
		}
		case "unread-transcript": {
			const source = stringField(request, "source") as TranscriptSource;
			if (!TRANSCRIPT_SOURCES.has(source)) throw new Error(`Unknown transcript source "${source}".`);
			const { loadUnreadTranscript } = await import("../core/TranscriptMessageCounter.js");
			return { entries: await loadUnreadTranscript(source, stringField(request, "transcriptPath"), cwd) };
		}
		case "transcript": {
			const source = stringField(request, "source") as TranscriptSource;
			if (!TRANSCRIPT_SOURCES.has(source)) throw new Error(`Unknown transcript source "${source}".`);
			const { loadTranscript } = await import("../core/TranscriptLoader.js");
			return {
				entries: await loadTranscript({ source, transcriptPath: stringField(request, "transcriptPath") }),
			};
		}
		case "compile": {
			const config = request.config as JolliMemoryConfig | undefined;
			if (!config || typeof config !== "object") throw new Error('Request field "config" must be an object.');
			const localFolder = optionalString(request, "localFolder") ?? config.localFolder;
			if (!localFolder) throw new Error("No Memory Bank folder configured.");
			const { compileAllRepos } = await import("../core/MultiRepoCompile.js");
			return compileAllRepos(localFolder, config);
		}
		case "pr-description": {
			const { buildPrDescription } = await import("../core/PrDescription.js");
			return buildPrDescription(cwd, {
				baseBranch: optionalString(request, "baseBranch"),
				includeMarkers: request.includeMarkers !== false,
			});
		}
		case "status": {
			const { createStorage } = await import("../core/StorageFactory.js");
			const { getStatus } = await import("../install/Installer.js");
			return getStatus(cwd, await createStorage(cwd, cwd));
		}
		case "sync": {
			const { loadConfig } = await import("../core/SessionTracker.js");
			const config = await loadConfig();
			if (!config.jolliApiKey) throw new Error("Sync requires a Jolli sign-in.");
			const { ensureKBInitAndMigrated } = await import("./SyncCommand.js");
			await ensureKBInitAndMigrated(cwd, config.localFolder);
			const { buildSyncEngine } = await import("../sync/SyncBootstrap.js");
			const ui = new IdeBridgeConflictUi(conflictChoices(request));
			const engine = await buildSyncEngine({ cwd, ui });
			if (engine === null) throw new Error("Sync requires a Jolli sign-in.");
			const rawReason = optionalString(request, "reason") ?? "manual";
			const reason = (["post-commit", "poll", "manual", "first-bind"] as const).find(
				(candidate) => candidate === rawReason,
			);
			if (reason === undefined) throw new Error(`Unknown sync reason "${rawReason}".`);
			const result = await engine.runRound({
				cwd,
				reason,
				transcripts: request.transcripts === true || config.syncTranscripts === true,
			});
			return { ...result, conflictDetails: ui.details };
		}
		case "conversation-overlay":
			return runConversationOverlayAction(cwd, request);
		case "session-state":
			return runSessionStateAction(cwd, request);
		case "auth":
			return runAuthAction(request);
		case "jolli-api":
			return runJolliApiAction(cwd, request);
		case "pricing": {
			const operation = stringField(request, "operation");
			if (operation === "sonnet-cost") {
				const { estimateConversationCostUsd } = await import("../core/TokenCost.js");
				return {
					costUsd: estimateConversationCostUsd(
						request.breakdown as Parameters<typeof estimateConversationCostUsd>[0],
						numberField(request, "totalTokens"),
					),
				};
			}
			const pricing = await import("../core/Pricing.js");
			if (operation === "provider") {
				return { provider: pricing.MODEL_PRICES[stringField(request, "model")]?.provider ?? "unknown" };
			}
			if (operation === "model-cost") {
				return {
					costUsd: pricing.estimateModelCostUsd(
						request.usage as Parameters<typeof pricing.estimateModelCostUsd>[0],
					),
				};
			}
			if (operation === "total-cost") {
				return pricing.estimateCostUsd(request.usages as Parameters<typeof pricing.estimateCostUsd>[0]);
			}
			throw new Error(`Unknown pricing operation "${operation}".`);
		}
		case "shared-store":
			return runSharedStoreAction(cwd, request);
		case "summary-store":
			return runSummaryStoreAction(cwd, request);
		case "summary-tree":
			return runSummaryTreeAction(request);
		case "plan-grouping":
			return runPlanGroupingAction(request);
		case "reference-store":
			return runReferenceStoreAction(request);
		case "kb":
			return runKbAction(request);
		case "storage":
			return runStorageAction(cwd, request);
		case "git-exec": {
			const { execGit } = await import("../core/GitOps.js");
			return execGit(stringArrayField(request, "args"), cwd);
		}
		case "git-main-worktree-root": {
			const { getProjectRootDir } = await import("../core/GitOps.js");
			return { path: await getProjectRootDir(cwd) };
		}
		case "git-remote": {
			const remote = await import("../core/GitRemoteUtils.js");
			switch (stringField(request, "operation")) {
				case "canonical-url":
					return { value: await remote.getCanonicalRepoUrl(cwd) };
				case "normalize-url":
					return { value: remote.normalizeRemoteUrl(stringField(request, "remote"), cwd) };
				case "derive-name":
					return { value: remote.deriveRepoNameFromUrl(stringField(request, "repoUrl")) };
				case "sanitize-branch":
					return { value: remote.sanitizeBranchSlug(optionalString(request, "branch")) };
				default:
					throw new Error("Unknown git-remote operation.");
			}
		}
		case "telemetry-track": {
			const { bootstrapTelemetry } = await import("../core/TelemetryStartup.js");
			const { bucket, track } = await import("../core/Telemetry.js");
			await bootstrapTelemetry({ cwd, platformDisabled: request.platformDisabled === true });
			const properties = {
				...((request.properties as Readonly<Record<string, unknown>> | undefined) ?? {}),
			};
			const bucketCounts = request.bucketCounts;
			if (bucketCounts !== undefined) {
				if (typeof bucketCounts !== "object" || bucketCounts === null || Array.isArray(bucketCounts)) {
					throw new Error('Request field "bucketCounts" must be an object.');
				}
				for (const [key, value] of Object.entries(bucketCounts)) {
					if (typeof value !== "number") throw new Error(`Bucket count "${key}" must be a number.`);
					properties[key] = bucket(value);
				}
			}
			track(stringField(request, "eventName") as Parameters<typeof track>[0], properties);
			return { ok: true };
		}
		case "telemetry-bootstrap": {
			const { bootstrapTelemetry } = await import("../core/TelemetryStartup.js");
			const { loadConfig } = await import("../core/SessionTracker.js");
			const { shouldShowTelemetryNotice } = await import("../core/TelemetryConsent.js");
			const platformDisabled = request.platformDisabled === true;
			await bootstrapTelemetry({ cwd, platformDisabled });
			return { shouldShowNotice: shouldShowTelemetryNotice({ config: await loadConfig(), platformDisabled }) };
		}
		case "telemetry-install-id": {
			const { getOrCreateInstallId } = await import("../core/SessionTracker.js");
			return getOrCreateInstallId();
		}
		case "telemetry-flush": {
			const { flushTelemetryNow } = await import("../core/TelemetryStartup.js");
			await flushTelemetryNow(cwd, { platformDisabled: request.platformDisabled === true });
			return { ok: true };
		}
		default:
			throw new Error(`Unknown IDE bridge action "${action}".`);
	}
}

/**
 * One-shot mode. Reads one request body from stdin (already just the `request`
 * payload — `method` and `cwd` come from the CLI args), invokes the handler,
 * and writes one JSON-RPC 2.0 response envelope on stdout. Success and error
 * shapes match the long-lived server so the host has a single parser.
 * Note there is no `id` in the one-shot response: the process itself is the
 * correlation — one spawn = one call.
 */
export async function executeIdeBridgeCommand(action: string, cwd: string): Promise<void> {
	try {
		setLogDir(cwd);
		const result = await runIdeBridgeAction(action, cwd, parseRequest(await readStdin()));
		console.log(JSON.stringify({ jsonrpc: "2.0", result }));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const data: Record<string, unknown> = {};
		if (error instanceof Error && error.name.length > 0) {
			data.errorName = error.name;
		}
		copyPrimitiveErrorFields(error, data);
		console.log(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message, data } }));
		process.exitCode = 1;
	}
}

/**
 * Wire protocol name for the long-lived JSON-RPC 2.0 ide-bridge server. The
 * host side refuses a handshake with any other value so a mismatched Node
 * binary (older plugin dist, newer client) fails loudly instead of silently
 * misbehaving.
 */
export const IDE_BRIDGE_PROTOCOL = "jolli-ide-bridge-jsonrpc-v1";

/** Handshake — a JSON-RPC 2.0 notification (no `id`) with method "ready". */
interface HandshakeLine {
	readonly jsonrpc: "2.0";
	readonly method: "ready";
	readonly params: {
		readonly protocol: typeof IDE_BRIDGE_PROTOCOL;
		readonly pluginVersion: string;
		readonly pid: number;
	};
}

/** One request received from the IDE. Fields extra to this shape are ignored. */
interface ServeRequest {
	readonly id: number | string | null;
	readonly action: string;
	readonly cwd?: string;
	readonly request?: JsonObject;
}

/**
 * Extracts the id from a decoded request line without throwing — used on the
 * error path so a malformed line still gets a paired error response when the
 * `id` field alone is intelligible.
 */
function extractRequestId(parsed: unknown): number | string | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const id = (parsed as { id?: unknown }).id;
	if (typeof id === "number" || typeof id === "string") return id;
	return null;
}

/**
 * Validates and normalises one raw JSON-RPC 2.0 request line into a
 * [ServeRequest]. Throws with a specific message on any missing / wrong-typed
 * field — the caller pairs the resulting error with whatever id could be
 * extracted separately.
 *
 * Wire shape: `{"jsonrpc":"2.0","id":<n|s>,"method":"<action>","params":{"cwd":"...","request":{...}}}`.
 * `jsonrpc` is required by the spec but we accept its absence for transitional
 * clients — the presence of `method`/`id` is what actually drives dispatch.
 */
function normaliseServeRequest(parsed: unknown): ServeRequest {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Request must be a JSON object.");
	}
	const raw = parsed as Record<string, unknown>;
	const method = raw.method;
	if (typeof method !== "string" || method.length === 0) {
		throw new Error('Request field "method" must be a non-empty string.');
	}
	const rawParams = raw.params;
	if (rawParams !== undefined && (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams))) {
		throw new Error('Request field "params" must be a JSON object.');
	}
	const params = (rawParams as Record<string, unknown> | undefined) ?? {};
	const cwd = params.cwd;
	if (cwd !== undefined && typeof cwd !== "string") {
		throw new Error('Request field "params.cwd" must be a string.');
	}
	const request = params.request;
	if (request !== undefined && (typeof request !== "object" || request === null || Array.isArray(request))) {
		throw new Error('Request field "params.request" must be a JSON object.');
	}
	const id = extractRequestId(parsed);
	return {
		id,
		action: method,
		...(typeof cwd === "string" ? { cwd } : {}),
		...(request ? { request: request as JsonObject } : {}),
	};
}

/**
 * Emits one JSON line to stdout as the wire format for the daemon. Kept as a
 * single choke point so any future framing change (e.g. Content-Length) is a
 * one-line edit.
 *
 * Stringify guard: a handler that returns a value carrying a bigint or a
 * circular reference makes `JSON.stringify` throw AFTER the request already
 * committed an id. Without this fallback the host's per-id future is orphaned
 * and only unblocks when the caller's own timeout fires (300 s in the default
 * bridge budget). Fall back to a minimal, guaranteed-serialisable error
 * envelope carrying the same id so the caller fails fast with a real message.
 *
 * Exported so vitest can assert the fallback envelope shape without spawning
 * a real daemon.
 */
export function writeServeLine(obj: object): void {
	let line: string;
	try {
		line = JSON.stringify(obj);
	} catch (err: unknown) {
		const rawId = (obj as { id?: unknown }).id;
		const id = typeof rawId === "number" || typeof rawId === "string" ? rawId : null;
		const message = err instanceof Error ? err.message : String(err);
		// JSON-RPC 2.0 error object. -32603 = internal error (spec).
		line = JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: {
				code: -32603,
				message: `response not serialisable: ${message}`,
				data: { errorName: "SerializationError" },
			},
		});
	}
	process.stdout.write(`${line}\n`);
}

/**
 * Long-lived NDJSON server mode for `ide-bridge`. Reads one JSON request per
 * line from stdin and writes one JSON response per line to stdout; every
 * request is dispatched concurrently by [runIdeBridgeAction] so a slow request
 * (e.g. `sync`, `compile`) cannot block a fast one (`session-state`, `status`).
 *
 * Contract highlights (see also IDE_BRIDGE_PROTOCOL):
 *   - Handshake — one `{"type":"ready", …}` line is emitted before any request
 *     is read, so the host can wait for it before sending traffic.
 *   - Requests — `{"id":<int|string>, "action":"<a>", "cwd":"<abs>", "request":{…}}`.
 *   - Responses — success `{"id":<n>, "type":"<action>", "result":<any>}`;
 *     failure `{"id":<n>, "type":"error", "message":"…", "errorName":"…",
 *     "details":{…}}` — same shape as the one-shot mode so the host can reuse
 *     one parser.
 *   - Malformed lines produce an error response whose id is whatever could be
 *     extracted, or `null` when even that fails; the loop keeps running.
 *   - Handler exceptions are caught per-request; the daemon process never
 *     exits from a business-logic error.
 *   - stdin EOF (`readline` `close` event) drains outstanding responses and
 *     exits cleanly with code 0.
 *   - stdout is protocol-only. All logging goes through [setLogDir] to the
 *     per-project log file, and any accidental stray writer would violate the
 *     protocol; the two `console.log`s in this file are the only stdout
 *     writers, both emitting well-formed JSON envelopes.
 */
export async function runIdeBridgeServe(cwdDefault: string): Promise<void> {
	setLogDir(cwdDefault);

	// Last-resort guards — any un-caught throw would otherwise crash the daemon
	// and orphan every in-flight future in the Kotlin client. Route to stderr
	// (Node's default for console.error / .warn) so stdout stays clean.
	process.on("uncaughtException", (err) => {
		console.error(
			`[ide-bridge-serve] uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
		);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(
			`[ide-bridge-serve] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`,
		);
	});

	const handshake: HandshakeLine = {
		jsonrpc: "2.0",
		method: "ready",
		params: {
			protocol: IDE_BRIDGE_PROTOCOL,
			pluginVersion: typeof __CLI_PKG_VERSION__ !== "undefined" ? __CLI_PKG_VERSION__ : "dev",
			pid: process.pid,
		},
	};
	writeServeLine(handshake);

	// Same stdout is used for two message families:
	//   - request/response pairs (this loop below)
	//   - server→client refresh notifications from fs.watch on the write outputs
	// Merging both into one process (scheme A') means the Kotlin host only
	// spawns and manages a single Node child; notifications carry no `id`, so
	// the host can route them by envelope `type` alone.
	const watchers = startRefreshWatchers(cwdDefault);

	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

	const pending = new Set<Promise<void>>();
	for await (const rawLine of rl) {
		if (rawLine.trim().length === 0) continue;
		const task = handleServeLine(rawLine, cwdDefault).catch((err) => {
			// handleServeLine already writes a JSON error line for any expected
			// failure; this catch only fires if the writer itself threw (e.g.
			// EPIPE after the client went away). Log and continue — the read
			// loop will naturally exit next.
			console.error(
				`[ide-bridge-serve] response write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		pending.add(task);
		task.finally(() => pending.delete(task));
	}

	// stdin closed → stop watchers and let outstanding work finish before
	// exiting so the host receives every pending response instead of a
	// truncated stream.
	stopRefreshWatchers(watchers);
	await Promise.all(pending);
}

/**
 * Debounced fs.watch on the two write outputs of the CLI-native git hooks:
 *   - `.jolli/jollimemory/git-op-queue/` (queue writes)
 *   - `<gitCommonDir>/refs/heads/jollimemory/summaries/` (orphan ref moves)
 *
 * Bursts collapse into one refresh line per kind after the watcher's quiet
 * window. Notification envelope carries no `id` — the host distinguishes it
 * from a response by the absence of that field and routes by `type` alone.
 * When the target directory does not yet exist (typical for orphan-ref on a
 * fresh clone), start a retry timer that polls until the first summary lands
 * and arm the watcher then.
 */
function startRefreshWatchers(cwd: string): {
	watchers: DaemonWatcher[];
	armRetries: NodeJS.Timeout[];
} {
	const DEBOUNCE_MS = 300;
	const ARM_RETRY_MS = 5000;
	const watchers: DaemonWatcher[] = [];
	const armRetries: NodeJS.Timeout[] = [];
	for (const target of computeWatchTargets(cwd)) {
		const watcher = new DaemonWatcher({
			path: target.path,
			debounceMs: DEBOUNCE_MS,
			ensureDir: target.ensureDir,
			onTrigger: () => {
				// JSON-RPC 2.0 server→client notification (no `id`).
				writeServeLine({
					jsonrpc: "2.0",
					method: "refresh",
					params: { kind: target.kind, cwd },
				});
			},
		});
		if (!watcher.start()) {
			const retry = setInterval(() => {
				if (watcher.start()) {
					clearInterval(retry);
					const idx = armRetries.indexOf(retry);
					if (idx >= 0) armRetries.splice(idx, 1);
				}
			}, ARM_RETRY_MS);
			retry.unref?.();
			armRetries.push(retry);
		}
		watchers.push(watcher);
	}
	return { watchers, armRetries };
}

function stopRefreshWatchers({
	watchers,
	armRetries,
}: {
	watchers: DaemonWatcher[];
	armRetries: NodeJS.Timeout[];
}): void {
	for (const w of watchers) w.stop();
	for (const t of armRetries) clearInterval(t);
}

/** Dispatches one line; always writes exactly one response line (success or error). */
async function handleServeLine(line: string, cwdDefault: string): Promise<void> {
	writeServeLine(await computeServeResponse(line, cwdDefault));
}

/**
 * Turns one request line into its response envelope — the object that the
 * daemon would otherwise pass straight to [writeServeLine]. Split out from
 * [handleServeLine] so vitest can exercise it without touching stdin/stdout
 * or spawning readline. Never throws — every failure (malformed JSON,
 * validator, handler exception) produces an `error`-typed envelope.
 */
export async function computeServeResponse(line: string, cwdDefault: string): Promise<Record<string, unknown>> {
	let id: number | string | null = null;
	try {
		const parsed: unknown = JSON.parse(line);
		id = extractRequestId(parsed);
		const req = normaliseServeRequest(parsed);
		id = req.id;
		const cwd = req.cwd && req.cwd.length > 0 ? req.cwd : cwdDefault;
		const result = await runIdeBridgeAction(req.action, cwd, req.request ?? {});
		return { jsonrpc: "2.0", id, result };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		// -32000 is the server-defined error range per JSON-RPC 2.0. Business
		// errors from handlers all funnel here; parse/dispatch failures share
		// the same envelope so the host has one code path.
		const data: Record<string, unknown> = {};
		if (error instanceof Error && error.name.length > 0) {
			data.errorName = error.name;
		}
		copyPrimitiveErrorFields(error, data);
		return {
			jsonrpc: "2.0",
			id,
			error: { code: -32000, message, data },
		};
	}
}
