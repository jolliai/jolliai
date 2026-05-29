/**
 * StarterKit (pure half).
 *
 * Template content for the `jolli new` scaffold: site.json + the
 * default markdown / OpenAPI files. The I/O wrapper that writes them
 * to disk lives in `cli/src/site/StarterKit.ts`; the web tool can
 * call `getStarterFiles()` and bundle the result into its own
 * "create new site" flow.
 */

import type { TemplateFile } from "./renderer/nextra/Types.js";

// ─── Starter file contents ────────────────────────────────────────────────────

export const SITE_JSON = JSON.stringify(
	{
		$schema: "https://jolli.ai/schemas/site-config.json",
		title: "My API Docs",
		description: "Documentation site powered by Jolli",
		theme: { pack: "forge" },
		navigation: [
			{
				page: "Documentation",
				root: "/docs",
				content: [
					{ article: "Getting Started", href: "getting-started" },
					{
						group: "Guides",
						root: "guides",
						content: [{ article: "Introduction", href: "introduction" }],
					},
				],
			},
			{
				page: "API Reference",
				root: "/api-openapi",
			},
		],
	},
	null,
	2,
);

export const INDEX_MD = `# Welcome

Welcome to your new documentation site, powered by **Jolli**.

## What's inside?

| File / Folder | Purpose |
|---|---|
| \`site.json\` | Site config — title, navigation pages, and theme |
| \`index.md\` | This page — the home page |
| \`docs/\` | Documentation page content |
| \`api/openapi.yaml\` | OpenAPI spec — auto-rendered as API Reference page |

## Next steps

1. Edit \`site.json\` to configure your navigation pages and theme.
2. Replace the example markdown files with your own content.
3. Replace \`api/openapi.yaml\` with your own OpenAPI spec.
4. Run \`jolli dev\` to preview, or \`jolli start\` to build and serve.
`;

export const DOCS_INDEX_MD = `# Documentation

Welcome to the documentation. Use the sidebar to navigate between pages.
`;

export const GETTING_STARTED_MD = `# Getting Started

This guide walks you through the basics of your new documentation site.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later
- The \`jolli\` CLI installed globally

## Running the site locally

\`\`\`bash
jolli dev
\`\`\`

This starts a live dev server with hot-reload. For a production build:

\`\`\`bash
jolli start
\`\`\`

## Project structure

\`\`\`
my-docs/
├── site.json            # Navigation pages, theme, footer
├── index.md             # Home page
├── docs/                # Documentation page
│   ├── getting-started.md
│   └── guides/
│       └── introduction.md
└── api/
    └── openapi.yaml     # Auto-rendered as API Reference page
\`\`\`

## How navigation works

\`site.json\` defines pages at the top of your site. Each page maps to a
content folder:

- **Documentation** page → \`docs/\` folder (markdown pages)
- **API Reference** page → auto-generated from \`api/openapi.yaml\`

Any \`.yaml\` or \`.json\` file with an \`openapi\` field is automatically
detected and rendered as an interactive API Reference with code samples
in cURL, JavaScript, TypeScript, Python, and Go.

## Adding a theme

\`\`\`json
{
  "theme": { "pack": "forge" }
}
\`\`\`

Theme packs are installed automatically from the Jolli theme registry.
Use \`"default"\` for the vanilla Nextra theme with no pack styling.
`;

export const OPENAPI_YAML = `openapi: "3.1.0"
info:
  title: Example API
  description: |
    This is an example OpenAPI 3.x specification included with your Jolli
    starter kit. Replace it with your own API spec.
  version: "1.0.0"
  contact:
    name: API Support
    url: https://example.com/support
    email: support@example.com
  license:
    name: Apache 2.0
    url: https://www.apache.org/licenses/LICENSE-2.0.html

servers:
  - url: https://api.example.com/v1
    description: Production server
  - url: https://staging-api.example.com/v1
    description: Staging server

tags:
  - name: items
    description: Operations on items

paths:
  /items:
    get:
      summary: List all items
      operationId: listItems
      tags:
        - items
      parameters:
        - name: limit
          in: query
          description: Maximum number of items to return
          required: false
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
      responses:
        "200":
          description: A list of items
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Item"
        "500":
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"

    post:
      summary: Create an item
      operationId: createItem
      tags:
        - items
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/NewItem"
      responses:
        "201":
          description: Item created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
        "400":
          description: Invalid request body
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"

  /items/{id}:
    get:
      summary: Get an item by ID
      operationId: getItem
      tags:
        - items
      parameters:
        - name: id
          in: path
          required: true
          description: The item ID
          schema:
            type: string
      responses:
        "200":
          description: The requested item
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
        "404":
          description: Item not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"

components:
  schemas:
    Item:
      type: object
      required:
        - id
        - name
      properties:
        id:
          type: string
          description: Unique identifier
          example: "item-123"
        name:
          type: string
          description: Display name
          example: "My Item"
        description:
          type: string
          description: Optional description
          example: "A detailed description of the item"
        createdAt:
          type: string
          format: date-time
          description: Creation timestamp

    NewItem:
      type: object
      required:
        - name
      properties:
        name:
          type: string
          description: Display name
          example: "My New Item"
        description:
          type: string
          description: Optional description

    Error:
      type: object
      required:
        - code
        - message
      properties:
        code:
          type: integer
          description: HTTP status code
          example: 404
        message:
          type: string
          description: Human-readable error message
          example: "Item not found"
`;

export const GUIDES_INTRODUCTION_MD = `# Introduction to Guides

This folder demonstrates **nested subfolder navigation** in Jolli.

Any subfolder you create inside your content folder automatically becomes a
section in the site navigation. Files inside the subfolder become pages within
that section.

## How navigation is generated

Jolli reads your folder structure and generates \`_meta.js\` files for Nextra v4.
Each file's name (without extension) becomes a navigation key, and the
title-cased version of the name becomes the display label.

For example:

| File | Navigation label |
|---|---|
| \`getting-started.md\` | Getting Started |
| \`api/openapi.yaml\` | Openapi |
| \`guides/introduction.md\` | Introduction |

## Adding more guides

Create additional \`.md\` files in this \`guides/\` folder and they will
automatically appear in the navigation under the **Guides** section.

You can also nest folders further — Jolli supports multiple levels of nesting.
`;

// ─── getStarterFiles ──────────────────────────────────────────────────────────

/**
 * Returns the canonical starter site as a flat list of
 * `{ path, content }` entries — the same shape used by the Nextra
 * emitter's `TemplateFile`. Paths are forward-slash, content-root-
 * relative (no leading slash); the consumer concatenates them onto
 * its own target directory.
 */
export function getStarterFiles(): TemplateFile[] {
	return [
		{ path: "site.json", content: SITE_JSON },
		{ path: "index.md", content: INDEX_MD },
		{ path: "docs/index.md", content: DOCS_INDEX_MD },
		{ path: "docs/getting-started.md", content: GETTING_STARTED_MD },
		{ path: "docs/guides/introduction.md", content: GUIDES_INTRODUCTION_MD },
		{ path: "api/openapi.yaml", content: OPENAPI_YAML },
	];
}
