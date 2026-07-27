# 71. Documentation Framework Detection

## Topic Statement

Detecting which documentation framework a source content folder belongs to by scanning for known filesystem marker files in a fixed order.

## Scope

**In scope:**
- The closed set of documentation frameworks the detector recognizes.
- The marker files associated with each framework.
- The order in which frameworks are checked (first match wins).
- Where each framework's markers are searched (the source root, and for some frameworks, the parent directory).
- The optional secondary lookup for a sidebar-config file once a framework has been identified.
- The shape of the returned detection result.
- The interactive yes/no prompt offered to the user once a framework is detected.
- Behavior when no framework is detected (returns null).

**Out of scope:**
- Reading or interpreting the content of any of the marker files. Detection is purely existence-based.
- Converting a Docusaurus sidebar into the configuration's overrides shape (covered by the Docusaurus-sidebar-conversion topic).
- The full first-use bootstrap flow that calls this detector (covered by the site-configuration-discovery topic).
- Detecting nested framework configurations or merging multiple frameworks.

## Data Contracts

### Recognized frameworks

The detector recognizes a closed set of five frameworks, identified by the following names in lowercase:

- `docusaurus`
- `mintlify`
- `vitepress`
- `mkdocs`
- `gitbook`

### Marker files per framework

Each framework has a list of files whose existence (anywhere in the search locations below) indicates that framework is in use:

- **Docusaurus** — any of: `docusaurus.config.js`, `docusaurus.config.ts`, `sidebars.js`, `sidebars.ts`. Also searched in the parent directory: `docusaurus.config.js`, `docusaurus.config.ts`. The associated sidebar-config files (searched separately) are: `sidebars.js`, `sidebars.ts` in the source root, then in the parent directory.
- **Mintlify** — `mint.json` in the source root.
- **VitePress** — `.vitepress/config.js` or `.vitepress/config.ts` in the source root.
- **MkDocs** — `mkdocs.yml` or `mkdocs.yaml` in the source root.
- **GitBook** — `SUMMARY.md` or `.gitbook.yaml` in the source root.

### Search locations

For each framework, the detector first checks the source root for the framework's primary marker files. Only Docusaurus also looks in the parent directory of the source root, because Docusaurus projects conventionally place `docusaurus.config.{js,ts}` one level above the docs folder.

### Detection result

When a framework matches, the detector returns:
- `name`: one of the five framework names above.
- `configPath`: the absolute path to the matched marker file (the first one that exists, in the order listed above).
- `sidebarPath` (optional): the absolute path to the framework's sidebar-config file when found. Currently only populated for Docusaurus, which has a separate sidebar-config file from its main config.

When no framework matches, the detector returns null.

### Migration prompt

A separate prompt operation accepts a detection result and asks the user, on a TTY, whether to generate `site.json` from the detected framework. The prompt text is:

`Found <FrameworkNameTitleCased> config. Generate site.json from it? (Y/n) `

An empty trimmed answer, `y`, or `yes` (case-insensitive) returns `true` (proceed with conversion). Anything else returns `false`.

When standard input is not a terminal, the prompt is skipped and `true` is returned (auto-accept).

## Behavior

### Detection algorithm

1. Iterate the framework rules in the order listed above (Docusaurus, Mintlify, VitePress, MkDocs, GitBook).
2. For each framework rule:
   - For each primary marker file in the rule, build the path joined to the source root and test whether it exists. If yes, return immediately with `name`, `configPath` set to that path, and `sidebarPath` resolved per the secondary-lookup step.
   - For each parent-directory marker file in the rule (if the rule defines any), test whether it exists in the parent directory of the source root. If yes, return immediately with the same fields.
3. If no rule matched, return null.

### Sidebar-file resolution (Docusaurus only today)

Once a framework match is found, the detector resolves the sidebar-config path independently of which marker file triggered the match:
1. For each sidebar-file candidate in the source root (`sidebars.js`, `sidebars.ts`), test existence; the first hit is the sidebar path.
2. If no source-root candidate exists, repeat the lookup against the parent directory.
3. If neither location yields a hit, leave the sidebar path undefined.

### Migration-prompt control flow

When invoked:
1. If standard input is not a terminal, return `true` synchronously.
2. Otherwise, prompt the user with the question text above.
3. Title-case the framework name in the prompt (first letter uppercased, rest unchanged).
4. Read the user's answer, trim whitespace, lowercase it.
5. Return `true` if the answer is empty, `y`, or `yes`. Otherwise return `false`.

## State Transitions

The detector is stateless; it observes the filesystem at one point in time and returns a result. There are no transitions modeled here. The migration-prompt operation is also stateless and returns a single boolean.

## Notable Behavior

- **First match wins, ordered.** Frameworks are checked in a fixed order: Docusaurus, Mintlify, VitePress, MkDocs, GitBook. If a project happened to contain marker files for multiple frameworks, the earlier-listed framework would be detected. This is by design; in practice projects do not mix marker files from multiple frameworks.
- **Docusaurus is the only framework that searches the parent directory.** This handles the canonical Docusaurus layout where `docusaurus.config.{js,ts}` sits next to a `docs/` folder rather than inside it. The other four frameworks place their config inside the documentation folder, so a parent-search would risk picking up an unrelated project's config.
- **Marker-only detection.** The detector never reads the content of the marker files. A `mint.json` that is empty or invalid still counts as "Mintlify detected" — the downstream caller is responsible for handling errors when it tries to use the detected configuration.
- **`SUMMARY.md` is the GitBook marker.** This is a notable design choice: the file `SUMMARY.md` is also a common Markdown filename in non-GitBook projects. A non-GitBook project that happens to ship a `SUMMARY.md` at its docs root will be misclassified. Downstream the GitBook converter is not implemented today, so the only consequence is a "GitBook conversion is not yet supported" warning during the bootstrap flow.
- **Sidebar lookup is independent of how the framework was matched.** Even if Docusaurus was detected via `docusaurus.config.ts` in the parent directory, the sidebar lookup still tries the source root first. This handles the common case of a sidebar file co-located with the docs folder.
- **Return-on-first-hit.** The detector does not enumerate every marker file present; it stops at the first existing file in the rule's list and reports that as `configPath`. Other marker files for the same framework are not surfaced.
- **Migration prompt defaults to yes.** Pressing Enter accepts the migration. This biases first-time experience toward picking up the framework's existing structure rather than starting from a blank slate.
- **Non-TTY auto-accept on the migration prompt.** Unattended runs (CI, automated scripts) treat the prompt as accepted. This means an unattended bootstrap of a Docusaurus project will trigger sidebar conversion automatically.

## Shared Behavior

- The detector's output is consumed by the site-configuration discovery flow, which decides whether to invoke a framework-specific converter.
- The Docusaurus-specific sidebar conversion that consumes `sidebarPath` is defined by the Docusaurus-sidebar-conversion topic.
- Other frameworks (Mintlify, VitePress, MkDocs, GitBook) are detected today but have no converter implementation; the bootstrap flow logs a warning and falls back to folder-structure defaults.
