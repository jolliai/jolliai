/**
 * Forge theme CSS — clean developer-docs visual style.
 *
 * Sidebar-dominant layout, navbar reduced to search + theme switch, three-column
 * desktop grid (sidebar | article | TOC), Inter typography, hairline borders.
 *
 * Pack-internal defaults are encoded in --forge-* and --header-/--nav-* CSS
 * variables. The override block (built by `buildForgeOverrides`) is appended at
 * the end of the file so customer accent + sidebar/header bg overrides take
 * precedence via the cascade.
 *
 * Vendored from the SaaS Forge pack
 * (`tools/nextra-generator/src/themes/forge/styles/ForgeCss.ts` in jolli.ai/jolli)
 * post-JOLLI-1392. The auth banner block has been stripped (CLI sites don't
 * have JWT auth) and the API-reference companion stylesheet (`buildApiCss`)
 * is intentionally not appended yet — it lands in a follow-up commit so the
 * OpenAPI page styling can be reviewed in isolation.
 */

/**
 * Base Forge stylesheet. Keep in sync with the
 * `forge-theme/forge.css` reference under Downloads.
 */
const FORGE_BASE_CSS = `/*
 * Forge Theme
 * To retheme: override the --header-* and --nav-* variables only.
 * Everything else derives from those + the general palette.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   DESIGN TOKENS
   ═══════════════════════════════════════════════════════════════════════════ */

:root {
  /* Nextra internals */
  --nextra-primary-hue: 228;
  --nextra-primary-saturation: 84%;
  --nextra-primary-lightness: 61%;
  --nextra-bg: 255 255 255;
  --nextra-navbar-height: 54px;

  /* ── Accent ─────────────────────────────────────────── */
  --forge-accent:        hsl(228 84% 61%);
  --forge-accent-soft:   hsl(228 84% 96%);
  --forge-accent-border: hsl(228 84% 75%);

  /* ── General palette ────────────────────────────────── */
  --forge-bg:            #ffffff;
  --forge-border:        #e5e7eb;
  --forge-border-soft:   #f3f4f6;
  --forge-text-strong:   #111827;
  --forge-text:          #374151;
  --forge-text-soft:     #6b7280;
  --forge-text-faint:    #9ca3af;
  --forge-hover-bg:      #f9fafb;

  /* ── Header (navbar) ────────────────────────────────── */
  --header-bg:             #ffffff;
  --header-border:         #e5e7eb;
  --header-logo-color:     #111827;
  --header-search-bg:      #f3f4f6;
  --header-search-border:  #e5e7eb;
  --header-search-color:   #6b7280;
  --header-kbd-bg:         #ffffff;
  --header-kbd-color:      #9ca3af;

  /* ── Left-hand nav (sidebar) ────────────────────────── */
  --nav-bg:                #f3f4f6;
  --nav-border:            #e5e7eb;
  --nav-section-color:     #9ca3af;
  --nav-item-color:        #4b5563;
  --nav-item-hover-bg:     #e9ebee;
  --nav-item-hover-color:  #111827;
  --nav-active-bg:         #ffffff;
  --nav-active-color:      hsl(228 84% 61%);
  --nav-active-bar:        hsl(228 84% 61%);
  --nav-footer-bg:         #eceef1;
  --nav-footer-border:     #e5e7eb;
  --nav-footer-color:      #6b7280;
}

.dark {
  --nextra-bg: 10 10 15;
  --nextra-primary-lightness: 68%;

  --forge-accent-soft:   hsl(228 84% 11%);
  --forge-accent-border: hsl(228 84% 40%);
  --forge-bg:            rgb(10 10 15);
  --forge-border:        #1f2937;
  --forge-border-soft:   #111827;
  --forge-text-strong:   #f9fafb;
  --forge-text:          #d1d5db;
  --forge-text-soft:     #9ca3af;
  --forge-text-faint:    #6b7280;
  --forge-hover-bg:      #111827;

  --header-bg:             rgb(10 10 15);
  --header-border:         #1f2937;
  --header-logo-color:     #f9fafb;
  --header-search-bg:      #111827;
  --header-search-border:  #1f2937;
  --header-search-color:   #9ca3af;
  --header-kbd-bg:         #1f2937;
  --header-kbd-color:      #4b5563;

  --nav-bg:                #111827;
  --nav-border:            #1f2937;
  --nav-section-color:     #6b7280;
  --nav-item-color:        #9ca3af;
  --nav-item-hover-bg:     #111827;
  --nav-item-hover-color:  #f9fafb;
  --nav-active-bg:         hsl(228 84% 11%);
  --nav-active-color:      hsl(228 84% 68%);
  --nav-active-bar:        hsl(228 84% 68%);
  --nav-footer-bg:         rgb(10 10 15);
  --nav-footer-border:     #1f2937;
  --nav-footer-color:      #6b7280;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BASE
   ═══════════════════════════════════════════════════════════════════════════ */

html {
  font-family: var(--forge-font-family, 'Inter', ui-sans-serif, system-ui, sans-serif) !important;
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.011em;
}

body { background-color: var(--forge-bg); }

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR LOGO — pinned to very top of sidebar column
   ═══════════════════════════════════════════════════════════════════════════ */

.forge-sidebar-logo {
  position: fixed;
  top: 0;
  left: 0;
  width: 295px;
  height: var(--nextra-navbar-height);
  background: var(--nav-bg);
  z-index: 36;
  display: flex;
  align-items: center;
  padding: 0 1rem;
  flex-shrink: 0;
}

.forge-sidebar-logo a {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--nav-item-hover-color);
  text-decoration: none;
}
.forge-sidebar-logo a img {
  flex-shrink: 0;
  height: 24px;
  width: auto;
}
.forge-sidebar-logo a:hover { opacity: 0.75; }

/* Light/dark logo swap — only fires when both variants are emitted. */
img.forge-logo-dark { display: none !important; }
.dark img.forge-logo-light { display: none !important; }
.dark img.forge-logo-dark { display: inline-block !important; }

@media (max-width: 767px) {
  .forge-sidebar-logo { display: none; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR SEARCH — pinned below the logo
   ═══════════════════════════════════════════════════════════════════════════ */

.forge-sidebar-search {
  position: fixed;
  top: var(--nextra-navbar-height);
  left: 0;
  width: 295px;
  padding: 0.625rem 1rem;
  background: var(--nav-bg);
  z-index: 36;
}

.forge-sidebar-search .nextra-search input {
  width: 100% !important;
  background: var(--forge-bg) !important;
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.5rem !important;
  padding: 0.4375rem 0.75rem !important;
  font-size: 0.8125rem !important;
  font-family: inherit !important;
  color: var(--forge-text-soft) !important;
  transition: border-color 0.15s, box-shadow 0.15s !important;
}
.forge-sidebar-search .nextra-search input::placeholder {
  color: var(--forge-text-faint) !important;
}
.forge-sidebar-search .nextra-search input:focus {
  border-color: var(--forge-accent) !important;
  box-shadow: 0 0 0 3px var(--forge-accent-soft) !important;
  outline: none !important;
  color: var(--forge-text-strong) !important;
}
.forge-sidebar-search .nextra-search kbd {
  background: var(--forge-border-soft) !important;
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.25rem !important;
  color: var(--forge-text-faint) !important;
  font-family: inherit !important;
  font-size: 0.625rem !important;
  box-shadow: none !important;
  padding: 0 0.3rem !important;
}
.dark .forge-sidebar-search .nextra-search input {
  background: var(--forge-border-soft) !important;
}

.nextra-sidebar > div:first-child {
  padding-top: calc(var(--nextra-navbar-height) + 3.75rem) !important;
}

.nextra-search ul,
.nextra-search [role="listbox"],
.nextra-search [role="dialog"],
.nextra-search > div:not(:first-child),
.nextra-search > p {
  z-index: 1000 !important;
  position: relative;
}

/* Portal-rendered search dropdown sits at body level. The default width
   inherits from the search input (~263px in the sidebar), which clips long
   result titles, and the default z-index is below the fixed sidebar (35),
   which paints over the dropdown's left half. We catch the portal element
   across nextra-theme-docs class-name variations (Nextra has shipped a few
   different combinations of tailwind utility classes) plus role-based
   fallbacks so any of them gets the wider min-width and the high z-index.
   position:relative is required because z-index has no effect on a
   position:static element.

   The :has rules use descendant matching (not direct-child) because Nextra
   sometimes wraps the listbox in one or more layers of divs inside the
   portal — newer combobox builds add an empty wrapper for transition
   animations, which broke the previous direct-child > [role=listbox]
   selector and let the sidebar paint over the popup. */
body > [class*="rounded-xl"][class*="shadow-xl"],
body > [class*="rounded-lg"][class*="shadow-lg"],
body > [class*="z-30"][class*="rounded"],
body > [class*="z-50"][class*="rounded"],
body > div[id^="headlessui-combobox"],
body > div[id^="headlessui"],
body > [data-headlessui-state],
body > div:has([role="listbox"]),
body > div:has([role="dialog"]),
body > [role="listbox"],
body > [role="dialog"][aria-modal="true"]:has([role="listbox"]) {
  position: relative !important;
  z-index: 9999 !important;
  min-width: 480px !important;
  max-width: calc(100vw - 2rem) !important;
}

body > [class*="rounded-xl"][class*="shadow-xl"] li > a,
body > [class*="rounded-lg"][class*="shadow-lg"] li > a,
body > [class*="rounded-xl"] [role="option"],
body > [class*="rounded-lg"] [role="option"],
body > [role="listbox"] [role="option"],
body > div:has(> [role="listbox"]) [role="option"] {
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

@media (max-width: 767px) {
  .forge-sidebar-search { display: none; }
  /* Search dropdown sizing on mobile. The desktop rules (above) hard-set
     min-width: 480px so the popover doesn't clip long titles next to the
     295px sidebar; on mobile that overflows the viewport, so we drop
     min-width and pin both width and max-width to (100vw - 1rem) so the
     dropdown fills the screen with a comfortable inset. max-height caps
     the popover at 70vh so it never pushes the input offscreen — the
     result list scrolls inside instead. */
  body > [class*="rounded-xl"][class*="shadow-xl"],
  body > [class*="rounded-lg"][class*="shadow-lg"],
  body > [class*="z-30"][class*="rounded"],
  body > [class*="z-50"][class*="rounded"],
  body > div[id^="headlessui-combobox"],
  body > div:has(> [role="listbox"]),
  body > [role="listbox"] {
    min-width: 0 !important;
    width: calc(100vw - 1rem) !important;
    max-width: calc(100vw - 1rem) !important;
    max-height: 70vh !important;
  }
  /* Override the desktop nowrap+ellipsis (where rows fit comfortably in
     the 480px popover): on mobile the rows must wrap so the page title
     and breadcrumb don't collapse to a single ellipsized character. Bump
     padding so each row hits a 44px+ tap target. */
  body > [class*="rounded-xl"][class*="shadow-xl"] li > a,
  body > [class*="rounded-lg"][class*="shadow-lg"] li > a,
  body > [class*="rounded-xl"] [role="option"],
  body > [class*="rounded-lg"] [role="option"],
  body > [role="listbox"] [role="option"],
  body > div:has(> [role="listbox"]) [role="option"] {
    white-space: normal !important;
    overflow: visible !important;
    text-overflow: clip !important;
    padding: 0.75rem 0.875rem !important;
    min-height: 2.75rem !important;
  }
  /* Nextra v4 portals the search popover (.nextra-search-results) via
     Headless UI Combobox + Floating UI. Floating UI anchors the popover
     to the search input's top edge ('top end'); when the input sits near
     the top of the mobile drawer, the available space above is just the
     navbar height (~30px), which collapses the popover to one cramped
     row. Sizing overrides alone can't fix this — the bigger popover
     just extends further off-screen above the viewport.

     Resolution: ignore Floating UI's anchor positioning on mobile and
     force-render the popover as a fixed overlay below the navbar,
     spanning most of the viewport. Visually disconnected from the input
     but always usable. !important wins over Floating UI's frame-by-frame
     inline style assignments because Floating UI doesn't set !important.

     Top is set to (navbar + 6rem) so the popover starts below the
     drawer's search input — the input lives at navbar-bottom + drawer
     top-padding + input-height, which works out to ~5rem below the
     navbar; the extra 1rem is breathing room so the popover isn't
     visually jammed up against the input. Users can keep typing and
     see results update without the popover masking the input. */
  .nextra-search-results {
    position: fixed !important;
    top: calc(var(--nextra-navbar-height) + 6rem) !important;
    left: 0.5rem !important;
    right: 0.5rem !important;
    bottom: 1rem !important;
    width: auto !important;
    max-width: none !important;
    height: auto !important;
    max-height: none !important;
  }
  .nextra-search-results [role="option"] {
    padding: 0.75rem 0.875rem !important;
    min-height: 2.75rem !important;
  }
}

/* Nextra's "Skip to Content" accessibility anchor uses an x:sr-only
   utility that gets overridden by our cascade-layer wrap, so it renders
   as a giant visible link in the top-left. We don't surface keyboard-skip
   navigation in the Jolli-generated layouts (the sidebar's first link is
   already the primary entry point), so hide it outright. */
.nextra-skip-nav,
a[href="#nextra-skip-nav"] {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
  /* Even when focused, don't reveal — feature isn't surfaced in Forge. */
  clip-path: inset(50%) !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HEADER / NAVBAR
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-navbar-blur {
  background-color: var(--header-bg) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  border-bottom: 1px solid var(--nav-bg) !important;
}

.nextra-navbar nav {
  max-width: 100% !important;
  padding-left: calc(295px + 1.5rem) !important;
  padding-right: 1.5rem !important;
  gap: 0 !important;
}

@media (max-width: 767px) {
  .nextra-navbar nav {
    padding-left: 1rem !important;
    padding-right: 1rem !important;
  }
  /* Hide the navbar's page-tab strip (Documentation, API Reference, header
     links). On mobile those entries live in the hamburger drawer — leaving
     them in the top bar made it overflow into a wrapped row at any
     viewport with more than two header items. The search wrapper, theme
     switch, and hamburger stay visible because they're siblings of (not
     inside) the nav-items div. */
  .nextra-navbar nav > div:not(:has(.nextra-search)) {
    display: none !important;
  }
}

.nextra-navbar nav > a[href="/"] {
  display: none !important;
}

@media (max-width: 767px) {
  .nextra-navbar nav > a[href="/"] {
    display: flex !important;
    align-items: center !important;
    margin-right: auto !important;
  }
}

.forge-navbar-logo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--forge-text-strong);
}
.forge-navbar-logo img {
  flex-shrink: 0;
  height: 24px;
  width: auto;
}

.nextra-navbar nav > div:not(:has(.nextra-search)) {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  overflow: visible;
  /* Right-align the nav links inside this flex:1 container so they cluster
     toward the search/theme controls instead of butting against the
     sidebar's right edge. The search wrapper is a separate sibling div with
     its own \`margin-left: auto\` (below), so it stays pinned rightmost
     after the nav links. */
  justify-content: flex-end;
}

/* Header links rendered from nav-* _meta.ts entries — give them comfortable
   spacing and link-style treatment so they do not butt against each other or
   look like raw text. */
.nextra-navbar nav > div > a,
.nextra-navbar nav > div > details {
  padding: 0.375rem 0.625rem !important;
  font-size: 0.8125rem !important;
  font-weight: 500 !important;
  color: var(--forge-text-soft) !important;
  text-decoration: none !important;
  border-radius: 0.375rem !important;
  transition: background 0.12s, color 0.12s !important;
  white-space: nowrap !important;
}
.nextra-navbar nav > div > a:hover,
.nextra-navbar nav > div > details:hover {
  background: var(--forge-hover-bg) !important;
  color: var(--forge-text-strong) !important;
}
.nextra-navbar nav > div > details > summary {
  cursor: pointer !important;
  list-style: none !important;
}

.nextra-navbar .nextra-search { margin-left: auto; }
.forge-sidebar-search .nextra-search { margin-left: 0; width: 100%; }

/* Forge renders search twice: a sidebar block (forge-sidebar-search) for
   desktop and Nextra's auto-rendered navbar search for mobile. Each viewport
   shows exactly one — sidebar is hidden under 768px (line 277) and the
   navbar copy is hidden at/above it here. Both are <Search/> from
   nextra/components and trigger the same Cmd+K modal, so duplication
   doesn't fork shortcut state. */
@media (min-width: 768px) {
  .nextra-navbar .nextra-search { display: none !important; }
}

.nextra-search input {
  width: 13rem !important;
  background: var(--header-search-bg) !important;
  border: 1px solid var(--header-search-border) !important;
  border-radius: 0.5rem !important;
  padding: 0.375rem 0.75rem !important;
  font-size: 0.8125rem !important;
  font-family: inherit !important;
  color: var(--header-search-color) !important;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s !important;
}
.nextra-search input::placeholder { color: var(--header-search-color) !important; }
.nextra-search input:focus {
  background: var(--forge-bg) !important;
  border-color: var(--forge-accent) !important;
  box-shadow: 0 0 0 3px var(--forge-accent-soft) !important;
  outline: none !important;
  color: var(--forge-text-strong) !important;
}

.nextra-search kbd {
  background: var(--header-kbd-bg) !important;
  border: 1px solid var(--header-search-border) !important;
  border-radius: 0.25rem !important;
  color: var(--header-kbd-color) !important;
  font-family: inherit !important;
  font-size: 0.625rem !important;
  letter-spacing: 0.02em !important;
  box-shadow: none !important;
  padding: 0 0.3rem !important;
}

.nextra-hamburger {
  color: var(--forge-text-soft) !important;
  padding: 0.375rem !important;
  border-radius: 0.375rem !important;
}
.nextra-hamburger:hover {
  background: var(--forge-hover-bg) !important;
  color: var(--forge-text-strong) !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN LAYOUT — 5-col grid
   col: [sidebar 295px] [1fr] [article 680px] [toc 220px] [1fr]
   ═══════════════════════════════════════════════════════════════════════════ */

div:has(> aside.nextra-sidebar) {
  display: grid !important;
  grid-template-columns: 295px 1fr 680px 220px 1fr !important;
  max-width: 100% !important;
  width: 100% !important;
  margin: 0 !important;
  align-items: start !important;
}

aside.nextra-sidebar { grid-column: 1 !important; grid-row: 1 !important; }
article              { grid-column: 3 !important; grid-row: 1 !important; min-width: 0 !important; width: 100% !important; max-width: 100% !important; margin: 0 !important; }
nav.nextra-toc       { grid-column: 4 !important; grid-row: 1 !important; width: 220px !important; order: unset !important; }

@media (max-width: 1279px) {
  div:has(> aside.nextra-sidebar) { grid-template-columns: 295px 1fr 680px 1fr !important; }
  article { grid-column: 3 !important; }
  nav.nextra-toc { display: none !important; }
}

@media (max-width: 900px) {
  div:has(> aside.nextra-sidebar) { grid-template-columns: 295px 1fr !important; }
  article { grid-column: 2 !important; }
}

@media (max-width: 767px) {
  div:has(> aside.nextra-sidebar) { grid-template-columns: 1fr !important; }
  aside.nextra-sidebar { display: none !important; }
  article { grid-column: 1 !important; padding: 0 1.25rem 4rem !important; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR / LEFT-HAND NAV
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-sidebar {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 295px !important;
  min-width: 295px !important;
  height: 100dvh !important;
  background: var(--nav-bg) !important;
  border-right: none !important;
  z-index: 35 !important;
}

div:has(> aside.nextra-sidebar)::before {
  content: '';
  display: block;
  grid-column: 1;
  grid-row: 1;
  width: 295px;
  pointer-events: none;
}

.nextra-sidebar > div:first-child {
  padding: calc(var(--nextra-navbar-height) + 3.75rem) 1rem 1rem !important;
}

:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul {
  gap: 0 !important;
  display: flex !important;
  flex-direction: column !important;
}

:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul > li > button {
  font-size: 0.6875rem !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.08em !important;
  color: var(--nav-section-color) !important;
  background: none !important;
  padding: 0.375rem 0.5rem 0.25rem 0.875rem !important;
  margin-top: 1.5rem !important;
  gap: 0 !important;
  cursor: default !important;
  pointer-events: none !important;
  border-radius: 0 !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul > li:first-of-type > button {
  margin-top: 0.5rem !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul > li > button > svg {
  display: none !important;
}

:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul > li.active > a,
:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul > li:not(.open) > a {
  font-size: 0.8125rem !important;
  padding: 0.3125rem 0.5rem 0.3125rem 0.875rem !important;
  border-radius: 0.375rem !important;
}

:is(.nextra-sidebar, .nextra-mobile-nav) li > div > ul {
  padding-left: 0.75rem !important;
  margin-left: 0 !important;
  padding-top: 0 !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) > div > div > ul > li > div > ul {
  padding-left: 0 !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) li > div {
  padding-top: 0 !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) li.open > a,
:is(.nextra-sidebar, .nextra-mobile-nav) li.open > button {
  padding-bottom: 0.5rem !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) li > div > ul::before {
  display: none !important;
  width: 0 !important;
}

:is(.nextra-sidebar, .nextra-mobile-nav) li > div > ul li > a,
:is(.nextra-sidebar, .nextra-mobile-nav) li > div > ul li > button {
  font-size: 0.8125rem !important;
  font-weight: 500 !important;
  color: var(--nav-item-color) !important;
  padding: 0.3125rem 0.5rem 0.3125rem 0.875rem !important;
  border-radius: 0.375rem !important;
  background: none !important;
  transition: background 0.1s, color 0.1s !important;
  margin: 0 !important;
  position: relative !important;
  overflow: visible !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) li > div > ul li > a:hover,
:is(.nextra-sidebar, .nextra-mobile-nav) li > div > ul li > button:hover {
  background: var(--nav-item-hover-bg) !important;
  color: var(--nav-item-hover-color) !important;
}

:is(.nextra-sidebar, .nextra-mobile-nav) li.active > a {
  color: var(--nav-active-color) !important;
  background: var(--nav-active-bg) !important;
}
:is(.nextra-sidebar, .nextra-mobile-nav) li.active > a::before {
  content: '';
  position: absolute;
  left: -0.625rem;
  top: 18%;
  bottom: 18%;
  width: 2px;
  border-radius: 0 1px 1px 0;
  background: var(--nav-active-bar);
}

.nextra-sidebar-footer { display: none !important; }

.nextra-navbar .nextra-theme-switch { display: flex; align-items: center; }
.nextra-navbar .nextra-theme-switch span { display: none !important; }
.nextra-navbar .nextra-theme-switch button {
  padding: 0.375rem !important;
  border-radius: 0.375rem !important;
  color: var(--forge-text-soft) !important;
  background: none !important;
  border: none !important;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: background 0.1s, color 0.1s;
}
.nextra-navbar .nextra-theme-switch button:hover {
  background: var(--forge-hover-bg) !important;
  color: var(--forge-text-strong) !important;
}

/* Mobile drawer (Forge keeps header nav + section nav, both scrollable).
   Nextra's MobileNav uses \`directories\` from \`normalizePages\` which
   contains the visible navbar entries (Documentation, API Reference)
   followed by the active section's items. We let both render so the
   drawer is the single pane the user navigates with.

   Scroll the whole drawer rather than flexing the first child as the
   scroll region — the flex approach clipped the search input because
   the search wrapper's natural height is taller than its flex basis,
   and shrink kicked in before the input cleared its own padding. */
.nextra-mobile-nav {
  background: var(--nav-bg) !important;
  overflow-y: auto !important;
  -webkit-overflow-scrolling: touch;
  /* \`scroll-padding-top\` tells the browser to treat the navbar-height
     band as scroll padding. Nextra's MobileNav calls
     \`scrollIntoView({ block: 'center' })\` on the active item when the
     drawer mounts; without this padding the drawer can scroll past its
     own top, hiding the search bar and the first nav items
     ("Documentation"/spec name) above the navbar's bottom edge. */
  scroll-padding-top: calc(var(--nextra-navbar-height, 54px) + 0.5rem);
}
/* Top padding clears the fixed navbar — without it the first nav item
   (e.g. "Documentation") paints behind the navbar at top:0. The drawer
   itself sits at top:0 by Nextra default, so the first child has to
   account for the navbar band itself. */
.nextra-mobile-nav > div:first-child {
  padding: calc(var(--nextra-navbar-height) + 0.75rem) 1rem 1rem !important;
}
/* Top-level navbar links in the drawer: render as a distinct band above the
   section items so the user can tell "site nav" from "page nav". The
   sidebar's section headers (\`> ul > li > button\`) already get section
   styling — page-tab links use \`<a>\` inside top-level \`<li>\` so we paint a
   subtle hairline below the band. */
.nextra-mobile-nav > div > div > ul > li:has(> a[href="/"]),
.nextra-mobile-nav > div > div > ul > li:has(> a[href^="/api-"]):not(:has(> div > ul)),
.nextra-mobile-nav > div > div > ul > li:has(> a[href^="http"]):not(:has(> div > ul)),
.nextra-mobile-nav > div > div > ul > li:has(> a[href^="mailto:"]):not(:has(> div > ul)) {
  font-weight: 500;
}
.nextra-mobile-nav > div > div > ul > li:has(> a[href="/"]) > a,
.nextra-mobile-nav > div > div > ul > li:has(> a[href^="/api-"]):not(:has(> div > ul)) > a,
.nextra-mobile-nav > div > div > ul > li:has(> a[href^="http"]):not(:has(> div > ul)) > a,
.nextra-mobile-nav > div > div > ul > li:has(> a[href^="mailto:"]):not(:has(> div > ul)) > a {
  font-size: 0.875rem !important;
  color: var(--nav-item-hover-color) !important;
  padding: 0.5rem 0.875rem !important;
}
/* Hide the theme switch in the mobile drawer footer. The dark/light
   toggle is already in the navbar (top right) — duplicating it pinned
   to the bottom of the drawer ate vertical space and added a
   distracting full-width band that competed with the nav items. */
.nextra-mobile-nav .nextra-sidebar-footer {
  display: none !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOC — right column
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-toc {
  width: 220px !important;
  min-width: 0 !important;
  position: sticky !important;
  top: var(--nextra-navbar-height) !important;
  max-height: calc(100vh - var(--nextra-navbar-height)) !important;
  overflow-y: auto !important;
}

.nextra-toc > div > p:first-child {
  font-size: 0.6875rem !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.08em !important;
  color: var(--forge-text-faint) !important;
  padding: 1.5rem 1rem 0.5rem !important;
}

.nextra-toc ul { padding: 0.5rem 1rem 1rem !important; }
.nextra-toc ul li { margin: 0 !important; }
.nextra-toc ul li a {
  font-size: 0.8125rem !important;
  font-weight: 400 !important;
  color: var(--forge-text-soft) !important;
  padding: 0.3rem 0 !important;
  display: block !important;
  transition: color 0.12s !important;
  line-height: 1.4 !important;
}
.nextra-toc ul li a:hover { color: var(--forge-accent) !important; }
.nextra-toc ul li a[class*="font-semibold"] {
  color: var(--forge-accent) !important;
  font-weight: 500 !important;
}

.nextra-toc > div > div:last-child { display: none !important; }

/* ═══════════════════════════════════════════════════════════════════════════
   ARTICLE CONTENT
   ═══════════════════════════════════════════════════════════════════════════ */

article {
  padding: 0 2.5rem 5rem !important;
  color: var(--forge-text) !important;
}

.nextra-breadcrumb {
  margin-top: 1.5rem !important;
  margin-bottom: 0.375rem !important;
  font-size: 0.75rem !important;
  color: var(--forge-text-faint) !important;
  gap: 0.375rem !important;
}
.nextra-breadcrumb span:last-child {
  color: var(--forge-accent) !important;
  font-weight: 500 !important;
}

article h1 {
  font-size: 1.75rem !important;
  font-weight: 700 !important;
  letter-spacing: -0.035em !important;
  line-height: 1.2 !important;
  color: var(--forge-text-strong) !important;
  margin-top: 0.25rem !important;
  margin-bottom: 0.75rem !important;
}
article h1 + p {
  font-size: 1rem !important;
  color: var(--forge-text-soft) !important;
  line-height: 1.65 !important;
  margin-top: 0 !important;
  margin-bottom: 1.5rem !important;
}
article h2 {
  font-size: 1.1875rem !important;
  font-weight: 600 !important;
  letter-spacing: -0.025em !important;
  line-height: 1.3 !important;
  color: var(--forge-text-strong) !important;
  margin-top: 2.25rem !important;
  margin-bottom: 0.625rem !important;
  padding-bottom: 0 !important;
  border-bottom: none !important;
}
article h3 {
  font-size: 1rem !important;
  font-weight: 600 !important;
  letter-spacing: -0.015em !important;
  color: var(--forge-text-strong) !important;
  margin-top: 1.75rem !important;
  margin-bottom: 0.5rem !important;
}
article h4 {
  font-size: 0.9375rem !important;
  font-weight: 600 !important;
  color: var(--forge-text-strong) !important;
  margin-top: 1.25rem !important;
}
article p {
  font-size: 0.9375rem !important;
  line-height: 1.75 !important;
  color: var(--forge-text) !important;
}
article a:not(.nextra-card) {
  color: var(--forge-accent) !important;
  font-weight: 500 !important;
  text-decoration: none !important;
}
article a:not(.nextra-card):hover {
  text-decoration: underline !important;
  text-underline-offset: 2px !important;
}
article ul, article ol {
  font-size: 0.9375rem !important;
  line-height: 1.75 !important;
  color: var(--forge-text) !important;
}
article hr { border-color: var(--forge-border) !important; margin: 2rem 0 !important; }
article strong { color: var(--forge-text-strong) !important; font-weight: 600 !important; }

/* Nextra 4 emits each <table> with \`display: block; overflow-x: auto\` so
   it acts as its own horizontal scroll container. That display:block was
   the source of the phantom band: with block layout the browser creates
   an anonymous table box inside the <table> for the actual cell layout
   and sizes the outer block independently — the rendered border hugs
   the article column while the cells fill only the natural content
   width. \`fit-content\` didn't reliably collapse the block in Chromium.
   Reverting the table to a real CSS table (\`display: table\`) with
   \`width: auto\` makes the cells size the box: the border now wraps the
   cells exactly. The trade-off is losing horizontal scroll for tables
   wider than the article column — content has to wrap inside cells
   instead — which is fine for docs tables (the API-reference endpoint
   tables are the wide-table case and they live inside their own grid). */
article *:has(> table) {
  max-width: 100% !important;
}
article table {
  display: table !important;
  width: auto !important;
  max-width: 100% !important;
  font-size: 0.875rem !important;
  border-collapse: separate !important;
  border-spacing: 0 !important;
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.5rem !important;
  margin: 1.5rem 0 !important;
  table-layout: auto !important;
  /* Cell text wraps instead of forcing horizontal scroll on the (now
     non-scrollable) block. Long unbroken strings (URLs, identifiers)
     still need word-break to avoid stretching the column past the
     article width. */
  word-break: break-word;
}
article thead tr th {
  background: var(--forge-border-soft) !important;
  color: var(--forge-text-soft) !important;
  font-size: 0.6875rem !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.06em !important;
  padding: 0.625rem 0.875rem !important;
  border-bottom: 1px solid var(--forge-border) !important;
  text-align: left !important;
}
.dark article thead tr th { background: #111827 !important; }
article tbody tr td {
  padding: 0.625rem 0.875rem !important;
  color: var(--forge-text) !important;
  border-bottom: 1px solid var(--forge-border) !important;
  vertical-align: top !important;
  font-size: 0.875rem !important;
  line-height: 1.5 !important;
}
article tbody tr:last-child td { border-bottom: none !important; }
article tbody tr:hover td { background: var(--forge-hover-bg) !important; }

article code:not(pre code) {
  font-size: 0.8125em !important;
  font-weight: 500 !important;
  color: hsl(228 84% 52%) !important;
  background: var(--forge-accent-soft) !important;
  border: 1px solid hsl(228 84% 88%) !important;
  border-radius: 0.3rem !important;
  padding: 0.1em 0.4em !important;
}
.dark article code:not(pre code) {
  color: hsl(228 84% 72%) !important;
  background: hsl(228 84% 10%) !important;
  border-color: hsl(228 84% 20%) !important;
}

.nextra-code pre, article pre {
  font-size: 0.8125rem !important;
  line-height: 1.7 !important;
  border-radius: 0.625rem !important;
  border: 1.5px solid var(--forge-border) !important;
  padding: 1rem 1.25rem !important;
  background: #f8fafc !important;
  overflow-x: auto;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04) !important;
}
.dark .nextra-code pre, .dark article pre {
  background: #0d1117 !important;
  border-color: var(--forge-border) !important;
  box-shadow: none !important;
}

/* Forge copy button — prominent chip in the top-right corner. Solid surface,
   sharper edge than Nextra's default ghost button so it reads as a
   first-class affordance rather than an afterthought. */
.nextra-code {
  position: relative !important;
}
.nextra-code button[title="Copy code"] {
  top: 0.5rem !important;
  right: 0.5rem !important;
  padding: 0.3125rem 0.4375rem !important;
  background: #ffffff !important;
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.375rem !important;
  color: var(--forge-text-soft) !important;
  opacity: 0.85 !important;
  transition: opacity 0.12s, color 0.12s, border-color 0.12s, background 0.12s !important;
}
.nextra-code:hover button[title="Copy code"] {
  opacity: 1 !important;
}
.nextra-code button[title="Copy code"]:hover {
  color: var(--forge-accent) !important;
  border-color: var(--forge-accent) !important;
}
.dark .nextra-code button[title="Copy code"] {
  background: #161b22 !important;
}

/* Forge keyboard chips — inset-shadow chip with monospace caption, mimicking
   macOS shortcut hints. Reinforces the "developer reference" stance. */
article kbd {
  display: inline-block;
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace) !important;
  font-size: 0.75rem !important;
  font-weight: 500 !important;
  line-height: 1 !important;
  color: var(--forge-text-strong) !important;
  background: #ffffff !important;
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.3125rem !important;
  padding: 0.1875rem 0.4375rem !important;
  box-shadow: inset 0 -1.5px 0 var(--forge-border-soft), 0 1px 0 var(--forge-border-soft) !important;
  vertical-align: 1px;
}
.dark article kbd {
  color: var(--forge-text-strong) !important;
  background: var(--forge-border-soft) !important;
  border-color: var(--forge-border) !important;
  box-shadow: inset 0 -1.5px 0 #000, 0 1px 0 #000 !important;
}

/* Forge definition lists — hanging-indent layout that reads like an API
   reference or a glossary entry rather than a stacked list. */
article dl {
  display: grid !important;
  grid-template-columns: 9rem 1fr !important;
  column-gap: 1.5rem !important;
  row-gap: 0.75rem !important;
  margin: 1.5rem 0 !important;
  padding: 1rem 1.25rem !important;
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.5rem !important;
  background: var(--forge-bg) !important;
}
article dt {
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace) !important;
  font-size: 0.8125rem !important;
  font-weight: 500 !important;
  color: var(--forge-accent) !important;
  align-self: start !important;
  padding-top: 0.1875rem !important;
}
article dd {
  margin: 0 !important;
  font-size: 0.875rem !important;
  line-height: 1.6 !important;
  color: var(--forge-text) !important;
}
@media (max-width: 767px) {
  article dl {
    grid-template-columns: 1fr !important;
    row-gap: 0.25rem !important;
  }
  article dd {
    margin-bottom: 0.5rem !important;
  }
}

.nextra-callout {
  border-radius: 0.5rem !important;
  padding: 0.875rem 1.125rem !important;
  font-size: 0.875rem !important;
  line-height: 1.6 !important;
  margin: 1.25rem 0 !important;
  border-width: 1px !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CARDS
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-cards { gap: 0.75rem !important; margin-top: 1.25rem !important; }

a.nextra-card {
  border: 1px solid var(--forge-border) !important;
  border-radius: 0.625rem !important;
  background: white !important;
  box-shadow: none !important;
  padding: 0 !important;
  overflow: hidden !important;
  transition: border-color 0.15s, box-shadow 0.15s !important;
  display: flex !important;
  flex-direction: column !important;
  text-decoration: none !important;
  position: relative;
}
.dark a.nextra-card { background: #0d1117 !important; border-color: var(--forge-border) !important; }

a.nextra-card:hover {
  border-color: var(--forge-accent-border) !important;
  box-shadow: 0 0 0 3px var(--forge-accent-soft) !important;
  background: white !important;
}
.dark a.nextra-card:hover { background: #0d1117 !important; }

a.nextra-card > span {
  padding: 1rem 1.125rem 0.875rem !important;
  gap: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  padding-right: 2.25rem !important;
}
a.nextra-card > span > span {
  font-size: 0.9rem !important;
  font-weight: 600 !important;
  color: var(--forge-text-strong) !important;
  letter-spacing: -0.01em !important;
  white-space: normal !important;
  overflow: visible !important;
  text-overflow: unset !important;
}
a.nextra-card::after {
  content: '↗';
  position: absolute;
  top: 0.9rem;
  right: 1rem;
  font-size: 0.875rem;
  line-height: 1;
  color: var(--forge-text-faint);
  transition: color 0.15s;
  font-weight: 400;
}
a.nextra-card:hover::after { color: var(--forge-accent) !important; }

/* ═══════════════════════════════════════════════════════════════════════════
   PREV/NEXT + FOOTER
   ═══════════════════════════════════════════════════════════════════════════ */

article + div { border-top-color: var(--forge-border) !important; }
article + div a { font-size: 0.875rem !important; color: var(--forge-text-soft) !important; font-weight: 500 !important; }
article + div a:hover { color: var(--forge-accent) !important; }
article > div[class*="text-end"] { font-size: 0.75rem !important; color: var(--forge-text-faint) !important; }

body > div:last-of-type { background: var(--forge-bg) !important; }

/* The footer must clear the 295px fixed sidebar AND align with the content
   + TOC columns (680 + 220 = 900px) rather than spanning the full canvas to
   the right of the sidebar. We size to 900px and offset by the sidebar plus
   half the leftover horizontal space so the footer reads as a continuation
   of the article column. The max() guard keeps the footer flush to the
   sidebar's right edge on viewports too narrow to center. */
footer {
  font-size: 0.8125rem !important;
  color: var(--forge-text-faint) !important;
  padding: 2.5rem 0 3rem !important;
  width: 900px !important;
  max-width: calc(100vw - 295px - 2rem) !important;
  margin-left: calc(295px + max((100vw - 295px - 900px) / 2, 0px)) !important;
  margin-right: auto !important;
  border-top: 1px solid var(--forge-border-soft) !important;
}

@media (max-width: 767px) {
  footer {
    width: auto !important;
    margin-left: 0 !important;
    max-width: 100vw !important;
    padding: 2rem 1.25rem !important;
  }
}

.nextra-border { border-color: var(--forge-border) !important; }

/* ═══════════════════════════════════════════════════════════════════════════
   MISC
   ═══════════════════════════════════════════════════════════════════════════ */

.subheading-anchor { opacity: 0; margin-left: 0.375rem; font-size: 0.75em; transition: opacity 0.15s; }
*:hover > .subheading-anchor, .subheading-anchor:focus { opacity: 0.4; }

::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 999px; }
.dark ::-webkit-scrollbar-thumb { background: #374151; }

/* ═══════════════════════════════════════════════════════════════════════════
   FOOTER (structured) — rendered when SiteBranding.footer is configured
   ═══════════════════════════════════════════════════════════════════════════ */

.forge-footer {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  padding: 0 0.5rem;
}

.forge-footer-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1.5rem;
}

.forge-footer-col h4 {
  font-size: 0.6875rem !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.08em !important;
  color: var(--forge-text-soft) !important;
  margin: 0 0 0.5rem 0 !important;
}

.forge-footer-col ul {
  list-style: none !important;
  margin: 0 !important;
  padding: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 0.25rem !important;
}

.forge-footer-col a {
  font-size: 0.8125rem !important;
  color: var(--forge-text-soft) !important;
  text-decoration: none !important;
}
.forge-footer-col a:hover {
  color: var(--forge-accent) !important;
}

.forge-footer-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--forge-border-soft);
  font-size: 0.75rem;
  color: var(--forge-text-faint);
}

.forge-footer-copyright,
.forge-footer-powered {
  font-size: 0.75rem;
  color: var(--forge-text-faint);
}

.forge-footer-social {
  display: inline-flex;
  align-items: center;
  gap: 0.875rem;
}
.forge-footer-social a {
  font-size: 0.75rem;
  color: var(--forge-text-soft) !important;
  text-decoration: none !important;
}
.forge-footer-social a:hover {
  color: var(--forge-accent) !important;
}
`;

/**
 * Customer overrides for Forge accent + sidebar/header backgrounds.
 * Appended after FORGE_BASE_CSS so the cascade gives the customer's
 * `primaryHue` (and any future per-pack overrides) precedence.
 */
export interface ForgeOverrideInput {
	/** Customer accent hue 0-360 (defaults to Forge's indigo 228). */
	accentHue: number;
	/** Customer font-family CSS value (defaults baked into base CSS if undefined). */
	fontFamily?: string;
}

export function buildForgeOverrides(input: ForgeOverrideInput): string {
	const hue = input.accentHue;
	const accent = `hsl(${hue} 84% 61%)`;
	const accentSoft = `hsl(${hue} 84% 96%)`;
	const accentBorder = `hsl(${hue} 84% 75%)`;
	const accentDark = `hsl(${hue} 84% 68%)`;
	const accentDarkSoft = `hsl(${hue} 84% 11%)`;
	const accentDarkBorder = `hsl(${hue} 84% 40%)`;
	const fontDecl = input.fontFamily ? `  --forge-font-family: ${input.fontFamily};\n` : "";

	return `
/* ── Forge theme overrides (generated) ──────────────────────────────────── */
:root {
${fontDecl}  --nextra-primary-hue:        ${hue};
  --nextra-primary-saturation: 84%;
  --nextra-primary-lightness:  61%;

  --forge-accent:        ${accent};
  --forge-accent-soft:   ${accentSoft};
  --forge-accent-border: ${accentBorder};

  --nav-active-color: ${accent};
  --nav-active-bar:   ${accent};
}

.dark {
  --nextra-primary-lightness: 68%;

  --forge-accent-soft:       ${accentDarkSoft};
  --forge-accent-border:     ${accentDarkBorder};
  --nav-active-color:        ${accentDark};
  --nav-active-bar:          ${accentDark};
}
`;
}

/**
 * Build the complete Forge stylesheet (base + customer overrides). The
 * API-reference companion stylesheet that the SaaS appends here is left out
 * for now; OpenAPI pages render with the default Nextra styling until the
 * follow-up commit ports `ApiCss` over.
 */
export function buildForgeCss(input: ForgeOverrideInput): string {
	return FORGE_BASE_CSS + buildForgeOverrides(input);
}
