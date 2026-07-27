# Theme Pack Manifests

## Topic Statement

A small registry of named theme packs that bundle a layout shape, default accent hue, default light/dark mode, and default body font, with each customer-overridable field cascading from a per-pack manifest onto the values declared in the site configuration.

## Scope

**In scope:**
- The two named packs the registry currently ships, and the visual stance each one stakes out.
- The fields that pack manifests pin (name, display name, tagline, defaults).
- The customer-overridable subset of those defaults that the site configuration can override.
- The cascade rule that resolves a final value from "manifest default" plus "configured override".
- The visible layout shape each pack imposes (sidebar position, navbar treatment, content column width).
- The CSS variable surface that page-level overrides hook into to retint a pack.

**Out of scope:**
- The exact CSS rules a pack ships (visual minutiae of typography, spacing, callout glyphs, etc.).
- The mechanics of how the resolved layout is written to disk for the build (covered by site-renderer topics).
- How the site configuration itself is parsed and validated.
- Search-result dropdown styling, scrollbar treatment, and other ambient pack details that are not selectable knobs.
- The OpenAPI-reference companion stylesheet that layers on top of pack styling.

## Data Contracts

### Pack manifest

A pack manifest is a small frozen record:

- **name** (required, lowercase token): the identifier the site configuration uses to select the pack (e.g. `forge`, `atlas`).
- **display name** (required, string): human-facing label shown in CLI prompts and selection UIs.
- **tagline** (required, string): one-phrase pitch ("Clean developer docs", "Editorial handbook").
- **defaults** (required, record): the four fallback values applied when a customer-overridable field is unset on the site configuration.

### Defaults block

Each pack's defaults pin:

- **primary hue** (required, integer 0-360): the HSL hue used to derive the pack's accent color.
- **default mode** (required, enum): which of light or dark mode is the cold-start default; the other is reachable via the in-page theme toggle.
- **font family** (required, enum token): the body font, drawn from a fixed allowlist (`inter`, `space-grotesk`, `ibm-plex`, `source-sans`, `source-serif`).

### Customer-overridable theme fields

The site configuration's `theme` block accepts the same three fields as the defaults block (primary hue, default mode, font family) plus three branding fields (light logo URL, dark logo URL, favicon). Each is independently optional. Branding fields have no manifest default — when unset, the layout omits the corresponding tag.

### Resolved layout input

The product of cascading: title, description, navigation entries, header configuration, footer configuration, plus the four fully-resolved theme values (primary hue, default mode, font family, branding URLs).

## Behavior

### Pack registry

Two packs are registered:

- **Forge** (clean developer docs feel): primary hue 228, default mode light, font family `inter`. Visual stance is sidebar-dominant — a fixed left-hand navigation column carries the bulk of the navigation, the top navbar holds search plus the theme toggle, and the article column sits in a multi-column desktop grid (sidebar, article, table of contents).
- **Atlas** (editorial handbook feel): primary hue 200, default mode dark, font family `source-serif`. Visual stance is top-navigation-dominant — the logo and primary navigation cluster at the top, the sidebar reads as a quiet "handbook spine" rather than a docs tree, the content column is wider, and the footer is treated as a magazine masthead.

### Override cascade

For each of the three default-able theme fields:

1. If the site configuration declares the field, take that value.
2. Otherwise take the value from the chosen pack's `defaults` block.

The cascade is per-field and independent: a customer can override hue alone and inherit mode and font from the pack.

### Branding cascade

For light logo URL, dark logo URL, and favicon: these come solely from the site configuration. There is one back-compat rule for favicon — a top-level `favicon` setting wins over a `theme.favicon` setting when both are present. When neither is present, no favicon tag is emitted.

### Pack selection

The site configuration's `theme.pack` token names the pack. When unset, sites bypass packs entirely and render with the underlying docs theme's vanilla styling.

## Notable Behavior

### Forge layout shape

- Fixed left sidebar of 295px width, pinned to the viewport, holding logo + search + section navigation, with the navbar reduced to right-side controls (search on mobile, theme toggle, hamburger).
- Five-column desktop grid: sidebar, leading gutter, article column at 680px, table of contents at 220px, trailing gutter.
- Below 1280px the table of contents is hidden; below 900px the trailing gutter collapses; below 768px the sidebar gives way to a hamburger drawer.

### Atlas layout shape

- Top navbar with centered logo and primary header items, capped at 1300px.
- Persistent sidebar of 280px presented as a quiet "chapter spine" with serif italic section headers and no chevron arrows; the sidebar can be fully collapsed via a built-in toggle that floats to the bottom-left of the viewport when collapsed.
- Article column at 820px, expanding to 980px when the sidebar is collapsed.
- Table of contents at 200px, hidden below 1280px.
- Footer rendered as a magazine masthead.

### CSS variable surface

Each pack exposes its accent and surface colors as CSS custom properties scoped to `:root` (light) and `.dark` (dark). The cascade emits a generated overrides block at the end of the pack's stylesheet that re-declares the accent variables in terms of the resolved primary hue, so customer-supplied hue takes effect via stylesheet cascade order rather than build-time templating of the base stylesheet.

The overrides block also declares an optional `--<pack>-font-family` custom property when the resolved font differs from the pack's pinned default; the pack's base stylesheet reads this variable via `var(--<pack>-font-family, <fallback>)` so the font swap is a one-line variable substitution.

### Font loading

The resolved font family value selects one entry from a fixed font catalogue that maps each token to (a) a remote stylesheet URL and (b) the corresponding CSS `font-family` declaration string. The remote stylesheet is loaded via a `<link rel="stylesheet">` tag emitted into the layout's head; the CSS declaration string is fed into the override block so the family name reaches the browser through both channels.

### Logo emission rules

- No logo URL configured: layouts emit a text-only logo using the site title.
- Light logo URL only: a single image tag is emitted with no light/dark swap.
- Both light and dark logo URLs: paired image tags are emitted with pack-specific class names that toggle `display: none` based on whether the document carries the dark-mode class.

User-provided URLs pass through a fail-closed allowlist (only `http`, `https`, `mailto`, `tel`, and relative paths are accepted; everything else collapses to `#`) before being interpolated into the layout.

### Default-mode handling

The resolved default mode is fed to the underlying docs theme's mode provider as the cold-start preference. The in-page theme toggle remains live in both packs regardless of the chosen default.

### Pack-specific layout knobs

Atlas additionally instructs the underlying docs theme to label the table of contents "Contents" (matching its editorial voice) and tunes the underlying theme's hue-saturation pair to its own value (saturation 70 vs Forge's 84). These are pack-internal decisions, not customer-overridable.

## Shared Behavior

- **Site configuration parsing** — produces the `theme` block whose values feed the cascade.
- **Site renderer** — consumes the resolved layout input and writes the layout file plus the pack stylesheet to the staged build directory.
- **OpenAPI rich-renderer companion stylesheet** — layered alongside the pack stylesheet so endpoint pages inherit the pack's accent and surface colors.
- **Default theme fallback** — the no-pack path that bypasses this registry entirely.
