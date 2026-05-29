/**
 * StarterKit — Scaffolds a new Content_Folder for `jolli new`.
 *
 * Writes a starter set of files into a new directory:
 *   - site.json          — site configuration
 *   - index.md           — welcome page
 *   - getting-started.md — getting started guide
 *   - api/openapi.yaml   — example OpenAPI 3.x spec
 *   - guides/introduction.md — nested subfolder example
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScaffoldResult } from "@jolli.ai/site-core";

// ─── Starter file contents ────────────────────────────────────────────────────

const SITE_JSON = JSON.stringify(
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

const INDEX_MD = `# Welcome

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

const DOCS_INDEX_MD = `# Documentation

Welcome to the documentation. Use the sidebar to navigate between pages.
`;

const GETTING_STARTED_MD = `# Getting Started

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

const OPENAPI_YAML = `openapi: "3.1.0"
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

const GUIDES_INTRODUCTION_MD = `# Introduction to Guides

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

// ─── scaffoldProject ──────────────────────────────────────────────────────────

/**
 * Scaffolds a new Content_Folder at `targetDir`.
 *
 * Returns `{ success: false }` (without modifying the filesystem) if the
 * target directory already exists.
 */
export async function scaffoldProject(targetDir: string): Promise<ScaffoldResult> {
	// 2.7 — Return error if target directory already exists
	if (existsSync(targetDir)) {
		return {
			success: false,
			targetDir,
			message: `Directory already exists: ${targetDir}`,
		};
	}

	try {
		// Create root and subdirectories
		await mkdir(join(targetDir, "api"), { recursive: true });
		await mkdir(join(targetDir, "docs", "guides"), { recursive: true });

		// Write all starter files in parallel
		await Promise.all([
			writeFile(join(targetDir, "site.json"), SITE_JSON, "utf-8"),
			writeFile(join(targetDir, "index.md"), INDEX_MD, "utf-8"),
			writeFile(join(targetDir, "docs", "index.md"), DOCS_INDEX_MD, "utf-8"),
			writeFile(join(targetDir, "docs", "getting-started.md"), GETTING_STARTED_MD, "utf-8"),
			writeFile(join(targetDir, "docs", "guides", "introduction.md"), GUIDES_INTRODUCTION_MD, "utf-8"),
			writeFile(join(targetDir, "api", "openapi.yaml"), OPENAPI_YAML, "utf-8"),
		]);

		return {
			success: true,
			targetDir,
			message: `Created ${targetDir}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			targetDir,
			message,
		};
	}
}
