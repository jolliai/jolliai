# 201. CLI Graph Export Command

## Topic Statement

The `graph` command exports a repository's already-built knowledge graph to a single self-contained HTML file that opens directly in a browser with no server, and optionally opens it in the default browser.

## Scope

**In scope:**
- The command's flags, defaults, and validation.
- How the source graph data is located and the error when it is missing.
- How the output path is interpreted (directory vs. explicit file).
- The structure of the assembled standalone file (what is inlined and in what order).
- The escaping applied to the embedded data.
- Console output and exit-code policy.
- The optional "open in browser" behavior.

**Out of scope / boundaries:**
- How the graph data is produced (a separate compile/build step is a prerequisite; this command only reads its output). The boundary is the on-disk graph data file.
- The interactive viewer's runtime behavior once the file is open in a browser — owned by the interactive-viewer spec. This spec documents only how that viewer's assets and data are packaged into the file.
- The repository's storage resolution internals (how the data directory is located) — this command consumes a resolved data root from the storage layer.

## Data Contracts

### Inputs (flags)

| Flag | Required | Meaning |
| --- | --- | --- |
| export target | **yes** | Output target: a directory, or an explicit path ending in the HTML extension (case-insensitive). |
| target repo directory | no | Repository to export; defaults to the current working directory. |
| open-in-browser | no | Boolean; when set, open the written file in the default browser after export. |

The export flag is the only action the command performs. Invoking the command with no export target is a usage error.

### Source data location

The repository's resolved data root is obtained from the storage layer (falling back to the target repo directory when the storage layer reports none). The source graph data is expected at a fixed sub-path beneath that root (a hidden `graph` data file under the project's hidden state directory). If that file does not exist, the command fails with a message that names the expected path and instructs the user to run the build/compile step first.

### Output path resolution

- If the export target ends in the HTML extension (case-insensitive), it is used verbatim as the output file.
- Otherwise the target is treated as a **directory**, and the output file is `<repo-name>-graph.html` inside it, where the repo name is the final segment of the resolved data root.
- Parent directories of the output file are created as needed. The file is written as UTF-8.

### Assembled file structure

The output is the interactive viewer's HTML template with three substitutions, producing one fully self-contained document (no external requests, safe to open from a local file):

1. The external stylesheet link is replaced with the stylesheet's contents inlined in a style block.
2. The template's scripts placeholder is replaced with, in order: every vendor runtime script inlined; then a single script assigning the repository's graph data (verbatim, after escaping) to the in-page embedded-data global the viewer reads; then every application script inlined.

Vendor scripts and application scripts are inlined in the **same order the viewer template loads them**, and the embedded-data assignment is placed **after the vendor scripts and before the application scripts** (the data-loading application script reads the global on execution).

Each substitution is performed against an expected template marker; a **missing marker is a hard error** (no silent no-op), surfaced as a clear message that the assets are corrupt/outdated.

### Embedded-data escaping

Before inlining, three substitutions neutralize the graph JSON so it cannot break out of the inline-script context: **every `<` character** becomes its JSON unicode-escape form `\u003c`, and the two raw line-separator characters JSON leaves unescaped (U+2028, U+2029) become `\u2028` / `\u2029`. `>` and `&` are deliberately left alone — neither can move the tokenizer out of script-data state.

The `<` rule is character-wide rather than a match on the closing-script-tag sequence: a script block has three tokenizer exits (`</script`, `<!--`, and a nested `<script` inside the escaped state the second one opens), all beginning with `<`, and `\u003c` is the same string to a JSON parser. Neutralizing only the first left a commit body carrying `<!--<script>` able to swallow every script inlined after the data assignment. The substitution is correct only because the input is an already-serialized JSON document, where every `<` sits inside a string literal. This command runs the same shared rule as the other surfaces that inline graph data into a page, not a private copy.

The template substitutions are applied as computed replacements rather than replacement patterns (which would reinterpret special replacement tokens), because the inlined assets and JSON contain such tokens.

### Asset resolution

The viewer assets (template, stylesheet, vendor scripts, application scripts) are located by probing a small ordered list of candidate directories relative to the running module (covering both the built/installed layout and running from source). The first candidate that contains the template wins. If none is found, the command fails with a message to reinstall.

## Behaviors (execution order)

1. If no export target was given, print a usage error to standard error and set a failing exit code; stop.
2. Resolve the target repo directory (flag or current directory).
3. Resolve the data root, compute the source graph data path, and verify it exists; if missing, throw the "no graph found — run the build first" error.
4. Locate the viewer assets, read them, escape the graph data, and assemble the standalone HTML.
5. Resolve the output file path (directory → `<repo>-graph.html`, or the explicit HTML path), create parent directories, and write the file.
6. Print a success line naming the written path and a note that the file is self-contained.
7. If open-in-browser is set, attempt to open the file in the default browser. A failure to open is **non-fatal** — it is logged as a warning and the export still counts as successful.
8. Any error during steps 3–5 is caught, printed to standard error as a single line, and a failing exit code is set.

## Console Output

- **Success:** two lines on standard output — one naming the exported file path, one stating it is self-contained and needs no server.
- **Usage error (no export target):** an error line on standard error.
- **Operational error (missing graph, missing assets, write failure):** an error line on standard error prefixed with "Error:".
- **Browser-open failure:** a non-fatal warning via the logger; does not change the exit code.

## Exit Codes

| Code | Condition |
| --- | --- |
| `0` | A file was written (even if the optional browser-open failed). |
| Non-zero (failing) | No export target supplied; the source graph data is missing; the viewer assets are missing; or the file could not be written. |

## Notable Behavior

- **Export is the only action.** The command intentionally exposes a single capability; calling it with no export target is a usage error, not a default action. (Notable.)
- **A non-`.html` target is always treated as a directory** and produces `<repo>-graph.html` inside it; there is no "guess whether this is a file" heuristic beyond the extension check. (Notable.)
- **Browser-open failure never fails the export.** The file is the deliverable; opening it is a convenience. (Notable.)
- **A missing template marker is fatal, not silent.** If the bundled assets drift out of sync with the expected markers, the command refuses to ship a half-assembled (e.g. asset-less) file. (Notable.)
- **The assembled file makes no external requests at runtime**, so it works from a local file with no server and no cross-origin concerns — the entire reason the data is inlined rather than fetched. (Notable.)
- **The template carries a hidden advisory element the export ships verbatim.** Alongside the host-control buttons, the viewer template includes a hidden stale-schema notice that the viewer runtime may reveal at load time. This command performs no wiring for it and no substitution against it — it travels through as part of the template like any other markup. (Notable.)
