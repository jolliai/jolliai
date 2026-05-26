/**
 * Tagged-union enum identifying which vault path family a relative path
 * belongs to. Drives sync's allowlist staging: `stageVault` filters
 * `git status` output through `classifyVaultPath` and stages only entries
 * whose kind is non-null (modulo the `syncTranscripts` opt-out for the
 * `"transcript"` kind).
 *
 * The list is **closed** in the sense that adding a new FolderStorage write
 * type requires adding a kind here. Phase 1's round-trip integration test
 * enforces "every FolderStorage write path classifies to non-null" so a
 * new write that bypasses this catalogue is caught immediately.
 *
 * Living in its own file so the classifier and the staging step can both
 * import it without cycle risk (classifier → OwnedPathKind, stageVault →
 * classifier + OwnedPathKind, GitClient parser → OwnedPathKind for the
 * per-kind telemetry counts).
 */
export type OwnedPathKind =
	// Root-level (only two — Phase 0.1 confirmed `.jolli/repos.json` is the
	// sole vault-root aggregate file; manifest/index/catalog/branches/config
	// all live per-repo):
	| "root-gitignore" // .gitignore — kept tracked for migration safety
	| "root-repos" // .jolli/repos.json — RepoMapping
	// Per-repo aggregates + content (under <repoFolder>/.jolli/...):
	| "repo-config" // <repoFolder>/.jolli/config.json (identity; MUST sync)
	| "repo-index" // <repoFolder>/.jolli/index.json
	| "repo-manifest" // <repoFolder>/.jolli/manifest.json
	| "repo-branches" // <repoFolder>/.jolli/branches.json
	| "repo-catalog" // <repoFolder>/.jolli/catalog.json
	// `shadow-status.json` is INTENTIONALLY absent — it's per-device dirty-
	// write recovery state, meaningless to peers. Classifier rejects it →
	// `stageVault` unstages any stray index entry → `MemoryBankBootstrap`'s
	// PER_DEVICE_JSON_GLOBS cleanup keeps legacy committed copies untracked.
	// See `MemoryBankBootstrap.ts` `PER_DEVICE_JSON_GLOBS` for the matching
	// untrack-on-rounds half.
	| "summary" // <repoFolder>/.jolli/summaries/<hash>.json
	| "transcript" // <repoFolder>/.jolli/transcripts/<hash>.json (gated)
	| "plan" // <repoFolder>/.jolli/plans/<slug>.md
	| "plan-progress" // <repoFolder>/.jolli/plan-progress/<slug>.json
	| "note" // <repoFolder>/.jolli/notes/<id>.md
	// Per-repo visible markdown (under <repoFolder>/<branch>/...):
	| "visible-summary" // <repoFolder>/<branch>/<slug>-<hex8>.md
	| "visible-plan" // <repoFolder>/<branch>/plan--<slug>.md
	| "visible-note" // <repoFolder>/<branch>/note--<id>.md
	// Catch-all for any safe-segmented path that doesn't match a specific
	// catalogue shape above. Covers (a) user-authored markdown the engine
	// did not write (e.g. acceptance fixtures' `<repo>/hello.md`,
	// `<repo>/notes/a.md`), (b) legacy-migration content the backend
	// hands us at root paths (`notes/hello.md`, `cfg.json`), and (c)
	// anything else a peer device committed that this device hasn't seen
	// before. The strict canary (`unowned`) is reserved for paths that
	// fail the segment-safety check (`..`, `\`, leading dot/dash, control
	// chars, etc.) — those still surface as drift signals.
	| "user-content";
