# site.json Reference

`site.json` is the configuration file at the root of your Content_Folder. It controls the site title, navigation, theme, header, footer, sidebar, and more.

## Minimal Example

```json
{
  "title": "My Docs",
  "description": "Documentation for My Project",
  "nav": []
}
```

Run `jolli dev .` in the folder containing this file to start a dev server.

---

## Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Site title. Displayed in the navbar logo and HTML `<title>`. |
| `description` | `string` | Yes | HTML meta description. |
| `nav` | `NavLink[]` | Yes | Legacy flat navbar links. Use `header` for dropdowns. |
| `header` | `HeaderConfig` | No | Navbar with dropdown support. Overrides `nav` when set. |
| `footer` | `FooterConfig` | No | Footer with columns, copyright, and social links. |
| `sidebar` | `SidebarOverrides` | No | Custom sidebar labels and ordering per directory. |
| `pathMappings` | `Record<string, string>` | No | Remap source folders to different content paths. |
| `favicon` | `string` | No | Favicon URL. Deprecated; use `theme.favicon` instead. |
| `theme` | `ThemeConfig` | No | Visual theme pack and branding options. |
| `branding` | `BrandingConfig` | No | Deprecated nested-shape alias for `theme`. Coerced at load time; `theme.*` wins on conflict. New site.json files should use `theme` directly. |

> **Custom scripts** (analytics, chat widgets, custom CSS) are **not** a `site.json` field — they use a file convention: drop `.js`/`.css` files into a `.jolli/scripts/` folder at your Content_Folder root. See [Custom Scripts](#custom-scripts-jolliscripts) below.

### How navbar entries reach the browser

`header.items` and `nav` are NOT spliced into the layout JSX as `<a>` / `<details>` tags. The CLI writes them into the **root `content/_meta.js`** so Nextra's `<Navbar>` renders them as native page tabs — the chevron on dropdowns, the hover styling, and the mobile-drawer integration come from Nextra and not from custom JSX.

When OpenAPI specs are detected, two extra entries are auto-injected into the same `_meta.js`:

- **`Documentation`** — links back to `/`. Always present whenever any specs are detected.
- **`API Reference`** — for a single spec, a direct link to `/api-{slug}`. For two or more specs, a `type: "menu"` dropdown with one sub-entry per spec.

A header item whose label matches `Documentation` / `API` / `API Reference` (case-insensitive) suppresses the matching auto-entry — customer overrides win.

---

## Navigation (`nav`)

The simplest way to add links to the navbar. Each entry is a flat link with no dropdown support.

```json
{
  "nav": [
    { "label": "Guides", "href": "/guides" },
    { "label": "API", "href": "/api" },
    { "label": "GitHub", "href": "https://github.com/myorg/myproject" }
  ]
}
```

When `header` is also set, `header.items` takes precedence and `nav` is ignored.

---

## Header (`header`)

Replaces `nav` with richer navbar items that support dropdowns.

### Direct links only

```json
{
  "header": {
    "items": [
      { "label": "Docs", "url": "/docs" },
      { "label": "Pricing", "url": "https://example.com/pricing" }
    ]
  }
}
```

### With dropdowns

Each item can have nested `items` to render a dropdown menu:

```json
{
  "header": {
    "items": [
      { "label": "Docs", "url": "/docs" },
      { "label": "API Reference", "url": "/api" },
      {
        "label": "Resources",
        "items": [
          { "label": "Blog", "url": "https://blog.example.com" },
          { "label": "Changelog", "url": "/changelog" },
          { "label": "Status", "url": "https://status.example.com" }
        ]
      },
      {
        "label": "Community",
        "items": [
          { "label": "Discord", "url": "https://discord.gg/example" },
          { "label": "GitHub Discussions", "url": "https://github.com/org/repo/discussions" }
        ]
      }
    ]
  }
}
```

An item must have either `url` (direct link) or `items` (dropdown), not both.

---

## Footer (`footer`)

Configures the site footer with copyright text, link columns, and social icons.

### All footer fields

| Field | Type | Description |
|-------|------|-------------|
| `copyright` | `string` | Copyright text displayed at the bottom. |
| `columns` | `FooterColumn[]` | Groups of links with a heading. |
| `socialLinks` | `SocialLinks` | URLs for social platform icons. |

### Social link platforms

Supported platforms (rendered in this order): `github`, `twitter`, `discord`, `linkedin`, `youtube`. Unset platforms are skipped.

### Example

```json
{
  "footer": {
    "copyright": "2026 Acme Inc. All rights reserved.",
    "columns": [
      {
        "title": "Product",
        "links": [
          { "label": "Features", "url": "/features" },
          { "label": "Pricing", "url": "/pricing" },
          { "label": "Changelog", "url": "/changelog" }
        ]
      },
      {
        "title": "Developers",
        "links": [
          { "label": "Documentation", "url": "/docs" },
          { "label": "API Reference", "url": "/api" },
          { "label": "SDKs", "url": "/sdks" }
        ]
      },
      {
        "title": "Company",
        "links": [
          { "label": "About", "url": "/about" },
          { "label": "Blog", "url": "https://blog.example.com" },
          { "label": "Careers", "url": "/careers" }
        ]
      }
    ],
    "socialLinks": {
      "github": "https://github.com/acme",
      "twitter": "https://twitter.com/acme",
      "discord": "https://discord.gg/acme",
      "youtube": "https://youtube.com/@acme"
    }
  }
}
```

When `footer` is omitted or empty, a bare default footer is rendered.

---

## Theme (`theme`)

Controls the visual appearance of the generated site.

### Theme fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pack` | `"forge"` \| `"atlas"` \| `"default"` | `"forge"` | Theme pack to use. `"forge"` is the implicit default. `"default"` is an explicit opt-in for the pre-pack vanilla `nextra-theme-docs` look. |
| `primaryHue` | `number` (0-360) | Pack default | Accent colour hue. Forge: 228 (indigo), Atlas: 200 (blue). |
| `defaultTheme` | `"light"` \| `"dark"` \| `"system"` | Pack default | Initial colour scheme. Forge: `"light"`, Atlas: `"dark"`. |
| `fontFamily` | `string` | Pack default | Body font. See font options below. |
| `logoUrl` | `string` | None | Logo image URL (light mode). |
| `logoUrlDark` | `string` | None | Logo image URL (dark mode). Falls back to `logoUrl`. |
| `logoText` | `string` | Site `title` | Override for the text shown alongside (or instead of) the logo image. Useful when the wordmark differs from the page title. |
| `logoDisplay` | `"text"` \| `"image"` \| `"both"` | Auto¹ | What the navbar logo renders. |
| `favicon` | `string` | None | Favicon URL. |

¹ When `logoDisplay` is unset, the layout infers `"both"` if `logoUrl` is set and `"text"` otherwise — preserving pre-`logoDisplay` behaviour. `"image"` with no `logoUrl` falls back to `"text"` to avoid an empty navbar logo.

### Deprecated alias: `branding`

The CLI also accepts a `branding` block in a nested shape. Fields are coerced into `theme.*` at load time; `theme.*` wins on conflict.

| `branding.*` | Coerces to |
|---|---|
| `branding.themePack` | `theme.pack` |
| `branding.colors.primaryHue` | `theme.primaryHue` |
| `branding.fontFamily` | `theme.fontFamily` |
| `branding.defaultTheme` | `theme.defaultTheme` |
| `branding.favicon` | `theme.favicon` |
| `branding.logo.image` | `theme.logoUrl` |
| `branding.logo.imageDark` | `theme.logoUrlDark` |
| `branding.logo.text` | `theme.logoText` |
| `branding.logo.display` | `theme.logoDisplay` |

`footer.social` is also accepted as an alias for `footer.socialLinks` with the same precedence rule.

New site.json files should use `theme` and `footer.socialLinks` directly. The aliases exist for back-compat with the older nested format.

### Theme packs

**`default`** — Vanilla Nextra theme. No custom CSS. Best for quick starts.

**`forge`** — Clean developer documentation style.
- Sidebar-first layout with three-column desktop grid (sidebar | article | TOC)
- Inter typography, hairline borders
- Light mode by default
- Default accent: indigo (hue 228)

**`atlas`** — Editorial / handbook style.
- Top-nav layout
- Source Serif typography, airy spacing
- Dark mode by default
- Default accent: blue (hue 200)

### Font options

| Value | Font | Style |
|-------|------|-------|
| `"inter"` | Inter | Clean sans-serif (Forge default) |
| `"space-grotesk"` | Space Grotesk | Geometric sans-serif |
| `"ibm-plex"` | IBM Plex Sans | Technical sans-serif |
| `"source-sans"` | Source Sans 3 | Neutral sans-serif |
| `"source-serif"` | Source Serif 4 | Editorial serif (Atlas default) |

---

## Sidebar (`sidebar`)

Overrides the auto-generated sidebar labels and ordering per directory.

```json
{
  "sidebar": {
    "/": {
      "index": "Home",
      "getting-started": "Getting Started",
      "guides": "Guides"
    },
    "/guides": {
      "quickstart": "Quick Start",
      "advanced": "Advanced Usage"
    }
  }
}
```

- Keys are directory paths (e.g. `"/"` for root, `"/guides"` for the guides folder).
- Values are ordered maps of `{ slug: label }`.
- Items are rendered in declaration order. Files not listed are appended alphabetically by Nextra.
- Use an object value for external links or separators:

```json
{
  "sidebar": {
    "/": {
      "index": "Home",
      "---": { "type": "separator" },
      "github": { "title": "GitHub", "href": "https://github.com/org/repo" }
    }
  }
}
```

---

## Path Mappings (`pathMappings`)

Remaps source folder paths to different locations in the generated site. Useful when the sidebar structure should differ from the physical folder layout.

```json
{
  "pathMappings": {
    "sql": "pipelines/sql",
    "api-docs": "reference/api"
  }
}
```

This maps `sql/` in your source folder to `pipelines/sql/` in the site content.

---

## Custom Scripts (`.jolli/scripts/`)

A raw escape-hatch for injecting third-party scripts and styles — Google Analytics, Google Tag Manager, Intercom/Crisp/Drift chat widgets, custom CSS — into every page of your site. This is a **file convention**, not a `site.json` field.

Commit `.js` / `.css` files into a `.jolli/scripts/` folder at the root of your Content_Folder:

```
my-docs/
├── site.json
├── index.md
└── .jolli/
    └── scripts/
        ├── analytics.js     → loaded on every page via <Script> (afterInteractive)
        └── theme.css        → injected on every page as <link rel="stylesheet">
```

- `*.js` files are bundled to `public/scripts/` and loaded on every page with Next.js `<Script strategy="afterInteractive">`.
- `*.css` files are bundled to `public/scripts/` and rendered as a hoistable `<link rel="stylesheet">`.
- Sub-folders are preserved: `.jolli/scripts/vendor/widget.js` is served at `/scripts/vendor/widget.js`.

Injection is theme-independent — it works for the `forge`, `atlas`, and `default` packs and any custom theme pack with no theme cooperation required.

### Why `.jolli/scripts/` and not a bare `scripts/`?

The folder is namespaced under `.jolli/` (Jolli's reserved directory) so it can't collide with a `scripts/` folder you already use for build tooling — only files explicitly placed under `.jolli/scripts/` are injected. The rest of `.jolli/` is reserved too: markdown or OpenAPI files placed anywhere under `.jolli/` are never published as doc pages or API references.

### Hygiene limits

| Limit | Value |
|-------|-------|
| Max file size | 64 KB per file (larger files are skipped with a warning) |
| Max files | 20 (sorted by name; extras beyond 20 are skipped) |

### Compatibility

- ✅ **Inline bootstraps work directly** (Intercom, Crisp, Drift, HubSpot, GTM, GA4) — the account ID is a value inside the snippet, so paste the snippet body into `.jolli/scripts/<name>.js`.
- ⚠️ **Single `<script src=… data-*=…>` tags** (e.g. Plausible's `data-domain`, Fathom's `data-site`) need a tiny JS loader instead — create the element and set its attributes in a `.js` file:

  ```js
  // .jolli/scripts/plausible.js
  const s = document.createElement("script");
  s.src = "https://plausible.io/js/script.js";
  s.defer = true;
  s.setAttribute("data-domain", "example.com");
  document.head.appendChild(s);
  ```

### Security

There is **no server-side sanitization** — the files live in your own repository (the same trust boundary as the rest of your content and config). Only the size/count hygiene limits above are enforced.

> ⚠️ Scripts injected on a password-protected site run in the authenticated visitor's context and can read their session. Only commit scripts you trust, the same as any first-party code on your site.

### Applying changes

Custom scripts are resolved when the build directory is scaffolded. Under `jolli dev`, **adding or removing** a script file requires a dev-server restart (the same as changing your theme), while **editing the contents** of an existing script hot-reloads on the next change.

---

## Full Examples

### Example 1: Minimal — just content, no customization

```json
{
  "title": "My Project",
  "description": "Project documentation",
  "nav": []
}
```

### Example 2: Default theme with header dropdowns and footer

```json
{
  "title": "Acme Platform",
  "description": "Acme Platform documentation",
  "nav": [],
  "header": {
    "items": [
      { "label": "Docs", "url": "/docs" },
      { "label": "API", "url": "/api" },
      {
        "label": "Resources",
        "items": [
          { "label": "Blog", "url": "https://blog.acme.dev" },
          { "label": "Changelog", "url": "/changelog" }
        ]
      }
    ]
  },
  "footer": {
    "copyright": "2026 Acme Inc.",
    "columns": [
      {
        "title": "Product",
        "links": [
          { "label": "Features", "url": "/features" },
          { "label": "Pricing", "url": "/pricing" }
        ]
      }
    ],
    "socialLinks": {
      "github": "https://github.com/acme",
      "discord": "https://discord.gg/acme"
    }
  }
}
```

### Example 3: Forge theme with custom branding

```json
{
  "title": "DevKit",
  "description": "DevKit developer documentation",
  "nav": [],
  "theme": {
    "pack": "forge",
    "primaryHue": 160,
    "defaultTheme": "light",
    "fontFamily": "space-grotesk",
    "logoUrl": "/images/logo.svg",
    "logoUrlDark": "/images/logo-dark.svg",
    "favicon": "/images/favicon.ico"
  },
  "header": {
    "items": [
      { "label": "Guides", "url": "/guides" },
      { "label": "API Reference", "url": "/api" },
      { "label": "GitHub", "url": "https://github.com/devkit/devkit" }
    ]
  },
  "footer": {
    "copyright": "2026 DevKit Labs",
    "socialLinks": {
      "github": "https://github.com/devkit",
      "twitter": "https://twitter.com/devkit"
    }
  }
}
```

### Example 4: Atlas theme for an editorial handbook

```json
{
  "title": "Engineering Handbook",
  "description": "Internal engineering handbook and style guide",
  "nav": [],
  "theme": {
    "pack": "atlas",
    "primaryHue": 220,
    "defaultTheme": "dark",
    "fontFamily": "source-serif",
    "logoUrl": "/images/handbook-logo.svg"
  },
  "header": {
    "items": [
      { "label": "Principles", "url": "/principles" },
      { "label": "Standards", "url": "/standards" },
      {
        "label": "Guides",
        "items": [
          { "label": "Code Review", "url": "/guides/code-review" },
          { "label": "Testing", "url": "/guides/testing" },
          { "label": "Deployment", "url": "/guides/deployment" }
        ]
      }
    ]
  },
  "footer": {
    "copyright": "Internal use only.",
    "columns": [
      {
        "title": "Quick Links",
        "links": [
          { "label": "Onboarding", "url": "/onboarding" },
          { "label": "Architecture", "url": "/architecture" },
          { "label": "Runbooks", "url": "/runbooks" }
        ]
      }
    ]
  }
}
```

### Example 5: Legacy format (backwards compatible)

Older `site.json` files without `header`, `footer`, or `theme` still work:

```json
{
  "title": "Old Docs",
  "description": "Legacy documentation site",
  "nav": [
    { "label": "Home", "href": "/" },
    { "label": "API", "href": "/api" }
  ],
  "favicon": "/favicon.ico",
  "sidebar": {
    "/": {
      "index": "Welcome",
      "getting-started": "Getting Started"
    }
  }
}
```

### Example 6: OpenAPI specs with Forge theme and sidebar overrides

```json
{
  "title": "Payment API",
  "description": "Payment gateway API documentation",
  "nav": [],
  "theme": {
    "pack": "forge",
    "primaryHue": 145,
    "fontFamily": "ibm-plex"
  },
  "header": {
    "items": [
      { "label": "Docs", "url": "/docs" },
      { "label": "API Reference", "url": "/api-payments" },
      {
        "label": "SDKs",
        "items": [
          { "label": "Node.js", "url": "https://github.com/pay/node-sdk" },
          { "label": "Python", "url": "https://github.com/pay/python-sdk" },
          { "label": "Go", "url": "https://github.com/pay/go-sdk" }
        ]
      }
    ]
  },
  "footer": {
    "copyright": "2026 PayCo Inc.",
    "columns": [
      {
        "title": "Resources",
        "links": [
          { "label": "Status Page", "url": "https://status.payco.dev" },
          { "label": "Changelog", "url": "/changelog" }
        ]
      }
    ],
    "socialLinks": {
      "github": "https://github.com/payco",
      "linkedin": "https://linkedin.com/company/payco"
    }
  },
  "sidebar": {
    "/": {
      "index": "Overview",
      "getting-started": "Getting Started",
      "authentication": "Authentication"
    }
  }
}
```

Place your OpenAPI spec files (`.yaml`, `.json`) in the content folder. They are automatically detected, parsed, and rendered as interactive API reference pages.

---

## Security

All URLs in `header`, `footer`, `nav`, and `theme` (logos, favicon) are sanitized. URLs using `javascript:`, `data:`, or `vbscript:` schemes are replaced with `"#"` to prevent script injection. Only `http(s):`, `mailto:`, `tel:`, relative paths, and fragment/query URLs are allowed.
