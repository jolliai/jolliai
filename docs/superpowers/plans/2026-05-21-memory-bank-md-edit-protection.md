# Memory Bank `.md` Edit Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently overwriting Memory Bank `.md` files that have been edited on disk, and make the sidebar reflect those edits with explicit UI affordances (decoration badge + revert command).

**Architecture:** Add a single `isUserEditedOnDisk` helper in `FolderStorage` that consolidates the existing inline fingerprint-vs-manifest checks (used today only for the deletion path). Wire it into the three visible-markdown write paths (`generateSummaryMarkdown` / `generatePlanMarkdown` / `generateNoteMarkdown`) so writes skip diverged files. Add force-overwrite revert helpers. Surface divergence in the VS Code sidebar by routing diverged summary clicks through `markdown.showPreview` (instead of the JSON-backed `SummaryWebviewPanel`), registering a `FileDecorationProvider` for badges, and adding a `jollimemory.revertMemoryFileEdits` command.

**Tech Stack:** TypeScript (Node 22+ ESM in `cli/`, esbuild CJS bundle in `vscode/`). Vitest for tests. Biome for lint/format (tabs, 4-wide, 120-col). VS Code Extension API for sidebar wiring.

**Spec:** [`docs/superpowers/specs/2026-05-21-memory-bank-md-edit-protection-design.md`](../specs/2026-05-21-memory-bank-md-edit-protection-design.md)

**Refinement vs spec:** Spec §Design > 1 names `cleanupSupersededDescendants` (line 511-512) as the only inline-divergence-check site to refactor. There is a second site — [`deleteVisibleArtifact` line 183-200](../../../cli/src/core/FolderStorage.ts) — with the same pattern. Task 1 below covers both; intent unchanged.

**Verify-and-commit policy:** Per user feedback `[[no-per-task-commit-and-test]]` — Tasks 1-11 below contain **only code-edit steps** (write test + write implementation). No per-task `Run test` / `Run suite` / `Commit` steps. All `npm run all` runs and a single combined commit happen in Task 12. This overrides the writing-plans skill default of "frequent commits / red-green per step."

**Important conventions:**
- DCO sign-off (`git commit -s`) required on every commit. CI rejects PRs without `Signed-off-by:`.
- No `Co-Authored-By: Claude …` trailer or `🤖 Generated with …` footer.
- `npm run all` must pass before committing (clean → build → lint → test).
- CLI code is held to 97% statements / 96% branches / 97% functions / 97% lines coverage (per `cli/vite.config.ts`).

---

## Task 1: Add `isUserEditedOnDisk` helper + refactor existing inline checks

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (add helper, refactor two existing call sites)
- Test: `cli/src/core/FolderStorage.test.ts`

The helper centralizes the "is the on-disk file diverged from manifest" check that today lives inline in `deleteVisibleArtifact` (lines 183-200) and `cleanupSupersededDescendants` (lines 537-551). On read failure we return `true` ("treat as edited, don't touch the file") matching the conservative behavior both existing call sites already implement.

- [ ] **Step 1: Write the test for the helper**

Append to the existing `describe("FolderStorage", () => { … })` block in `cli/src/core/FolderStorage.test.ts`:

```ts
describe("isUserEditedOnDisk", () => {
    it("returns false when the file does not exist", () => {
        const result = (storage as unknown as {
            isUserEditedOnDisk(abs: string, fp: string | undefined): boolean;
        }).isUserEditedOnDisk(join(rootPath, "nope.md"), "abc123");
        expect(result).toBe(false);
    });

    it("returns false when no manifest fingerprint baseline is available", () => {
        const absPath = join(rootPath, "main", "foo.md");
        mkdirSync(join(rootPath, "main"), { recursive: true });
        writeFileSync(absPath, "anything", "utf-8");
        const result = (storage as unknown as {
            isUserEditedOnDisk(abs: string, fp: string | undefined): boolean;
        }).isUserEditedOnDisk(absPath, undefined);
        expect(result).toBe(false);
    });

    it("returns false when on-disk content matches the fingerprint", () => {
        const absPath = join(rootPath, "main", "foo.md");
        mkdirSync(join(rootPath, "main"), { recursive: true });
        const content = "stable content";
        writeFileSync(absPath, content, "utf-8");
        const fingerprint = MetadataManager.sha256(content);
        const result = (storage as unknown as {
            isUserEditedOnDisk(abs: string, fp: string | undefined): boolean;
        }).isUserEditedOnDisk(absPath, fingerprint);
        expect(result).toBe(false);
    });

    it("returns true when on-disk content diverges from the fingerprint", () => {
        const absPath = join(rootPath, "main", "foo.md");
        mkdirSync(join(rootPath, "main"), { recursive: true });
        writeFileSync(absPath, "edited content", "utf-8");
        const fingerprint = MetadataManager.sha256("original content");
        const result = (storage as unknown as {
            isUserEditedOnDisk(abs: string, fp: string | undefined): boolean;
        }).isUserEditedOnDisk(absPath, fingerprint);
        expect(result).toBe(true);
    });
});
```

- [ ] **Step 2: Implement the helper**

In `cli/src/core/FolderStorage.ts`, add a private method (near the other private helpers around line 470):

```ts
/**
 * Returns true when `absPath` exists on disk AND its sha256 differs from
 * `manifestFingerprint`. Used by every write/delete path that must not
 * clobber files a user has hand-edited.
 *
 * Returns false when the file is missing OR when no baseline fingerprint
 * is available (legacy manifest entries written before fingerprint
 * tracking). Legacy entries will be brought under protection on their
 * next system-side write, which populates the fingerprint.
 *
 * On a readFileSync failure we return true ("treat as edited"). The
 * two pre-existing inline implementations of this check both kept the
 * file on read errors; preserving that behaviour means callers stay
 * conservative without needing exception-handling boilerplate.
 */
private isUserEditedOnDisk(absPath: string, manifestFingerprint: string | undefined): boolean {
    if (!existsSync(absPath)) return false;
    if (!manifestFingerprint) return false;
    let diskFingerprint: string;
    try {
        diskFingerprint = MetadataManager.sha256(readFileSync(absPath, "utf-8"));
        /* v8 ignore start -- defensive: readFileSync only fails after existsSync passed if the file is replaced by a directory or the fs throws EACCES mid-flow. Not reachable from a single-process unit test without mocking node:fs. */
    } catch (err) {
        log.warn("isUserEditedOnDisk: cannot read %s [%s] — treating as edited", absPath, String(err));
        return true;
    }
    /* v8 ignore stop */
    return diskFingerprint !== manifestFingerprint;
}
```

- [ ] **Step 3: Refactor `deleteVisibleArtifact` to use the helper**

Replace lines 183-200 (the `if (manifestEntry?.fingerprint) { … }` block) with:

```ts
if (manifestEntry?.fingerprint && this.isUserEditedOnDisk(absPath, manifestEntry.fingerprint)) {
    log.warn(
        "Skipping cleanup of %s — file modified since manifest record (likely hand-edited)",
        relativePath,
    );
    return;
}
```

- [ ] **Step 4: Refactor `cleanupSupersededDescendants` to use the helper**

Replace lines 537-551 (the `let onDiskFingerprint … if (onDiskFingerprint !== entry.fingerprint)` block) with:

```ts
if (this.isUserEditedOnDisk(absPath, entry.fingerprint)) {
    log.warn(
        "Skipping cleanup of %s — file modified since manifest record (likely hand-edited)",
        entry.path,
    );
    continue;
}
```

---

## Task 2: Protect `generateSummaryMarkdown` from silent overwrites

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (line 470-516, `generateSummaryMarkdown`)
- Test: `cli/src/core/FolderStorage.test.ts`

After this task, a hand-edited `<branch>/<slug>-<hash8>.md` survives a subsequent `writeFiles` pass with the same summary JSON.

- [ ] **Step 1: Write the tests**

Append to the existing `describe("FolderStorage", () => { … })` block:

```ts
describe("generateSummaryMarkdown: write protection", () => {
    it("skips overwriting a user-edited visible markdown", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "abcdef1234567890",
            commitMessage: "Add feature",
            branch: "main",
        });
        await storage.writeFiles(
            [{ path: "summaries/abcdef1234567890.json", content: summaryJson }],
            "seed",
        );

        const visiblePath = join(rootPath, "main", "add-feature-abcdef12.md");
        expect(existsSync(visiblePath)).toBe(true);

        const editedContent = "# User edited content\n\nThis must survive.";
        writeFileSync(visiblePath, editedContent, "utf-8");

        await storage.writeFiles(
            [{ path: "summaries/abcdef1234567890.json", content: summaryJson }],
            "regenerate",
        );

        expect(readFileSync(visiblePath, "utf-8")).toBe(editedContent);
    });

    it("overwrites normally when the on-disk file matches the manifest fingerprint", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "11112222deadbeef",
            commitMessage: "Refactor module",
            branch: "main",
        });
        await storage.writeFiles(
            [{ path: "summaries/11112222deadbeef.json", content: summaryJson }],
            "seed",
        );

        const visiblePath = join(rootPath, "main", "refactor-module-11112222.md");
        const before = readFileSync(visiblePath, "utf-8");

        const updatedJson = makeSummaryJson({
            commitHash: "11112222deadbeef",
            commitMessage: "Refactor module v2",
            branch: "main",
        });
        await storage.writeFiles(
            [{ path: "summaries/11112222deadbeef.json", content: updatedJson }],
            "update",
        );

        const after = readFileSync(visiblePath, "utf-8");
        expect(after).not.toBe(before);
    });

    it("overwrites legacy entries without a fingerprint, then protects on next write", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "3333444455556666",
            commitMessage: "Old commit",
            branch: "main",
        });
        await storage.writeFiles(
            [{ path: "summaries/3333444455556666.json", content: summaryJson }],
            "seed",
        );

        const visiblePath = join(rootPath, "main", "old-commit-33334444.md");
        const manifestEntry = metadataManager.findById("3333444455556666");
        expect(manifestEntry).toBeDefined();
        expect(manifestEntry?.fingerprint).toBeDefined();

        // Simulate legacy by deleting the fingerprint from the manifest entry.
        metadataManager.updateManifest({
            path: manifestEntry!.path,
            fileId: manifestEntry!.fileId,
            type: manifestEntry!.type,
            fingerprint: undefined as unknown as string,
            source: manifestEntry!.source,
            title: manifestEntry!.title,
        });

        writeFileSync(visiblePath, "# Legacy hand-edit", "utf-8");

        await storage.writeFiles(
            [{ path: "summaries/3333444455556666.json", content: summaryJson }],
            "rewrite-legacy",
        );

        // Legacy: overwrite was permitted (no baseline to protect).
        expect(readFileSync(visiblePath, "utf-8")).not.toContain("Legacy hand-edit");

        // Now there IS a fingerprint; a fresh hand-edit must be protected.
        writeFileSync(visiblePath, "# Post-legacy hand-edit", "utf-8");
        await storage.writeFiles(
            [{ path: "summaries/3333444455556666.json", content: summaryJson }],
            "second-rewrite",
        );
        expect(readFileSync(visiblePath, "utf-8")).toContain("Post-legacy hand-edit");
    });
});
```

- [ ] **Step 2: Implement the protection**

In `cli/src/core/FolderStorage.ts`, modify `generateSummaryMarkdown` (line 470). Insert the divergence check between the relative-path computation and the `atomicWrite`. After line 487 (`const markdown = …`), add:

```ts
const targetPath = join(this.rootPath, relativePath);

const existingEntry = this.metadataManager.findByPath(relativePath);
if (this.isUserEditedOnDisk(targetPath, existingEntry?.fingerprint)) {
    log.info("FolderStorage: skip overwrite of user-edited %s", relativePath);
    return;
}

this.atomicWrite(targetPath, markdown);
```

Remove the existing `const targetPath = join(this.rootPath, relativePath);` line that previously appeared just before `atomicWrite` (now consolidated above).

**Critical:** the `return` must happen before `updateManifest`. Leaving the manifest's previous fingerprint intact is what allows the next write pass to still detect the divergence. If the manifest were updated to the freshly-computed fingerprint, the next pass would see "no divergence" and silently overwrite.

---

## Task 3: Protect `generatePlanMarkdown` from silent overwrites

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (line 593-617, `generatePlanMarkdown`)
- Test: `cli/src/core/FolderStorage.test.ts`

Same pattern as Task 2.

- [ ] **Step 1: Write the test**

```ts
describe("generatePlanMarkdown: write protection", () => {
    it("skips overwriting a user-edited visible plan markdown", async () => {
        // Seed via writeFiles using the plans/ path prefix and an embedded
        // commit hash so resolveBranchFromSlug routes to a branch folder.
        const summaryJson = makeSummaryJson({
            commitHash: "aaaa1111bbbb2222",
            commitMessage: "Add login",
            branch: "feature/login",
        });
        await storage.writeFiles(
            [{ path: "summaries/aaaa1111bbbb2222.json", content: summaryJson }],
            "seed-summary",
        );
        await storage.writeFiles(
            [
                {
                    path: "plans/aaaa1111bbbb2222.md",
                    content: "# Plan body\n\nThink about login.",
                    branch: "feature/login",
                },
            ],
            "seed-plan",
        );

        const visiblePath = join(rootPath, "feature-login", "plan--aaaa1111bbbb2222.md");
        expect(existsSync(visiblePath)).toBe(true);

        const editedContent = "# Hand-edited plan\n\nMust survive.";
        writeFileSync(visiblePath, editedContent, "utf-8");

        await storage.writeFiles(
            [
                {
                    path: "plans/aaaa1111bbbb2222.md",
                    content: "# Plan body\n\nThink about login.",
                    branch: "feature/login",
                },
            ],
            "regenerate-plan",
        );

        expect(readFileSync(visiblePath, "utf-8")).toBe(editedContent);
    });
});
```

- [ ] **Step 2: Implement the protection**

In `cli/src/core/FolderStorage.ts`, modify `generatePlanMarkdown` (line 593). After `const markdown = …` (around line 602), replace the `this.atomicWrite(join(this.rootPath, relativePath), markdown);` line with:

```ts
const targetPath = join(this.rootPath, relativePath);

const existingEntry = this.metadataManager.findByPath(relativePath);
if (this.isUserEditedOnDisk(targetPath, existingEntry?.fingerprint)) {
    log.info("FolderStorage: skip overwrite of user-edited %s", relativePath);
    return;
}

this.atomicWrite(targetPath, markdown);
```

---

## Task 4: Protect `generateNoteMarkdown` from silent overwrites

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (line 623-647, `generateNoteMarkdown`)
- Test: `cli/src/core/FolderStorage.test.ts`

Same pattern.

- [ ] **Step 1: Write the test**

```ts
describe("generateNoteMarkdown: write protection", () => {
    it("skips overwriting a user-edited visible note markdown", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "cccc3333dddd4444",
            commitMessage: "Doc bug",
            branch: "fix/doc-bug",
        });
        await storage.writeFiles(
            [{ path: "summaries/cccc3333dddd4444.json", content: summaryJson }],
            "seed-summary",
        );
        await storage.writeFiles(
            [
                {
                    path: "notes/cccc3333dddd4444.md",
                    content: "# Note body",
                    branch: "fix/doc-bug",
                },
            ],
            "seed-note",
        );

        const visiblePath = join(rootPath, "fix-doc-bug", "note--cccc3333dddd4444.md");
        expect(existsSync(visiblePath)).toBe(true);

        const editedContent = "# Hand-edited note\n\nMust survive.";
        writeFileSync(visiblePath, editedContent, "utf-8");

        await storage.writeFiles(
            [
                {
                    path: "notes/cccc3333dddd4444.md",
                    content: "# Note body",
                    branch: "fix/doc-bug",
                },
            ],
            "regenerate-note",
        );

        expect(readFileSync(visiblePath, "utf-8")).toBe(editedContent);
    });
});
```

- [ ] **Step 2: Implement the protection**

In `cli/src/core/FolderStorage.ts`, modify `generateNoteMarkdown` (line 623). After `const markdown = …` (around line 632), replace the `this.atomicWrite(join(this.rootPath, relativePath), markdown);` line with:

```ts
const targetPath = join(this.rootPath, relativePath);

const existingEntry = this.metadataManager.findByPath(relativePath);
if (this.isUserEditedOnDisk(targetPath, existingEntry?.fingerprint)) {
    log.info("FolderStorage: skip overwrite of user-edited %s", relativePath);
    return;
}

this.atomicWrite(targetPath, markdown);
```

---

## Task 5: Add `forceRegenerateVisibleMarkdown` for summary revert

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (add new method)
- Test: `cli/src/core/FolderStorage.test.ts`

The existing `regenerateVisibleMarkdown` (line 235) has `if (existsSync(absPath)) return true` early-return so it is safe as a heal path. The revert command needs the opposite: actively overwrite a diverged file. Add a sibling method `forceRegenerateVisibleMarkdown` that unlinks first.

- [ ] **Step 1: Write the test**

```ts
describe("forceRegenerateVisibleMarkdown", () => {
    it("overwrites a diverged visible markdown back to the JSON-derived version", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "5555666677778888",
            commitMessage: "Add tests",
            branch: "main",
        });
        await storage.writeFiles(
            [{ path: "summaries/5555666677778888.json", content: summaryJson }],
            "seed",
        );

        const visiblePath = join(rootPath, "main", "add-tests-55556666.md");
        const original = readFileSync(visiblePath, "utf-8");

        writeFileSync(visiblePath, "# Diverged content", "utf-8");
        expect(readFileSync(visiblePath, "utf-8")).toBe("# Diverged content");

        const result = await storage.forceRegenerateVisibleMarkdown({
            commitHash: "5555666677778888",
            commitMessage: "Add tests",
            commitDate: "2026-01-15T10:00:00Z",
            branch: "main",
            generatedAt: "2026-01-15T10:00:00Z",
            parentCommitHash: null,
        });

        expect(result).toBe(true);
        expect(readFileSync(visiblePath, "utf-8")).toBe(original);
    });

    it("returns false when the hidden JSON source is missing", async () => {
        const result = await storage.forceRegenerateVisibleMarkdown({
            commitHash: "9999000011112222",
            commitMessage: "Phantom",
            commitDate: "2026-01-15T10:00:00Z",
            branch: "main",
            generatedAt: "2026-01-15T10:00:00Z",
            parentCommitHash: null,
        });
        expect(result).toBe(false);
    });
});
```

- [ ] **Step 2: Implement the method**

In `cli/src/core/FolderStorage.ts`, add directly above `regenerateVisibleMarkdown` (line 235) so the two related methods are colocated:

```ts
/**
 * Like {@link regenerateVisibleMarkdown} but actively overwrites any
 * existing on-disk `.md`. Used by the revert command: when the user has
 * edited the visible markdown and wants to discard those edits, we
 * unlink the diverged file and let `regenerateVisibleMarkdown` write a
 * fresh copy from the hidden JSON.
 *
 * Returns true when the regenerate succeeded, false when the hidden
 * source was missing.
 */
async forceRegenerateVisibleMarkdown(entry: SummaryIndexEntry): Promise<boolean> {
    const branchFolder = this.metadataManager.resolveFolderForBranch(entry.branch);
    const slug = FolderStorage.slugify(entry.commitMessage);
    const hash8 = entry.commitHash.substring(0, 8);
    const relativePath = `${branchFolder}/${slug}-${hash8}.md`;
    const absPath = join(this.rootPath, relativePath);

    if (existsSync(absPath)) {
        try {
            unlinkSync(absPath);
            /* v8 ignore start -- defensive: unlinkSync only fails after existsSync if a concurrent process removed the file or the fs throws EACCES mid-flow. */
        } catch (err) {
            log.warn("forceRegenerateVisibleMarkdown: cannot unlink %s [%s]", relativePath, String(err));
            return false;
        }
        /* v8 ignore stop */
    }

    return this.regenerateVisibleMarkdown(entry);
}
```

---

## Task 6: Add `regenerateVisiblePlan` for plan revert

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (add new method)
- Test: `cli/src/core/FolderStorage.test.ts`

Plans have no pre-existing `regenerateVisible*` method, so this is a single force-overwrite implementation.

- [ ] **Step 1: Write the test**

```ts
describe("regenerateVisiblePlan", () => {
    it("overwrites a diverged visible plan from the hidden plans/ source", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "abcd1234abcd1234",
            commitMessage: "Plan thing",
            branch: "feature/plan-thing",
        });
        await storage.writeFiles(
            [{ path: "summaries/abcd1234abcd1234.json", content: summaryJson }],
            "seed-summary",
        );
        await storage.writeFiles(
            [
                {
                    path: "plans/abcd1234abcd1234.md",
                    content: "# Original plan",
                    branch: "feature/plan-thing",
                },
            ],
            "seed-plan",
        );

        const visiblePath = join(rootPath, "feature-plan-thing", "plan--abcd1234abcd1234.md");
        writeFileSync(visiblePath, "# Diverged plan", "utf-8");

        const result = await storage.regenerateVisiblePlan("abcd1234abcd1234", "feature/plan-thing");

        expect(result).toBe(true);
        expect(readFileSync(visiblePath, "utf-8")).toContain("Original plan");
        expect(readFileSync(visiblePath, "utf-8")).not.toContain("Diverged");
    });

    it("returns false when the hidden plans/ source is missing", async () => {
        const result = await storage.regenerateVisiblePlan("nonexistent", "main");
        expect(result).toBe(false);
    });
});
```

- [ ] **Step 2: Implement the method**

Add to `cli/src/core/FolderStorage.ts` near `generatePlanMarkdown` (around line 590):

```ts
/**
 * Read the hidden `.jolli/plans/<slug>.md` source and rewrite the
 * visible `<branchFolder>/plan--<slug>.md`. Used by the revert command
 * when a user wants to discard hand-edits to the visible plan.
 *
 * Unlinks any existing visible file first so the underlying
 * generatePlanMarkdown write succeeds.
 *
 * Returns true on success, false when the hidden source is missing.
 */
async regenerateVisiblePlan(slug: string, branch: string): Promise<boolean> {
    const hiddenContent = await this.readFile(`plans/${slug}.md`);
    if (!hiddenContent) {
        log.warn("regenerateVisiblePlan: hidden plans/%s.md missing", slug);
        return false;
    }

    const branchFolder = this.metadataManager.resolveFolderForBranch(branch);
    const visiblePath = join(this.rootPath, branchFolder, `plan--${slug}.md`);
    if (existsSync(visiblePath)) {
        try {
            unlinkSync(visiblePath);
            /* v8 ignore start -- defensive: see forceRegenerateVisibleMarkdown */
        } catch (err) {
            log.warn("regenerateVisiblePlan: cannot unlink %s [%s]", visiblePath, String(err));
            return false;
        }
        /* v8 ignore stop */
    }

    this.generatePlanMarkdown(`plans/${slug}.md`, hiddenContent, branch);
    return true;
}
```

---

## Task 7: Add `regenerateVisibleNote` for note revert

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (add new method)
- Test: `cli/src/core/FolderStorage.test.ts`

- [ ] **Step 1: Write the test**

```ts
describe("regenerateVisibleNote", () => {
    it("overwrites a diverged visible note from the hidden notes/ source", async () => {
        const summaryJson = makeSummaryJson({
            commitHash: "ef0123ef0123ef01",
            commitMessage: "Note thing",
            branch: "fix/note-thing",
        });
        await storage.writeFiles(
            [{ path: "summaries/ef0123ef0123ef01.json", content: summaryJson }],
            "seed-summary",
        );
        await storage.writeFiles(
            [
                {
                    path: "notes/ef0123ef0123ef01.md",
                    content: "# Original note",
                    branch: "fix/note-thing",
                },
            ],
            "seed-note",
        );

        const visiblePath = join(rootPath, "fix-note-thing", "note--ef0123ef0123ef01.md");
        writeFileSync(visiblePath, "# Diverged note", "utf-8");

        const result = await storage.regenerateVisibleNote("ef0123ef0123ef01", "fix/note-thing");

        expect(result).toBe(true);
        expect(readFileSync(visiblePath, "utf-8")).toContain("Original note");
    });

    it("returns false when the hidden notes/ source is missing", async () => {
        const result = await storage.regenerateVisibleNote("nonexistent", "main");
        expect(result).toBe(false);
    });
});
```

- [ ] **Step 2: Implement the method**

Add to `cli/src/core/FolderStorage.ts` near `generateNoteMarkdown` (around line 620):

```ts
/**
 * Read the hidden `.jolli/notes/<id>.md` source and rewrite the visible
 * `<branchFolder>/note--<id>.md`. Used by the revert command.
 *
 * Unlinks any existing visible file first so the underlying
 * generateNoteMarkdown write succeeds.
 *
 * Returns true on success, false when the hidden source is missing.
 */
async regenerateVisibleNote(id: string, branch: string): Promise<boolean> {
    const hiddenContent = await this.readFile(`notes/${id}.md`);
    if (!hiddenContent) {
        log.warn("regenerateVisibleNote: hidden notes/%s.md missing", id);
        return false;
    }

    const branchFolder = this.metadataManager.resolveFolderForBranch(branch);
    const visiblePath = join(this.rootPath, branchFolder, `note--${id}.md`);
    if (existsSync(visiblePath)) {
        try {
            unlinkSync(visiblePath);
            /* v8 ignore start -- defensive: see forceRegenerateVisibleMarkdown */
        } catch (err) {
            log.warn("regenerateVisibleNote: cannot unlink %s [%s]", visiblePath, String(err));
            return false;
        }
        /* v8 ignore stop */
    }

    this.generateNoteMarkdown(`notes/${id}.md`, hiddenContent, branch);
    return true;
}
```

---

## Task 8: Add `isMemoryFileDivergedOnDisk` to JolliMemoryBridge

**Files:**
- Modify: `cli/src/core/FolderStorage.ts` (promote `isUserEditedOnDisk` to public)
- Modify: `vscode/src/JolliMemoryBridge.ts` (add new method)
- Test: `vscode/src/JolliMemoryBridge.test.ts`

The VS Code extension needs to ask the bridge "is this on-disk Memory Bank `.md` diverged from manifest?" The bridge already owns repo-resolution for cross-repo Memory Bank views (see `getSummaryAnyRepoWithSource`); we reuse that resolver to find the correct `FolderStorage` instance.

The existing cross-repo code (e.g. `getSummaryAnyRepoWithSource` line 1592 and `listBranchMemories` line 1475) uses this discovery pattern that we reuse:

```ts
const cfg = (await loadConfig()) as Record<string, unknown>;
const customKBPath = cfg.localFolder as string | undefined;
const kbParent = resolveKbParent(customKBPath);
const currentRepoName = extractRepoName(this.cwd);
const currentRemoteUrl = getRemoteUrl(this.cwd);
const repos = discoverRepos(currentRepoName, currentRemoteUrl, kbParent);
// repos: { repoName, kbRoot, remoteUrl, isCurrentRepo }[]
```

The implementation does NOT use `this.getStorage()` (which may return a `DualWriteStorage` wrapping a `FolderStorage`) because we want to talk directly to the `FolderStorage` divergence helper.

- [ ] **Step 1: Promote `FolderStorage.isUserEditedOnDisk` from `private` to public**

In `cli/src/core/FolderStorage.ts`, the helper added in Task 1 was `private`. Remove the `private` modifier and update the docstring:

```ts
/**
 * Public method (no `private`): the VS Code extension's bridge calls
 * this directly to drive divergence-aware UI. Not part of the
 * StorageProvider interface because only the folder backend has visible
 * markdown to be edited.
 */
isUserEditedOnDisk(absPath: string, manifestFingerprint: string | undefined): boolean {
    // … same body as Task 1 …
}
```

- [ ] **Step 2: Write the test**

Append to `vscode/src/JolliMemoryBridge.test.ts`. First inspect the top of the file to copy the existing setup pattern (tmpdir kbRoot + seeded storage):

```ts
describe("isMemoryFileDivergedOnDisk", () => {
    it("returns true when the on-disk file diverges from the manifest fingerprint", async () => {
        // Setup: bridge.cwd points at a tmpdir repo whose kbRoot has been
        // seeded with a summary md. (Copy the seed pattern from existing
        // tests above this describe block.)
        const visiblePath = join(kbRoot, "main", "seed-aaaa1111.md");
        expect(existsSync(visiblePath)).toBe(true);

        writeFileSync(visiblePath, "# hand-edited\n", "utf-8");

        const result = await bridge.isMemoryFileDivergedOnDisk(visiblePath);
        expect(result).toBe(true);
    });

    it("returns false when on-disk matches the manifest fingerprint", async () => {
        const visiblePath = join(kbRoot, "main", "seed-aaaa1111.md");
        // No edit between seed and check.
        const result = await bridge.isMemoryFileDivergedOnDisk(visiblePath);
        expect(result).toBe(false);
    });

    it("returns false when the file is not under any known kbRoot", async () => {
        const result = await bridge.isMemoryFileDivergedOnDisk("/tmp/random/elsewhere.md");
        expect(result).toBe(false);
    });
});
```

If the existing bridge tests mock the storage layer rather than spin up a real tmpdir kbRoot, mirror that pattern: stub `discoverRepos`/`FolderStorage` and assert the wiring (`MetadataManager.findByPath` called with the correct relative path; `FolderStorage.isUserEditedOnDisk` called with that fingerprint). The deeper behaviour is already covered by Tasks 1-7's unit tests; the bridge test only needs to prove the dispatch is correct.

- [ ] **Step 3: Implement `isMemoryFileDivergedOnDisk` on the bridge**

In `vscode/src/JolliMemoryBridge.ts`, add the method near `getSummaryAnyRepoWithSource` (line 1592):

```ts
/**
 * Returns true if `absPath` is under a known Memory Bank kbRoot AND its
 * sha256 differs from the manifest fingerprint recorded when the system
 * last wrote that path. Used by the VS Code extension to drive the
 * divergence banner, decoration provider, and revert command.
 *
 * Returns false on any of: absPath not under a known kbRoot; manifest
 * has no fingerprint (legacy); file matches manifest. The "false on
 * unknown" choice is deliberate — the decoration provider asks about
 * every VS Code file URI it sees and must not flag files outside the
 * Memory Bank.
 */
async isMemoryFileDivergedOnDisk(absPath: string): Promise<boolean> {
    try {
        const cfg = (await loadConfig()) as Record<string, unknown>;
        const customKBPath = cfg.localFolder as string | undefined;
        const kbParent = resolveKbParent(customKBPath);
        const currentRepoName = extractRepoName(this.cwd);
        const currentRemoteUrl = getRemoteUrl(this.cwd);
        const repos = discoverRepos(currentRepoName, currentRemoteUrl, kbParent);
        const { sep } = await import("node:path");
        for (const repo of repos) {
            const prefix = repo.kbRoot.endsWith(sep) ? repo.kbRoot : repo.kbRoot + sep;
            if (!absPath.startsWith(prefix)) continue;
            const relPath = absPath.slice(prefix.length);
            const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
            const entry = mm.findByPath(relPath);
            if (!entry) return false;
            const storage = new FolderStorage(repo.kbRoot, mm);
            return storage.isUserEditedOnDisk(absPath, entry.fingerprint);
        }
    } catch (err) {
        log.warn("isMemoryFileDivergedOnDisk", `${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
}
```

(Imports at top of file already cover `loadConfig`, `resolveKbParent`, `extractRepoName`, `getRemoteUrl`, `discoverRepos`, `MetadataManager`, `FolderStorage`, `join`. Add `sep` import from `node:path` if not present.)

---

## Task 9: Route diverged summary clicks through `markdown.showPreview`

**Files:**
- Modify: `vscode/src/Extension.ts` (lines 2099-2143, `openMemoryFile` command handler)
- Test: `vscode/src/Extension.test.ts`

Today the `openMemoryFile` handler reads frontmatter, looks up the JSON summary, and renders `SummaryWebviewPanel` from the JSON. The `.md` body is never read. Modify the flow so that when the file is diverged, we (a) show an information message with a `[Revert]` action, then (b) open `markdown.showPreview` instead of the webview.

Use a session-scoped Set to avoid re-showing the information message on every click of the same diverged file within one VS Code session.

- [ ] **Step 1: Write the test**

First inspect `vscode/src/Extension.test.ts` to see the existing harness — most likely it constructs a fake `bridge` and runs commands via `vscode.commands.executeCommand`. Append:

```ts
describe("openMemoryFile divergence routing", () => {
    let tmpRoot: string;
    let absPath: string;

    beforeEach(() => {
        tmpRoot = makeTmpDir(); // reuse existing helper
        mkdirSync(join(tmpRoot, "main"), { recursive: true });
        absPath = join(tmpRoot, "main", "foo-abcdef12.md");
        writeFileSync(
            absPath,
            "---\ntype: commit\ncommitHash: abcdef1234567890abcdef1234567890abcdef12\n---\n# Body",
            "utf-8",
        );
    });
    afterEach(() => rmrf(tmpRoot));

    it("routes diverged summary files to markdown.showPreview", async () => {
        vi.spyOn(bridge, "isMemoryFileDivergedOnDisk").mockResolvedValue(true);
        const executeCommand = vi.spyOn(vscode.commands, "executeCommand");
        vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

        await vscode.commands.executeCommand("jollimemory.openMemoryFile", absPath);

        expect(executeCommand).toHaveBeenCalledWith("markdown.showPreview", expect.anything());
    });

    it("routes non-diverged summary files to SummaryWebviewPanel", async () => {
        vi.spyOn(bridge, "isMemoryFileDivergedOnDisk").mockResolvedValue(false);
        vi.spyOn(bridge, "getSummaryAnyRepoWithSource").mockResolvedValue({
            summary: makeCommitSummary(), // reuse existing helper or inline a minimal CommitSummary
            sourceRepoName: null,
            sourceRemoteUrl: null,
        });
        const panelShow = vi.spyOn(SummaryWebviewPanel, "show").mockResolvedValue(undefined);

        await vscode.commands.executeCommand("jollimemory.openMemoryFile", absPath);

        expect(panelShow).toHaveBeenCalled();
    });

    it("only shows the divergence info message once per session per file", async () => {
        vi.spyOn(bridge, "isMemoryFileDivergedOnDisk").mockResolvedValue(true);
        const infoSpy = vi.spyOn(vscode.window, "showInformationMessage")
            .mockResolvedValue(undefined);

        await vscode.commands.executeCommand("jollimemory.openMemoryFile", absPath);
        await vscode.commands.executeCommand("jollimemory.openMemoryFile", absPath);

        expect(infoSpy).toHaveBeenCalledTimes(1);
    });
});
```

If the existing test file doesn't have `makeTmpDir`/`rmrf` helpers, copy them from `cli/src/core/FolderStorage.test.ts` (lines 17-30).

- [ ] **Step 2: Modify the handler**

In `vscode/src/Extension.ts`, modify the `openMemoryFile` command (lines 2099-2143). Replace the body of the `if (meta)` branch with:

```ts
if (meta) {
    if (await bridge.isMemoryFileDivergedOnDisk(absPath)) {
        // Diverged: show info message (once per file per session) with a
        // [Revert] action, then fall through to markdown preview so the
        // user sees their actual on-disk content (not the JSON-derived
        // system version).
        if (!divergenceMessageShown.has(absPath)) {
            divergenceMessageShown.add(absPath);
            const choice = await vscode.window.showInformationMessage(
                "This memory file has on-disk edits. System view is unavailable until reverted.",
                "Revert",
                "Dismiss",
            );
            if (choice === "Revert") {
                await vscode.commands.executeCommand("jollimemory.revertMemoryFileEdits", absPath);
                return;
            }
        }
        await vscode.commands.executeCommand("markdown.showPreview", uri);
        return;
    }

    const { summary, sourceRepoName, sourceRemoteUrl } =
        await bridge.getSummaryAnyRepoWithSource(meta.commitHash);
    if (summary) {
        await SummaryWebviewPanel.show(
            summary,
            context.extensionUri,
            workspaceRoot,
            bridge,
            commitsStore.getMainBranch(),
            "kb",
            sourceRepoName,
            sourceRemoteUrl,
        );
        return;
    }
    log.warn(
        "cmd",
        `openMemoryFile: frontmatter for ${absPath} references commit ${meta.commitHash} but no summary found; falling back to markdown preview`,
    );
}
await vscode.commands.executeCommand("markdown.showPreview", uri);
```

Add at the top of `Extension.ts` activate() (or wherever module-scoped state lives — match the existing pattern):

```ts
// Tracks Memory Bank files for which the divergence info message has
// already been shown in this session, so re-opening a known-diverged
// file does not re-pop the toast.
const divergenceMessageShown = new Set<string>();
```

---

## Task 10: Add `MemoryFileDecorationProvider` for badge

**Files:**
- Create: `vscode/src/services/MemoryFileDecorationProvider.ts`
- Modify: `vscode/src/Extension.ts` (register provider during activate)
- Modify: `vscode/src/services/KbFoldersService.ts` (expose file-change event if not already)
- Test: `vscode/src/services/MemoryFileDecorationProvider.test.ts`

A `FileDecorationProvider` adds a small badge (`✎`) and tooltip on diverged Memory Bank `.md` files visible in any VS Code file UI (explorer, the Memory Bank sidebar tree).

The provider listens to manifest-write events emitted by `KbFoldersService` (which already watches the kbRoot via chokidar/fs.watch) so the badge clears immediately after a revert.

- [ ] **Step 1: Write the test**

Create `vscode/src/services/MemoryFileDecorationProvider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MemoryFileDecorationProvider } from "./MemoryFileDecorationProvider.js";

describe("MemoryFileDecorationProvider", () => {
    it("returns a badge decoration for diverged Memory Bank md", async () => {
        const bridge = {
            isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(true),
        } as unknown as JolliMemoryBridge;
        const provider = new MemoryFileDecorationProvider(bridge);
        const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.md");

        const result = await provider.provideFileDecoration(uri, {} as never);

        expect(result?.badge).toBe("✎");
        expect(result?.tooltip).toMatch(/edited on disk/i);
    });

    it("returns undefined for non-diverged files", async () => {
        const bridge = {
            isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(false),
        } as unknown as JolliMemoryBridge;
        const provider = new MemoryFileDecorationProvider(bridge);
        const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.md");

        const result = await provider.provideFileDecoration(uri, {} as never);

        expect(result).toBeUndefined();
    });

    it("does not call the bridge for non-md files", async () => {
        const bridge = {
            isMemoryFileDivergedOnDisk: vi.fn(),
        } as unknown as JolliMemoryBridge;
        const provider = new MemoryFileDecorationProvider(bridge);
        const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.txt");

        const result = await provider.provideFileDecoration(uri, {} as never);

        expect(result).toBeUndefined();
        expect(bridge.isMemoryFileDivergedOnDisk).not.toHaveBeenCalled();
    });

    it("emits onDidChangeFileDecorations when refreshUri is called", () => {
        const bridge = { isMemoryFileDivergedOnDisk: vi.fn() } as unknown as JolliMemoryBridge;
        const provider = new MemoryFileDecorationProvider(bridge);
        const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.md");
        const listener = vi.fn();
        provider.onDidChangeFileDecorations(listener);

        provider.refreshUri(uri);

        expect(listener).toHaveBeenCalledWith(uri);
    });
});
```

- [ ] **Step 2: Implement the provider**

Create `vscode/src/services/MemoryFileDecorationProvider.ts`:

```ts
import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";

export class MemoryFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this.emitter.event;

    constructor(private readonly bridge: JolliMemoryBridge) {}

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        if (!uri.fsPath.toLowerCase().endsWith(".md")) return undefined;
        const diverged = await this.bridge.isMemoryFileDivergedOnDisk(uri.fsPath);
        if (!diverged) return undefined;
        return {
            badge: "✎",
            tooltip: "Edited on disk — system view unavailable",
            propagate: false,
        };
    }

    /**
     * Notify VS Code that the decoration for a specific URI may have
     * changed. Called by the revert command and by KbFoldersService when
     * a manifest write completes.
     */
    refreshUri(uri: vscode.Uri): void {
        this.emitter.fire(uri);
    }

    /**
     * Notify VS Code that all decorations may have changed. Used when
     * the bridge re-discovers repos (kbRoot list churns).
     */
    refreshAll(): void {
        this.emitter.fire(undefined);
    }

    dispose(): void {
        this.emitter.dispose();
    }
}
```

- [ ] **Step 3: Register the provider in `activate()`**

In `vscode/src/Extension.ts`, inside `activate()`, after `bridge` is constructed, add:

```ts
const memoryFileDecorationProvider = new MemoryFileDecorationProvider(bridge);
context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(memoryFileDecorationProvider),
    memoryFileDecorationProvider,
);
```

Also import the class at the top of the file:

```ts
import { MemoryFileDecorationProvider } from "./services/MemoryFileDecorationProvider.js";
```

- [ ] **Step 4: Wire the existing KbFoldersService file-event channel to call `refreshUri`**

Locate the existing `KbFoldersService` file-change handler in `vscode/src/services/KbFoldersService.ts`. Add a callback hook so the decoration provider can subscribe:

```ts
kbFoldersService.onFileChanged((uri) => memoryFileDecorationProvider.refreshUri(uri));
```

If `KbFoldersService` doesn't expose an `onFileChanged` event, add a minimal `EventEmitter<vscode.Uri>` to it. Look at the existing emit sites (where it currently fires `memoriesStore.refresh` etc. after a kbRoot file event) to find the right hook point.

---

## Task 11: Add `revertMemoryFileEdits` command + right-click menu

**Files:**
- Modify: `vscode/src/JolliMemoryBridge.ts` (add `resolveMemoryFile`)
- Modify: `vscode/src/Extension.ts` (register command)
- Modify: `vscode/package.json` (declare command + menu contribution)
- Test: `vscode/src/Extension.test.ts`

The command receives an `absPath: string` (from either the info-message `[Revert]` action in Task 9 or a right-click menu). It looks up the manifest entry for that path, determines `type` (`commit` | `plan` | `note`), and calls the matching FolderStorage revert method.

- [ ] **Step 1: Write the test**

Append to `vscode/src/Extension.test.ts`. For each test case, stub `bridge.resolveMemoryFile` to return a `{ folderStorage, manifestEntry }` shape:

```ts
describe("jollimemory.revertMemoryFileEdits", () => {
    const absPath = "/tmp/kb-fake/repo/main/foo-abcdef12.md";

    it("calls forceRegenerateVisibleMarkdown for a commit-type file", async () => {
        const folderStorage = {
            forceRegenerateVisibleMarkdown: vi.fn().mockResolvedValue(true),
            regenerateVisiblePlan: vi.fn(),
            regenerateVisibleNote: vi.fn(),
        } as unknown as FolderStorage;
        vi.spyOn(bridge, "resolveMemoryFile").mockResolvedValue({
            folderStorage,
            manifestEntry: {
                path: "main/foo-abcdef12.md",
                fileId: "abcdef1234567890abcdef1234567890abcdef12",
                type: "commit",
                fingerprint: "old",
                source: { commitHash: "abcdef1234567890abcdef1234567890abcdef12", branch: "main", generatedAt: "2026-01-15T10:00:00Z" },
                title: "Add foo",
            },
        });

        await vscode.commands.executeCommand("jollimemory.revertMemoryFileEdits", absPath);

        expect(folderStorage.forceRegenerateVisibleMarkdown).toHaveBeenCalledWith(
            expect.objectContaining({
                commitHash: "abcdef1234567890abcdef1234567890abcdef12",
                branch: "main",
            }),
        );
    });

    it("calls regenerateVisiblePlan for a plan-type file", async () => {
        const folderStorage = {
            forceRegenerateVisibleMarkdown: vi.fn(),
            regenerateVisiblePlan: vi.fn().mockResolvedValue(true),
            regenerateVisibleNote: vi.fn(),
        } as unknown as FolderStorage;
        vi.spyOn(bridge, "resolveMemoryFile").mockResolvedValue({
            folderStorage,
            manifestEntry: {
                path: "feature-x/plan--abcd1234abcd1234.md",
                fileId: "plan:abcd1234abcd1234",
                type: "plan",
                fingerprint: "old",
                source: { branch: "feature/x" },
                title: "Plan x",
            },
        });

        await vscode.commands.executeCommand(
            "jollimemory.revertMemoryFileEdits",
            "/tmp/kb-fake/repo/feature-x/plan--abcd1234abcd1234.md",
        );

        expect(folderStorage.regenerateVisiblePlan).toHaveBeenCalledWith(
            "abcd1234abcd1234",
            "feature/x",
        );
    });

    it("calls regenerateVisibleNote for a note-type file", async () => {
        const folderStorage = {
            forceRegenerateVisibleMarkdown: vi.fn(),
            regenerateVisiblePlan: vi.fn(),
            regenerateVisibleNote: vi.fn().mockResolvedValue(true),
        } as unknown as FolderStorage;
        vi.spyOn(bridge, "resolveMemoryFile").mockResolvedValue({
            folderStorage,
            manifestEntry: {
                path: "fix-y/note--ef01ef01ef01ef01.md",
                fileId: "note:ef01ef01ef01ef01",
                type: "note",
                fingerprint: "old",
                source: { branch: "fix/y" },
                title: "Note y",
            },
        });

        await vscode.commands.executeCommand(
            "jollimemory.revertMemoryFileEdits",
            "/tmp/kb-fake/repo/fix-y/note--ef01ef01ef01ef01.md",
        );

        expect(folderStorage.regenerateVisibleNote).toHaveBeenCalledWith(
            "ef01ef01ef01ef01",
            "fix/y",
        );
    });

    it("fires decoration refresh for the reverted file", async () => {
        const folderStorage = {
            forceRegenerateVisibleMarkdown: vi.fn().mockResolvedValue(true),
        } as unknown as FolderStorage;
        vi.spyOn(bridge, "resolveMemoryFile").mockResolvedValue({
            folderStorage,
            manifestEntry: {
                path: "main/foo-abcdef12.md",
                fileId: "abcdef1234567890abcdef1234567890abcdef12",
                type: "commit",
                fingerprint: "old",
                source: { commitHash: "abcdef1234567890abcdef1234567890abcdef12", branch: "main", generatedAt: "2026-01-15T10:00:00Z" },
                title: "Add foo",
            },
        });
        const refreshSpy = vi.spyOn(memoryFileDecorationProvider, "refreshUri");

        await vscode.commands.executeCommand("jollimemory.revertMemoryFileEdits", absPath);

        expect(refreshSpy).toHaveBeenCalledWith(vscode.Uri.file(absPath));
    });
});
```

- [ ] **Step 2: Add the bridge accessor `resolveMemoryFile`**

In `vscode/src/JolliMemoryBridge.ts`, add a method right after `isMemoryFileDivergedOnDisk` (introduced in Task 8). Same discovery walk, different return shape:

```ts
/**
 * Locate the FolderStorage + manifest entry responsible for `absPath`,
 * or null if the file is not under any known Memory Bank kbRoot. Used
 * by the revert command to dispatch to the correct regenerate helper.
 */
async resolveMemoryFile(absPath: string): Promise<{
    folderStorage: FolderStorage;
    manifestEntry: ManifestEntry;
} | null> {
    try {
        const cfg = (await loadConfig()) as Record<string, unknown>;
        const customKBPath = cfg.localFolder as string | undefined;
        const kbParent = resolveKbParent(customKBPath);
        const currentRepoName = extractRepoName(this.cwd);
        const currentRemoteUrl = getRemoteUrl(this.cwd);
        const repos = discoverRepos(currentRepoName, currentRemoteUrl, kbParent);
        const { sep } = await import("node:path");
        for (const repo of repos) {
            const prefix = repo.kbRoot.endsWith(sep) ? repo.kbRoot : repo.kbRoot + sep;
            if (!absPath.startsWith(prefix)) continue;
            const relPath = absPath.slice(prefix.length);
            const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
            const manifestEntry = mm.findByPath(relPath);
            if (!manifestEntry) return null;
            const folderStorage = new FolderStorage(repo.kbRoot, mm);
            return { folderStorage, manifestEntry };
        }
    } catch (err) {
        log.warn("resolveMemoryFile", `${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
}
```

(`ManifestEntry` is imported from `@jolli.ai/cli/dist/core/MetadataManager.js` — verify the existing import path used elsewhere in `JolliMemoryBridge.ts`.)

- [ ] **Step 3: Register the command**

In `vscode/src/Extension.ts`, register a new command alongside `openMemoryFile`:

```ts
vscode.commands.registerCommand(
    "jollimemory.revertMemoryFileEdits",
    async (absPath: unknown) => {
        if (typeof absPath !== "string" || absPath.length === 0) return;
        const resolved = await bridge.resolveMemoryFile(absPath);
        if (!resolved) {
            vscode.window.showWarningMessage(
                "Memory Bank: cannot revert — file is not under a known kbRoot.",
            );
            return;
        }
        const { folderStorage, manifestEntry } = resolved;
        let ok = false;
        if (manifestEntry.type === "commit") {
            const branch = manifestEntry.source?.branch ?? "main";
            ok = await folderStorage.forceRegenerateVisibleMarkdown({
                commitHash: manifestEntry.fileId,
                commitMessage: manifestEntry.title ?? manifestEntry.fileId,
                commitDate: manifestEntry.source?.generatedAt ?? "",
                branch,
                generatedAt: manifestEntry.source?.generatedAt ?? "",
                parentCommitHash: null,
            });
        } else if (manifestEntry.type === "plan") {
            const slug = manifestEntry.fileId.replace(/^plan:/, "");
            const branch = manifestEntry.source?.branch ?? "main";
            ok = await folderStorage.regenerateVisiblePlan(slug, branch);
        } else if (manifestEntry.type === "note") {
            const id = manifestEntry.fileId.replace(/^note:/, "");
            const branch = manifestEntry.source?.branch ?? "main";
            ok = await folderStorage.regenerateVisibleNote(id, branch);
        }
        if (ok) {
            memoryFileDecorationProvider.refreshUri(vscode.Uri.file(absPath));
            vscode.window.showInformationMessage(`Reverted to system version: ${absPath}`);
        } else {
            vscode.window.showWarningMessage(
                `Memory Bank: revert failed for ${absPath} — hidden source missing.`,
            );
        }
    },
),
```

- [ ] **Step 4: Declare the command + right-click menu in `vscode/package.json`**

Under `contributes.commands` add:

```json
{
    "command": "jollimemory.revertMemoryFileEdits",
    "title": "Memory Bank: Revert Edits to System Version"
}
```

Under `contributes.menus.explorer/context` add:

```json
{
    "command": "jollimemory.revertMemoryFileEdits",
    "when": "resourceFilename =~ /\\.md$/ && jollimemory.isMemoryBankFile",
    "group": "jollimemory@1"
}
```

In `KbFoldersService` (or wherever the active kbRoot URI list lives), set the context key whenever the resource under the cursor is a Memory Bank file:

```ts
// Whenever the active editor / explorer selection changes, check whether
// the file is under a known kbRoot and set the context key accordingly.
vscode.commands.executeCommand("setContext", "jollimemory.isMemoryBankFile", isUnderKbRoot(uri));
```

(Exact wire-up may be simpler: a `vscode.workspace.onDidChangeActiveTextEditor` hook in `Extension.ts` that sets the context key based on a bridge query.)

---

## Task 12: Verify everything and commit once

**Files:** none (verification + commit only)

All code changes from Tasks 1-11 are in the working tree. This task does the single `npm run all` and the single combined commit.

- [ ] **Step 1: Run `npm run all` from the repo root**

Run: `npm run all`

Expected: clean → build → lint → test all PASS. CLI coverage thresholds (97% statements / 96% branches / 97% functions / 97% lines) still met. The VS Code build inlines the updated cli/src so the extension picks up the new helpers automatically.

If any task's test fails, fix it (return to that task) and re-run `npm run all` from the top. Do not partial-commit.

- [ ] **Step 2: Verify the staged change set covers the expected files**

```bash
git status
```

Expected files modified or created:
- `cli/src/core/FolderStorage.ts`
- `cli/src/core/FolderStorage.test.ts`
- `vscode/src/JolliMemoryBridge.ts`
- `vscode/src/JolliMemoryBridge.test.ts`
- `vscode/src/Extension.ts`
- `vscode/src/Extension.test.ts`
- `vscode/src/services/MemoryFileDecorationProvider.ts` (new)
- `vscode/src/services/MemoryFileDecorationProvider.test.ts` (new)
- `vscode/src/services/KbFoldersService.ts` (likely modified to add `onFileChanged` event + context key)
- `vscode/package.json` (command + menu contribution)

If anything unexpected appears (e.g. an unrelated file), investigate before committing.

- [ ] **Step 3: Single combined commit**

```bash
git add cli/src/core/FolderStorage.ts cli/src/core/FolderStorage.test.ts \
        vscode/src/JolliMemoryBridge.ts vscode/src/JolliMemoryBridge.test.ts \
        vscode/src/Extension.ts vscode/src/Extension.test.ts \
        vscode/src/services/MemoryFileDecorationProvider.ts \
        vscode/src/services/MemoryFileDecorationProvider.test.ts \
        vscode/src/services/KbFoldersService.ts \
        vscode/package.json
git commit -s -m "Protect hand-edited Memory Bank markdown files from silent overwrite

Memory Bank visible markdown files at <localFolder>/<repo>/<branch>/*.md
were silently overwritten on the next regeneration and never reflected
in the sidebar. The fingerprint mechanism already used to skip deletion
of human-edited files was not applied to the write path, and the sidebar
read path bypassed disk content entirely.

Changes:
- FolderStorage: extract inline divergence check into isUserEditedOnDisk
  helper; use it across generateSummaryMarkdown / generatePlanMarkdown /
  generateNoteMarkdown to skip overwrites of diverged files. Refactor
  deleteVisibleArtifact and cleanupSupersededDescendants to use the same
  helper.
- FolderStorage: add forceRegenerateVisibleMarkdown / regenerateVisiblePlan /
  regenerateVisibleNote for the revert path (unlink-then-regenerate).
- JolliMemoryBridge: add isMemoryFileDivergedOnDisk and resolveMemoryFile
  using the existing cross-repo discovery walk.
- Extension.ts openMemoryFile: when a summary md is diverged, show a
  one-shot info message with [Revert] action and open markdown.showPreview
  (instead of the JSON-backed SummaryWebviewPanel). Plans/notes already
  flowed through showPreview; they get the same protection by virtue of
  the write-path fix.
- New MemoryFileDecorationProvider adds a ✎ badge + tooltip to diverged
  md files in any VS Code file UI.
- New jollimemory.revertMemoryFileEdits command + right-click menu
  delegates to the matching regenerate helper based on manifest type."
```

- [ ] **Step 4: Manual acceptance — summary protection**

Run `cd vscode && npm run deploy` then Developer: Reload Window. Open a Memory Bank summary md (`<kbRoot>/main/<slug>-<hash8>.md`) in VS Code editor, add a line, save. Make a new commit on the workspace repo. **Verify:** the visible md still contains your added line. Check Output → Jolli Memory; expect a log line like `FolderStorage: skip overwrite of user-edited …`.

- [ ] **Step 5: Manual acceptance — sidebar diverged routing**

Click the edited file in the Memory Bank sidebar. **Verify:**
- A small `✎` badge appears next to the filename (decoration provider).
- An information message pops up with `[Revert]` and `[Dismiss]` actions.
- Dismissing it opens a markdown preview showing the EDITED content (not the JSON version).
- Re-clicking the same file in the same session does NOT re-pop the message.

- [ ] **Step 6: Manual acceptance — revert**

From the divergence info message, click `[Revert]`. **Verify:**
- The file content reverts to the system-generated version.
- The `✎` badge disappears.
- Clicking the file again opens `SummaryWebviewPanel` (rich UI) as before.

- [ ] **Step 7: Manual acceptance — plans + notes**

Repeat steps 4-6 against `<kbRoot>/<branch>/plan--<slug>.md` and `<kbRoot>/<branch>/note--<id>.md` files. (For plans/notes the sidebar already renders markdown preview, so the only visible UI change from Task 9 is the badge and the info message — `SummaryWebviewPanel` is not involved.)

- [ ] **Step 8: Push the branch**

Once all manual checks pass, push the branch and confirm CI is green.

```bash
git push origin fix-badge-count
```

(Or whichever branch you're working on — `git status` will tell you.)
