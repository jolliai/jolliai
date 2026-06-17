# Third-Party Notices

This project's shipped artifacts — the **`@jolli.ai/cli`** npm package and the
**Jolli Memory VS Code extension** (VSIX) — include third-party software. This
file lists those components and their licenses.

Scope:

- **Direct runtime dependencies** (npm `dependencies`) of the CLI and the VS Code
  extension are listed below. Some are bundled into the shipped build output
  (Vite/esbuild); others are installed alongside the package by npm. Either way
  their license applies to the distribution.
- **Vendored components** — third-party code checked directly into this repo's
  source tree (`cli/src/graph/assets/vendor/`, copied into the VSIX at
  `assets/graph/vendor/`) — are listed separately.
- **Build/test tooling** (devDependencies such as esbuild, Vite, Vitest, Biome,
  TypeScript) is **not** distributed and is therefore not listed.
- **Transitive dependencies** carry their own licenses; a full transitive
  enumeration should be generated at release time (e.g. with a license-scanning
  tool over the production dependency tree).
- The **IntelliJ plugin** (`intellij/`) bundles JVM dependencies declared in its
  own Gradle build and is tracked separately from this file.

Versions reflect the currently resolved installs and track the semver ranges in
the respective `package.json` files.

---

## Runtime dependencies (npm)

| Component | Version | License | Used by |
|---|---|---|---|
| `@anthropic-ai/sdk` | 0.39.0 | MIT | CLI, VS Code (LLM calls) |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | CLI (MCP server) |
| `@orama/orama` | 3.1.18 | Apache-2.0 | CLI, VS Code (local search index) |
| `@orama/plugin-data-persistence` | 3.1.18 | Apache-2.0 | CLI, VS Code (search index persistence) |
| `commander` | 13.1.0 | MIT | CLI (argument parsing) |
| `open` | 11.0.0 | MIT | CLI, VS Code (open URLs/files) |
| `semver` | 7.8.1 | ISC | CLI (version comparisons) |
| `minimatch` | 10.2.5 | BlueOak-1.0.0 | VS Code (glob matching) |
| `@vscode/codicons` | 0.0.45 | CC-BY-4.0 | VS Code (sidebar icon font) |

## Vendored components (knowledge-graph visualization runtime)

Source of truth at `cli/src/graph/assets/vendor/`; shipped in the VSIX at
`assets/graph/vendor/`. Each file also carries its license/copyright inline.

| Component | Version | License | File |
|---|---|---|---|
| `elkjs` | 0.11.0 | EPL-2.0 | `elk.bundled.js` |
| `@panzoom/panzoom` | 4.6.2 | MIT | `panzoom.min.js` |
| `marked` | 15.0.7 | MIT | `marked.min.js` |

- **elkjs** © Kiel University and others. The EPL-2.0 copyright and
  `SPDX-License-Identifier: EPL-2.0` notices are preserved verbatim inside
  `elk.bundled.js` (shipped byte-for-byte unmodified, not minified).
- **@panzoom/panzoom** © Timmy Willison and other contributors.
- **marked** © 2011-2025 Christopher Jeffrey.

---

## License references

Full texts for the non-inlined licenses:

- **Apache-2.0** — https://www.apache.org/licenses/LICENSE-2.0
- **EPL-2.0** — https://www.eclipse.org/legal/epl-2.0/
- **BlueOak-1.0.0** — https://blueoakcouncil.org/license/1.0.0
- **CC-BY-4.0** — https://creativecommons.org/licenses/by/4.0/legalcode
  (the `@vscode/codicons` icon font is used under CC-BY-4.0; attribution: the
  VS Code icon set by Microsoft.)

### MIT License

Applies to the MIT-licensed components above (`@anthropic-ai/sdk`,
`@modelcontextprotocol/sdk`, `commander`, `open`, `@panzoom/panzoom`, `marked`).
Copyright is held by the respective authors named in each entry.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License

Applies to `semver`. Copyright is held by its authors (Isaac Z. Schlueter and
contributors).

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```
