# 318. IntelliJ Memory Bank Folder Setting Key Migration

## Topic Statement

The IntelliJ configuration record carries **one** nullable field for the user's custom Memory Bank parent folder, `localFolder`, annotated `@SerializedName(value = "localFolder", alternate = ["knowledgeBasePath"])` ([`core/Types.kt:656-657`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/Types.kt)). There is no separate `knowledgeBasePath` field — it was deleted. IntelliJ before 1.1 persisted the user's Memory Bank path under that legacy key, which the CLI and the VS Code extension never read; the two IDE surfaces therefore resolved the same repository to different Memory Bank folders. The alternate is a read-side shim that recovers the value on load, and serialization always emits the canonical key, so a legacy-only configuration is corrected on the next save. Every consumer of the setting was moved to the single field in the same change. The behavior is fully pinned by `TypesTest.LocalFolderMigration`, including the edge case that makes Gson's alternate mechanism uncomfortable: primary and alternate have **no priority relative to each other** — whichever key appears later in the JSON stream wins — so the intended migration works only because of where the canonical key lands in the merged file.

## Scope

**In scope:**
- The single-field shape, the annotation, and the deletion of the separate legacy field.
- Read behavior for a legacy-only configuration, a canonical-only configuration, an absent setting, and a configuration carrying both keys.
- Write behavior: which key is emitted, and what happens to the legacy key already on disk.
- The consumer sites moved to the single field in lockstep.
- The cross-surface divergence this removes, including which prior spec statement it corrects.

**Out of scope:**
- The rest of the configuration record's fields, and the machine-global versus per-project split of configuration state (owned by spec 129, which covers the IntelliJ configuration surface in general).
- The bridge operations `config-load` / `config-save` and the CLI's merge-and-atomic-write behind them (owned by spec 287 and the CLI's own configuration spec).
- What the resolved folder is *used for*: the per-repository root resolution, the claiming write, the folder layout, and the discovery pass (owned by specs 151 and 300).
- The Settings dialog's Memory Bank tab as a UI surface — its fields, its migrate button, and its deferred background apply (owned by spec 135).
- The one read path that still consumes the resolved root directly (owned by spec 314).

## Data Contracts

### The field

```kotlin
@SerializedName(value = "localFolder", alternate = ["knowledgeBasePath"])
val localFolder: String? = null,
```

One nullable `String` on `JolliMemoryConfig`. `null` means "no custom folder" — consumers fall back to `KBPathResolver.KB_PARENT` (`~/Documents/jolli`) or pass `null` through to the CLI resolver, which applies its own default.

### Where the record lives

IntelliJ does not read or write the file directly. `SessionTracker.loadConfig` / `loadConfigFromDir` issue the bridge `session-state` action with operation `config-load`, and `saveConfigToDir` issues `config-save` with the whole serialized record. The Gson instance on the Kotlin side is built with `serializeNulls()`, so a `null` field is emitted as an explicit JSON `null` rather than omitted.

On the CLI side, `config-save` calls `saveConfigScoped(update, dir)`, which loads the existing on-disk record, computes `{ ...existing, ...update }`, and atomically writes the result. The CLI's own `JolliMemoryConfig` type **never declared** `knowledgeBasePath`, and its read-time legacy-key coalescer (`coalesceLegacyKeys`) handles only `syncEnabled → autoSyncEnabled`. Neither side deletes the legacy key.

### Gson's alternate rule

Gson resolves `alternate` by walking the JSON top-to-bottom and **assigning the field on every matching key it encounters**. Primary and alternate compete on file order, not on precedence. There is no "primary wins".

## Behavior

### Reading

| On-disk shape | `localFolder` after load |
|---|---|
| `{ "knowledgeBasePath": "/legacy/path" }` | `"/legacy/path"` — the migration path. |
| `{ "localFolder": "/new/path" }` | `"/new/path"`. |
| `{}` | `null`. |
| `{ "localFolder": "/new", "knowledgeBasePath": "/legacy" }` | `"/legacy"` — the later key wins. |
| `{ "knowledgeBasePath": "/legacy", "localFolder": "/new" }` | `"/new"` — the later key wins. |
| `{ "localFolder": null, "knowledgeBasePath": "/legacy" }` | `"/legacy"` — the legacy key overwrites the null. |
| `{ "knowledgeBasePath": "/legacy", "localFolder": null }` | `null` — the null overwrites the legacy value. |

Every row is a test in `TypesTest.LocalFolderMigration`, using a Gson built with `serializeNulls()` to match production.

### Writing

Serialization emits only `localFolder`; the annotation's alternate is read-side only, so `knowledgeBasePath` never appears in output (`out shouldNotContain "knowledgeBasePath"` is asserted). `SettingsDialog` writes `localFolder = kbPath.ifBlank { null }` as part of a whole-record save.

**The legacy key is not removed from disk.** The CLI's merge is `{ ...existing, ...update }` over an object parsed from the file; because neither the CLI type nor the Kotlin type declares `knowledgeBasePath`, it survives in `existing` and is written back out. What actually makes the migration stick is **key order**: object spread preserves the existing keys' positions and appends keys that were not there before, so on a legacy-only configuration the appended `localFolder` lands **after** `knowledgeBasePath` in the written JSON — and by the alternate rule above, later wins on the next read. The legacy key then sits there permanently as an inert earlier duplicate.

### Consumers moved in lockstep

| Site | Use |
|---|---|
| `services/JolliMemoryService.kt` | `KBPathResolver.resolve(...)` + `initializeKBFolder` in the Memory Bank initialization step of project init. **This is the service's only consumer.** The second one it used to have — the re-attach of the direct-mirror read source on a settings save — went with that read source; no attach hook exists to re-target. |
| `toolwindow/KBExplorerPanel.kt` | `KBRepoDiscoverer.discover(..., config.localFolder)` — the repositories the tree enumerates; `KBPathResolver.resolve(...)` + `initializeKBFolder` for the workspace repository; and the wiki-build parent, `config.localFolder?.let { Path.of(it) } ?: KBPathResolver.KB_PARENT`. |
| `toolwindow/BreadcrumbHeaderPanel.kt` | `KBRepoDiscoverer.discover(..., customParent = config.localFolder)` — the repo picker's row list. |
| `toolwindow/SettingsDialog.kt` | The write (`localFolder = kbPath.ifBlank { null }`), the off-EDT snapshot taken before the dialog closes, the field's initial text, and the migrate-button flow's stale-folder scan, archive, and re-resolve. |

Because both the tree's discovery call and the breadcrumb's discovery call read the same field, a mismatch here would have shown up as a picker listing repositories the tree could not render.

## State Transitions

| From (on-disk) | Event | To (on-disk) | Effective value |
|---|---|---|---|
| `knowledgeBasePath` only | Load | unchanged | the legacy value |
| `knowledgeBasePath` only | Any save | `knowledgeBasePath` (unchanged position) + `localFolder` appended after it | the newly-written value; canonical key wins from here on |
| both, canonical later | Load | unchanged | the canonical value |
| both, legacy later | Load | unchanged | the **legacy** value — the canonical key is shadowed |
| neither | Any save | `localFolder` only | the written value, or an explicit `null` |

## Notable Behavior

- **Gson's `alternate` is not a fallback, and the tests exist to say so.** A reader who assumes "primary wins" will predict the wrong value for three of the seven rows above. The annotation is safe for the *intended* input — a file with only the legacy key — and order-dependent for anything else.
- **The stated risk case is a legacy key followed by an explicit `"localFolder": null`**, which silently drops the user's setting. `TypesTest` pins it and records that no current writer in `main/` produces that shape. The ingredients do exist, though: the Kotlin Gson is built with `serializeNulls()`, `SettingsDialog` writes `kbPath.ifBlank { null }`, and the CLI merge preserves the legacy key at its original (earlier) position. The combination is reachable only when a legacy-configuration user clears the Memory Bank path field outright — where dropping the setting is the intended outcome anyway. The genuinely dangerous shape is the other one: a file whose `localFolder` precedes `knowledgeBasePath`, where the legacy value shadows the canonical one on **every** load and no save can fix it, because saving only overwrites the canonical key in place. (Surprising.)
- **"Self-heals" means the canonical key starts winning, not that the legacy key goes away.** Neither surface deletes it — the CLI's `coalesceLegacyKeys` handles only the `syncEnabled` rename, and its merge is additive. A configuration migrated years ago still carries `knowledgeBasePath` today, inert.
- **Before this, the two IDE surfaces loaded different Memory Bank folders for the same repository.** IntelliJ wrote and read `knowledgeBasePath`; the CLI, the VS Code extension, and every hook read `localFolder`. Both keys lived in the *same* machine-global `config.json`, so this was never a file-level divergence — it was two names for one setting inside one file, which is why it was invisible until someone pointed IntelliJ's Memory Bank tab at a new folder and watched writes keep landing in the old one.
- **This is the residual of a divergence spec 129 already declared retired.** That spec records that the per-IDE `config-intellij.json` and its forward-copy migration no longer exist, and that IntelliJ reads and writes the shared record through the bridge — all true. The key-level divergence documented here survived that consolidation: same file, same bridge, different key.
- **The divergence this was reported against has since been removed twice over.** The retired mirror-read spec (307) recorded a "sixth difference": that this IDE resolved the mirror's read root from its own Memory Bank folder setting, which was *not* the value the canonical write path resolved the same folder from, so re-targeting the folder from IntelliJ moved where memory was **read** without moving where it was **written**, and a folder left populated by an earlier session would be served while fresh writes landed elsewhere. Collapsing to one field made both resolutions take the same input. The read side of it then disappeared outright: the second read source was deleted, so there is no separate mirror-read root to diverge. What the field still feeds is the initialization resolve and the repository discovery the tree and picker enumerate.
- **The field is the input to a resolution that can mutate the filesystem.** `KBPathResolver.resolve` is the claiming resolution — it can create a per-repository subdirectory and claim it — so a changed value is not merely a changed read target. That is owned by specs 151 and 300; noted here because it is what makes reading the *right* key load-bearing rather than cosmetic.

## Shared Behavior

- **IntelliJ Config File Migration, Retired (129)** — owns the broader statement that IntelliJ shares the machine-global configuration record with the CLI and VS Code; this spec covers the one key-level divergence that outlived it.
- **CLI IDE-Bridge Command Surface (287)** — owns the `config-load` / `config-save` operations and the merge-plus-atomic-write behind them.
- **Memory Bank Folder Layout (151)** and **Memory Bank Write Boundary and State Reporting (300)** — own what the resolved parent folder means, the per-repository claiming resolution, and the boundary that can refuse it.
- **IntelliJ Settings Dialog (135)** — owns the Memory Bank tab that writes the field and the deferred apply that re-resolves the per-repository root, initializes it, and re-runs migration against the freshly saved value. That apply no longer re-points any reader: no reader on this host holds a Memory Bank root between calls — the surviving native metadata read is handed one per call by its caller, and every other data read goes through the bridge and never names a folder at all.
- **IntelliJ Direct Memory-Mirror Read Path, Retired (307)** — the historical record of the deleted read source that once consumed the resolved root and recorded the divergence noted above. Nothing in it describes live behavior; **IntelliJ Native Memory Bank Metadata Read (314)** is the one surviving direct consumer of a resolved root.
- **IntelliJ Memory Bank Repo-Scope Filter (316)** and **IntelliJ KB Explorer Panel (193)** — consume the field through repository discovery.
