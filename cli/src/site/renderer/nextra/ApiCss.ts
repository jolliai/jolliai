/**
 * CSS for the API-reference components — try-it widget, code-sample tabs,
 * parameter tables, schema/response blocks, method/status pills.
 *
 * Surfaces, typography, and dark-mode colours hook into Nextra's existing
 * `--nextra-*` tokens so the API pages match the rest of the docs site
 * without any per-customer theming. The accent hue is the only knob and
 * defaults to a Nextra-ish blue (220) — Phase 6 hardcodes this; theme
 * customisation is a future enhancement.
 *
 * Ported verbatim (modulo this header) from JOLLI-1392's themes/ApiCss.ts.
 * That source layered the output onto Forge / Atlas / Classic theme-pack
 * stylesheets; we emit it standalone since jolliai has no theme packs.
 */

import type { TemplateFile } from "./Types.js";

const DEFAULT_ACCENT_HUE = 220;

export interface ApiCssInput {
	/** Primary accent hue 0-360, used for method badges and active states. */
	accentHue?: number;
}

/**
 * Returns a `TemplateFile` for the API stylesheet. Path is project-root
 * relative — `NextraRenderer.initProject` writes it under the build dir
 * and `app/layout.tsx` imports it.
 */
export function generateApiCss(input: ApiCssInput = {}): TemplateFile {
	return {
		path: "styles/api.css",
		content: buildApiCss({ accentHue: input.accentHue ?? DEFAULT_ACCENT_HUE }),
	};
}

export function buildApiCss(input: ApiCssInput & { accentHue: number }): string {
	const hue = input.accentHue;
	return `
/* ═══════════════════════════════════════════════════════════════════════════
   API REFERENCE COMPONENTS
   Hooks into Nextra's existing \`--nextra-*\` tokens for surfaces / typography
   / dark mode. Accent hue is the only customer-driven input.
   ═══════════════════════════════════════════════════════════════════════════ */

:root {
  --api-method-get-bg:    hsl(155 70% 45%);
  --api-method-post-bg:   hsl(${hue} 84% 50%);
  --api-method-put-bg:    hsl(38 95% 50%);
  --api-method-patch-bg:  hsl(265 70% 55%);
  --api-method-delete-bg: hsl(0 75% 55%);
  --api-status-2xx:       hsl(155 70% 35%);
  --api-status-3xx:       hsl(${hue} 70% 50%);
  --api-status-4xx:       hsl(38 95% 45%);
  --api-status-5xx:       hsl(0 75% 50%);
}

.dark {
  --api-method-get-bg:    hsl(155 60% 50%);
  --api-method-post-bg:   hsl(${hue} 84% 60%);
  --api-method-put-bg:    hsl(38 95% 55%);
  --api-method-patch-bg:  hsl(265 70% 65%);
  --api-method-delete-bg: hsl(0 75% 60%);
  --api-status-2xx:       hsl(155 60% 50%);
  --api-status-3xx:       hsl(${hue} 70% 60%);
  --api-status-4xx:       hsl(38 95% 55%);
  --api-status-5xx:       hsl(0 75% 60%);
}

/* Method/status pills */
.api-method {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #ffffff;
  text-transform: uppercase;
}
.api-method-get    { background: var(--api-method-get-bg); }
.api-method-post   { background: var(--api-method-post-bg); }
.api-method-put    { background: var(--api-method-put-bg); }
.api-method-patch  { background: var(--api-method-patch-bg); }
.api-method-delete { background: var(--api-method-delete-bg); }
.api-method-head,
.api-method-options { background: var(--nextra-bg); color: inherit; border: 1px solid currentColor; }

.api-endpoint-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0.5rem 0 1.5rem;
}
.api-endpoint-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.95rem;
  background: var(--nextra-bg);
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid hsl(0 0% 50% / 0.2);
}
.api-endpoint-tag {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid hsl(0 0% 50% / 0.2);
}
.api-endpoint-deprecated {
  font-size: 0.75rem;
  font-weight: 600;
  color: hsl(0 75% 50%);
  border: 1px solid currentColor;
  padding: 2px 8px;
  border-radius: 4px;
}

/* Parameter tables */
.api-param-section { margin: 1rem 0 1.5rem; }
.api-param-section-title {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
}
.api-param-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  /* Fixed layout so column widths come from the rules below, not from
     browser auto-sizing. Default auto-sizing in the narrow two-column
     reference layout was wrapping the "NAME"/"TYPE"/"REQUIRED" headers
     (and the param-name code chips) onto two lines while leaving the
     description column with too much slack. */
  table-layout: fixed;
}
/* Column-width hints: name and type get just enough for typical content
   (path/query param names and OpenAPI primitive types are short); required
   is two characters ("Yes"/"No"); description takes whatever remains. */
.api-param-table th:nth-child(1),
.api-param-table td:nth-child(1) { width: 22%; }
.api-param-table th:nth-child(2),
.api-param-table td:nth-child(2) { width: 16%; }
.api-param-table th:nth-child(3),
.api-param-table td:nth-child(3) { width: 14%; }
.api-param-table th:nth-child(4),
.api-param-table td:nth-child(4) { width: auto; }
/* Param-name chips can break on hyphens/underscores when a name is unusually
   long, but should never wrap mid-word and lose the chip outline. */
.api-param-table td code {
  word-break: break-word;
  overflow-wrap: anywhere;
}
.api-param-table th,
.api-param-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid hsl(0 0% 50% / 0.15);
  vertical-align: top;
}
.api-param-table th {
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}
.api-param-table code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
}

/* Schema blocks */
.api-schema-block {
  border: 1px solid hsl(0 0% 50% / 0.2);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin: 0.5rem 0 1.5rem;
}
.api-schema-root,
.api-schema-children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.api-schema-row {
  padding: 4px 0;
}
.api-schema-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}
.api-schema-toggle {
  background: transparent;
  border: 1px solid hsl(0 0% 50% / 0.3);
  border-radius: 3px;
  width: 18px;
  height: 18px;
  font-size: 0.85rem;
  line-height: 1;
  cursor: pointer;
  color: inherit;
}
.api-schema-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 500;
}
.api-schema-type {
  font-size: 0.8rem;
  opacity: 0.65;
}
.api-schema-required {
  font-size: 0.7rem;
  color: hsl(0 75% 50%);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.api-schema-description {
  font-size: 0.85rem;
  opacity: 0.75;
  padding-left: 26px;
  margin-top: 2px;
}

/* Response blocks */
.api-response-block {
  border: 1px solid hsl(0 0% 50% / 0.2);
  border-radius: 6px;
  margin: 0.5rem 0 1rem;
  overflow: hidden;
}
.api-response-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: hsl(0 0% 50% / 0.06);
}
.api-response-status {
  font-weight: 700;
  font-size: 0.9rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.api-status-2xx { color: var(--api-status-2xx); }
.api-status-3xx { color: var(--api-status-3xx); }
.api-status-4xx { color: var(--api-status-4xx); }
.api-status-5xx { color: var(--api-status-5xx); }
.api-status-default { opacity: 0.7; }
.api-response-description { font-size: 0.9rem; }
.api-response-contenttype {
  font-size: 0.75rem;
  opacity: 0.6;
  margin-left: auto;
}
.api-response-block .api-schema-block {
  margin: 0;
  border: none;
  border-top: 1px solid hsl(0 0% 50% / 0.15);
  border-radius: 0;
}

/* Auth requirements */
.api-auth-list {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.api-auth-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border: 1px solid hsl(0 0% 50% / 0.2);
  border-radius: 4px;
  font-size: 0.9rem;
}
.api-auth-name { font-weight: 600; }
.api-auth-description { opacity: 0.8; }
.api-auth-scopes { font-size: 0.8rem; opacity: 0.65; margin-left: auto; }
.api-auth-none { font-size: 0.9rem; opacity: 0.7; }

/* Two-column endpoint layout. The left column hosts the docs that the
   reader scrolls (Try It, description, auth, params, request/response
   schemas); the right column hosts the code samples and response
   examples and "sticks" so they stay visible while the left column
   scrolls. On narrow viewports it collapses to a single column.

   Bias toward the left column — schemas and parameter tables benefit
   from extra width; the code samples are short and read fine in a
   narrower aside. The 1.25fr/1fr split lands around 56/44, leaving the
   left column ~125px wider than a 50/50 grid at typical viewport widths
   without starving the code panel. */
.api-endpoint-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 1.75rem;
  align-items: start;
  margin-top: 0.5rem;
  width: 100%;
}
.api-endpoint-main {
  min-width: 0;
}
.api-endpoint-aside {
  min-width: 0;
  position: sticky;
  top: calc(var(--nextra-navbar-height, 64px) + 16px);
  display: flex;
  flex-direction: column;
  /* Tight gap so the request and response code blocks read as a single
     paired unit, not two distant sections. */
  gap: 0.5rem;
}
.api-endpoint-aside h3 {
  /* Inline-level section labels for "Request" / "Response" — small and
     muted so the code blocks are the focus, not the labels. Hidden when
     the CodeSwitcher takes over the labelling slot via its own header. */
  font-size: 0.75rem !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.05em !important;
  margin: 0.25rem 0 0 !important;
  opacity: 0.7 !important;
}
/* Compact code blocks inside the aside — the page already has a primary
   reading column on the left, so the right column should read as a
   reference panel, not a code playground. Drop the font ~10% and tighten
   the line-height. */
.api-endpoint-aside pre,
.api-endpoint-aside .nextra-code pre,
.api-endpoint-aside code {
  font-size: 0.75rem !important;
  line-height: 1.6 !important;
}
@media (max-width: 1180px) {
  .api-endpoint-grid {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
  .api-endpoint-aside {
    position: static;
  }
}

/* Multi-spec sites: the runtime <ScopedNextraLayout> wrapper sets
   data-jolli-multi-spec="true" on <html> and unhides the active spec's
   per-spec page-tab so Nextra can scope the sidebar. Without this rule
   the navbar would show both the active spec's tab AND the "API
   Reference" dropdown — visually redundant. The dropdown is rendered as
   a <button>/<details> (not a top-level <a>), so the selector spares it. */
html[data-jolli-multi-spec="true"] .nextra-navbar nav > div > a[href^="/api-"] {
  display: none !important;
}

/* Nextra clamps the article column for comfortable docs reading.
   Inside that column a 50/50 split is far too narrow for code samples
   on the right and schema docs on the left, so on API endpoint pages
   we widen — but to a capped width, not the full viewport. Going
   edge-to-edge on a 1920px monitor produced lines too long to scan;
   the cap at ~1400px keeps it readable on big screens while still
   doubling the width compared to the regular docs reading column.

   \`theme.toc: false\` in the page frontmatter already removes the TOC,
   so its column is dead space we can reclaim. These overrides are gated
   by \`:has(.api-endpoint-grid)\` so they only apply on endpoint pages —
   normal docs pages stay at their respective reading widths. */
article:has(.api-endpoint-grid) {
  max-width: 1400px !important;
  width: 100% !important;
  margin: 0 auto !important;
  padding: 2rem 2.25rem 5rem !important;
}
@media (max-width: 767px) {
  /* Mobile: tighten the gutter so 320px viewports don't lose half their
     width to padding. The 2.25rem gutter looks fine at desktop but
     swallows a third of a phone screen. */
  article:has(.api-endpoint-grid) {
    padding: 1rem 1rem 4rem !important;
  }
}

/* Replace Nextra's default multi-column page grid with a 2-column grid
   (sidebar + rest) when an endpoint grid is present, then let the article
   span columns 2 → end and centre within the reclaimed space.

   GATED to viewports that actually have a desktop sidebar — otherwise
   the rule reintroduces a 295px sidebar column on mobile (where the
   media-query layout has already collapsed to a single column), which
   squashes the article column to ~100px and makes \`List all pets\` wrap
   one letter per line. The \`min-width: 768px\` matches Nextra's mobile
   breakpoint where the sidebar is hidden. */
@media (min-width: 768px) {
  div:has(article .api-endpoint-grid) {
    grid-template-columns: 295px 1fr !important;
  }
  div:has(article .api-endpoint-grid) > article {
    grid-column: 2 / -1 !important;
  }
}
/* TOC always hidden on endpoint pages (no media gate — the page-level
   \`theme.toc: false\` already disables the TOC, this is just defense). */
div:has(article .api-endpoint-grid) > nav.nextra-toc {
  display: none !important;
}

/* Belt-and-suspenders override so the centred-article clamp doesn't
   reassert itself mid-transition during sidebar-collapse animations. */
body:has(article .api-endpoint-grid) article {
  max-width: 1400px !important;
  margin: 0 auto !important;
}

/* Code sample blocks: rely on Nextra's MDX → Shiki highlighting on the
   underlying fenced blocks. We tighten margins so the code panel sits
   flush inside the right column without a double border. */
.api-endpoint-aside pre,
.api-endpoint-aside .nextra-code {
  margin: 0;
}

/* ──────────────────────────────────────────────────────────────────────
   CODE SWITCHER — top-right dropdown + copy button on a single fenced
   block. Replaces the horizontal Nextra <Tabs> strip on endpoint pages
   so each code panel reads as a unit (header bar + body) rather than
   tabs floating above a separate surface. The dropdown picks
   language/status; the copy button copies the visible pane's text.
   ────────────────────────────────────────────────────────────────────── */
.api-code-switcher {
  position: relative;
  border: 1px solid hsl(0 0% 50% / 0.18);
  border-radius: 6px;
  overflow: hidden;
  background: var(--nextra-bg);
}
.api-code-switcher-toolbar {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem 0.375rem 0.75rem;
  border-bottom: 1px solid hsl(0 0% 50% / 0.12);
  background: hsl(0 0% 50% / 0.04);
  font-size: 0.7rem;
}
.dark .api-code-switcher-toolbar {
  /* The light-mode 4% black tint disappears against dark surfaces — bump
     to a 6% white tint so the toolbar still reads as a distinct header. */
  background: hsl(0 0% 100% / 0.06);
  border-bottom-color: hsl(0 0% 100% / 0.1);
}
.api-code-switcher-label {
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  opacity: 0.6;
  margin-right: auto;
}
.api-code-switcher-select {
  appearance: none;
  -webkit-appearance: none;
  /* color-scheme tells the browser which palette to use for the native
     popup (option list). Without this, Chrome/Edge render a white system
     popup even on dark surfaces, which made the dropdown unreadable. */
  color-scheme: light;
  background: transparent;
  border: 1px solid hsl(0 0% 50% / 0.2);
  border-radius: 4px;
  padding: 2px 22px 2px 8px;
  font-size: 0.7rem;
  font-weight: 500;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  /* Caret glyph */
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position:
    calc(100% - 12px) 50%,
    calc(100% - 7px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  opacity: 0.9;
  transition: opacity 0.12s, border-color 0.12s, background-color 0.12s;
}
.api-code-switcher-select:hover,
.api-code-switcher-select:focus {
  opacity: 1;
  border-color: hsl(${hue} 84% 50% / 0.5);
  outline: none;
}
.dark .api-code-switcher-select {
  color-scheme: dark;
  border-color: hsl(0 0% 100% / 0.18);
  background-color: hsl(0 0% 100% / 0.04);
}
.dark .api-code-switcher-select:hover,
.dark .api-code-switcher-select:focus {
  background-color: hsl(0 0% 100% / 0.08);
  border-color: hsl(${hue} 84% 60% / 0.55);
}
/* Force option rows to inherit the dark surface — Chrome/Edge can still
   render a white popup on Windows even when the host element has
   color-scheme: dark, so we set the surface explicitly. */
.dark .api-code-switcher-select option {
  background-color: rgb(var(--nextra-bg));
  color: inherit;
}
.api-code-switcher-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid hsl(0 0% 50% / 0.2);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.7rem;
  font-weight: 500;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  opacity: 0.9;
  transition: opacity 0.12s, color 0.12s, border-color 0.12s, background-color 0.12s;
}
.api-code-switcher-copy:hover {
  opacity: 1;
  border-color: hsl(${hue} 84% 50% / 0.5);
  color: hsl(${hue} 84% 50%);
}
.api-code-switcher-copy[data-copied="true"] {
  color: hsl(155 70% 35%);
  border-color: hsl(155 70% 35% / 0.5);
  opacity: 1;
}
.dark .api-code-switcher-copy {
  border-color: hsl(0 0% 100% / 0.18);
  background-color: hsl(0 0% 100% / 0.04);
}
.dark .api-code-switcher-copy:hover {
  background-color: hsl(0 0% 100% / 0.08);
  border-color: hsl(${hue} 84% 60% / 0.55);
  color: hsl(${hue} 84% 65%);
}
.dark .api-code-switcher-copy[data-copied="true"] {
  color: hsl(155 60% 60%);
  border-color: hsl(155 60% 50% / 0.55);
}
.api-code-switcher-body {
  position: relative;
}
/* Nextra/MDX wraps fenced blocks in .nextra-code. Strip its borders +
   radius since the switcher already provides the surrounding frame. */
.api-code-switcher-body .nextra-code,
.api-code-switcher-body pre {
  margin: 0 !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
/* Hide Nextra's built-in copy button — the switcher carries its own. */
.api-code-switcher-body button[title="Copy code"] {
  display: none !important;
}
.api-code-switcher-pane[hidden] {
  display: none !important;
}

/* Try-it widget */
.api-tryit {
  border: 1px solid hsl(0 0% 50% / 0.2);
  border-radius: 6px;
  padding: 1rem;
  margin: 0.5rem 0 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.api-tryit-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0.25rem;
}
.api-tryit-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.95rem;
}
.api-tryit-section {
  border: 1px solid hsl(0 0% 50% / 0.15);
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.api-tryit-section legend {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 6px;
  opacity: 0.7;
}
.api-tryit-field { display: flex; flex-direction: column; gap: 4px; }
.api-tryit-label {
  font-size: 0.85rem;
  font-weight: 500;
}
.api-tryit-hint {
  font-size: 0.75rem;
  opacity: 0.65;
  font-weight: 400;
}
.api-tryit-input,
.api-tryit-textarea {
  border: 1px solid hsl(0 0% 50% / 0.25);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 0.9rem;
  background: var(--nextra-bg);
  color: inherit;
  font-family: inherit;
}
.api-tryit-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  resize: vertical;
}
.api-tryit-input:focus,
.api-tryit-textarea:focus {
  outline: 2px solid hsl(${hue} 84% 50% / 0.4);
  outline-offset: 1px;
  border-color: hsl(${hue} 84% 50%);
}
.api-tryit-send {
  align-self: flex-start;
  background: hsl(${hue} 84% 50%);
  color: #ffffff;
  border: none;
  border-radius: 4px;
  padding: 8px 18px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.api-tryit-send:hover:not(:disabled) { background: hsl(${hue} 84% 45%); }
.api-tryit-send:disabled { opacity: 0.6; cursor: not-allowed; }
.api-tryit-error {
  padding: 0.5rem 0.75rem;
  border: 1px solid hsl(0 75% 50% / 0.4);
  border-radius: 4px;
  background: hsl(0 75% 50% / 0.08);
  color: hsl(0 75% 40%);
  font-size: 0.85rem;
}
.dark .api-tryit-error { color: hsl(0 75% 70%); }
.api-tryit-response {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 0.25rem;
}
.api-tryit-response-status {
  font-size: 0.95rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.api-tryit-response-headers summary {
  cursor: pointer;
  font-size: 0.85rem;
  opacity: 0.8;
}
.api-tryit-response-headers pre,
.api-tryit-response-body {
  margin: 0;
  padding: 0.75rem;
  background: var(--nextra-bg);
  border: 1px solid hsl(0 0% 50% / 0.15);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  line-height: 1.5;
  overflow-x: auto;
}
.api-tryit-response-headers pre {
  border-radius: 4px;
}
/* Wrapper carries the toolbar + body together so the corners line up
   (toolbar on top, body underneath, sharing the same outer border). */
.api-tryit-response-body-wrap {
  border: 1px solid hsl(0 0% 50% / 0.15);
  border-radius: 4px;
  overflow: hidden;
}
.api-tryit-response-body-wrap .api-tryit-response-body {
  border: none;
  border-radius: 0;
  border-top: 1px solid hsl(0 0% 50% / 0.15);
}
.api-tryit-response-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  background: hsl(0 0% 50% / 0.04);
}
.dark .api-tryit-response-toolbar {
  background: hsl(0 0% 100% / 0.03);
}
.api-tryit-response-label {
  font-size: 0.75rem;
  font-weight: 500;
  opacity: 0.75;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* JSON syntax highlighting for the Try It response body. Token colors mirror
   the Shiki "github-light" / "github-dark" palettes the static code samples
   use, so live and example responses look like siblings. */
.api-tryit-response-body .json-key { color: hsl(220 100% 36%); }
.api-tryit-response-body .json-string { color: hsl(0 60% 40%); }
.api-tryit-response-body .json-number { color: hsl(220 80% 40%); }
.api-tryit-response-body .json-boolean { color: hsl(280 60% 40%); font-weight: 500; }
.api-tryit-response-body .json-null { color: hsl(280 60% 40%); font-weight: 500; }
.dark .api-tryit-response-body .json-key { color: hsl(210 95% 75%); }
.dark .api-tryit-response-body .json-string { color: hsl(20 80% 70%); }
.dark .api-tryit-response-body .json-number { color: hsl(150 70% 65%); }
.dark .api-tryit-response-body .json-boolean { color: hsl(280 80% 75%); }
.dark .api-tryit-response-body .json-null { color: hsl(280 80% 75%); }
`;
}
