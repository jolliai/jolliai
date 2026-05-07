# VS Code Onboarding Panel + Auto-Enable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the VS Code extension, (1) auto-install Jolli Memory hooks on first activation but persistently honour an explicit user opt-out, and (2) replace the bare "disabled-banner" with an onboarding panel that promotes the Anthropic-API-key path as the recommended option while keeping Jolli sign-in as a secondary alternative.

**Architecture:**
- **Persistence:** The opt-out is a marker file at `<projectDir>/.jolli/jollimemory/disabled-by-user` — sibling of `sessions.json` / `cursors.json` / `git-op-queue/`, gitignored via the existing `.jolli/` rule. The file's *existence* is the boolean (the body holds an ISO timestamp purely for human debugging). `disableJolliMemory` writes the file; `enableJolliMemory` removes it. Encapsulated in [`vscode/src/services/ManualDisableFlag.ts`](../../../vscode/src/services/ManualDisableFlag.ts) so the CLI and IntelliJ surfaces can adopt the same marker later without diverging. (Earlier draft used `vscode.ExtensionContext.workspaceState`; that bound the opt-out to VS Code's per-machine workspaceStorage, so reinstalling VS Code or moving the project dir silently dropped the user's intent — the marker file fixes that.)
- **Auto-enable trigger:** End of `activate()`, after `refreshStatusBar()` resolves the actual `enabled` value. If `!enabled && !manuallyDisabled`, the extension awaits `bridge.enable()` and re-runs `refreshStatusBar()`. This piggybacks on the existing enable command path so all stores stay in sync.
- **Onboarding visibility:** A new derived field `configured = signedIn || hasApiKey` rides on the existing `SidebarState` snapshot pushed to the webview. The webview shows the onboarding panel iff `configured === false` (independent of `enabled`); otherwise the existing tab UI renders. The legacy `disabled-banner` inside the Status tab is preserved for the `enabled === false && configured === true` edge case.
- **Onboarding actions:** "Configure API Key" (primary, recommended) runs `jollimemory.openSettings` (existing) so users land on the SettingsWebviewPanel they already know — no inline input mirror of the IntelliJ design, since reusing the settings page is simpler and matches the way every other API-key-style config is captured today. "Sign In / Sign Up" (secondary) runs `jollimemory.signIn` (existing OAuth flow).

**Tech Stack:** TypeScript (ESM in `cli/`, esbuild-bundled CJS in `vscode/`), Vitest, vscode webview (CSP-strict, `.hidden` class for visibility), existing CSS/HTML/Script three-builder pattern in `vscode/src/views/Sidebar*Builder.ts`.

---

## File structure

**New files:** none.

**Modified files:**
- `vscode/src/Extension.ts`
  - `activate()` end-of-init: read `workspaceState.get("jollimemory.manuallyDisabled")`, conditionally call `bridge.enable()` once.
  - `enableJolliMemory` command: set `manuallyDisabled = false`.
  - `disableJolliMemory` command: set `manuallyDisabled = true` (before the async `bridge.disable()` so the opt-out is durable even if uninstall fails).
- `vscode/src/views/SidebarMessages.ts`
  - Extend `SidebarState` with `readonly configured: boolean`.
- `vscode/src/views/SidebarWebviewProvider.ts`
  - Add `configured` to the serialized state snapshot, computed from the StatusStore derived flags (`signedIn || hasApiKey`).
  - Re-push state from existing auth and status listeners (already fire on sign-in/sign-out and config save).
- `vscode/src/views/SidebarHtmlBuilder.ts`
  - Add the onboarding-panel skeleton (`#onboarding-panel`) as a sibling of `#tab-bar` and `#tab-content-*`, hidden by default via `.hidden`.
- `vscode/src/views/SidebarCssBuilder.ts`
  - Add the onboarding-panel styles: card surface, RECOMMENDED badge, blue accent button, secondary outlined button, OR divider.
- `vscode/src/views/SidebarScriptBuilder.ts`
  - Toggle `#onboarding-panel` vs `#tab-bar`/`#tab-toolbar`/`#tab-content-*` based on `state.configured`.
  - Wire the two onboarding buttons to `vscode.postMessage` outbound `command` actions.

**Tests modified:**
- `vscode/src/Extension.test.ts` — auto-enable + manualDisable persistence tests.
- `vscode/src/views/SidebarHtmlBuilder.test.ts` — assert onboarding skeleton present, hidden by default.
- `vscode/src/views/SidebarScriptBuilder.test.ts` — assert show/hide behaviour gated on `configured`.
- `vscode/src/views/SidebarWebviewProvider.test.ts` — assert serialized state includes `configured` derived from auth + apiKey.

---

## Task 1: SidebarState gains `configured` field (host-side)

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts:21-50`
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` (the serializer that builds the state pushed to webview)
- Test: `vscode/src/views/SidebarWebviewProvider.test.ts`

- [ ] **Step 1: Write the failing test**

In `vscode/src/views/SidebarWebviewProvider.test.ts`, add to the existing `describe("serialize state")` group:

```typescript
it("derives configured=true when signedIn", () => {
    const state = buildSidebarState({
        enabled: true,
        signedIn: true,
        hasApiKey: false,
        // ...other defaults already used in nearby tests
    });
    expect(state.configured).toBe(true);
});

it("derives configured=true when hasApiKey", () => {
    const state = buildSidebarState({
        enabled: true,
        signedIn: false,
        hasApiKey: true,
    });
    expect(state.configured).toBe(true);
});

it("derives configured=false when neither signedIn nor hasApiKey", () => {
    const state = buildSidebarState({
        enabled: true,
        signedIn: false,
        hasApiKey: false,
    });
    expect(state.configured).toBe(false);
});
```

(`buildSidebarState` is the existing helper in this test file; if it doesn't yet expose `signedIn`/`hasApiKey` inputs, the test should be written against whatever provider method actually emits the snapshot — read the file first and adapt.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts -t "configured"`
Expected: FAIL — `state.configured` is `undefined`.

- [ ] **Step 3: Add `configured` to `SidebarState`**

In `vscode/src/views/SidebarMessages.ts`, extend the `SidebarState` interface:

```typescript
export interface SidebarState {
    readonly enabled: boolean;
    readonly authenticated: boolean;
    /**
     * True when the user can actually use Jolli Memory's AI features:
     * either signed in to Jolli, or they've supplied an Anthropic API key.
     * Drives the onboarding-panel vs main-UI split in the sidebar webview.
     */
    readonly configured: boolean;
    readonly activeTab: SidebarTab;
    readonly kbMode: KbMode;
    readonly branchName: string;
    readonly detached: boolean;
    readonly kbRepoFolder?: string;
    readonly degradedReason?: SidebarDegradedReason;
}
```

- [ ] **Step 4: Compute `configured` in the serializer**

In `vscode/src/views/SidebarWebviewProvider.ts`, find the spot that builds the `SidebarState` (the same place that already populates `authenticated` and `enabled`). Add:

```typescript
const configured = derived.signedIn || derived.hasApiKey;
return {
    enabled,
    authenticated,
    configured,
    // ...rest
};
```

(`derived` here is the StatusStore's StatusDerived value already in scope — see `StatusStore.derived.signedIn` and `StatusStore.derived.hasApiKey` defined in `StatusDataService.derive`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarWebviewProvider.test.ts -t "configured"`
Expected: PASS (3 tests).

Run: `npm run typecheck:vscode`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add vscode/src/views/SidebarMessages.ts vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarWebviewProvider.test.ts
git commit -s -m "feat(vscode): derive configured (signedIn || hasApiKey) on SidebarState"
```

---

## Task 2: HTML skeleton for onboarding panel

**Files:**
- Modify: `vscode/src/views/SidebarHtmlBuilder.ts:35-72`
- Test: `vscode/src/views/SidebarHtmlBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

In `vscode/src/views/SidebarHtmlBuilder.test.ts`, add:

```typescript
it("includes the onboarding panel skeleton, hidden by default", () => {
    const html = buildSidebarHtml("nonce", "vscode-resource:", "codicon.css", DEFAULT_STRINGS);
    expect(html).toContain('id="onboarding-panel"');
    expect(html).toMatch(/<div class="onboarding-panel hidden"/);
    expect(html).toContain("Get started with Jolli Memory");
    expect(html).toContain("Sign in to Jolli");
    expect(html).toContain("Use your Anthropic API key");
    expect(html).toContain("RECOMMENDED");
    expect(html).toContain('id="onboarding-signin-btn"');
    expect(html).toContain('id="onboarding-apikey-btn"');
});

it("renders Anthropic API key as the recommended option above Sign in to Jolli", () => {
    const html = buildSidebarHtml("nonce", "vscode-resource:", "codicon.css", DEFAULT_STRINGS);
    const apikeyIdx = html.indexOf("Use your Anthropic API key");
    const signinIdx = html.indexOf("Sign in to Jolli");
    expect(apikeyIdx).toBeGreaterThan(-1);
    expect(signinIdx).toBeGreaterThan(-1);
    expect(apikeyIdx).toBeLessThan(signinIdx);
    // RECOMMENDED badge should appear above (i.e. in the same DOM region as)
    // the Anthropic card, not the Sign in card.
    const badgeIdx = html.indexOf("RECOMMENDED");
    expect(badgeIdx).toBeGreaterThan(apikeyIdx - 600); // within the apikey card block
    expect(badgeIdx).toBeLessThan(signinIdx);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts -t "onboarding panel skeleton"`
Expected: FAIL — strings not found.

- [ ] **Step 3: Add the onboarding-panel skeleton**

In `vscode/src/views/SidebarHtmlBuilder.ts`, modify the `<div class="sidebar-root">` block to add the onboarding panel as a sibling **before** `<div class="tab-bar">`. Note the order: the **Anthropic API key** option is the recommended primary path on top, and **Sign in to Jolli** sits below as the secondary alternative.

```html
<div class="onboarding-panel hidden" id="onboarding-panel" role="region" aria-label="Get started with Jolli Memory">
  <header class="ob-header">
    <div class="ob-title-row">
      <i class="codicon codicon-sparkle ob-title-icon" aria-hidden="true"></i>
      <h2 class="ob-title">Get started with Jolli Memory</h2>
    </div>
    <p class="ob-subtitle">Jolli Memory automatically captures your work context and surfaces relevant memories as you code. Choose how you'd like to set it up.</p>
  </header>
  <hr class="ob-divider" />
  <section class="ob-card ob-card--recommended">
    <span class="ob-badge">RECOMMENDED</span>
    <div class="ob-card-row">
      <i class="codicon codicon-key ob-card-icon" aria-hidden="true"></i>
      <div class="ob-card-text">
        <h3 class="ob-card-title">Use your Anthropic API key</h3>
        <p class="ob-card-desc">Connect your own Anthropic API key for AI summarization. Memories are stored locally only.</p>
      </div>
    </div>
  </section>
  <button type="button" id="onboarding-apikey-btn" class="ob-btn ob-btn--primary">Configure API Key</button>
  <div class="ob-or"><span>OR</span></div>
  <section class="ob-card">
    <div class="ob-card-row">
      <i class="codicon codicon-cloud ob-card-icon" aria-hidden="true"></i>
      <div class="ob-card-text">
        <h3 class="ob-card-title">Sign in to Jolli</h3>
        <p class="ob-card-desc">Use Jolli's cloud to sync memories across machines and get AI summarization out of the box. Free to get started.</p>
      </div>
    </div>
  </section>
  <button type="button" id="onboarding-signin-btn" class="ob-btn ob-btn--secondary">Sign In / Sign Up</button>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts -t "onboarding panel skeleton"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarHtmlBuilder.ts vscode/src/views/SidebarHtmlBuilder.test.ts
git commit -s -m "feat(vscode): add onboarding-panel HTML skeleton (Anthropic key recommended, Sign in fallback)"
```

---

## Task 3: Onboarding-panel CSS

**Files:**
- Modify: `vscode/src/views/SidebarCssBuilder.ts` (append at end of returned CSS string)
- Test: `vscode/src/views/SidebarCssBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

In `vscode/src/views/SidebarCssBuilder.test.ts`, add:

```typescript
it("emits onboarding-panel styles", () => {
    const css = buildSidebarCss();
    expect(css).toMatch(/\.onboarding-panel\b/);
    expect(css).toMatch(/\.ob-card--recommended\b/);
    expect(css).toMatch(/\.ob-badge\b/);
    expect(css).toMatch(/\.ob-btn--primary\b/);
    expect(css).toMatch(/\.ob-btn--secondary\b/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarCssBuilder.test.ts -t "onboarding-panel styles"`
Expected: FAIL.

- [ ] **Step 3: Append onboarding styles**

In `vscode/src/views/SidebarCssBuilder.ts`, append at the end of `buildSidebarCss()`'s returned template literal:

```css
/* ── Onboarding panel ───────────────────────────────────────────── */
.onboarding-panel {
    padding: 16px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
}
.ob-header { margin-bottom: 12px; }
.ob-title-row { display: flex; align-items: center; gap: 8px; }
.ob-title-icon { font-size: 18px; color: var(--vscode-textLink-foreground); }
.ob-title { font-size: 14px; font-weight: 600; margin: 0; }
.ob-subtitle {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 6px 0 0 0;
    line-height: 1.5;
}
.ob-divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    margin: 12px 0 14px 0;
}
.ob-card {
    position: relative;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 6px;
    padding: 12px;
    background: var(--vscode-editor-background);
}
.ob-card--recommended {
    border-color: var(--vscode-focusBorder);
    border-width: 1.5px;
}
.ob-badge {
    position: absolute;
    top: 10px;
    right: 10px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 3px 8px;
    border-radius: 8px;
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    background: color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent);
}
.ob-card-row { display: flex; gap: 10px; align-items: flex-start; }
.ob-card-icon {
    font-size: 16px;
    margin-top: 2px;
    color: var(--vscode-foreground);
}
.ob-card-text { flex: 1; min-width: 0; }
.ob-card-title { font-size: 12px; font-weight: 600; margin: 0; }
.ob-card-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 4px 0 0 0;
    line-height: 1.5;
}
.ob-btn {
    display: block;
    width: 100%;
    padding: 8px 12px;
    margin-top: 8px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    text-align: center;
    border: 1px solid transparent;
}
.ob-btn--primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.ob-btn--primary:hover { background: var(--vscode-button-hoverBackground); }
.ob-btn--secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border-color: var(--vscode-widget-border, var(--vscode-editorWidget-border));
}
.ob-btn--secondary:hover { background: var(--vscode-list-hoverBackground); }
.ob-or {
    display: flex; align-items: center; gap: 10px;
    margin: 14px 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}
.ob-or::before, .ob-or::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vscode -- src/views/SidebarCssBuilder.test.ts -t "onboarding-panel styles"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarCssBuilder.test.ts
git commit -s -m "feat(vscode): add onboarding-panel CSS using vscode theme tokens"
```

---

## Task 4: Webview script — toggle onboarding vs tabs based on `configured`

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts`
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

In `vscode/src/views/SidebarScriptBuilder.test.ts`, add:

```typescript
it("registers onboarding signin button to dispatch jollimemory.signIn", () => {
    const js = buildSidebarScript();
    expect(js).toContain("onboarding-signin-btn");
    expect(js).toContain("'jollimemory.signIn'");
});
it("registers onboarding apikey button to dispatch jollimemory.openSettings", () => {
    const js = buildSidebarScript();
    expect(js).toContain("onboarding-apikey-btn");
    expect(js).toContain("'jollimemory.openSettings'");
});
it("toggles onboarding panel on configured=false", () => {
    const js = buildSidebarScript();
    // The render() routine must add/remove the .hidden class on #onboarding-panel
    // and inversely on #tab-bar / #tab-toolbar / #tab-content-* based on
    // state.configured.
    expect(js).toContain("state.configured");
    expect(js).toContain("onboarding-panel");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the toggle and click handlers in the script builder**

In `vscode/src/views/SidebarScriptBuilder.ts`, locate the part of the script that runs on every `state` update (the existing `render()` / state-dispatch closure). Add this block at the top of the render path, **before** the existing tab-bar visibility logic:

```javascript
const onboardingEl = document.getElementById('onboarding-panel');
const tabBarEl = document.getElementById('tab-bar');
const tabToolbarEl = document.getElementById('tab-toolbar');
const tabContentBranch = document.getElementById('tab-content-branch');
const tabContentKb = document.getElementById('tab-content-kb');
const tabContentStatus = document.getElementById('tab-content-status');
const onboardingHidden = state.configured !== false;
onboardingEl.classList.toggle('hidden', onboardingHidden);
tabBarEl.classList.toggle('hidden', !onboardingHidden);
// tab-toolbar and tab-content-* keep their existing per-tab toggles when shown;
// here we just force-hide them while onboarding is active.
if (!onboardingHidden) {
    tabToolbarEl.classList.add('hidden');
    tabContentBranch.classList.add('hidden');
    tabContentKb.classList.add('hidden');
    tabContentStatus.classList.add('hidden');
    return;  // skip the rest of render() — onboarding takes the whole view
}
```

(The exact insertion point depends on the existing render shape — see the SidebarScriptBuilder file. The intent: when `configured === false`, only the onboarding panel is visible, and the rest of render() is skipped. When `true`, the existing behaviour is unchanged.)

Then, at the end of the script's one-time DOMContentLoaded init block (next to the other `addEventListener` calls), add:

```javascript
document.getElementById('onboarding-signin-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'command', command: 'jollimemory.signIn' });
});
document.getElementById('onboarding-apikey-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'command', command: 'jollimemory.openSettings' });
});
```

(Reuse the existing generic `command` outbound message protocol — see `SidebarMessages.ts` outbound types and the existing iconButton wiring at line ~302.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "feat(vscode): show onboarding panel when sidebar state.configured is false"
```

---

## Task 5: Persist `manuallyDisabled` on Disable, clear on Enable

**Files:**
- Modify: `vscode/src/Extension.ts:1177-1249` (the two command registrations)
- Test: `vscode/src/Extension.test.ts:1264-1330` (existing `enableJolliMemory` / `disableJolliMemory` describe blocks)

- [ ] **Step 1: Write the failing test**

In `vscode/src/Extension.test.ts`, inside `describe("disableJolliMemory")`:

```typescript
it("persists manualDisable=true to workspaceState", async () => {
    const handler = getRegisteredCommand("jollimemory.disableJolliMemory");
    bridge.disable.mockResolvedValue({ success: true, message: "ok" });
    await handler();
    expect(workspaceStateUpdate).toHaveBeenCalledWith("jollimemory.manuallyDisabled", true);
});
```

And inside `describe("enableJolliMemory")`:

```typescript
it("clears manualDisable in workspaceState", async () => {
    const handler = getRegisteredCommand("jollimemory.enableJolliMemory");
    bridge.enable.mockResolvedValue({ success: true, message: "ok" });
    await handler();
    expect(workspaceStateUpdate).toHaveBeenCalledWith("jollimemory.manuallyDisabled", false);
});
```

(`workspaceStateUpdate` is the existing mock spy on `context.workspaceState.update` — see how nearby tests reference workspaceState. Add a spy if missing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vscode -- src/Extension.test.ts -t "manualDisable"`
Expected: FAIL.

- [ ] **Step 3: Persist the flag**

In `vscode/src/Extension.ts`, just below the existing constants near the top of `activate()`, declare a helper key:

```typescript
const MANUAL_DISABLE_KEY = "jollimemory.manuallyDisabled";
```

Then in the `enableJolliMemory` registration, immediately after `if (!result.success)` returns / before the success branch's existing logic:

```typescript
await context.workspaceState.update(MANUAL_DISABLE_KEY, false);
```

(Place it after the `if (!result.success)` early-return so we only clear it on success.)

In the `disableJolliMemory` registration, **before** the `await bridge.disable()` call (so the opt-out is durable even if uninstall fails):

```typescript
await context.workspaceState.update(MANUAL_DISABLE_KEY, true);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vscode -- src/Extension.test.ts -t "manualDisable"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/Extension.ts vscode/src/Extension.test.ts
git commit -s -m "feat(vscode): persist manuallyDisabled flag in workspaceState"
```

---

## Task 6: Auto-enable on activate when not manually disabled

**Files:**
- Modify: `vscode/src/Extension.ts` (the `activate()` body, after `refreshStatusBar()` resolves)
- Test: `vscode/src/Extension.test.ts`

- [ ] **Step 1: Write the failing test**

In `vscode/src/Extension.test.ts`, add a new describe block near the existing `activate()` tests:

```typescript
describe("auto-enable on activate", () => {
    it("calls bridge.enable() when status.enabled=false and manuallyDisabled=false", async () => {
        bridge.getStatus.mockResolvedValue({ enabled: false, /* ... */ });
        workspaceStateGet.mockReturnValue(false);
        await activate(mockContext);
        expect(bridge.enable).toHaveBeenCalledTimes(1);
    });

    it("does NOT call bridge.enable() when status.enabled=false but manuallyDisabled=true", async () => {
        bridge.getStatus.mockResolvedValue({ enabled: false, /* ... */ });
        workspaceStateGet.mockReturnValue(true);
        await activate(mockContext);
        expect(bridge.enable).not.toHaveBeenCalled();
    });

    it("does NOT call bridge.enable() when status.enabled=true (already enabled)", async () => {
        bridge.getStatus.mockResolvedValue({ enabled: true, /* ... */ });
        workspaceStateGet.mockReturnValue(false);
        await activate(mockContext);
        expect(bridge.enable).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vscode -- src/Extension.test.ts -t "auto-enable on activate"`
Expected: FAIL.

- [ ] **Step 3: Add the auto-enable hook**

In `vscode/src/Extension.ts`, find the line in `activate()` where `refreshStatusBar()` is first awaited (the `currentEnabled = status.enabled;` assignment after initial wiring). Right after that line, add:

```typescript
// Auto-enable on first run unless the user has explicitly opted out.
// `manuallyDisabled` is only set to true by disableJolliMemory; on a fresh
// install / fresh workspace it's undefined → falsy → we install.
const manuallyDisabled =
    context.workspaceState.get<boolean>(MANUAL_DISABLE_KEY) === true;
if (!currentEnabled && !manuallyDisabled) {
    log.info("activate", "Auto-enabling Jolli Memory (no opt-out recorded)");
    const result = await bridge.enable();
    if (result.success) {
        const refreshed = await refreshStatusBar(
            bridge, memoriesStore, plansStore, filesStore, commitsStore, statusBar,
        );
        currentEnabled = refreshed.enabled;
        sidebarProvider.notifyEnabledChanged(refreshed.enabled);
    } else {
        log.warn("activate", "Auto-enable failed", { message: result.message });
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vscode -- src/Extension.test.ts -t "auto-enable on activate"`
Expected: PASS.

- [ ] **Step 5: Run the full vscode test suite**

Run: `npm run test:vscode`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add vscode/src/Extension.ts vscode/src/Extension.test.ts
git commit -s -m "feat(vscode): auto-enable Jolli Memory on activate unless manually disabled"
```

---

## Task 7: End-to-end smoke + final checks

- [ ] **Step 1: Build the extension**

Run: `cd vscode && npm run build && cd ..`
Expected: build succeeds.

- [ ] **Step 2: Run full pipeline**

Run from repo root: `npm run typecheck && npm run lint && npm run test`
Expected: all pass.

- [ ] **Step 3: Manual smoke (in a real VS Code Extension Host)**

Start with a fresh repo where Jolli is NOT installed and the workspaceState is clean:

1. Reload VS Code in the dev sandbox (`F5` in `vscode/`).
2. Open the JolliMemory side panel.
3. **Expect:** sidebar shows the onboarding panel because `configured=false` (not signed in, no API key).
4. Run `jollimemory.signIn` (or click Sign In / Sign Up).
5. **Expect:** after OAuth, sidebar flips to the normal tabs — onboarding panel hidden.
6. Run `Jolli Memory: Disable` from the command palette.
7. Reload the window.
8. **Expect:** sidebar still shows the disabled state — auto-enable was suppressed because `manuallyDisabled=true`.
9. Run `Jolli Memory: Enable`.
10. Reload the window.
11. **Expect:** sidebar shows the normal tabs without re-prompting.

- [ ] **Step 4: Final commit (if anything was tweaked during smoke)**

```bash
git status
# If clean: skip. Otherwise:
git add -p
git commit -s -m "fix(vscode): <follow-up from smoke test>"
```

---

## Self-review checklist

- [ ] **Spec coverage:** Auto-enable on install? Task 6. Manual-disable persistence? Task 5. Highlight Anthropic API key as recommended (top + RECOMMENDED badge + primary button), Sign in as fallback? Tasks 2 + 3. Onboarding shows on `!configured`? Tasks 1 + 4.
- [ ] **No placeholders:** Every `<description>` resolved to a concrete string; every step has runnable code or an exact command.
- [ ] **Type consistency:** `MANUAL_DISABLE_KEY` is referenced uniformly in Tasks 5 and 6. `state.configured` is the same property name in Tasks 1 and 4. The two onboarding button IDs (`onboarding-signin-btn`, `onboarding-apikey-btn`) match across Tasks 2 and 4.
- [ ] **No private DOM coupling:** the script toggles by id (`onboarding-panel`, `tab-bar`, etc.), all defined in the HTML skeleton in Task 2.
