# push-to-jolli + memory-space selection (CLI/MCP) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent push a branch's JolliMemory to the Jolli cloud and choose the target memory space, via `jolli push`/`spaces`/`bind` CLI commands + matching MCP tools, with an optional push step in the `jolli-pr` skill.

**Architecture:** Port VS Code's push stack into `cli/src/core/` (repo-identity helpers, an auth-aware HTTP client, and the per-summary push orchestrator with docId write-back), then expose it through three CLI commands and three MCP tools that share that core (single engine, two surfaces — same pattern as `get_pr_description`/`queue_status`). The `jolli-pr` skill gains a Step 5 that offers to push after the PR is created. VS Code's own push path is untouched.

**Tech Stack:** TypeScript (ESM), Node 22.5+, Commander (CLI), `@modelcontextprotocol/sdk` (MCP), `fetch`, Vitest + coverage, Biome.

## Global Constraints

- DCO sign-off on the single final commit: `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated with` trailer.
- `npm run all` must pass before the (single) commit — run once at the end. **No per-task `npm run all`, no per-task commits** (user preference); each task writes test+impl and runs only its targeted Vitest.
- Local `npm run all` has known non-deterministic flakes in `cli/src/sync/GitClient.test.ts` + `cli/src/core/KBPathResolver.test.ts` (worktree/`safe.bareRepository` env, untouched files). Run the full suite with `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all GIT_CONFIG_KEY_1=core.excludesFile GIT_CONFIG_VALUE_1=/dev/null` to get a clean signal.
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`). Coverage-exempt lines use `/* v8 ignore start */ … /* v8 ignore stop */` blocks (single-line `ignore next` does NOT work here).
- Biome: tabs, 4-wide, 120 columns; `noExplicitAny: error`, `noUnusedImports/Variables: error`, import ordering enforced (`../core/…` before `../Logger.js`). Run `npx biome check --error-on-warnings` (from `cli/`) on every touched file before finishing a task.
- **Title-stability constraint (load-bearing):** the push `title` / `relativePath` / `repoUrl` MUST be derived with the same logic as VS Code (ported `getCanonicalRepoUrl`/`normalizeRemoteUrl`/`buildBranchRelativePath` + `buildPushTitle`) so re-push of a commit updates in place and CLI↔vscode pushes of the same commit converge on one doc. Different commits must not collapse to one title-slug.
- Push always sends `repoUrl` (per-repo binding); an unbound repo goes through the space-selection flow, never the org default.
- API-key parsing stays in lockstep — reuse `cli/src/core/JolliApiUtils.ts` (`parseJolliApiKey`, `parseBaseUrl`); do not fork a 4th copy.
- `toForwardSlash` for `\`→`/` path normalization; never inline `.replace(/\\/g,"/")`.
- No backend changes; VS Code push path untouched.

---

## File Structure

**Create (cli):**
- `cli/src/core/GitRemoteUtils.ts` — ported repo-identity helpers (`getCanonicalRepoUrl`, `normalizeRemoteUrl`, `deriveRepoNameFromUrl`, `sanitizeBranchSlug`, `buildBranchRelativePath`).
- `cli/src/core/JolliMemoryPushClient.ts` — auth-aware HTTP client: `listSpaces`, `createBinding`, `push`, `deleteDoc`; typed errors; header builder.
- `cli/src/core/JolliMemoryPushOrchestrator.ts` — per-summary push + docId write-back (ported `pushSummaryWithAttachments` etc.), plus `serializeSummaryJson`, `buildPushMarkdown`, `latestPlanPerName`, `applyPlanUrls`, `applyNoteUrls`.
- `cli/src/commands/JolliCloudCommands.ts` — `registerPushCommand`, `registerSpacesCommand`, `registerBindCommand` (+ shared result rendering).
- Test files alongside each.

**Modify (cli):**
- `cli/src/Api.ts` — register the 3 commands; add their names to `MEMORY_COMMAND_NAMES`.
- `cli/src/mcp/McpServer.ts` — 3 tool defs + 3 dispatch cases.
- `cli/src/mcp/McpTools.ts` — `runPushMemory`, `runListSpaces`, `runBindSpace`.
- `cli/src/mcp/McpServer.test.ts` — update tool-count/dispatch assertions (5→8... i.e. current count + 3).
- `cli/src/install/SkillInstaller.ts` — `buildPrSkillTemplate` Step 5.
- `cli/src/install/SkillInstaller.test.ts` — Step 5 assertions.

**Port sources (read these in vscode; do not modify them):**
- `vscode/src/util/GitRemoteUtils.ts` (`getCanonicalRepoUrl` 49-61, `normalizeRemoteUrl` 64-116, `deriveRepoNameFromUrl` 119-148, `sanitizeBranchSlug` 156-165).
- `vscode/src/views/SummaryUtils.ts` (`buildBranchRelativePath` 83-85).
- `vscode/src/services/JolliPushService.ts` (`pushToJolli` 184-277, `deleteFromJolli` 283-326, `buildJolliApiHeaders` 147-173, `JolliPushPayload` 90-115, `JolliPushResult` 118-129, error classes 44-87).
- `vscode/src/services/JolliMemoryApiService.ts` (`listJolliMemorySpaces` 159-192, `createJolliMemoryBinding` 198-225, `sendJson` 87-147, interfaces 31-60).
- `vscode/src/services/JolliPushOrchestrator.ts` (`pushSummaryWithAttachments` 154-263 incl. write-back 218-225, `pushPlanList` 270-318, `pushNoteList` 321-384, `applyPlanUrls` 387-397, `applyNoteUrls` 400-409, `cleanupOrphanedDocs` 417-445, `serializeSummaryJson` 73-84, `PushContext` 87-98, `PushAttachmentFailure` 37-42, `ShareBindingError`/`BindingOutcome`).
- `vscode/src/services/LiveShareController.ts` — **primary branch-push port source**: `pushBranchMemoriesToSpace(deps, branch)` 425-462, `assignOwnedAttachments(subjectSummaries)` 149-199 (cross-commit plan/note dedup + seed docIds), `PushBranchMemoriesResult` 402-414, `LiveShareDeps` 67-72, `resolveBaseUrl` 110-118, `buildPushContext` 284-293.
- `vscode/src/views/BindingResolver.ts` — `resolveBindingViaChooser` (reference only; maps chooser outcome to `{status: "bound"|"anotherOpen"|"cancelled"}`; the CLI equivalent is the `binding_required` → list-spaces → bind flow, no webview).
- `vscode/src/views/SummaryMarkdownBuilder.ts` (`buildMarkdown` 44-57 — push-specific summary markdown).
- `vscode/src/util/PlanGrouping.ts` (`latestPlanPerName` 85-113 — still required for `pushSummary`'s single-summary/no-attachments fallback, even though `assignOwnedAttachments` handles the branch batch).

**CLI reuse (call, don't reimplement):**
- `foldGitTransportToHttps`, `CASE_INSENSITIVE_PATH_HOSTS` — `cli/src/core/KBPathResolver.ts:436`, `:434` (post-rebase; bodies unchanged).
- `execGit` — `cli/src/core/GitOps.ts:36`; `getCurrentBranch` — `:322`; `getDefaultBranch` — `:338` (post-rebase line shift; bodies unchanged).
- `JOLLI_CLIENT_HEADER` — `cli/src/core/ClientHeader.ts:22`.
- `parseJolliApiKey`/`parseBaseUrl` (`JolliApiKeyMeta` `{t,u,o}`) — `cli/src/core/JolliApiUtils.ts:56`/`:30`.
- `loadConfig` (reads `jolliApiKey`,`jolliUrl`) — `cli/src/core/SessionTracker.ts`.
- `buildPushTitle` — `cli/src/core/SummaryFormat.ts:200`.
- `pushFooter`/`pushPlansAndNotesSection`/`pushRecapSection` — `cli/src/core/SummaryMarkdownBuilder.ts` (used by the ported `buildPushMarkdown`).
- `readPlanFromBranch` (`SummaryStore.ts:2311`), `readNoteFromBranch` (`SummaryStore.ts:2416`).
- `loadBranchSummaries(cwd, mainBranch)` — `cli/src/core/PrDescription.ts:54`.
- `getDefaultBranch`/`getCurrentBranch` — `cli/src/core/GitOps.ts`.
- `storeSummary(summary, cwd, force, artifacts, storage, readStorage)` — `cli/src/core/SummaryStore.ts:233` (write-back; already locks internally).
- `createStorage(cwd, cwd)` — `cli/src/core/StorageFactory.ts`; `setActiveStorage`/`getActiveStorage` — `SummaryStore.ts`.
- `resolveProjectDir`, `SAFE_ARGUMENT_PATTERN`, `readStdin` — `cli/src/commands/CliUtils.ts`.

---

## Task 1: Port repo-identity helpers → `cli/src/core/GitRemoteUtils.ts`

**Files:**
- Create: `cli/src/core/GitRemoteUtils.ts`, `cli/src/core/GitRemoteUtils.test.ts`

**Interfaces produced:**
- `getCanonicalRepoUrl(workspaceRoot: string): Promise<string>`
- `normalizeRemoteUrl(remote: string, workspaceRootForFallback: string): string`
- `deriveRepoNameFromUrl(repoUrl: string): string`
- `sanitizeBranchSlug(branch: string | undefined): string`
- `buildBranchRelativePath(branch: string | undefined): string`

- [ ] **Step 1: Write failing tests**

Create `cli/src/core/GitRemoteUtils.test.ts`. These pin the exact canonical forms the server also computes (verify against the vscode source's behavior while porting):

```ts
import { describe, expect, it } from "vitest";
import { buildBranchRelativePath, deriveRepoNameFromUrl, normalizeRemoteUrl, sanitizeBranchSlug } from "./GitRemoteUtils.js";

describe("normalizeRemoteUrl", () => {
	it("folds SSH scp form to https and strips .git", () => {
		expect(normalizeRemoteUrl("git@github.com:Owner/Repo.git", "/ws")).toBe("https://github.com/owner/repo");
	});
	it("lower-cases path only for case-insensitive hosts", () => {
		expect(normalizeRemoteUrl("https://example.com/Owner/Repo", "/ws")).toBe("https://example.com/Owner/Repo");
	});
	it("falls back to file:// on no remote", () => {
		expect(normalizeRemoteUrl("", "/ws/proj")).toBe("file:///ws/proj");
	});
});

describe("deriveRepoNameFromUrl", () => {
	it("takes the last path segment minus .git", () => {
		expect(deriveRepoNameFromUrl("https://github.com/owner/my-repo")).toBe("my-repo");
	});
});

describe("sanitizeBranchSlug / buildBranchRelativePath", () => {
	it("sanitizes branch to a slug", () => {
		expect(sanitizeBranchSlug("feature/Foo Bar")).toBe("feature/Foo-Bar");
		expect(buildBranchRelativePath("feature/Foo Bar")).toBe(sanitizeBranchSlug("feature/Foo Bar"));
	});
	it("empty branch → _", () => {
		expect(sanitizeBranchSlug(undefined)).toBe("_");
	});
});
```

> While porting, open `vscode/src/util/GitRemoteUtils.ts` and confirm each assertion's expected value matches that source's real output; adjust the expected literals to the source's actual behavior if any differ (the source is authoritative, the tests pin it).

- [ ] **Step 2: Run — expect FAIL** (`npm run test -w @jolli.ai/cli -- src/core/GitRemoteUtils.test.ts`) — module not found.

- [ ] **Step 3: Port the implementation**

Copy the five functions verbatim from the port sources into `cli/src/core/GitRemoteUtils.ts`, adapting only imports:
- `import { execGit } from "./GitOps.js";`
- `import { CASE_INSENSITIVE_PATH_HOSTS, foldGitTransportToHttps } from "./KBPathResolver.js";`
- `getCanonicalRepoUrl` uses `execGit(["config","--get","remote.origin.url"], workspaceRoot)` then `normalizeRemoteUrl(stdout.trim(), workspaceRoot)`; on empty/error → `normalizeRemoteUrl("", workspaceRoot)`.
- `buildBranchRelativePath` = `sanitizeBranchSlug(branch)` (from SummaryUtils.ts:83-85).
Keep the vscode bodies otherwise byte-identical (they already only depend on CLI-native `execGit`/`CASE_INSENSITIVE_PATH_HOSTS`).

- [ ] **Step 4: Run — expect PASS.** Then `npx biome check --error-on-warnings src/core/GitRemoteUtils.ts src/core/GitRemoteUtils.test.ts` from `cli/`.

---

## Task 2: `JolliMemoryPushClient` — spaces + bindings + errors

**Files:**
- Create: `cli/src/core/JolliMemoryPushClient.ts`, `cli/src/core/JolliMemoryPushClient.test.ts`

**Interfaces produced:**
- `class JolliMemoryPushClient { constructor(opts?: { fetchImpl?: typeof fetch; baseUrlOverride?: string; apiKeyProvider?: () => Promise<string | undefined>; timeoutMs?: number }) }`
- `listSpaces(): Promise<{ spaces: Array<{ id: number; name: string; slug: string }>; defaultSpaceId: number | null }>`
- `createBinding(args: { repoUrl: string; repoName: string; jmSpaceId: number }): Promise<{ bindingId: number; jmSpaceId: number; repoName: string }>`
- Error classes (module-level): `NotAuthenticatedError`, `ClientOutdatedError`, `BindingAlreadyExistsError`, `BindingRequiredError` (with `readonly repoUrl: string`).
- Private `buildHeaders(apiKey, keyMeta, tenantSlug): Record<string,string>` and `resolveAuth(): Promise<{ apiKey; baseUrl; keyMeta; tenantSlug }>` (throws `NotAuthenticatedError` if no key/URL).

- [ ] **Step 1: Write failing tests** (injected fetch)

Create `cli/src/core/JolliMemoryPushClient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BindingAlreadyExistsError, ClientOutdatedError, JolliMemoryPushClient, NotAuthenticatedError } from "./JolliMemoryPushClient.js";

const KEY = "sk-jol-test"; // parseJolliApiKey may return null for a plain key → baseUrlOverride supplies the URL
function client(fetchImpl: typeof fetch) {
	return new JolliMemoryPushClient({ fetchImpl, baseUrlOverride: "https://jolli.ai", apiKeyProvider: async () => KEY });
}
function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("listSpaces", () => {
	it("returns spaces + defaultSpaceId", async () => {
		const c = client(async () => jsonResponse(200, { defaultSpaceId: 7, spaces: [{ id: 7, name: "Eng", slug: "eng" }] }));
		const r = await c.listSpaces();
		expect(r.defaultSpaceId).toBe(7);
		expect(r.spaces[0]).toEqual({ id: 7, name: "Eng", slug: "eng" });
	});
	it("throws NotAuthenticatedError when no api key", async () => {
		const c = new JolliMemoryPushClient({ fetchImpl: async () => jsonResponse(200, {}), apiKeyProvider: async () => undefined });
		await expect(c.listSpaces()).rejects.toBeInstanceOf(NotAuthenticatedError);
	});
});

describe("createBinding", () => {
	it("parses the real {binding, repoFolder} shape", async () => {
		const c = client(async () => jsonResponse(201, { binding: { id: 3, jmSpaceId: 7, repoName: "repo" }, repoFolder: { id: 9, jrn: "jrn:..." } }));
		const r = await c.createBinding({ repoUrl: "https://github.com/o/r", repoName: "repo", jmSpaceId: 7 });
		expect(r).toEqual({ bindingId: 3, jmSpaceId: 7, repoName: "repo" });
	});
	it("maps 409 to BindingAlreadyExistsError", async () => {
		const c = client(async () => jsonResponse(409, { error: "binding_already_exists" }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toBeInstanceOf(BindingAlreadyExistsError);
	});
	it("maps 426 to ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { error: "client_outdated" }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toBeInstanceOf(ClientOutdatedError);
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (`npm run test -w @jolli.ai/cli -- src/core/JolliMemoryPushClient.test.ts`).

- [ ] **Step 3: Implement**

Model the constructor/auth/header/timeout plumbing on `cli/src/sync/BackendClient.ts` (constructor opts, `AbortController` timeout, header set), but with push-specific error taxonomy. Key pieces:

```ts
import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { type JolliApiKeyMeta, parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import { loadConfig } from "./SessionTracker.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "./TraceContext.js";

export class NotAuthenticatedError extends Error {}
export class ClientOutdatedError extends Error {}
export class BindingAlreadyExistsError extends Error {}
export class BindingRequiredError extends Error {
	readonly repoUrl: string;
	constructor(repoUrl: string, message?: string) { super(message ?? "binding_required"); this.repoUrl = repoUrl; this.name = "BindingRequiredError"; }
}

interface Opts { fetchImpl?: typeof fetch; baseUrlOverride?: string; apiKeyProvider?: () => Promise<string | undefined>; timeoutMs?: number; }

export class JolliMemoryPushClient {
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrlOverride?: string;
	private readonly apiKeyProvider: () => Promise<string | undefined>;
	private readonly timeoutMs: number;
	constructor(opts: Opts = {}) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrlOverride = opts.baseUrlOverride;
		this.apiKeyProvider = opts.apiKeyProvider ?? (async () => (await loadConfig()).jolliApiKey);
		this.timeoutMs = opts.timeoutMs ?? 30_000;
	}

	private async resolveAuth() {
		const apiKey = await this.apiKeyProvider();
		if (!apiKey) throw new NotAuthenticatedError("Not signed in to Jolli. Run `jolli auth login` or sign in via the extension.");
		const keyMeta = parseJolliApiKey(apiKey);
		const rawBase = this.baseUrlOverride ?? keyMeta?.u;
		if (!rawBase) throw new NotAuthenticatedError("No Jolli URL configured. Regenerate your Jolli API key or set jolliUrl.");
		const { origin, tenantSlug } = parseBaseUrl(rawBase);
		return { apiKey, baseUrl: rawBase, origin, tenantSlug, keyMeta };
	}

	private buildHeaders(apiKey: string, keyMeta: JolliApiKeyMeta | null, tenantSlug: string | undefined, hasBody: boolean): Record<string, string> {
		const h: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "x-jolli-client": JOLLI_CLIENT_HEADER };
		if (hasBody) h["Content-Type"] = "application/json";
		if (tenantSlug) h["x-tenant-slug"] = tenantSlug;
		if (keyMeta?.o) h["x-org-slug"] = keyMeta.o;
		h[TRACE_HEADER_NAME] = currentTraceHeader() ?? newTraceHeader();
		return h;
	}

	private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; json: any }> {
		const { apiKey, origin, tenantSlug, keyMeta } = await this.resolveAuth();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(new URL(path, origin).toString(), {
				method, headers: this.buildHeaders(apiKey, keyMeta, tenantSlug, body !== undefined),
				body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal,
			});
			const text = await res.text();
			const json = text ? JSON.parse(text) : {};
			return { status: res.status, json };
		} finally { clearTimeout(timer); }
	}

	async listSpaces() {
		const { status, json } = await this.call("GET", "/api/jolli-memory/spaces");
		if (status === 426) throw new ClientOutdatedError(json.message ?? "Client outdated — update the CLI/extension.");
		if (status < 200 || status >= 300) throw new Error(json.error ?? `HTTP ${status}`);
		const spaces = (json.spaces ?? []).map((s: any) => ({ id: s.id, name: s.name, slug: s.slug }));
		return { spaces, defaultSpaceId: json.defaultSpaceId ?? null };
	}

	async createBinding(args: { repoUrl: string; repoName: string; jmSpaceId: number }) {
		const { status, json } = await this.call("POST", "/api/jolli-memory/bindings", args);
		if (status === 426) throw new ClientOutdatedError(json.message ?? "Client outdated.");
		if (status === 409 && json.error === "binding_already_exists") throw new BindingAlreadyExistsError(json.message ?? "binding_already_exists");
		if (status < 200 || status >= 300) throw new Error(json.error ?? `HTTP ${status}`);
		return { bindingId: json.binding.id, jmSpaceId: json.binding.jmSpaceId, repoName: json.binding.repoName };
	}
}
```

> Confirm `TRACE_HEADER_NAME`/`currentTraceHeader`/`newTraceHeader` exports exist in `cli/src/core/TraceContext.ts` (BackendClient imports them); adjust the import if the names differ.

- [ ] **Step 4: Run — expect PASS.** Biome-check the two files.

---

## Task 3: `JolliMemoryPushClient.push` + `deleteDoc`

**Files:**
- Modify: `cli/src/core/JolliMemoryPushClient.ts`, `cli/src/core/JolliMemoryPushClient.test.ts`

**Interfaces produced:**
- `interface PushPayload { title; content; commitHash; docType: "summary"|"plan"|"note"; branch?; docId?; repoUrl?; relativePath?; summaryJson? }` (mirror `JolliPushPayload` fields verbatim).
- `interface PushResult { url: string; docId: number; jrn: string; created: boolean; summaryJsonDocId?: number }`
- `push(payload: PushPayload): Promise<PushResult>` — maps `412 binding_required` → `BindingRequiredError(json.repoUrl ?? payload.repoUrl ?? "")`, `426` → `ClientOutdatedError`, `409 binding_already_exists` → `BindingAlreadyExistsError`.
- `deleteDoc(docId: number): Promise<void>` (best-effort; mirror `deleteFromJolli`).

- [ ] **Step 1: Write failing tests**

```ts
import { BindingRequiredError } from "./JolliMemoryPushClient.js";
// ... same helpers as Task 2 ...
describe("push", () => {
	it("returns the push result on 201", async () => {
		const c = client(async () => jsonResponse(201, { url: "/articles/x", docId: 42, jrn: "jrn", created: true }));
		const r = await c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary", repoUrl: "https://github.com/o/r", relativePath: "main" });
		expect(r.docId).toBe(42);
		expect(r.created).toBe(true);
	});
	it("maps 412 binding_required to BindingRequiredError carrying repoUrl", async () => {
		const c = client(async () => jsonResponse(412, { error: "binding_required", repoUrl: "https://github.com/o/r" }));
		await expect(c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary", repoUrl: "https://github.com/o/r" }))
			.rejects.toMatchObject({ name: "BindingRequiredError", repoUrl: "https://github.com/o/r" });
	});
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `push` + `deleteDoc` on the class, reusing `call<T>`:

```ts
async push(payload: PushPayload): Promise<PushResult> {
	const { status, json } = await this.call("POST", "/api/push/jollimemory", payload);
	if (status === 426) throw new ClientOutdatedError(json.message ?? "Client outdated — update the CLI/extension.");
	if (status === 412 && json.error === "binding_required") throw new BindingRequiredError(json.repoUrl ?? payload.repoUrl ?? "", json.message);
	if (status === 409 && json.error === "binding_already_exists") throw new BindingAlreadyExistsError(json.message ?? "binding_already_exists");
	if (status < 200 || status >= 300) throw new Error(json.error ?? `HTTP ${status}`);
	return { url: json.url, docId: json.docId, jrn: json.jrn, created: json.created, summaryJsonDocId: json.summaryJsonDocId };
}
async deleteDoc(docId: number): Promise<void> {
	const { status } = await this.call("DELETE", `/api/push/jollimemory/${docId}`);
	if (status < 200 || status >= 300) throw new Error(`delete failed: HTTP ${status}`);
}
```

> Verify the DELETE path against `deleteFromJolli` (JolliPushService.ts:283-326) — use whatever exact path it targets.

- [ ] **Step 4: Run — expect PASS.** Biome-check.

---

## Task 4: Push-content helpers → orchestrator support

**Files:**
- Create: `cli/src/core/JolliMemoryPushOrchestrator.ts` (helpers only in this task), `cli/src/core/JolliMemoryPushOrchestrator.test.ts`

**Interfaces produced:**
- `serializeSummaryJson(summary: CommitSummary): string | undefined` (strips `jolliDocId`/`jolliDocUrl`/`orphanedDocIds`; cap identical to vscode).
- `buildPushMarkdown(summary: CommitSummary): string` (ported `buildMarkdown`, SummaryMarkdownBuilder.ts:44-57).
- `latestPlanPerName(plans: ReadonlyArray<PlanReference>): ReadonlyArray<PlanReference>` (ported PlanGrouping.ts:85-113).
- `applyPlanUrls(plans, planUrls): ReadonlyArray<PlanReference> | undefined` and `applyNoteUrls(notes, noteUrls)` (ported verbatim, JolliPushOrchestrator.ts:387-409).
- `assignOwnedAttachments(summaries): { ownedPlans: Map<string, PlanReference[]>; ownedNotes: Map<string, NoteReference[]>; seedPlanDocIds: Map<string, number>; seedNoteDocIds: Map<string, number> }` — ported from `LiveShareController.ts:149-199`: cross-commit dedup (latest `updatedAt` wins per plan-base-key / note-id), carrying a known `jolliPlanDocId`/`jolliNoteDocId` forward as a seed, and assigning each winning ref to its owner commit. Used by `pushBranchToJolli` (Task 5) so a plan/note recurring across commits pushes to ONE Space doc.

- [ ] **Step 1: Write failing tests**

```ts
import { applyPlanUrls, latestPlanPerName, serializeSummaryJson } from "./JolliMemoryPushOrchestrator.js";
import type { CommitSummary, PlanReference } from "../Types.js";

it("serializeSummaryJson strips push-state fields", () => {
	const s = { commitHash: "a", jolliDocId: 5, jolliDocUrl: "u", orphanedDocIds: [1] } as unknown as CommitSummary;
	const json = JSON.parse(serializeSummaryJson(s)!);
	expect(json.jolliDocId).toBeUndefined();
	expect(json.jolliDocUrl).toBeUndefined();
	expect(json.orphanedDocIds).toBeUndefined();
	expect(json.commitHash).toBe("a");
});
it("applyPlanUrls merges docId/url by slug", () => {
	const plans = [{ slug: "p1", title: "P1", addedAt: "", updatedAt: "" }] as PlanReference[];
	const out = applyPlanUrls(plans, [{ slug: "p1", url: "https://j/articles?doc=9", docId: 9 }])!;
	expect(out[0].jolliPlanDocId).toBe(9);
	expect(out[0].jolliPlanDocUrl).toBe("https://j/articles?doc=9");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Port the helpers** into `JolliMemoryPushOrchestrator.ts`:
- `serializeSummaryJson` verbatim from JolliPushOrchestrator.ts:73-84 (keep the cap constant).
- `applyPlanUrls`/`applyNoteUrls` verbatim from :387-409.
- `latestPlanPerName` verbatim from vscode PlanGrouping.ts:85-113.
- `assignOwnedAttachments` verbatim from `LiveShareController.ts:149-199` (adapt imports only). Add a test: a plan recurring in two summaries (different `updatedAt`) yields one owned entry on the latest-revision owner with the seed docId carried forward.
- `buildPushMarkdown` = ported `buildMarkdown` (SummaryMarkdownBuilder.ts:44-57), importing `pushFooter`/`pushPlansAndNotesSection`/`pushRecapSection` from `cli/src/core/SummaryMarkdownBuilder.js` (already CLI-native). Rename to `buildPushMarkdown` to avoid colliding with any existing `buildMarkdown`.

- [ ] **Step 4: Run — expect PASS.** Biome-check.

---

## Task 5: Orchestrator `pushBranchToJolli` + docId write-back

**Files:**
- Modify: `cli/src/core/JolliMemoryPushOrchestrator.ts`, `cli/src/core/JolliMemoryPushOrchestrator.test.ts`

**Interfaces:**
- Consumes: `JolliMemoryPushClient` (Task 2/3), `getCanonicalRepoUrl`/`deriveRepoNameFromUrl`/`buildBranchRelativePath` (Task 1), `buildPushTitle`, `serializeSummaryJson`/`buildPushMarkdown`/`latestPlanPerName`/`applyPlanUrls`/`applyNoteUrls`/`assignOwnedAttachments` (Task 4), `readPlanFromBranch`/`readNoteFromBranch`, `storeSummary`, `loadBranchSummaries`, `getCurrentBranch`/`getDefaultBranch`.
- Produces:
  - `pushSummary(summary, ctx, attachments?): Promise<{ summary: CommitSummary; summaryUrl: string }>` — port of `pushSummaryWithAttachments` (`attachments?: { plans; notes }`; when omitted it falls back to `latestPlanPerName` internally), with write-back via `storeSummary(updated, ctx.cwd, true, undefined, ctx.storage)` and `cleanupOrphanedDocs`.
  - `pushBranchToJolli(opts: { cwd: string; baseBranch?: string; space?: string; client?: JolliMemoryPushClient }): Promise<PushBranchResult>` where `PushBranchResult = { type: "pushed"; pushed: number; skipped: number; urls: string[] } | { type: "binding_required"; repoUrl: string; spaces: {id;name;slug}[]; defaultSpaceId: number|null } | { type: "error"; message: string }`.
  - `PushContext = { cwd; baseUrl; apiKey; repoUrl; client; storage }`.

- [ ] **Step 1: Write failing tests** (mock the client)

```ts
import { pushBranchToJolli } from "./JolliMemoryPushOrchestrator.js";
// Build a fake client whose push() resolves { docId, url, created } and capture storeSummary calls via a storage stub / spy on SummaryStore.
// Assert: after push, storeSummary called with force=true and a summary carrying jolliDocId/jolliDocUrl; re-push passes docId; a client.push throwing BindingRequiredError makes pushBranchToJolli return { type: "binding_required", spaces, ... } after listing spaces.
```
(Model the storage/summary fixtures on `PrDescription.test.ts`. Spy: `vi.spyOn(SummaryStore, "storeSummary")`.)

Concretely assert at least:
- `pushBranchToJolli` on a branch with one summary (no attachments) → calls `client.push` once with `{ docType:"summary", repoUrl, relativePath, title: buildPushTitle(summary), commitHash }`, then `storeSummary` with a summary whose `jolliDocId`/`jolliDocUrl` are set (`jolliDocUrl === `${base}/articles?doc=${docId}``).
- when `summary.jolliDocId` is already set, the push payload includes `docId`.
- when `client.push` throws `BindingRequiredError` and no `space` given → returns `{ type: "binding_required", repoUrl, spaces, defaultSpaceId }` (from `client.listSpaces()`).
- when `space` given and unbound → calls `client.createBinding` first, then pushes.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

Port `pushSummaryWithAttachments` → `pushSummary` (JolliPushOrchestrator.ts:154-263) and `pushPlanList`/`pushNoteList`/`cleanupOrphanedDocs` (:270-445) into this file, adapting:
- `ctx.storeSummary(updated, true)` → `storeSummary(updated, ctx.cwd, true, undefined, ctx.storage)` (CLI signature).
- `deleteFromJolli(...)` → `ctx.client.deleteDoc(id)`.
- `pushToJolli(ctx.baseUrl, ctx.apiKey, payload)` → `ctx.client.push(payload)`.
- plan content via `readPlanFromBranch(plan.slug, ctx.cwd, ctx.storage)`, note content via `note.content ?? readNoteFromBranch(note.id, ctx.cwd, ctx.storage)` (match vscode's choice at :332-356).
- `displayBase = ctx.baseUrl.replace(/\/+$/, "")`, `summaryUrl = `${displayBase}/articles?doc=${result.docId}``.

Then `pushBranchToJolli`:
```ts
export async function pushBranchToJolli(opts): Promise<PushBranchResult> {
	const client = opts.client ?? new JolliMemoryPushClient();
	const cwd = opts.cwd;
	try {
		const repoUrl = await getCanonicalRepoUrl(cwd);
		if (opts.space) { // proactively bind before pushing
			const jmSpaceId = await resolveSpaceId(client, opts.space);
			try { await client.createBinding({ repoUrl, repoName: deriveRepoNameFromUrl(repoUrl), jmSpaceId }); }
			catch (e) { if (!(e instanceof BindingAlreadyExistsError)) throw e; }
		}
		const base = opts.baseBranch ?? (await getDefaultBranch(cwd));
		const { summaries, missingCount } = await loadBranchSummaries(cwd, base);
		const storage = getActiveStorage();
		const ctx = { cwd, baseUrl: (await client.resolveBaseUrl()), repoUrl, client, storage };
		// Mirror LiveShareController.pushBranchMemoriesToSpace: cross-commit dedup, then
		// push oldest→newest passing each summary its OWNED (deduped) plans/notes.
		const { ownedPlans, ownedNotes } = assignOwnedAttachments(summaries);
		const urls: string[] = [];
		for (const s of summaries) {
			const attachments = { plans: ownedPlans.get(s.commitHash) ?? [], notes: ownedNotes.get(s.commitHash) ?? [] };
			const { summaryUrl } = await pushSummary(s, ctx, attachments); // BindingRequiredError/PluginOutdated propagate (fatal)
			urls.push(summaryUrl);
		}
		return { type: "pushed", pushed: summaries.length, skipped: missingCount, urls };
	} catch (e) {
		if (e instanceof BindingRequiredError) {
			const { spaces, defaultSpaceId } = await client.listSpaces();
			return { type: "binding_required", repoUrl: e.repoUrl, spaces, defaultSpaceId };
		}
		if (e instanceof NotAuthenticatedError) return { type: "error", message: e.message };
		return { type: "error", message: e instanceof Error ? e.message : String(e) };
	}
}
```
Add small helpers: `resolveSpaceId(client, space)` (numeric → number; else match `slug`/`name` from `listSpaces`), and expose `resolveBaseUrl()` on the client (returns the resolved base for URL building) — add it to `JolliMemoryPushClient` in this task if simpler, or compute the base in the orchestrator via `parseJolliApiKey`/config. Keep `setActiveStorage(await createStorage(cwd, cwd))` responsibility in the CALLER (command/MCP), so the orchestrator just reads `getActiveStorage()`.

> This is the largest task. If it grows unwieldy, split `pushSummary` (port) and `pushBranchToJolli` (new glue) into two commits within the task, but keep it one reviewable unit.

- [ ] **Step 4: Run — expect PASS.** Biome-check.

---

## Task 6: `jolli push` / `jolli spaces` / `jolli bind` CLI commands

**Files:**
- Create: `cli/src/commands/JolliCloudCommands.ts`, `cli/src/commands/JolliCloudCommands.test.ts`
- Modify: `cli/src/Api.ts`

**Interfaces produced:** `registerPushCommand(program)`, `registerSpacesCommand(program)`, `registerBindCommand(program)`.

- [ ] **Step 1: Write failing tests** — model on `PrDescriptionCommand.test.ts` (build a `Command`, `parseAsync`, capture `console.log`). Inject a fake `JolliMemoryPushClient` by spying on the orchestrator/client. Assert: `spaces --format json` prints the list; `push --format json` prints `{type:"pushed",...}`; `push` on binding_required prints `{type:"binding_required", spaces, ...}`; error path sets `process.exitCode = 1`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** all three in `JolliCloudCommands.ts`, following `PrDescriptionCommand.ts` conventions (`resolveProjectDir()` for `--cwd`, `setLogDir`, `Option(...).choices(["json"])`, error → `{type:"error",message}` + `process.exitCode=1`). Each command sets up storage first: `setActiveStorage(await createStorage(projectDir, projectDir))`.
- `jolli push [--base <b>] [--space <id|slug>] [--format json]` → `pushBranchToJolli({ cwd, baseBranch, space })`; render the `pushed`/`binding_required`/`error` union (human text lists spaces on binding_required).
- `jolli spaces [--format json]` → `new JolliMemoryPushClient().listSpaces()`.
- `jolli bind --space <id|slug> [--repo-name <n>]` → resolve repoUrl via `getCanonicalRepoUrl`, resolve space id, `createBinding`; handle `BindingAlreadyExistsError` with a friendly message.

- [ ] **Step 4: Register in `cli/src/Api.ts`**: import the three `register*` functions; call them next to `registerPrDescriptionCommand(program);`; add `"push"`, `"spaces"`, `"bind"` to the `MEMORY_COMMAND_NAMES` set (near line 152) so the help-grouping invariant test passes.

- [ ] **Step 5: Run — expect PASS** (`npm run test -w @jolli.ai/cli -- src/commands/JolliCloudCommands.test.ts` and `src/Api.test.ts`). Biome-check.

---

## Task 7: MCP tools `push_memory` / `list_spaces` / `bind_space`

**Files:**
- Modify: `cli/src/mcp/McpTools.ts`, `cli/src/mcp/McpServer.ts`, `cli/src/mcp/McpTools.test.ts`, `cli/src/mcp/McpServer.test.ts`

**Interfaces produced:** `runPushMemory(cwd, { baseBranch?, space? })`, `runListSpaces(cwd)`, `runBindSpace(cwd, { space })` — all returning plain JSON-serializable objects, delegating to the orchestrator/client (same setup: `setActiveStorage(await createStorage(cwd, cwd))` — note `startMcpServer` already does this once, so the handlers can rely on the active storage).

- [ ] **Step 1: Write failing tests** in `McpTools.test.ts` (mock client): `runListSpaces` returns `{spaces, defaultSpaceId}`; `runPushMemory` returns the pushed/binding_required union.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** handlers in `McpTools.ts`; add three `TOOL_DEFINITIONS` entries + dispatch cases in `McpServer.ts`:
- `push_memory` inputs `{ baseBranch?: string, space?: string }` → `pushBranchToJolli({ cwd, baseBranch, space })`.
- `list_spaces` inputs `{}` → `runListSpaces`.
- `bind_space` inputs `{ space: string }` (required) → resolve + `createBinding`.

- [ ] **Step 4: Update `McpServer.test.ts`** tool-count/dispatch assertions to include the three new tools (exact-set assertion, alphabetically placed) — mirror how Q1's `queue_status` update was done.

- [ ] **Step 5: Run — expect PASS.** Biome-check.

---

## Task 8: `jolli-pr` skill Step 5 (offer to push)

**Files:**
- Modify: `cli/src/install/SkillInstaller.ts`, `cli/src/install/SkillInstaller.test.ts`

- [ ] **Step 1: Write failing test** in `SkillInstaller.test.ts`:
```ts
it("Step 5 offers to push memory to Jolli and handles space binding", () => {
	const pr = buildPrSkillTemplate();
	expect(pr).toContain("## Step 5: Push memory to Jolli");
	expect(pr).toContain("push_memory");
	expect(pr).toContain("binding_required");
	expect(pr.indexOf("## Step 4")).toBeLessThan(pr.indexOf("## Step 5"));
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — append Step 5 to `buildPrSkillTemplate` after Step 4. All backticks inside the template literal MUST stay escaped as `` \` `` and `${` as `\${` (builder-backtick trap). Content:
```
## Step 5: Push memory to Jolli (optional)

After reporting the PR URL, ask the user: "Push this branch's memory to Jolli?"
Only proceed if they say yes.

Preferred (MCP): call \`push_memory\` (on Claude Code \`mcp__jollimemory__push_memory\`),
optionally \`{"space": "<name-or-id>"}\` if the user named a space, else \`{}\`.
Fallback (CLI): \`"$HOME/.jolli/jollimemory/run-cli" push --format json\` (add \`--space <id|slug>\` if named).

- \`{ "type": "pushed", "pushed": N, "urls": [...] }\` → tell the user N memories were pushed; share the article URLs.
- \`{ "type": "binding_required", "repoUrl": "...", "spaces": [ { "id", "name", "slug" } ], "defaultSpaceId": N }\`
  → this repo isn't linked to a Jolli memory space yet. Present the \`spaces\` list and let the user pick one
  (or use the space they already named). Then bind + retry:
  MCP: \`bind_space\` with \`{"space": "<id-or-slug>"}\`, then call \`push_memory\` again.
  CLI: \`"$HOME/.jolli/jollimemory/run-cli" bind --space <id|slug>\`, then \`... push --format json\`.
  The binding is remembered server-side per repo, so future pushes won't ask again.
- \`{ "type": "error", "message": "..." }\` → relay it (e.g. not signed in → sign in / \`jolli auth login\`; outdated → update). Do not retry blindly.
```

- [ ] **Step 4: Run — expect PASS.** Biome-check.

---

## Task 9: Full verification + single commit

- [ ] **Step 1:** Run the full gate with the env workaround:
```bash
GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all GIT_CONFIG_KEY_1=core.excludesFile GIT_CONFIG_VALUE_1=/dev/null npm run all
```
Expected: build/typecheck/lint/tests pass; the only tolerated failures are the pre-existing GitClient/KBPathResolver env flakes. If any NEW file dips below the coverage floor, add the missing-branch test rather than an ignore block. If `PrDescriptionCommand`/other `PrDescriptionResult` consumers break on typecheck, they don't (this feature doesn't change that type).

- [ ] **Step 2:** Squash all task commits into one signed commit (controller does this):
```bash
git reset --soft <BASE>   # BASE = commit before Task 1
git add -A
git commit -s -m "feat(cli): push JolliMemory to Jolli cloud + memory-space selection from CLI/MCP

Add jolli push/spaces/bind commands and push_memory/list_spaces/bind_space MCP
tools that push a branch's summaries to Jolli, choose the target memory space
(list → user picks → bind), and write jolliDocId/jolliDocUrl back into each
summary. jolli-pr gains a Step 5 that offers to push after the PR is created.
VS Code push path and the PR body are unchanged."
```
No Claude co-author trailer.

---

## Self-Review

**1. Spec coverage:**
- CLI push/spaces/bind → Task 6. MCP push_memory/list_spaces/bind_space → Task 7. ✅
- JolliMemoryPushClient (list/bind/push/delete + errors + headers, real `{binding,repoFolder}` shape) → Tasks 2-3. ✅
- Repo-identity/title parity (title-stability constraint) → Task 1 + `buildPushTitle` reuse + Task 5 payload. ✅
- Push orchestration + docId write-back (summary + plan/note ids, orphan cleanup, re-push docId) → Tasks 4-5. ✅
- jolli-pr Step 5 (ask-first, binding flow, error relay) → Task 8. ✅
- Always send repoUrl / unbound→selection (no org default) → Task 5 `pushBranchToJolli`. ✅
- PR body unchanged / VS Code display via shared field → not touched (no task modifies PR builders or vscode), as specified. ✅
- Auth/`x-jolli-client`/tenant/org headers, API-key parser reuse → Task 2. ✅
- Testing + coverage floor + single signed commit → per-task tests + Task 9. ✅

**2. Placeholder scan:** Port tasks cite exact vscode `file:line` ranges + the specific adaptations (imports, `fetch`, CLI `storeSummary` signature, `deleteDoc`), not "port it somehow." New glue (client, commands, MCP, Step 5) has complete code. The only deferred literal is confirming a couple of expected-string values against the authoritative vscode source while porting (Task 1) — an instruction to pin, not a gap.

**3. Type consistency:** `JolliMemoryPushClient` methods/errors named identically across Tasks 2-3-5-6-7. `pushBranchToJolli` return union (`pushed`/`binding_required`/`error`) used the same in Tasks 5-6-7-8. `PushPayload`/`PushResult` field names match the wire (`docId`, `summaryJson`, `relativePath`). Write-back fields (`jolliDocId`/`jolliDocUrl`/`jolliPlanDocId`/`jolliNoteDocId`) match `cli/src/Types.ts`.
