/**
 * Atlas theme CSS — editorial handbook visual style.
 *
 * Top-nav layout, serif headlines (Source Serif 4), dark-default mode (warm
 * cream when toggled to light), wider content column, airy spacing, masthead-
 * style footer. Accent color used as ambient glow rather than solid fill.
 *
 * Vendored from the SaaS Atlas pack
 * (`tools/nextra-generator/src/themes/atlas/styles/AtlasCss.ts` in jolli.ai/jolli)
 * post-JOLLI-1392. The auth banner block has been stripped (CLI sites have no
 * JWT auth) and the API-reference companion stylesheet is consumed via
 * `styles/api.css` from the rich-renderer pipeline rather than appended here.
 */

const ATLAS_BASE_CSS = `/*
 * Atlas Theme — editorial handbook
 * Pack-internal decisions: serif headlines, dark default, top-nav, masthead footer.
 *
 * Source Serif 4 is loaded via a <link rel="stylesheet"> in app/layout.tsx
 * (see Atlas Apply.ts) so the browser can fetch the font in parallel with the
 * page HTML rather than waiting for this stylesheet to parse.
 */

:root {
  --nextra-primary-hue: 200;
  --nextra-primary-saturation: 70%;
  --nextra-primary-lightness: 56%;
  --nextra-bg: 250 250 247;
  --nextra-navbar-height: 60px;

  --atlas-accent:        hsl(200 70% 56%);
  --atlas-accent-soft:   hsl(200 70% 95%);
  --atlas-accent-glow:   hsla(200, 70%, 50%, 0.15);

  --atlas-bg:            #fafaf7;
  --atlas-bg-surface:    #ffffff;
  --atlas-border:        #e7e5e0;
  --atlas-border-soft:   #f1efea;
  --atlas-text-strong:   #18181b;
  --atlas-text:          #3f3f46;
  --atlas-text-soft:     #71717a;
  --atlas-text-faint:    #a1a1aa;

  --atlas-headline-font: 'Source Serif 4', 'Iowan Old Style', Georgia, serif;
}

.dark {
  --nextra-bg: 10 10 15;
  --nextra-primary-lightness: 64%;

  --atlas-accent:        hsl(200 70% 64%);
  --atlas-accent-soft:   hsl(200 70% 12%);
  --atlas-accent-glow:   hsla(200, 70%, 60%, 0.2);

  --atlas-bg:            #0a0a0f;
  --atlas-bg-surface:    #131318;
  --atlas-border:        #27272a;
  --atlas-border-soft:   #1c1c1f;
  --atlas-text-strong:   #fafafa;
  --atlas-text:          #d4d4d8;
  --atlas-text-soft:     #a1a1aa;
  --atlas-text-faint:    #71717a;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BASE
   ═══════════════════════════════════════════════════════════════════════════ */

html {
  font-family: var(--atlas-font-family, 'Inter', ui-sans-serif, system-ui, sans-serif) !important;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.005em;
}

body { background-color: var(--atlas-bg); }

/* ═══════════════════════════════════════════════════════════════════════════
   TOP NAVBAR — Atlas-specific (logo centered, slim height)
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-navbar-blur {
  background-color: var(--atlas-bg) !important;
  backdrop-filter: blur(8px) !important;
  border-bottom: 1px solid var(--atlas-border-soft) !important;
}

/* Navbar inner width matches the sidebar (280) + article (820) + TOC (200) =
   1300px so the header reads as the cap of the same column band instead of
   visibly narrower than the content below it. */
.nextra-navbar nav {
  max-width: 1300px !important;
  margin: 0 auto !important;
  padding: 0 1.5rem !important;
  height: var(--nextra-navbar-height) !important;
}

.atlas-navbar-logo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--atlas-headline-font);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--atlas-text-strong);
}
.atlas-navbar-logo img {
  flex-shrink: 0;
  height: 28px;
  width: auto;
}

.atlas-logo-dark { display: none !important; }
.dark .atlas-logo-light { display: none !important; }
.dark .atlas-logo-dark { display: inline-block !important; }

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR — Atlas treats the sidebar as a "handbook spine" rather than a
   docs tree. Transparent surface, hairline right rule, looser line-height,
   serif italic small-caps section headers, decimal-leading-zero numbering on
   top-level folders, no chevron arrows. The intent is "engineering wiki"
   not "Stripe SDK reference".
   ═══════════════════════════════════════════════════════════════════════════ */

aside.nextra-sidebar-container,
aside.nextra-sidebar {
  background: transparent !important;
  border-right: 1px solid var(--atlas-border-soft) !important;
  width: 280px !important;
  scrollbar-width: thin !important;
  scrollbar-color: var(--atlas-border) transparent !important;
}
aside.nextra-sidebar::-webkit-scrollbar,
aside.nextra-sidebar-container::-webkit-scrollbar {
  width: 6px;
}
aside.nextra-sidebar::-webkit-scrollbar-track,
aside.nextra-sidebar-container::-webkit-scrollbar-track {
  background: transparent;
}
aside.nextra-sidebar::-webkit-scrollbar-thumb,
aside.nextra-sidebar-container::-webkit-scrollbar-thumb {
  background: var(--atlas-border-soft);
  border-radius: 3px;
}
aside.nextra-sidebar:hover::-webkit-scrollbar-thumb,
aside.nextra-sidebar-container:hover::-webkit-scrollbar-thumb {
  background: var(--atlas-border);
}

aside.nextra-sidebar > div,
aside.nextra-sidebar-container > div {
  padding-left: 0.75rem !important;
  padding-right: 1.25rem !important;
}

/* Top-level folder/section headers — serif italic, sit as quiet "chapter
   titles" with a faded hairline rule beneath them (print-book divider). */
aside.nextra-sidebar > div > div > ul > li > button,
aside.nextra-sidebar-container > div > div > ul > li > button {
  font-family: var(--atlas-headline-font) !important;
  font-style: italic !important;
  font-size: 0.9375rem !important;
  font-weight: 500 !important;
  letter-spacing: 0.01em !important;
  color: var(--atlas-text-strong) !important;
  text-transform: none !important;
  background: none !important;
  border: none !important;
  margin-top: 1.75rem !important;
  margin-bottom: 0.5rem !important;
  padding: 0.25rem 0.5rem 0.5rem !important;
  width: 60% !important;
  text-align: left !important;
  cursor: pointer;
  border-bottom: 1px solid var(--atlas-border-soft) !important;
}

/* Hide chevron arrows on the section tree only — collapse state is implied
   by indent. Scoped to ul-button so the sidebar-footer theme toggle (also
   a button + svg) is left intact. */
aside.nextra-sidebar ul li > button > svg,
aside.nextra-sidebar-container ul li > button > svg {
  display: none !important;
}

/* Nested entries — quiet, looser line-height, larger indent */
aside.nextra-sidebar li > div > ul,
aside.nextra-sidebar-container li > div > ul {
  margin-left: 1rem !important;
  border-left: 1px solid var(--atlas-border-soft) !important;
  padding-left: 0.25rem !important;
}

aside.nextra-sidebar li a,
aside.nextra-sidebar-container li a {
  position: relative !important;
  font-size: 0.9375rem !important;
  line-height: 1.7 !important;
  color: var(--atlas-text-soft) !important;
  padding: 0.3rem 0.5rem 0.3rem 1.25rem !important;
  border-left: 3px solid transparent !important;
  border-radius: 0 !important;
  background: none !important;
  transition: border-color 0.15s, color 0.15s, background 0.15s !important;
}
/* Quiet hyphen bullet before each entry — marginal-note feel */
aside.nextra-sidebar li a::before,
aside.nextra-sidebar-container li a::before {
  content: "-";
  position: absolute;
  left: 0.5rem;
  color: var(--atlas-text-faint);
  font-weight: 400;
}
aside.nextra-sidebar li a:hover,
aside.nextra-sidebar-container li a:hover {
  color: var(--atlas-text-strong) !important;
  border-left-color: var(--atlas-border) !important;
  background: none !important;
}
aside.nextra-sidebar li.active > a,
aside.nextra-sidebar-container li.active > a {
  color: var(--atlas-accent) !important;
  font-weight: 500 !important;
  border-left-color: var(--atlas-accent) !important;
  background: var(--atlas-accent-soft) !important;
  box-shadow: none !important;
}
.dark aside.nextra-sidebar li.active > a,
.dark aside.nextra-sidebar-container li.active > a {
  background: transparent !important;
  box-shadow: inset 4px 0 0 var(--atlas-accent), 0 0 12px var(--atlas-accent-glow) !important;
  border-left-color: transparent !important;
}

/* Sidebar footer — holds Nextra's theme switch. Solid background so scrolled
   sidebar content doesn't bleed through. Soft inset top shadow gives a quiet
   scroll cue (content fading behind the footer). */
.nextra-sidebar-footer {
  border-top: 1px solid var(--atlas-border-soft) !important;
  background: var(--atlas-bg) !important;
  padding: 0.75rem 0.5rem !important;
  box-shadow: 0 -8px 8px -8px rgba(0, 0, 0, 0.06) !important;
}
.dark .nextra-sidebar-footer {
  box-shadow: 0 -8px 8px -8px rgba(0, 0, 0, 0.4) !important;
}
.nextra-sidebar-footer button {
  font-size: 0.8125rem !important;
  color: var(--atlas-text-soft) !important;
  background: transparent !important;
  border: 1px solid var(--atlas-border-soft) !important;
  border-radius: 8px !important;
  transition: border-color 0.15s, color 0.15s !important;
}
.nextra-sidebar-footer button:hover {
  color: var(--atlas-text-strong) !important;
  border-color: var(--atlas-border) !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOBILE — below the md breakpoint (<768px) Nextra's persistent sidebar is
   replaced by a hamburger-driven drawer (.nextra-mobile-nav). Our overrides:
     - Hide the desktop collapse toggle (drawer is its own affordance)
     - Force the persistent sidebar offscreen (defensive against our 280px
       width override leaking in at narrow viewports)
     - Tighten article padding so the reading column doesn't overflow
     - Shrink the navbar logo so it fits next to the hamburger + theme toggle
   ═══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 767px) {
  /* Hide Nextra's collapse toggle on mobile — the hamburger drawer is the
     sole nav affordance below md. */
  button[title="Collapse sidebar"],
  button[title="Expand sidebar"] {
    display: none !important;
  }
  aside.nextra-sidebar,
  aside.nextra-sidebar-container {
    display: none !important;
  }
  article {
    padding: 1.75rem 1.25rem 4rem !important;
  }
  article h1 {
    font-size: 2rem !important;
  }
  article h2 {
    font-size: 1.375rem !important;
  }
  .atlas-navbar-logo {
    font-size: 1rem !important;
  }
  .nextra-navbar nav {
    padding: 0 1rem !important;
  }
  /* Drawer styling — slides in from left, fills most of screen. We let
     the drawer itself be the scroll container (overflow-y: auto on the
     <aside>) so EVERY child is visible no matter how tall — the previous
     attempt at flexing the first child as the scroll region clipped the
     search input because flex-shrink kicked in before the input's own
     padding cleared. Touch-scrolling momentum is preserved on iOS.

     \`scroll-padding-top\` keeps Nextra's auto-scroll-to-active behavior
     from pushing the search bar off the top: Nextra calls
     \`scrollIntoView({ block: 'center' })\` on the active item when the
     drawer mounts, and without this padding the drawer scrolled past
     its own top edge, half-hiding the search input. */
  .nextra-mobile-nav {
    width: 320px !important;
    max-width: 88vw !important;
    background: var(--atlas-bg) !important;
    border-right: 1px solid var(--atlas-border-soft) !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch;
    scroll-padding-top: calc(var(--nextra-navbar-height, 60px) + 0.5rem);
  }
  /* Comfortable inset for the directory list. Top padding has to clear
     the fixed navbar manually — Nextra v4's default mobile drawer sits
     at top:0 and does NOT pad for the navbar, so without this the first
     directory item paints behind the navbar band. */
  .nextra-mobile-nav > div:first-child {
    padding: calc(var(--nextra-navbar-height) + 0.75rem) 0.875rem 1.5rem !important;
  }
  /* Hide the theme switch pinned at the bottom of the drawer. The
     dark/light toggle is already in the navbar; duplicating it inside
     the drawer added a full-width band that ate vertical space and
     competed with the directory list for attention. */
  .nextra-mobile-nav .nextra-sidebar-footer {
    display: none !important;
  }
  /* Atlas mobile drawer: hide the top-level navbar entries (Documentation,
     API Reference, customer-supplied header links) so the drawer is just
     the active section's nav. The header items are still reachable from
     the top navbar above the drawer. We match by href shape because Nextra
     doesn't tag virtual nav-only items with an identifying attribute:
       - href="/"        → __documentation
       - href^="/api-"   → single-spec API Reference link, or wrapper-emitted
                            top-level page-tab during API scope (visually
                            redundant with the dropdown)
       - href^="http"    → external customer header links (Support, Sign In, …)
       - href^="mailto:" → external mailto header links
     The folder-bound \`api-{spec}\` page-tab renders as a folder (<li> with
     nested <ul>) and is excluded by the \`:not(:has(> div > ul))\` guard.
     The "API Reference" multi-spec dropdown renders as <li> containing a
     nested <ul> whose links go to /api-* — that's the dropdown filter. */
  .nextra-mobile-nav > div > div > ul > li:has(> a[href="/"]),
  .nextra-mobile-nav > div > div > ul > li:has(> a[href^="http"]):not(:has(> div > ul)),
  .nextra-mobile-nav > div > div > ul > li:has(> a[href^="mailto:"]):not(:has(> div > ul)),
  .nextra-mobile-nav > div > div > ul > li:has(> a[href^="/api-"]):not(:has(> div > ul)),
  .nextra-mobile-nav > div > div > ul > li:has(> div > ul > li > a[href^="/api-"]),
  .nextra-mobile-nav > div > div > ul > li:has(> div > ul > li > a[href^="http"]) {
    display: none !important;
  }
  /* Footer columns stack on mobile */
  .atlas-footer-columns {
    flex-direction: column !important;
    gap: 1.5rem !important;
  }
  footer {
    padding: 2rem 1.25rem 3rem !important;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR COLLAPSE — hijacks Nextra's built-in toggle button (rendered in
   the sidebar-footer next to the theme switch). Nextra flips the button's
   title between "Collapse sidebar" and "Expand sidebar" — we use that as
   the state signal:
     - Collapsed: sidebar grid track + element width go to 0; the toggle
       button itself escapes via position:fixed so it stays visible at
       bottom-left of the viewport, just outside the article column.
     - Expanded: everything renders normally.
   ═══════════════════════════════════════════════════════════════════════════ */

div:has(> aside.nextra-sidebar) {
  transition: grid-template-columns 0.25s ease !important;
}
aside.nextra-sidebar,
aside.nextra-sidebar-container {
  transition: width 0.25s ease, opacity 0.2s ease, padding 0.2s ease;
}
article {
  transition: max-width 0.25s ease;
}

/* Collapsed-state layout — driven by the toggle button's "Expand sidebar" title */
div:has(> aside.nextra-sidebar:has(button[title="Expand sidebar"])) {
  grid-template-columns: 0 1fr !important;
}
aside.nextra-sidebar:has(button[title="Expand sidebar"]),
aside.nextra-sidebar-container:has(button[title="Expand sidebar"]) {
  width: 0 !important;
  min-width: 0 !important;
  padding: 0 !important;
  border-right: none !important;
}
/* Hide the rest of the footer (theme switch, etc.) when collapsed so they
   don't ghost in. The toggle itself escapes the hide via position:fixed. */
aside.nextra-sidebar:has(button[title="Expand sidebar"]) .nextra-sidebar-footer > *:not(button[title="Expand sidebar"]) {
  opacity: 0 !important;
  pointer-events: none !important;
}
body:has(button[title="Expand sidebar"]) article {
  max-width: 980px !important;
}

/* Style Nextra's toggle button — same look in either state, prominent so the
   user always knows where it is. Sits in the sidebar-footer when expanded. */
button[title="Collapse sidebar"],
button[title="Expand sidebar"] {
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border: 1px solid var(--atlas-border) !important;
  border-radius: 6px !important;
  background: var(--atlas-bg-surface) !important;
  color: var(--atlas-text-strong) !important;
  opacity: 1 !important;
  cursor: pointer !important;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04) !important;
  transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s !important;
}
button[title="Collapse sidebar"]:hover,
button[title="Expand sidebar"]:hover {
  background: var(--atlas-bg) !important;
  color: var(--atlas-accent) !important;
  border-color: var(--atlas-accent) !important;
  box-shadow: 0 0 0 3px var(--atlas-accent-glow) !important;
}
.dark button[title="Collapse sidebar"],
.dark button[title="Expand sidebar"] {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4) !important;
}

/* Collapsed: float the toggle out of the now-zero-width sidebar so it stays
   visible. Anchored at bottom-left of the viewport, just outside the article. */
button[title="Expand sidebar"] {
  position: fixed !important;
  left: 12px !important;
  bottom: 1rem !important;
  z-index: 50 !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ARTICLE — wider reading column with sidebar present. Generous breathing
   room, but no longer fights Nextra's three-column grid.
   ═══════════════════════════════════════════════════════════════════════════ */

article {
  max-width: 820px !important;
  padding: 2.5rem 2rem 5rem !important;
  margin: 0 auto !important;
  color: var(--atlas-text) !important;
}

article h1 {
  font-family: var(--atlas-headline-font) !important;
  font-size: 2.5rem !important;
  font-weight: 600 !important;
  letter-spacing: -0.005em !important;
  line-height: 1.15 !important;
  color: var(--atlas-text-strong) !important;
  margin-top: 0 !important;
  margin-bottom: 1.5rem !important;
}

article h1 + p {
  font-size: 1.125rem !important;
  color: var(--atlas-text-soft) !important;
  line-height: 1.7 !important;
  margin-bottom: 2.5rem !important;
}

article h2 {
  font-family: var(--atlas-headline-font) !important;
  font-size: 1.5rem !important;
  font-weight: 600 !important;
  letter-spacing: -0.005em !important;
  line-height: 1.3 !important;
  color: var(--atlas-text-strong) !important;
  margin-top: 3rem !important;
  margin-bottom: 0.875rem !important;
  padding-bottom: 0 !important;
  border-bottom: none !important;
}
article h2::before {
  content: "-";
  color: var(--atlas-text-faint);
  font-weight: 400;
  margin-right: 0.5rem;
}

article h3 {
  font-family: var(--atlas-headline-font) !important;
  font-size: 1.125rem !important;
  font-weight: 600 !important;
  color: var(--atlas-text-strong) !important;
  margin-top: 2rem !important;
  margin-bottom: 0.625rem !important;
}

article p {
  font-size: 0.9375rem !important;
  line-height: 1.8 !important;
  color: var(--atlas-text) !important;
  margin-bottom: 1.125rem !important;
}

article ul,
article ol {
  font-size: 0.9375rem !important;
  line-height: 1.75 !important;
}

article a:not(.nextra-card) {
  color: var(--atlas-accent) !important;
  font-weight: 500 !important;
  text-decoration: underline !important;
  text-underline-offset: 3px !important;
  text-decoration-thickness: 1px !important;
}
article a:not(.nextra-card):hover {
  text-decoration-thickness: 2px !important;
}

/* User-authored markdown <hr> ('---') — quiet faded hairline rule. Auto-rendered
   header separators get out of the way via tight margins. */
article hr {
  border: none !important;
  height: 1px !important;
  background: var(--atlas-border-soft) !important;
  margin: 1.5rem auto !important;
  max-width: 6rem !important;
}

article strong { color: var(--atlas-text-strong) !important; font-weight: 600 !important; }

/* Code — full-bleed, soft surface, no gutter */
article code:not(pre code) {
  font-size: 0.8125em !important;
  font-weight: 500 !important;
  color: var(--atlas-text-strong) !important;
  background: var(--atlas-border-soft) !important;
  border-radius: 4px !important;
  padding: 0.15em 0.4em !important;
}

/* Atlas code blocks — printed-listing style. No card border, no rounded
   corners; instead the block extends past the article column by ~1rem each
   side and is bookended by hairline rules above and below, so code reads
   like a typeset listing in a print magazine rather than an inset card. */
.nextra-code {
  position: relative !important;
  margin: 2rem -1rem !important;
}
.nextra-code pre, article pre {
  font-size: 0.875rem !important;
  line-height: 1.75 !important;
  border-radius: 0 !important;
  border: none !important;
  border-top: 1px solid var(--atlas-border-soft) !important;
  border-bottom: 1px solid var(--atlas-border-soft) !important;
  padding: 1.25rem 1.5rem !important;
  background: var(--atlas-bg-surface) !important;
  margin: 0 !important;
}

/* Quiet copy button — italic small-caps "copy" tag, no surface treatment */
.nextra-code button[title="Copy code"] {
  top: 0.625rem !important;
  right: 0.75rem !important;
  padding: 0.25rem 0.4375rem !important;
  background: transparent !important;
  border: 1px solid var(--atlas-border-soft) !important;
  border-radius: 4px !important;
  color: var(--atlas-text-faint) !important;
  opacity: 0.7 !important;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s !important;
}
.nextra-code:hover button[title="Copy code"] {
  opacity: 1 !important;
}
.nextra-code button[title="Copy code"]:hover {
  color: var(--atlas-accent) !important;
  border-color: var(--atlas-accent) !important;
}

/* Cards with soft shadow (light) / glow (dark) */
a.nextra-card {
  border: 1px solid var(--atlas-border) !important;
  border-radius: 12px !important;
  background: var(--atlas-bg-surface) !important;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04) !important;
  transition: border-color 0.2s, box-shadow 0.2s !important;
}
a.nextra-card:hover {
  border-color: var(--atlas-accent) !important;
  box-shadow: 0 0 0 4px var(--atlas-accent-glow) !important;
}
.dark a.nextra-card {
  box-shadow: none !important;
}
.dark a.nextra-card:hover {
  box-shadow: 0 0 0 4px var(--atlas-accent-glow) !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOC — tight, quiet "Contents" rail. Sticky behavior is owned by Nextra's
   inner wrapper div, which already pins itself to var(--nextra-navbar-height).
   We don't fight it from the outer nav — that creates a parent/child sticky
   conflict that visually "shifts" the TOC down on scroll.
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-toc {
  width: 200px !important;
}

.nextra-toc > div > p:first-child {
  font-family: var(--atlas-headline-font) !important;
  font-style: italic !important;
  font-size: 0.8125rem !important;
  font-weight: 500 !important;
  letter-spacing: 0.02em !important;
  color: var(--atlas-text-soft) !important;
  padding: 1rem 1rem 0.5rem !important;
  margin-bottom: 0.25rem !important;
  border-bottom: 1px solid var(--atlas-border-soft) !important;
}

.nextra-toc ul li a {
  font-size: 0.75rem !important;
  line-height: 1.5 !important;
  color: var(--atlas-text-faint) !important;
  padding: 0.25rem 0.75rem !important;
  border-left: 2px solid transparent !important;
  transition: color 0.15s, border-color 0.15s !important;
}
.nextra-toc ul li a:hover {
  color: var(--atlas-text-soft) !important;
  border-left-color: var(--atlas-border) !important;
}
.nextra-toc ul li a.nextra-toc-active,
.nextra-toc ul li a[data-active="true"] {
  color: var(--atlas-text-strong) !important;
  border-left-color: var(--atlas-accent) !important;
}

@media (max-width: 1279px) {
  .nextra-toc { display: none !important; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FOOTER — masthead style
   ═══════════════════════════════════════════════════════════════════════════ */

footer {
  font-family: var(--atlas-headline-font) !important;
  font-size: 0.875rem !important;
  color: var(--atlas-text-soft) !important;
  padding: 1.75rem 1.5rem 2rem !important;
  border-top: 1px solid var(--atlas-border-soft) !important;
  margin-top: 2rem !important;
}
footer > div:first-child {
  margin-top: 0 !important;
  padding-top: 0 !important;
}

footer .atlas-footer-masthead {
  font-family: var(--atlas-headline-font);
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--atlas-text-strong);
  letter-spacing: -0.005em;
  margin-bottom: 0.5rem;
}

footer .atlas-footer-copy {
  font-family: 'Inter', sans-serif;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--atlas-text-faint);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENTRY METADATA STRIP — date, reading time, type, rendered above h1 by
   the AtlasWrapper when the page frontmatter carries a date field.
   Establishes the "this is a dated entry" feel that distinguishes Atlas
   from Forge's reference-doc stance.
   ═══════════════════════════════════════════════════════════════════════════ */

.atlas-entry-meta {
  font-family: 'Inter', sans-serif;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atlas-text-faint);
  margin: 0 0 1rem 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.atlas-entry-date,
.atlas-entry-type {
  color: var(--atlas-text-soft);
}

.atlas-entry-sep {
  color: var(--atlas-text-faint);
}

.atlas-entry-type {
  text-transform: uppercase;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DIGEST CALLOUTS — <Outcome>, <Decision>, <ActionItem> render as styled
   asides for capturing conversation summary structure. Each variant has its
   own accent tint so a reader scanning a long entry can spot the structure
   at a glance.
   ═══════════════════════════════════════════════════════════════════════════ */

.atlas-callout {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  margin: 1.75rem 0;
  border-radius: 12px;
  border: 1px solid var(--atlas-border-soft);
  background: var(--atlas-bg-surface);
}

.atlas-callout-head {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--atlas-headline-font);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--atlas-text-strong);
}

.atlas-callout-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  font-size: 0.75rem;
  line-height: 1;
}

.atlas-callout-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.6875rem;
}

.atlas-callout-body {
  font-family: 'Inter', sans-serif;
  font-size: 0.9375rem;
  line-height: 1.7;
  color: var(--atlas-text);
}
.atlas-callout-body > *:first-child { margin-top: 0; }
.atlas-callout-body > *:last-child { margin-bottom: 0; }

/* Variant accents — each gets a tinted glyph background and left border. */
.atlas-callout-outcome {
  border-left: 3px solid hsl(150 50% 45%);
}
.atlas-callout-outcome .atlas-callout-glyph {
  background: hsl(150 50% 92%);
  color: hsl(150 60% 30%);
}
.dark .atlas-callout-outcome .atlas-callout-glyph {
  background: hsl(150 50% 14%);
  color: hsl(150 50% 70%);
}

.atlas-callout-decision {
  border-left: 3px solid var(--atlas-accent);
}
.atlas-callout-decision .atlas-callout-glyph {
  background: var(--atlas-accent-soft);
  color: var(--atlas-accent);
}

.atlas-callout-action {
  border-left: 3px solid hsl(35 80% 50%);
}
.atlas-callout-action .atlas-callout-glyph {
  background: hsl(35 80% 92%);
  color: hsl(35 70% 35%);
}
.dark .atlas-callout-action .atlas-callout-glyph {
  background: hsl(35 60% 14%);
  color: hsl(35 80% 70%);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PULL QUOTES — <Quote source="..."> for capturing dialogue snippets.
   ═══════════════════════════════════════════════════════════════════════════ */

.atlas-quote {
  margin: 2rem 0;
  padding: 0 0 0 1.5rem;
  border-left: 3px solid var(--atlas-accent);
}

.atlas-quote blockquote {
  margin: 0 !important;
  padding: 0 !important;
  font-family: var(--atlas-headline-font) !important;
  font-style: italic !important;
  font-size: 1.125rem !important;
  line-height: 1.6 !important;
  color: var(--atlas-text-strong) !important;
}

.atlas-quote figcaption {
  margin-top: 0.625rem;
  font-family: 'Inter', sans-serif;
  font-size: 0.8125rem;
  color: var(--atlas-text-soft);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENTRY FEED — reverse-chronological list for index pages. Each row links
   to a dated entry; sized to feel like a Substack-archive list, not docs
   nav cards.
   ═══════════════════════════════════════════════════════════════════════════ */

.atlas-feed {
  list-style: none !important;
  margin: 2rem 0 !important;
  padding: 0 !important;
  border-top: 1px solid var(--atlas-border-soft);
}

.atlas-feed-item {
  margin: 0 !important;
  border-bottom: 1px solid var(--atlas-border-soft);
}

.atlas-feed-link {
  display: block !important;
  padding: 1.5rem 0 !important;
  text-decoration: none !important;
  transition: opacity 0.15s;
}
.atlas-feed-link:hover { opacity: 0.85; }

.atlas-feed-meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-family: 'Inter', sans-serif;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--atlas-text-faint);
  margin-bottom: 0.375rem;
}

.atlas-feed-title {
  font-family: var(--atlas-headline-font) !important;
  font-size: 1.375rem !important;
  font-weight: 600 !important;
  letter-spacing: -0.005em !important;
  color: var(--atlas-text-strong) !important;
  margin: 0 0 0.5rem 0 !important;
}

.atlas-feed-excerpt {
  font-family: 'Inter', sans-serif;
  font-size: 0.9375rem;
  line-height: 1.65;
  color: var(--atlas-text-soft);
  margin: 0 !important;
}

.atlas-feed-empty {
  color: var(--atlas-text-soft);
  font-style: italic;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FOOTER (structured) — rendered when SiteBranding.footer is configured
   Atlas keeps its masthead character; columns/social sit above the masthead.
   ═══════════════════════════════════════════════════════════════════════════ */

.atlas-footer {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2.25rem;
  padding: 0 0.5rem;
}

.atlas-footer-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 2rem;
}

.atlas-footer-col h4 {
  font-family: var(--atlas-headline-font) !important;
  font-size: 0.875rem !important;
  font-weight: 600 !important;
  color: var(--atlas-text-strong) !important;
  margin: 0 0 0.625rem 0 !important;
}

.atlas-footer-col ul {
  list-style: none !important;
  margin: 0 !important;
  padding: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 0.375rem !important;
}

.atlas-footer-col a {
  font-family: 'Inter', sans-serif !important;
  font-size: 0.875rem !important;
  color: var(--atlas-text-soft) !important;
  text-decoration: none !important;
}
.atlas-footer-col a:hover {
  color: var(--atlas-accent) !important;
}

.atlas-footer-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--atlas-border-soft);
}

.atlas-footer-social {
  display: inline-flex;
  align-items: center;
  gap: 1rem;
}
.atlas-footer-social a {
  font-family: 'Inter', sans-serif !important;
  font-size: 0.75rem !important;
  text-transform: uppercase !important;
  letter-spacing: 0.06em !important;
  color: var(--atlas-text-soft) !important;
  text-decoration: none !important;
}
.atlas-footer-social a:hover {
  color: var(--atlas-accent) !important;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEARCH RESULTS DROPDOWN — Nextra portals the dropdown to body level. By
   default it inherits the search input's width (clipping long result titles)
   and stacks below the sidebar (whose left half then paints over the
   dropdown). Match the portal element across the tailwind/headless-ui
   variations Nextra has shipped, force a wider min-width, and use a z-index
   high enough to beat any site chrome. position:relative is required for
   z-index to take effect on otherwise position:static elements.
   ═══════════════════════════════════════════════════════════════════════════ */

.nextra-search ul,
.nextra-search [role="listbox"],
.nextra-search [role="dialog"],
.nextra-search > div:not(:first-child),
.nextra-search > p {
  z-index: 9999 !important;
  position: relative;
}

body > [class*="rounded-xl"][class*="shadow-xl"],
body > [class*="rounded-lg"][class*="shadow-lg"],
body > [class*="z-30"][class*="rounded"],
body > [class*="z-50"][class*="rounded"],
body > div[id^="headlessui-combobox"],
body > div:has(> [role="listbox"]),
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
  body > [class*="rounded-xl"][class*="shadow-xl"],
  body > [class*="rounded-lg"][class*="shadow-lg"],
  body > [class*="z-30"][class*="rounded"],
  body > [class*="z-50"][class*="rounded"],
  body > div[id^="headlessui-combobox"],
  body > div:has(> [role="listbox"]),
  body > [role="listbox"] {
    min-width: 0 !important;
  }
}

`;

export interface AtlasOverrideInput {
	accentHue: number;
	fontFamily?: string;
}

export function buildAtlasOverrides(input: AtlasOverrideInput): string {
	const hue = input.accentHue;
	const fontDecl = input.fontFamily ? `  --atlas-font-family: ${input.fontFamily};\n` : "";

	return `
/* ── Atlas theme overrides (generated) ──────────────────────────────────── */
:root {
${fontDecl}  --nextra-primary-hue:        ${hue};
  --nextra-primary-saturation: 70%;
  --nextra-primary-lightness:  56%;

  --atlas-accent:      hsl(${hue} 70% 56%);
  --atlas-accent-soft: hsl(${hue} 70% 95%);
  --atlas-accent-glow: hsla(${hue}, 70%, 50%, 0.15);
}

.dark {
  --nextra-primary-lightness: 64%;
  --atlas-accent:      hsl(${hue} 70% 64%);
  --atlas-accent-soft: hsl(${hue} 70% 12%);
  --atlas-accent-glow: hsla(${hue}, 70%, 60%, 0.2);
}
`;
}

/**
 * Build the complete Atlas stylesheet (base + customer overrides). The
 * API-reference companion stylesheet that the SaaS appends here is left out
 * — the CLI's rich-renderer writes `styles/api.css` separately and the
 * layout imports it alongside `themes/atlas.css`.
 */
export function buildAtlasCss(input: AtlasOverrideInput): string {
	return ATLAS_BASE_CSS + buildAtlasOverrides(input);
}
