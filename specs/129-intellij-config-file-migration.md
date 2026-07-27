# IntelliJ Config File Migration (Retired)

## Topic Statement

This topic previously described a per-IDE-namespaced configuration file (`config-intellij.json`) that the IntelliJ surface wrote alongside the shared `config.json`, a one-time forward copy of the shared file into the per-IDE file on first read, and the permanent divergence that followed — CLI-side changes no longer reaching the IDE and vice versa. **None of that exists.** There is no per-IDE configuration file, no migration copy, and no host/CLI divergence. The IntelliJ surface reads and writes the **shared machine-global** `config.json` through a bridge operation delegated to the command-line surface, so the IDE, the CLI, and the VS Code extension all see the same record.

## Scope

**In scope:**
- Recording that the per-IDE configuration file and its migration are gone: the IntelliJ surface has exactly one configuration file, the shared machine-global one, and no code path reads or writes any IDE-namespaced filename.
- The delegated load / save contract: every IntelliJ configuration read and write is a round-trip to the command-line surface's own config loader / scoped saver, both of which are hard-wired to the shared filename.
- The settings-dialog **Apply** sequence, which is four separate non-atomic writes against that one shared file.
- The cross-surface consequence: settings that were previously IDE-private are now shared with two other surfaces.

**Out of scope:**
- The settings dialog's fields, tabs, provider cards, and per-field persistence table — owned by the IntelliJ settings-dialog spec.
- Auth-token storage, the environment-variable override, and the sign-in flows — owned by the auth specs.
- The credential-priority rules that combine the persisted fields at request-dispatch time — owned by the LLM-credential-priority spec.
- The Space file, which lives at a different path and was never part of this topic.

## Data Contracts

### The one configuration file

`<user-home>/.jolli/jollimemory/config.json` — the shared machine-global configuration, produced and consumed by the command-line surface, the VS Code extension, and the IntelliJ surface alike. The IntelliJ surface resolves this directory locally (it is the one bootstrap path that cannot itself go through the command-line surface, because resolving the runtime depends on it), then hands the directory to the delegated load / save operation as an explicit argument.

`config-intellij.json` is **not** a file the product creates, reads, or writes. The name survives only in stale source comments explaining why certain fields are force-nulled during Apply; those comments describe a file that no longer exists and no behavior depends on them.

### Field sharing

Because there is one file, every persisted field is cross-surface. The fields that were IDE-private under the retired design and are now shared include: the paused flag, the auto-sync toggle, the sync-transcripts toggle, the per-agent enabled flags, the Memory Bank folder path, the model alias, the per-request token cap, and the exclude-pattern list. In addition, the provider-routing group (provider choice, direct API key, local-agent tool and path), the DCO sign-off flag, and the telemetry opt-out are all persisted into the same file.

## Behavior

### Read path

A configuration read is a single delegated operation: the IntelliJ surface asks the command-line surface to load the configuration from the shared directory and deserializes the returned record. There is no existence check on an IDE-namespaced file, no fallback, and no copy step. A missing or unparseable file yields an all-null record from the command-line side, exactly as it does for the other surfaces.

### Write path

A configuration write is a single delegated operation carrying the target directory and the whole record. The command-line side performs the scoped save against the shared filename.

Two convenience writes exist on top of it, each a read-modify-write of the same shared file: one that overlays only the provider-routing group, and one that overlays only the DCO sign-off flag.

### Settings Apply — a four-write non-atomic sequence

Clicking **Apply** in the settings dialog performs four writes against the one shared file, in order, with no enclosing lock or transaction:

1. **Full-record save with five fields force-nulled.** The dialog builds a complete record from its fields and writes it — but with the direct API key, the provider choice, the local-agent tool, the local-agent path, and the DCO sign-off flag all set to explicit JSON `null`. (The IntelliJ serializer emits nulls rather than omitting them, so these five keys are actually written as null on disk, not left at their prior values.)
2. **Provider-routing restore.** A read-modify-write that puts the provider choice, the direct API key, and the local-agent tool back.
3. **DCO sign-off restore.** A second, separate read-modify-write that puts the sign-off flag back.
4. **Telemetry.** A third, separate read-modify-write that sets the telemetry opt-out to `on` or `off`.

Between writes 1 and 2 the file on disk genuinely has no provider choice and no API key; between 1 and 3 it has no sign-off flag. Any other surface that loads the configuration inside that window reads the nulled state.

Two additional reads of the same file precede write 1 — one to decide whether the platform API key was cleared by the user (which triggers a sign-out) and one to re-read after that possible sign-out so the auth token is current.

## State Transitions

There is no migration state machine. The only state a configuration file has is present-or-absent, and an absent file deserializes to an all-null record.

The Apply sequence's transient states are the observable transitions:

```
steady            ── Apply write 1 ──► provider group + sign-off flag null on disk
(write 1 state)   ── Apply write 2 ──► provider group restored, sign-off still null
(write 2 state)   ── Apply write 3 ──► sign-off restored
(write 3 state)   ── Apply write 4 ──► telemetry set; steady
any write fails   ──────────────────► the file is left at whichever intermediate state was reached
```

## Notable Behavior

- **There is no per-IDE configuration file and never a divergence.** A user who signs in through the command-line surface sees that sign-in in the IDE immediately, and a setting changed in the IDE is visible to the CLI and the VS Code extension. The retired design's central consequence — two files drifting apart — cannot occur.
- **The `config-intellij.json` mentions in the source are comments only.** They justify the force-nulling in Apply write 1 by reference to a file that no longer exists. The force-nulling itself is real; its stated rationale is stale.
- **Apply is not atomic and can be observed mid-sequence.** Four separate writes to one shared machine-global file mean a concurrent reader on any surface — including a background summary worker on the command-line side — can observe the provider choice and API key as absent. Nothing retries or rolls back: a failure partway through leaves the file at the intermediate state it reached.
- **The local-agent path is nulled and never actually restored.** Apply write 1 sets it to null; the provider-routing restore preserves "whatever is currently on disk" for that field, which by then is the null write 1 just made. So an Apply silently erases a configured local-agent path even though the dialog never asked to change it.
- **Settings the IDE does not surface are still preserved.** Because writes 2, 3 and 4 are read-modify-writes over the loaded record, fields the IntelliJ dialog has no control for survive an Apply — except for the five that write 1 explicitly nulls.
- **The shared directory path is the one thing resolved locally.** Every other path and every read/write goes through the command-line surface; the machine-global state directory is computed in-process because resolving the delegated runtime itself depends on knowing where the configuration lives.

## Shared Behavior

- The on-disk configuration schema, the loader, and the scoped saver are owned by the command-line surface; the IntelliJ surface is a thin adapter over them.
- The IntelliJ settings-dialog spec owns the field list, the provider cards, and the per-field persistence table; this spec owns only the file identity and the Apply write sequence.
- Auth-token persistence, the environment-variable override, and sign-out are owned by the auth specs; a cleared platform API key in the dialog triggers a sign-out before the Apply writes begin.
- Credential precedence at request-dispatch time is owned by the LLM-credential-priority spec.
