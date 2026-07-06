# Create PR → push memories to Jolli Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a signed-in user clicks Create PR / Update PR in the Create PR pane, after the PR is created/updated, push the branch's memories to the bound Jolli Space as articles.

**Architecture:** Orchestrate in the panel layer (`CreatePrWebviewPanel`), mirroring `SummaryWebviewPanel.runJolliPush` (apiKey + `resolveBinding` chooser + toasts). The submit handlers return a `"succeeded" | "failed"` signal; on success + signed-in the panel runs a new branch content-push. Branch-wide push + cross-commit plan/note dedup lives in `LiveShareController` (dedup extracted from the existing live-share path). No live-share link is minted.

**Tech Stack:** TypeScript, VS Code extension host (esbuild → CJS), Vitest.

## Global Constraints

- DCO sign-off on every commit: `git commit -s`. (Repo CI rejects PRs without `Signed-off-by:`.)
- No `Co-Authored-By: Claude …` trailer and no "🤖 Generated with …" footer in commits.
- `npm run all` must pass before commit (clean → build → lint → test).
- Biome: tabs, 4-wide, 120 column limit; `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. CI runs `biome check --error-on-warnings` (warnings fail).
- VS Code webview CSP forbids inline `style=""` and inline event handlers — not relevant here (no HTML changes), but keep in mind.
- Reads come from the orphan branch; `pushSummaryWithAttachments` handles storage. Do not add git plumbing.
- Toast copy reuses the exact wording from `SummaryWebviewPanel.runJolliPush` for the binding-chooser outcomes so the two surfaces are identical.

---

## File Structure

- **Modify** `vscode/src/services/LiveShareController.ts` — extract `assignOwnedAttachments` from `pushSubjectAndBuildRef`; add exported `pushBranchMemoriesToSpace` + `PushBranchMemoriesResult`.
- **Modify** `vscode/src/services/LiveShareController.test.ts` — tests for `pushBranchMemoriesToSpace`; assert `pushSubjectAndBuildRef` refs unchanged.
- **Modify** `vscode/src/services/PrCommentService.ts` — `handleCreatePr` / `handleUpdatePrWithPush` return `PrSubmitOutcome` (`"succeeded" | "failed"`).
- **Modify** `vscode/src/services/PrCommentService.test.ts` — assert the return value on each branch.
- **Modify** `vscode/src/views/CreatePrWebviewPanel.ts` — store `bridge` + `signedIn`; run the push after a successful submit; new `pushMemoriesToSpace()`.
- **Modify** `vscode/src/views/CreatePrWebviewPanel.test.ts` — signed-in/out gating, outcome gating, toast/chooser branches.

---

## Task 1: Branch content-push + shared dedup helper (`LiveShareController`)

**Files:**
- Modify: `vscode/src/services/LiveShareController.ts`
- Test: `vscode/src/services/LiveShareController.test.ts`

**Interfaces:**
- Consumes: `pushSummaryWithAttachments(summary, ctx, attachments?, options?, retried?)`, `PushContext`, `PushAttachmentFailure`, `BindingOutcome` (from `JolliPushOrchestrator.js`); `LiveShareDeps { bridge; workspaceRoot; apiKey; resolveBinding }`, `resolveBaseUrl`, `buildPushContext`, `loadSubjectSummaries`, `withSubjectLock` (already in this file); `getCanonicalRepoUrl` (from `../util/GitRemoteUtils.js`).
- Produces:
  ```ts
  export interface PushBranchMemoriesResult {
    readonly pushedCount: number;
    readonly attachmentCount: number;
    readonly attachmentFailures: ReadonlyArray<PushAttachmentFailure>;
  }
  export function pushBranchMemoriesToSpace(deps: LiveShareDeps, branch: string): Promise<PushBranchMemoriesResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `vscode/src/services/LiveShareController.test.ts`. The file already mocks `pushSummaryWithAttachments` as `mockPush`, `loadBranchSummaries` as `mockLoad`, `getCanonicalRepoUrl`, and `parseJolliApiKey` as `mockParseKey`. Add `pushBranchMemoriesToSpace` to the import from `./LiveShareController.js`, import `ShareBindingError` from `./JolliPushOrchestrator.js` (it is NOT mocked away — add it to the existing `vi.mock("./JolliPushOrchestrator.js", …)` factory), and add this block:

```ts
// Extend the JolliPushOrchestrator mock factory so ShareBindingError is a real class:
// vi.mock("./JolliPushOrchestrator.js", () => ({
//   pushSummaryWithAttachments: mockPush,
//   ShareBindingError: class ShareBindingError extends Error {
//     constructor(readonly outcome: string) { super(outcome); this.name = "ShareBindingError"; }
//   },
// }));
import { pushBranchMemoriesToSpace } from "./LiveShareController.js";
import { ShareBindingError } from "./JolliPushOrchestrator.js";

describe("pushBranchMemoriesToSpace", () => {
	const deps = () => ({
		bridge: { storeSummary: vi.fn() } as never,
		workspaceRoot: "/repo",
		apiKey: "sk-jol-x",
		resolveBinding: vi.fn(),
	});

	beforeEach(() => {
		mockParseKey.mockReturnValue({ u: "https://acme.jolli.ai" });
	});

	it("pushes every branch summary and returns aggregate counts", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A", [plan("p", "2026-01-01")]), summary("B")] });
		mockPush
			.mockResolvedValueOnce({
				pushedDoc: { summaryDocId: 1001, plans: [{ slug: "p", docId: 7, url: "u" }], notes: [] },
				attachmentFailures: [], attachmentCount: 1,
			})
			.mockResolvedValueOnce({
				pushedDoc: { summaryDocId: 1002, plans: [], notes: [] },
				attachmentFailures: [], attachmentCount: 0,
			});

		const result = await pushBranchMemoriesToSpace(deps(), "feature/x");

		expect(mockPush).toHaveBeenCalledTimes(2);
		expect(result.pushedCount).toBe(2);
		expect(result.attachmentCount).toBe(1);
		expect(result.attachmentFailures).toEqual([]);
	});

	it("dedupes a plan recurring across commits to one owner push (latest revision)", async () => {
		// Same plan slug on both commits; the newer updatedAt wins and is pushed under its owner only.
		mockLoad.mockResolvedValue({
			summaries: [summary("A", [plan("p", "2026-01-01")]), summary("B", [plan("p", "2026-02-01")])],
		});
		mockPush.mockResolvedValue({
			pushedDoc: { summaryDocId: 0, plans: [], notes: [] }, attachmentFailures: [], attachmentCount: 0,
		});

		await pushBranchMemoriesToSpace(deps(), "feature/x");

		// Exactly one of the two summary pushes carries the plan (the B owner); the other carries none.
		const attachmentArgs = mockPush.mock.calls.map((c) => c[2] as { plans: unknown[]; notes: unknown[] });
		const withPlan = attachmentArgs.filter((a) => a.plans.length === 1);
		expect(withPlan).toHaveLength(1);
	});

	it("is non-strict: omits strictAttachments so attachment failures are collected, not thrown", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A")] });
		mockPush.mockResolvedValue({
			pushedDoc: { summaryDocId: 1001, plans: [], notes: [] },
			attachmentFailures: [{ label: 'plan "x"', message: "unreadable" }], attachmentCount: 0,
		});

		const result = await pushBranchMemoriesToSpace(deps(), "feature/x");

		// options arg (4th param) must NOT set strictAttachments.
		const optionsArg = mockPush.mock.calls[0][3] as { strictAttachments?: boolean } | undefined;
		expect(optionsArg?.strictAttachments).toBeUndefined();
		expect(result.attachmentFailures).toHaveLength(1);
		expect(result.pushedCount).toBe(1);
	});

	it("throws NothingToShareError when the branch has no summaries", async () => {
		mockLoad.mockResolvedValue({ summaries: [] });
		await expect(pushBranchMemoriesToSpace(deps(), "feature/x")).rejects.toThrow(NothingToShareError);
	});

	it("stops and propagates when a summary push throws (e.g. binding cancelled)", async () => {
		mockLoad.mockResolvedValue({ summaries: [summary("A"), summary("B")] });
		mockPush.mockRejectedValueOnce(new ShareBindingError("cancelled"));

		await expect(pushBranchMemoriesToSpace(deps(), "feature/x")).rejects.toBeInstanceOf(ShareBindingError);
		expect(mockPush).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/services/LiveShareController.test.ts -t "pushBranchMemoriesToSpace"`
Expected: FAIL — `pushBranchMemoriesToSpace is not a function` (not yet exported).

- [ ] **Step 3: Extract `assignOwnedAttachments` from `pushSubjectAndBuildRef`**

In `vscode/src/services/LiveShareController.ts`, replace steps 1–2 (the `planWinners`/`noteWinners` computation and the `ownedPlans`/`ownedNotes` assignment) inside `pushSubjectAndBuildRef` with a call to a new private helper. Add the helper directly above `pushSubjectAndBuildRef`:

```ts
/**
 * Cross-commit dedup: pick the winner revision per plan base-slug / note id
 * (latest updatedAt), remember the owner commit + any known docId to reuse, and
 * assign each winner (docId injected) to its owner commit. Shared by the
 * live-share push and the Create-PR branch push so both dedup identically.
 *
 * Also returns the seed docId maps (winners that already have a known docId) so
 * `pushSubjectAndBuildRef` can pre-seed its `covered` resolution exactly as
 * before — the Create-PR path ignores these (it builds no `covered`).
 */
function assignOwnedAttachments(subjectSummaries: ReadonlyArray<CommitSummary>): {
	ownedPlans: Map<string, PlanReference[]>;
	ownedNotes: Map<string, NoteReference[]>;
	seedPlanDocIds: Map<string, number>;
	seedNoteDocIds: Map<string, number>;
} {
	const planWinners = new Map<string, Winner<PlanReference>>();
	const noteWinners = new Map<string, Winner<NoteReference>>();
	for (const summary of subjectSummaries) {
		for (const plan of summary.plans ?? []) {
			const key = planBaseKey(plan.slug);
			const prev = planWinners.get(key);
			const seedDocId = plan.jolliPlanDocId ?? prev?.seedDocId;
			if (!prev || Date.parse(plan.updatedAt) >= Date.parse(prev.ref.updatedAt)) {
				planWinners.set(key, { ref: plan, ownerCommit: summary.commitHash, seedDocId });
			} else if (seedDocId !== prev.seedDocId) {
				planWinners.set(key, { ...prev, seedDocId });
			}
		}
		for (const note of summary.notes ?? []) {
			const prev = noteWinners.get(note.id);
			const seedDocId = note.jolliNoteDocId ?? prev?.seedDocId;
			if (!prev || Date.parse(note.updatedAt) >= Date.parse(prev.ref.updatedAt)) {
				noteWinners.set(note.id, { ref: note, ownerCommit: summary.commitHash, seedDocId });
			} else if (seedDocId !== prev.seedDocId) {
				noteWinners.set(note.id, { ...prev, seedDocId });
			}
		}
	}

	const ownedPlans = new Map<string, PlanReference[]>();
	const ownedNotes = new Map<string, NoteReference[]>();
	const pushInto = <T>(map: Map<string, T[]>, commit: string, item: T): void => {
		const arr = map.get(commit);
		if (arr) arr.push(item);
		else map.set(commit, [item]);
	};
	for (const w of planWinners.values()) {
		pushInto(ownedPlans, w.ownerCommit, w.seedDocId ? { ...w.ref, jolliPlanDocId: w.seedDocId } : w.ref);
	}
	for (const w of noteWinners.values()) {
		pushInto(ownedNotes, w.ownerCommit, w.seedDocId ? { ...w.ref, jolliNoteDocId: w.seedDocId } : w.ref);
	}

	const seedPlanDocIds = new Map<string, number>();
	const seedNoteDocIds = new Map<string, number>();
	for (const w of planWinners.values()) if (w.seedDocId) seedPlanDocIds.set(planBaseKey(w.ref.slug), w.seedDocId);
	for (const [id, w] of noteWinners) if (w.seedDocId) seedNoteDocIds.set(id, w.seedDocId);

	return { ownedPlans, ownedNotes, seedPlanDocIds, seedNoteDocIds };
}
```

Then in `pushSubjectAndBuildRef`, replace its steps 1–2 blocks (the winner computation, the owned-attachment assignment, AND the pre-seed at old lines 191–194) with a single call. The result is byte-equivalent — the pre-seed maps are now returned by the helper:

```ts
	// 1–2. Cross-commit dedup: winners + owned attachments + seed docId maps.
	const { ownedPlans, ownedNotes, seedPlanDocIds, seedNoteDocIds } = assignOwnedAttachments(subjectSummaries);

	// 3. Push each summary oldest→newest with only its owned attachments. Capture the
	//    pushed summary docId per commit and accumulate the branch-wide attachment map,
	//    pre-seeded with any known docIds so a doc pushed under another commit still links.
	const planDocIdByBase = new Map<string, number>(seedPlanDocIds);
	const noteDocIdById = new Map<string, number>(seedNoteDocIds);
```

**Do not** change anything else in `pushSubjectAndBuildRef`. Verify the existing `generateLiveShare`/`reconcileLiveShare` tests still pass in Step 6 — they lock the ref output.

- [ ] **Step 4: Add `pushBranchMemoriesToSpace`**

Add near the end of `vscode/src/services/LiveShareController.ts` (after `reconcileLiveShare`). Also add the `PushAttachmentFailure` type to the existing type-only import from `./JolliPushOrchestrator.js`:

```ts
/** Aggregate outcome of a branch content-push (no share link). */
export interface PushBranchMemoriesResult {
	readonly pushedCount: number;
	readonly attachmentCount: number;
	readonly attachmentFailures: ReadonlyArray<PushAttachmentFailure>;
}

/**
 * Pushes all of a branch's memories (base..HEAD) to the bound Space as articles,
 * WITHOUT creating a share link. Reuses the same cross-commit plan/note dedup as
 * {@link generateLiveShare}. Best-effort on attachments (non-strict): a single
 * unreadable plan/note is collected into `attachmentFailures`, not thrown. Fatal
 * binding / plugin errors propagate (BindingRequiredError → ShareBindingError via
 * the injected `resolveBinding`). Throws {@link NothingToShareError} when the
 * branch has no summaries.
 */
export function pushBranchMemoriesToSpace(deps: LiveShareDeps, branch: string): Promise<PushBranchMemoriesResult> {
	return withSubjectLock(deps.workspaceRoot, branch, async () => {
		const baseUrl = resolveBaseUrl(deps.apiKey);
		const repoUrl = await getCanonicalRepoUrl(deps.workspaceRoot);
		const subjectSummaries = await loadSubjectSummaries(deps, undefined);
		if (subjectSummaries.length === 0) throw new NothingToShareError(branch);

		const ctx = buildPushContext(deps, baseUrl, repoUrl);
		const { ownedPlans, ownedNotes } = assignOwnedAttachments(subjectSummaries);

		let pushedCount = 0;
		let attachmentCount = 0;
		const attachmentFailures: PushAttachmentFailure[] = [];
		for (const summary of subjectSummaries) {
			const result = await pushSummaryWithAttachments(summary, ctx, {
				plans: ownedPlans.get(summary.commitHash) ?? [],
				notes: ownedNotes.get(summary.commitHash) ?? [],
			});
			pushedCount += 1;
			attachmentCount += result.attachmentCount;
			attachmentFailures.push(...result.attachmentFailures);
		}
		return { pushedCount, attachmentCount, attachmentFailures };
	});
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm run test:vscode -- src/services/LiveShareController.test.ts -t "pushBranchMemoriesToSpace"`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Run the full LiveShareController suite (regression on the extraction)**

Run: `npm run test:vscode -- src/services/LiveShareController.test.ts`
Expected: PASS — the existing `generateLiveShare` / `reconcileLiveShare` ref-output tests confirm `assignOwnedAttachments` extraction changed no behavior.

- [ ] **Step 7: Commit**

```bash
git add vscode/src/services/LiveShareController.ts vscode/src/services/LiveShareController.test.ts
git commit -s -m "Add pushBranchMemoriesToSpace for branch content-push (no share link)"
```

---

## Task 2: Submit handlers return a success signal (`PrCommentService`)

**Files:**
- Modify: `vscode/src/services/PrCommentService.ts`
- Test: `vscode/src/services/PrCommentService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PrSubmitOutcome = "succeeded" | "failed";
  export function handleCreatePr(title, body, cwd, postMessage, expectedBranch?): Promise<PrSubmitOutcome>;
  export function handleUpdatePrWithPush(title, body, cwd, postMessage, summaryBranch?): Promise<PrSubmitOutcome>;
  ```
- Consumes: (unchanged internals — `findPrForBranch`, `pushBranch`, `createPr`, `syncPrTitleBody`, `handleCheckPrStatus`).

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/services/PrCommentService.test.ts` (it already mocks `gh`/`git` via the subprocess layer). Add cases asserting the resolved value:

```ts
describe("handleCreatePr return value", () => {
	it('resolves "succeeded" after a fresh PR is created', async () => {
		// Arrange: current branch matches, no existing PR, push ok, create ok
		// (reuse the suite's existing success-path setup helpers).
		const outcome = await handleCreatePr("t", "b", "/repo", vi.fn(), "feature/x");
		expect(outcome).toBe("succeeded");
	});

	it('resolves "failed" when blocked by the cross-branch guard', async () => {
		// Arrange: getCurrentBranch → "other" so expectedBranch !== current.
		const outcome = await handleCreatePr("t", "b", "/repo", vi.fn(), "feature/x");
		expect(outcome).toBe("failed");
	});

	it('resolves "failed" when the push is cancelled', async () => {
		// Arrange: pushBranch → non-fast-forward, gate declined → "cancelled".
		const outcome = await handleCreatePr("t", "b", "/repo", vi.fn(), "feature/x");
		expect(outcome).toBe("failed");
	});
});

describe("handleUpdatePrWithPush return value", () => {
	it('resolves "succeeded" after an existing PR is updated', async () => {
		const outcome = await handleUpdatePrWithPush("t", "b", "/repo", vi.fn(), "feature/x");
		expect(outcome).toBe("succeeded");
	});

	it('resolves "failed" when lookup errors', async () => {
		const outcome = await handleUpdatePrWithPush("t", "b", "/repo", vi.fn(), "feature/x");
		expect(outcome).toBe("failed");
	});
});
```

> When implementing, wire each `describe` to the mock arrangement the existing suite already uses for that path (search the test file for the "creates a new PR" / "cross-branch" / "cancelled" / "updates PR" / "lookupError" cases and reuse their `mockExecGh`/`mockExecGit`/`gateForcePush` setup). Every existing test that calls these two functions keeps passing because the added return value is ignored where not asserted.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/services/PrCommentService.test.ts -t "return value"`
Expected: FAIL — functions currently resolve `undefined`, not `"succeeded"`/`"failed"`.

- [ ] **Step 3: Add the `PrSubmitOutcome` type**

In `vscode/src/services/PrCommentService.ts`, above `handleCreatePr` (near the other submit-time helpers at line ~661):

```ts
/** Result of a Create/Update-PR submit: whether the branch was pushed and the PR create/update landed. */
export type PrSubmitOutcome = "succeeded" | "failed";
```

- [ ] **Step 4: Change `handleCreatePr` return type + all returns**

Change the signature to `): Promise<PrSubmitOutcome> {`. Then at each return point:
- detached-HEAD block → `return "failed";`
- cross-branch block → `return "failed";`
- `preLookup.kind === "lookupError"` → `return "failed";`
- create→update fallback: not confirmed → `return "failed";`; `updatePush === "cancelled"` → `return "failed";`; after `showOpenPrToast(…)` in the fallback success → `return "succeeded";`
- `pushResult === "cancelled"` → `return "failed";`
- fresh-create success tail: after `showOpenPrToast("Pull request created!", prUrl);` add `return "succeeded";`
- `catch` block: after `showErrorMessage` add `return "failed";`

- [ ] **Step 5: Change `handleUpdatePrWithPush` return type + all returns**

Change the signature to `): Promise<PrSubmitOutcome> {`. Then:
- detached-HEAD block → `return "failed";`
- cross-branch block → `return "failed";`
- `lookup.kind === "lookupError"` → `return "failed";`
- `lookup.kind === "found"`: `pushResult === "cancelled"` → `return "failed";`; after `showOpenPrToast(\`Updated PR #\${pr.number}\`, pr.url);` → `return "succeeded";`
- noPr: not confirmed → `return "failed";`; `pushResult === "cancelled"` → `return "failed";`; after `showOpenPrToast("Pull request created!", prUrl);` → `return "succeeded";`
- `catch` block: after `showErrorMessage` add `return "failed";`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/services/PrCommentService.test.ts`
Expected: PASS (new return-value cases + all existing cases).

- [ ] **Step 7: Commit**

```bash
git add vscode/src/services/PrCommentService.ts vscode/src/services/PrCommentService.test.ts
git commit -s -m "Return succeeded/failed outcome from Create/Update PR handlers"
```

---

## Task 3: Panel orchestration — push memories after a successful submit (`CreatePrWebviewPanel`)

**Files:**
- Modify: `vscode/src/views/CreatePrWebviewPanel.ts`
- Test: `vscode/src/views/CreatePrWebviewPanel.test.ts`

**Interfaces:**
- Consumes: `pushBranchMemoriesToSpace`, `PushBranchMemoriesResult` (Task 1); `handleCreatePr`/`handleUpdatePrWithPush` returning `PrSubmitOutcome` (Task 2); `ShareBindingError`, `PushAttachmentFailure`, `type BindingOutcome` (from `../services/JolliPushOrchestrator.js`); `PluginOutdatedError`, `parseJolliApiKey` (from `../services/JolliPushService.js`); `loadGlobalConfig` (from `../util/WorkspaceUtils.js`); `deriveRepoNameFromUrl`, `getCanonicalRepoUrl` (from `../util/GitRemoteUtils.js`); `BindingChooserWebviewPanel` (from `./BindingChooserWebviewPanel.js`).
- Produces: no new exports (private method `pushMemoriesToSpace`).

- [ ] **Step 1: Write the failing tests**

In `vscode/src/views/CreatePrWebviewPanel.test.ts`, extend the hoisted mocks and add a `pushBranchMemoriesToSpace` mock + supporting module mocks, then add cases. Add to the `vi.hoisted` block: `handleCreatePr`/`handleUpdatePrWithPush` should now `mockResolvedValue("succeeded")`, and add `pushBranchMemories: vi.fn().mockResolvedValue({ pushedCount: 2, attachmentCount: 0, attachmentFailures: [] })`, `openAndAwait: vi.fn().mockResolvedValue({ kind: "selected" })`. Add these module mocks:

```ts
vi.mock("../services/LiveShareController.js", () => ({ pushBranchMemoriesToSpace: mocks.pushBranchMemories }));
vi.mock("../services/JolliPushOrchestrator.js", () => ({
	ShareBindingError: class ShareBindingError extends Error {
		constructor(readonly outcome: string) { super(outcome); this.name = "ShareBindingError"; }
	},
}));
vi.mock("../services/JolliPushService.js", () => ({
	parseJolliApiKey: () => ({ u: "https://acme.jolli.ai" }),
	PluginOutdatedError: class PluginOutdatedError extends Error {},
}));
vi.mock("../util/WorkspaceUtils.js", () => ({ loadGlobalConfig: vi.fn().mockResolvedValue({ jolliApiKey: "sk-jol-x" }) }));
vi.mock("../util/GitRemoteUtils.js", () => ({
	deriveRepoNameFromUrl: () => "repo",
	getCanonicalRepoUrl: vi.fn().mockResolvedValue("https://github.com/acme/repo"),
}));
vi.mock("./BindingChooserWebviewPanel.js", () => ({
	BindingChooserWebviewPanel: { openAndAwait: mocks.openAndAwait, dispose: vi.fn() },
}));
```

Add a helper to drive a `createPr` message through an open panel (the suite already builds panels via `created[]`), then the cases:

```ts
describe("push memories to Space after a successful submit", () => {
	it("pushes when signed in and the submit succeeds", async () => {
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ true);
		await created[0].onMsg({ command: "createPr" });
		await flush(); // await microtasks
		expect(mocks.pushBranchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRoot: "/repo", apiKey: "sk-jol-x" }),
			"feature/x",
		);
	});

	it("does NOT push when signed out", async () => {
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(mocks.pushBranchMemories).not.toHaveBeenCalled();
	});

	it("does NOT push when the submit failed", async () => {
		mocks.handleCreatePr.mockResolvedValue("failed");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(mocks.pushBranchMemories).not.toHaveBeenCalled();
	});

	it("shows a success toast with the pushed count", async () => {
		mocks.pushBranchMemories.mockResolvedValue({ pushedCount: 2, attachmentCount: 0, attachmentFailures: [] });
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("Shared 2 memories to your Jolli Space"),
		);
	});

	it("resolveBinding opens the binding chooser and a selection lets the push proceed", async () => {
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		const deps = mocks.pushBranchMemories.mock.calls[0][0];
		const outcome = await deps.resolveBinding("https://github.com/acme/repo");
		expect(mocks.openAndAwait).toHaveBeenCalled();
		expect(outcome).toEqual({ status: "bound" });
	});

	it("shows the cancelled-binding error when the push throws ShareBindingError('cancelled')", async () => {
		const { ShareBindingError } = await import("../services/JolliPushOrchestrator.js");
		mocks.pushBranchMemories.mockRejectedValue(new ShareBindingError("cancelled"));
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Push cancelled"),
		);
	});
});
```

Add a `flush` helper at the top of the test file if absent: `const flush = () => new Promise((r) => setTimeout(r, 0));`. Ensure the suite has `bridge`/`uri` fixtures (reuse existing ones; `bridge` needs `storeSummary: vi.fn()` and `getCurrentBranch`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/CreatePrWebviewPanel.test.ts -t "push memories to Space"`
Expected: FAIL — `pushBranchMemories` never called (panel does not push yet).

- [ ] **Step 3: Add imports + store `bridge` and `signedIn`**

In `vscode/src/views/CreatePrWebviewPanel.ts` add imports:

```ts
import { loadGlobalConfig } from "../util/WorkspaceUtils.js";
import { parseJolliApiKey, PluginOutdatedError } from "../services/JolliPushService.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../util/GitRemoteUtils.js";
import { BindingChooserWebviewPanel } from "./BindingChooserWebviewPanel.js";
import { pushBranchMemoriesToSpace } from "../services/LiveShareController.js";
import { ShareBindingError } from "../services/JolliPushOrchestrator.js";
```

Add an instance field and thread `bridge` through the constructor:

```ts
	/** Tracks Jolli sign-in state so a successful submit knows whether to push memories. Kept in sync via notifyAuthChanged + render. */
	private signedIn = false;
```

Change the constructor signature to accept the bridge:

```ts
	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly workspaceRoot: string,
		private readonly extensionUri: vscode.Uri,
		private readonly bridge: JolliMemoryBridge,
	) {
```

In `show()`, pass the bridge when constructing:

```ts
		const self = new CreatePrWebviewPanel(panel, workspaceRoot, extensionUri, bridge);
```

In `render()`, after `this.vm = vm;` add:

```ts
		this.signedIn = vm.signedIn === true;
```

In `notifyAuthChanged()`, before/after the existing `postMessage`, sync the instance flag:

```ts
	static notifyAuthChanged(authenticated: boolean): void {
		if (CreatePrWebviewPanel.current) CreatePrWebviewPanel.current.signedIn = authenticated;
		void CreatePrWebviewPanel.current?.panel.webview.postMessage({ command: "authChanged", authenticated });
	}
```

- [ ] **Step 4: Capture the submit outcome and run the push**

In `handle()`'s `case "createPr"`, replace the `if (this.vm.existingPr) { … } else { … }` block with an outcome-capturing version, still inside the existing `try { … } finally { this.prActionInFlight = false; }`:

```ts
					const outcome = this.vm.existingPr
						? await handleUpdatePrWithPush(title, body, this.workspaceRoot, post, this.vm.branch)
						: await handleCreatePr(title, body, this.workspaceRoot, post, this.vm.branch);
					// Signed-in: after the PR is live, share the branch's memories to the
					// user's Jolli Space (the pane's share notice promises this). A push
					// failure never rolls back the already-created PR.
					if (outcome === "succeeded" && this.signedIn) {
						await this.pushMemoriesToSpace();
					}
```

- [ ] **Step 5: Add the `pushMemoriesToSpace` method**

Add as a private method on the class (mirrors `SummaryWebviewPanel.runJolliPush` — same apiKey guard, same `resolveBinding` chooser wiring, same `ShareBindingError` branches):

```ts
	/**
	 * Pushes the branch's memories to the bound Jolli Space as articles (no share
	 * link). Runs only after a successful Create/Update PR when signed in. UI —
	 * apiKey guard, binding-chooser wiring, and toasts — mirrors
	 * SummaryWebviewPanel.runJolliPush so both surfaces behave identically. A push
	 * failure is surfaced as a non-blocking toast; the PR is already created.
	 */
	private async pushMemoriesToSpace(): Promise<void> {
		if (!this.vm) return;
		const branch = this.vm.branch;
		const config = await loadGlobalConfig();
		const apiKey = config.jolliApiKey;
		if (!apiKey) {
			vscode.window.showWarningMessage("Please configure your Jolli API Key first (STATUS panel → ...).");
			return;
		}
		const resolvedBaseUrl = parseJolliApiKey(apiKey)?.u;
		if (!resolvedBaseUrl) {
			vscode.window.showWarningMessage(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
			);
			return;
		}
		const baseUrl = resolvedBaseUrl.replace(/\/+$/, "");

		try {
			const result = await pushBranchMemoriesToSpace(
				{
					bridge: this.bridge,
					workspaceRoot: this.workspaceRoot,
					apiKey,
					resolveBinding: async (repo) => {
						const outcome = await BindingChooserWebviewPanel.openAndAwait({
							extensionUri: this.extensionUri,
							baseUrl,
							apiKey,
							repoUrl: repo,
							suggestedRepoName: deriveRepoNameFromUrl(repo),
						});
						if (outcome.kind === "selected") return { status: "bound" };
						if (outcome.kind === "anotherOpen") return { status: "anotherOpen" };
						return { status: "cancelled" };
					},
				},
				branch,
			);

			const n = result.pushedCount;
			const noun = n === 1 ? "memory" : "memories";
			if (result.attachmentFailures.length > 0) {
				vscode.window.showWarningMessage(
					`Shared ${n} ${noun} to your Jolli Space, but ${result.attachmentFailures.length} attachment(s) failed to push.`,
					{
						modal: true,
						detail: result.attachmentFailures.map((f) => `• ${f.label}: ${f.message}`).join("\n"),
					},
				);
			} else {
				vscode.window.showInformationMessage(`Shared ${n} ${noun} to your Jolli Space.`);
			}
		} catch (err: unknown) {
			if (err instanceof ShareBindingError) {
				if (err.outcome === "anotherOpen") {
					vscode.window.showInformationMessage(
						"A Memory space chooser is already open for this repo. Finish there, then create the PR again to share.",
					);
				} else if (err.outcome === "cancelled") {
					vscode.window.showErrorMessage(
						"Push cancelled — no Memory space chosen for this repo. Create the PR again when you're ready to share.",
					);
				} else {
					vscode.window.showErrorMessage("Sharing failed — could not bind a Memory space for this repo.");
				}
				return;
			}
			if (err instanceof PluginOutdatedError) {
				vscode.window.showErrorMessage(
					"Sharing failed — your Jolli Memory plugin is outdated. Please update to the latest version.",
					{ modal: true },
				);
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showWarningMessage(`PR is ready, but sharing memories to Jolli Space failed: ${msg}`);
		}
	}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/CreatePrWebviewPanel.test.ts`
Expected: PASS (new push cases + all existing cases; existing cases updated so `handleCreatePr` resolves `"succeeded"`).

- [ ] **Step 7: Commit**

```bash
git add vscode/src/views/CreatePrWebviewPanel.ts vscode/src/views/CreatePrWebviewPanel.test.ts
git commit -s -m "Push branch memories to Jolli Space after a signed-in Create/Update PR"
```

---

## Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: PASS — clean → build → lint → test across cli + vscode. Confirm no biome warnings (they fail CI) and CLI coverage thresholds are unaffected (this change is vscode-only).

- [ ] **Step 2: Manual smoke (optional, if a dev host is available)**

In an Extension Development Host on a branch with committed memories and a signed-in Jolli account: run **Jolli Memory: Create PR** → click **Create PR** → confirm the PR is created AND a "Shared N memories to your Jolli Space." toast appears; open the Space and confirm the articles. Repeat on a repo with no bound Space → confirm the binding chooser opens, and selecting a Space completes the push.

---

## Self-Review

**Spec coverage:**
- Decision 1 (content-only branch push + dedup) → Task 1 (`pushBranchMemoriesToSpace`, `assignOwnedAttachments`, non-strict).
- Decision 2 (unbound → binding chooser, then retry) → Task 3 `resolveBinding` wiring + `ShareBindingError` branches; retry is internal to `pushSummaryWithAttachments`.
- Decision 3 (both Create + Update push) → Task 3 Step 4 (`existingPr ? handleUpdatePrWithPush : handleCreatePr`, both gated on `"succeeded"`).
- Invariant "push after PR success, never rolls back PR" → Task 2 outcome + Task 3 gating + catch surfaces toast only.
- Invariant "not signed in → no push" → Task 3 `&& this.signedIn` gate + test.
- Toast table → Task 3 Step 5 (all rows) + tests for success/cancelled.
- Testing section → Tasks 1/2/3 test steps.

**Placeholder scan:** No TBD/TODO. The one soft reference — Task 2 Step 1 "reuse the suite's existing setup helpers" — is a pointer to concrete existing test arrangements in the same file (each named), not a missing implementation; the return-value assertions themselves are complete.

**Type consistency:** `PushBranchMemoriesResult { pushedCount; attachmentCount; attachmentFailures }` used identically in Task 1 (produce) and Task 3 (consume). `PrSubmitOutcome = "succeeded" | "failed"` consistent across Tasks 2 and 3. `resolveBinding` returns `{ status: "bound" | "anotherOpen" | "cancelled" }` (matches `BindingOutcome`). `ShareBindingError.outcome` values (`anotherOpen`/`cancelled`/`failed`) match the branches.
