# 199. Knowledge Graph Artifact Storage

## Topic Statement

Persist a repo's knowledge graph as a single regenerable JSON file in the hidden canonical layer of its Memory Bank folder, written atomically and read back with a parse-failure tolerance that degrades to a full rebuild.

## Scope

**In scope:**
- The fixed on-disk location of the graph file under a repo's per-repo folder root.
- The single-file design and why the artifact and the incremental baseline are the same file.
- The write: directory creation, serialization format, atomic replace, and the returned path.
- The read: missing-file tolerance, parse-failure tolerance, and the never-throw contract.
- The path helper that resolves the file location for a given root.

**Out of scope (boundaries):**
- The content/shape of the persisted object (the data model, fingerprint maps, stats — spec 196). This layer serializes whatever object it is handed and parses it back as an opaque shape for the caller to field-validate.
- The atomic-write primitive's internals (tmp-file creation, rename, the platform fallback) — only its atomicity guarantee and its one residual tearing caveat are in scope.
- Choosing whether to write at all, and how the read result is used as the incremental baseline (spec 197).
- The standalone self-contained HTML export, which reads this file but assembles a separate deliverable (a distinct concern — the export inlines this file's bytes into an HTML shell).
- The viewer runtime that consumes the file (it is referenced externally by the host webview; this layer writes only data, no runtime).
- The Memory Bank folder layout that establishes the per-repo root (spec 151) and the dual-write/orphan-branch storage providers — this file is written with direct filesystem calls and is **not** mirrored to the orphan branch.

## Data Contracts

### File location

A single file at a fixed relative path under the per-repo folder root: a hidden top-level directory, a graph subdirectory, and the graph file. (In this layout: `<root>/.jolli/graph/graph.json`.) The path helper returns this absolute path for any given root.

### Persisted object

The full knowledge-graph object (spec 196): schema version, generated-at timestamp, source label, the two per-topic fingerprint maps, stats, categories, topics, units, edges, and the co-change topic-edge list. This layer treats it as an opaque serializable value on write and as an unknown-shaped value on read.

### Write result

A record carrying the absolute path of the written file.

## Behavior

### Write

1. Compute the graph directory under the root and create it recursively (idempotent).
2. Compute the file path.
3. Serialize the graph object as tab-indented JSON.
4. Write it atomically (write to a temporary sibling, then rename over the destination) so a read during a compile, or a crash mid-write, never leaves a truncated file that would break the viewer/export.
5. Return the file path.

### Read

1. Attempt to read the file as text. On any read error (missing file, unreadable), return null — degrade to a full rebuild.
2. Attempt to parse the text as JSON. On a parse error, log a warning ("treating as no baseline / full rebuild") and return null.
3. Otherwise return the parsed object, typed as the graph shape but **not** field-validated here. The caller is responsible for the field-set check before reusing it as an incremental baseline.

The read never throws.

## State Transitions

### The graph file

```
ABSENT ──(write)──> PRESENT (atomic; dir auto-created)
PRESENT ──(write)──> PRESENT (atomically replaced)
```

### A read

```
file missing / unreadable      ──> null (no warning beyond the swallowed error)
file present + unparseable      ──> null + warning logged
file present + parseable        ──> parsed object verbatim (no field validation)
```

## Notable Behavior

- **Single file by design.** The graph file is a superset of the raw distilled layer (the distilled subset is recoverable from it via the restore step in spec 196), so it doubles as both the artifact the viewer renders and the incremental baseline. Keeping one file means one write — no cross-file torn write where a fresh artifact pairs with a stale separate baseline.
- **Folder-local and regenerable.** The file is written with direct filesystem calls and is deliberately **not** dual-written to the orphan branch. If it is lost or corrupted, the next build degrades to a full rebuild and self-heals; the orphan branch remains the system of record, so no source data is lost.
- **Atomic write, with one residual tearing caveat.** The tmp-then-rename sequence prevents a truncated file in the normal case. A single file can still tear on the platform-specific write fallback; that is acceptable precisely because a parse failure on read degrades to a full rebuild rather than propagating.
- **Read is parse-tolerant and never throws.** Both a missing file and a corrupt file return null; only the corrupt case logs a warning. This is the contract that lets the construction layer treat "no baseline" and "bad baseline" identically.
- **No field validation on read.** The read returns the parsed object as-is. The decision about whether it is structurally usable as a baseline is made by the caller (spec 197) using the restore field-set check and the fingerprint-map predicate (spec 196).
- **The directory is created on every write.** The recursive directory creation is idempotent, so the first write into a fresh repo and every subsequent write share the same path.

## Shared Behavior

- **The persisted shape and its baseline role.** The object written and read here is the knowledge-graph artifact defined in spec 196; its restore-to-distilled and fingerprint-map predicate are what the caller applies to a read result. The two embedded fingerprint maps make this file usable as the incremental baseline.
- **Read-as-baseline and write-after-assembly.** The construction layer (spec 197) reads this file before deciding full vs. incremental and writes it after assembly; it relies on the null-on-failure read and the path returned by the write.
- **The export deliverable.** A separate export reads this file's bytes and inlines them into a self-contained HTML alongside the viewer runtime; that deliverable is out of scope here, but it depends on this file existing at the fixed location.
- **Memory Bank folder root.** The per-repo root this file is rooted under is established by the Memory Bank folder layout (spec 151); the hidden canonical layer is where regenerable, programmatic-access data lives.
- **Vault sync participation.** The artifact participates in vault sync as a regenerable file: when the Memory Bank folder is git-synced to a personal-space vault, this file is allowlisted for staging under its own path kind (spec 163), and a sync conflict on it is resolved deterministically by keeping the side with the newer embedded generated-at timestamp — never an AI merge or a user prompt (the newest-timestamp conflict tier — spec 150) — because the loser regenerates on its next build.
