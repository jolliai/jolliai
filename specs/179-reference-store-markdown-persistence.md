# 179. Reference store markdown persistence

## Topic Statement

Persist each extracted external reference as a single per-reference markdown file under a per-source subdirectory inside the project's local jollimemory directory, with a YAML-style frontmatter header carrying the core scalar metadata plus an opaque list of source-specific display fields, followed by a markdown body holding the human-readable description.

## Scope

**In scope:**

- The on-disk location scheme: one directory tree rooted at the project's local jollimemory directory, with a per-source subdirectory and a single markdown file per reference whose stem is a sanitized form of the reference's native id.
- The per-source filename sanitization rules: identity for sources whose native id is already filesystem-safe and globally unique within the source; a replace-unsafe-then-append-content-hash transformation for the sources whose native id carries directory separators or is otherwise collision-prone (two built-ins today).
- A defensive path-traversal guard on the identity branch that rejects unsafe characters even when the source-specific contract says the input is already safe.
- The serialized file shape: a fenced YAML-style frontmatter block followed by a markdown body; each frontmatter scalar is emitted as a JSON-encoded value; the optional source-specific field set is emitted as a list-of-objects under a single fixed key, with one JSON object per item.
- Which scalars are required at frontmatter-write time and at frontmatter-parse time, and how they round-trip back into the in-memory reference shape.
- Idempotent writes: comparing the rendered bytes against the existing file's bytes and skipping the write entirely when they match, preserving filesystem modification timestamps.
- Replacing the file in-place when the rendered content differs (no rename, no temp file, no separate update path).
- Hard-delete of an individual reference's file, tolerating the file already being absent without raising.
- Recursive parent-directory creation on first write into a per-source subdirectory.
- A canonical content-hash function that hashes the rendered file bytes with the "referenced-at" timestamp zeroed, so that re-references of the same logical entity at later times keep the same content-hash guard value.
- Parsing the on-disk markdown back into the in-memory reference shape, including:
  - rejecting malformed inputs (no opening fence, no closing fence, missing required scalars, a `source` value failing the lenient charset check, non-JSON values in required scalars);
  - dropping individual field-list items that are non-JSON, that have the wrong object shape, that carry an unsafe key character set, or whose icon attribute is the wrong type, while still returning the rest of the reference;
  - ignoring frontmatter lines that are neither key-value nor list-item lines.
- A markdown-body normalization rule, shared between render and parse, that strips leading and trailing blank lines on the body so render-then-parse on the same reference yields a byte-equal canonical form.
- A conditional, auto-generated explanatory note appended after the body for any reference whose source declares either of the two consumer flags (track-only; arguments-derived), its exact user-visible text, the machine-readable sentinel that opens it, and the parse-time truncation that cuts it back off.
- A pure-string variant of the parser for callers that already hold the markdown text in memory (no filesystem read).

**Boundaries:**

- This spec does NOT cover how a reference is extracted from an AI agent's transcript or where the in-memory reference shape comes from. The extractor and the source definitions are the upstream producer; see the transcript-extraction spec (153), the source-definition DSL/engine spec (255), and the built-in catalog (154).
- This spec does NOT cover the per-project registry that tracks which references are currently uncommitted, where their files live, when they were added, or when they were last updated. The registry is a separate persisted document that points at the files this spec writes.
- This spec does NOT cover how a reference is archived into a commit summary on the orphan branch, how the content-hash this module produces is used as a commit-time guard, how archived references are migrated when a commit is squashed, or how an orphan-branch-side copy of the markdown is read back at regenerate time.
- This spec does NOT cover the prompt-block emission the shared engine does at LLM-summarization time (spec 255); this spec only persists the per-reference state.
- This spec does NOT cover access serialization with the git-op queue or any other writer; concurrent writes against the same per-reference file are not coordinated by this layer.
- This spec does NOT cover authentication, network calls, rate limiting, or any interaction with the external source itself.
- This spec does NOT cover the per-source semantic meaning of any field-list entry — every entry is opaque to this layer once it has passed the shape gate.

## Data Contracts

### On-disk location

For each persisted reference:

- A root directory: the per-project jollimemory directory inside the user's working tree.
- A per-source subdirectory under the root, named exactly by the source id. A source id is a plain string; the id space is **open** (spec 255) — twelve ids ship as built-in definitions today but the layout does not assume a fixed set.
- A single markdown file inside that subdirectory whose name is `<sanitized-key>.md`, where `<sanitized-key>` is the post-sanitization form of the reference's source-native identifier.
- Parent directories are created on demand at first write; creation is recursive and idempotent.

### Sanitized filename key

The sanitized key is computed from the source id and the source-native identifier. Which branch applies is **driven by the source definition's declared path-safety flag** (spec 255's `storage.nativeIdPathSafe`), resolved by looking the source id up in the definition registry — not by a hard-coded per-source table:

- **Path-safe sources** (flag true) — those whose native id is already filesystem-safe and globally unique within the source: the ticket-key trackers, the page-id knowledge base, and the chat-thread source — the sanitized key is the native id byte-for-byte (identity).
  - Including the case where the upstream registry has already appended a short content-hash suffix to disambiguate post-archive variants of the same entity; the suffix form (`<bareId>-<shortHash>`) flows through identity unchanged.
  - This byte-equal identity is load-bearing for the upstream registry's archive round-trip; a different sanitized key on either side would break round-trip lookups.
  - The identity branch still applies the defensive path-traversal guard below.
- **Non-path-safe sources** (flag false) — two built-ins declare this today: the code-host source, whose native id is `<owner>/<repo>#<number>` (both the slash and the hash mark are unsafe filename bytes, and two different repositories can share the same issue number), and the library-documentation source, whose native id is a slash-prefixed multi-segment library identifier. The sanitized key is computed in two steps:
  1. Replace every byte that is not a word character, `.`, or `-` with a single `-` (literally one `-` per unsafe byte, no run-collapsing).
  2. Append a `-` followed by the first eight lowercase hexadecimal characters of the SHA-256 hash of the original (un-sanitized) native id.
  - The eight-character hash suffix is the cross-repo collision guard; two repositories sharing an issue number land at different files because the hash is computed over the original native id, not over the post-replace form.
  - The sanitization is deterministic: the same input always yields the same output (no salt, no time component).
- **A source id not registered in the registry** (e.g. a definition removed after data was already written for it on disk) is treated conservatively as **non-path-safe** — the replace-then-hash form. Defaulting to identity would skip sanitization for a source whose native-id shape is unknown, so the safe-for-any-input hashed form is used instead.

### Defensive identity-branch guard

Even on identity sources whose contract guarantees a filesystem-safe native id, the sanitization step still rejects two patterns and raises an error when either appears:

- A literal `..` substring (path traversal).
- Any forward slash or backslash byte (directory separator on either kind of host filesystem).

The guard exists because reference parsing rehydrates the native id from untrusted persisted markdown without a per-source format check; the path boundary is defended at sanitization time rather than at every present and future call site. Legitimate native ids for the identity sources contain none of these patterns, so the guard never fires on real inputs.

### Frontmatter format

The on-disk file is a single text file with this structure, in order, with each item on its own line, lines separated by `\n`, and a trailing `\n` at end of file:

1. A fenced opener `---`.
2. A sequence of `key: value` scalar lines (one per scalar), in this fixed order:
   - `source` → JSON-encoded string with the source-id value.
   - `nativeId` → JSON-encoded string with the source-canonical identifier.
   - `title` → JSON-encoded string.
   - `url` → JSON-encoded string. **Emitted only when the reference carries a non-empty url.** When the source's url is absent (a source whose url field-spec is optional and whose payload carried none — e.g. a chat thread with no resolvable permalink), the `url:` line is omitted entirely rather than written as `url: ""` or `url: null`, so that the parser's missing-key path round-trips it back to an absent url.
3. An optional fields list block. It appears only when the reference carries at least one displayable field. When present, it consists of:
   - A line containing exactly `fields:`.
   - One line per field of the form `  - <json>` (two leading spaces, a hyphen, a space, then the JSON encoding of the field object). Field-object shape is `{key, label, value, icon?}` — see "Field-list item shape" below.
   - The fields list is omitted entirely (not written as an empty list) when the reference carries no fields.
4. Two trailing scalars, in this order:
   - `referencedAt` → JSON-encoded string holding the timestamp of the tool-result row that produced this reference, or the empty string if none.
   - `sourceToolName` → JSON-encoded string holding the canonical tool name (this is the persisted spelling of the in-memory reference's tool-name field).
5. A fenced closer `---`.
6. A blank line.
7. The body — the reference's description text — appearing only when the in-memory reference carries a non-empty description after edge-newline stripping (see "Body normalization" below).
8. A conditional **auto-generated note block** (see below), appearing only when the reference's source is currently registered in the definition registry **and** that definition declares the track-only flag, the arguments-derived flag, or both.

The frontmatter key set above is the complete set the writer ever emits. Every value is JSON-encoded; the writer never emits a raw or unquoted scalar.

### Auto-generated note block

For a reference whose registered source definition declares either consumer flag (spec 255 owns the flags; spec 154 records which built-in declares them), the writer appends an explanatory footer after the body. It exists because these sources deliberately store very little content, which reads as a bug to a user browsing the file.

Layout, in order: a blank line, then a single-line HTML-comment **sentinel**, then a blank line, then a horizontal rule `---`, then a blank line, then one or two blockquote paragraphs. When both paragraphs are present they are joined by a bare `>` continuation line so the two render as one blockquote.

The sentinel is exactly:

```
<!-- jolli:auto-note -->
```

Paragraph one is emitted if and only if the definition declares **arguments-derived**. Its text interpolates the source's display label **twice**:

```
> ℹ️ **This is a bookmark, not a full copy.** Only the query and the <LABEL> link are recorded here — <LABEL>'s full response is intentionally not saved. This is expected behaviour, not a bug.
```

Paragraph two is emitted if and only if the definition declares **track-only**. Its text is fixed, with no interpolation:

```
> _Track-only_ — this reference is kept as background context but is **not** used as a source when generating memory summaries.
```

Consequences of the two independent conditions:

- A source declaring only arguments-derived gets paragraph one alone; a source declaring only track-only gets paragraph two alone; a source declaring both gets both, joined by the `>` continuation line.
- **An ordinary source gets nothing at all** — no blank line, no sentinel, no rule, no paragraph. Its rendered bytes are identical to what the writer produced before this block existed.
- The note is derived **entirely from the source definition**, never from any stored body text, so it is byte-identical across every render of the same source. That property is what makes the round-trip below stable.

### Rendering depends on registry state

Because emitting the note requires looking the reference's source id up in the definition registry, the writer is **no longer a pure function of the in-memory reference alone** — its output also depends on which definitions are currently registered. A reference whose source has since been de-registered renders **without** a note, even if it previously had one.

The parse side is deliberately asymmetric: it cuts the note on the **sentinel text**, not on any registry lookup, so it still strips a note it would no longer render. This asymmetry is intentional — it is what keeps a de-registered source's already-written file round-tripping to the same body.

### Field-list item shape

Each entry in the fields list, on disk and after parsing, is an object with:

- A string **key** matching a single non-empty run of word characters and hyphens (i.e., `[A-Za-z0-9_-]+`). Any other key character set is rejected at parse time; see "Field-key character constraint" below.
- A string **label** (human-readable, opaque to this layer).
- A string **value** (pre-formatted for display, opaque to this layer).
- An optional string **icon** (opaque to this layer). When present it must be a string; any other type causes the entry to be dropped at parse time.

The order of entries within the fields list is preserved exactly as the writer received them — no sorting, no de-duplication.

### Body normalization rule

The body region (everything after the closing `---` fence and the mandatory blank line) is canonicalized by stripping any run of leading newlines and any run of trailing newlines before either rendering or parsing. The same stripping function is applied on both sides so that a render → parse → render cycle is byte-stable on any reference whose source description carries edge whitespace (e.g., descriptions that end with `\n`, end with CRLF, or are wrapped in newlines).

This shared normalization is intentional: without it, a description ending in `\n` would be written verbatim but read back trimmed, causing the canonical content-hash of the freshly-extracted reference to never match the canonical content-hash of the round-tripped reference. The downstream guard would then see the reference as "changed" on every commit and re-process it forever.

**Parse-time note truncation (same class of invariant).** Before the edge-newline stripping runs, the parser cuts the body region at the **first occurrence of the auto-note sentinel**, discarding the sentinel and everything after it. This is the mirror of the writer's conditional note block, and it is required for exactly the same reason: without the cut, the note would fold into the parsed description, be re-appended on the next render, and drift the content hash — re-upserting and re-archiving the reference on every commit forever.

Two properties of the cut are load-bearing:

- It keys on the **sentinel text**, not on the source definition. A reference whose source has been de-registered still parses back to the same body, because the strip does not depend on the writer's registry lookup.
- It is applied **unconditionally**, to every source, not only to flag-declaring ones.

### Accumulating bodies

A source definition may declare an **accumulate-body** flag (spec 154; one built-in declares it today). Its identity is an act rather than an entity, so successive writes of the same key must *collect* rather than overwrite.

The body of such a source is a list of **entry lines**, one per recorded act, each carrying the act's text and the timestamp it was recorded at, with the text delimited so a text containing the delimiter character still round-trips (the split is taken at the last delimiter occurrence in the line). Entries are emitted newest-first, ordered by timestamp with the text as tie-breaker so the rendered bytes — and therefore the content hash — do not depend on scan order. The same entry text seen twice collapses onto the later timestamp.

Two further properties:

- **The list is capped.** Beyond a fixed maximum the oldest entries are dropped, and the drop is *announced* in the body by a notice line rather than happening silently. The notice is re-derived on every render and is sticky: a body that has ever overflowed keeps its notice even if a later merge would not itself overflow. The cap is chosen for the readability of the human-browsable markdown, not measured against a workload.
- **Non-entry lines are preserved verbatim.** These files are the user-browsable layer, so any hand-edited line from either side of a merge is kept and hoisted above the entry list rather than discarded by the next machine write. The auto-note block is not one of these: it is cut before the merge ever sees it (see "Parse-time note truncation"), so it can never be folded into an accumulated body.

Reading the newest entry back out of a body is done through the **same entry format the writer emits**, exposed as a helper alongside a source-gated variant that returns nothing for a non-accumulating source. Display surfaces (specs 187, 255) call those helpers; none of them re-derives the entry format locally, which is what keeps the surfaces from drifting apart from the writer or from each other.

### Canonical content hash

A content-hash function is exposed for downstream guard use. For a given in-memory reference, it computes the SHA-256 hash, in lowercase hexadecimal, of the canonical rendered bytes of the file that the writer would emit for the same reference with the `referencedAt` scalar replaced by the empty string.

Consequences:

- Two references that differ only in their `referencedAt` timestamp hash to the same value.
- Two references that differ in any other persisted scalar (source, native id, title, url, source-tool-name, fields content, fields ordering, description after edge-newline stripping) hash to different values.

### Required-field set at parse time

A persisted file is accepted as a valid reference if and only if all of the following hold:

- The first line, after trimming whitespace, is exactly `---`.
- A later line, after trimming whitespace, is exactly `---` (the closing fence). Lines between the two are the frontmatter.
- A scalar named `source` is present, its JSON-decoded value is a string, and that string passes the **lenient source-id charset check** (non-empty, `[\w-]+`) — NOT a closed-enumeration membership test. See "Source-id model" below.
- A scalar named `nativeId` is present and its JSON-decoded value is a string.
- A scalar named `title` is present, JSON-decoded to a non-empty string.
- A scalar named `referencedAt` is present, JSON-decoded to a string (the empty string is allowed).
- A scalar named `sourceToolName` is present, JSON-decoded to a non-empty string.

`url` is **not** a required scalar. A missing `url:` key parses as an absent url (not an empty string) and does not fail the reference; when present it is JSON-decoded to a string. A source whose url field-spec is optional may legitimately lack one.

Any missing required scalar (other than url), any JSON-decode failure on a required scalar, a `source` value failing the charset check, or a missing closing fence causes the parse to return a null reference. The file is not deleted or modified by a failing parse.

### Source-id model

A source id is a plain string; the id space is **open** (spec 255). The parse path applies only a **lenient charset check** (non-empty, `[\w-]+`): a reference persisted under a source id that has since been removed from the definition registry still parses, rather than being silently dropped — data loss on a definition removal would be worse than keeping a reference whose source is not currently registered.

A separate **strict registered-source check** (does this id name a definition currently in the registry?) exists but is applied only at the path-interpolation sinks — where a source id is about to be concatenated into a filesystem path and must name a real, known source (the orphan-branch/Memory-Bank archive path resolver, out of scope here). The lenient parse check and the strict path-guard check are deliberately different gates for deliberately different purposes; the read/parse path uses the lenient one.

## Behavior

Behaviors are described in the order each call site triggers them.

### Write or refresh a reference's on-disk file

The caller provides an in-memory reference and the project's working-tree root.

**The caller must hold the project's plans lock across this call** — see "Atomic-write is not provided" below for why this is a requirement rather than a nicety.

1. Compute the sanitized filename key from the reference's source id and native id (see "Sanitized filename key" and "Defensive identity-branch guard"). If the identity-branch guard rejects the native id, the write call propagates the error to the caller and does not touch the filesystem.
2. Compute the absolute target path `<jollimemory-dir>/references/<source>/<sanitized-key>.md`.
3. Attempt to read the existing file at the target path. If the read fails for any reason, treat it as "no existing file". The failure is swallowed.
4. Determine the **effective reference** to render. For a source declaring the accumulate-body flag, when an existing file was read and parses, the effective reference is the incoming one with its body replaced by the merge of the existing body with the incoming body (see "Accumulating bodies"). For every other source, and for a first write, the effective reference is the incoming one unchanged.
5. Render the effective reference into the canonical bytes (see "Frontmatter format", "Body normalization rule", and — for a flag-declaring source — "Auto-generated note block", which requires a definition-registry lookup on the reference's source id). Capture those bytes and their canonical content hash (see "Canonical content hash") for the return value.
6. If the existing bytes match the freshly rendered bytes exactly, log a "skipped" debug event and return the target path and content hash without writing.
7. Create the parent directory recursively if it does not exist. A pre-existing directory is not an error.
8. Write the rendered bytes to the target path. Encoding is UTF-8. The write replaces the file in place (no temp-file rename dance; not atomic against external readers).
9. Log a "wrote" debug event with the path and rendered byte count.
10. Return the target path and the content hash.

The read must precede the render, not follow it: for an accumulating source the rendered bytes and the returned hash have to describe the *merged* reference, and hashing the pre-merge reference would return a digest of bytes that never reach disk.

### Read a reference from a file

The caller provides an absolute path to a per-reference markdown file.

1. Attempt to read the file as UTF-8.
   - If the read fails for any reason (missing file, permission denied, etc.), return null. The failure is swallowed.
2. Parse the resulting string per the parser rules described below.
3. Return the parsed reference, or null if the parse failed.

### Read a reference from an in-memory string

The caller provides a markdown string already in hand (e.g., a copy fetched from the orphan-branch storage by a different module). No filesystem I/O is performed.

1. Apply the parser rules below directly to the supplied string.
2. Return the parsed reference, or null if the parse failed.

### Parser rules

Given a markdown string:

1. Split on `\n` into lines.
2. If the first line, trimmed of surrounding whitespace, is not exactly `---`, return null.
3. Walk forward from the second line looking for the first line whose trimmed form is `---`. If no such line is found, return null. Call the index of that line the closing index.
4. Slice the lines strictly between the opener and the closer as the frontmatter region.
5. Take the remaining lines after the closer, joined back with `\n`, cut the result at the first occurrence of the auto-note sentinel (discarding the sentinel and everything after it — see "Parse-time note truncation"), then apply the body normalization rule (strip leading and trailing newline runs). The result is the body candidate. The cut runs regardless of which source the file names.
6. Initialise an empty map of scalar values and an empty list of field-list items.
7. Track a single boolean "currently inside the fields list" flag, initially false.
8. For each line in the frontmatter region, in order:
   - If the flag is set:
     - If the line matches a list-item pattern (whitespace, hyphen, space, then a JSON value occupying the rest of the line), attempt to JSON-parse the value:
       - If parse fails: skip the item; continue scanning subsequent lines without unsetting the flag.
       - If parse succeeds: check the item against the field-list item shape (see "Field-list item shape", including the key character constraint and the icon-type constraint); accept it if and only if it passes, otherwise silently drop it. Either way, continue scanning subsequent lines without unsetting the flag.
     - If the line does not match the list-item pattern, unset the flag and re-process this same line at the next bullet point (fall through to the next handler).
   - If the line, trimmed, is exactly `fields:`, set the flag and continue with the next line.
   - Otherwise, attempt to match the line against a `key: value` scalar pattern where `key` is one or more ASCII letters and `value` is the rest of the line after a colon and at least one space. If it matches, record the raw value string against the key in the scalar map. If it does not match, ignore the line entirely (no error).
9. Read the raw value of each scalar from the scalar map and attempt to JSON-parse it. A missing scalar, a JSON-parse failure, or a JSON value that is not a string is treated as "absent." For the `source` scalar, the decoded string is additionally checked against the lenient charset check (non-empty, `[\w-]+`); it is NOT checked against a closed enumeration.
10. If `source` is absent or fails the charset check, or if `nativeId` is absent, return null. Then, if `title` is absent, `referencedAt` is absent, or `sourceToolName` is absent, return null. `url` is read the same way but its absence does NOT fail the parse.
11. Construct the in-memory reference:
    - The registry map key is `<source>:<nativeId>` (using the post-parse values).
    - `source`, `nativeId`, `title`, `referencedAt`, and the tool-name field (named `sourceToolName` on disk, `toolName` in memory) are populated from the parsed scalars.
    - `url` is attached only when it was present; an absent url omits the property entirely (not an empty string).
    - The fields list is attached only when it is non-empty; an empty list omits the property entirely.
    - The body, after edge-newline stripping, is attached as the description only when it is non-empty; an empty body omits the property entirely.
12. Return the reference.

### Delete a reference's file

The caller provides an absolute path to a per-reference markdown file.

1. Attempt to remove the file with "force" semantics: a missing file is not an error.
2. Any other unexpected filesystem error is propagated to the caller.
3. No directory cleanup is performed; the per-source subdirectory is left in place even if it becomes empty.

### Idempotent write semantics

Calling the writer twice in succession with the same in-memory reference performs exactly one disk write:

- The first call creates the parent directory if needed and writes the file.
- The second call finds the existing file's bytes byte-equal to what it would write, logs a "skipped" debug event, and returns immediately. The filesystem modification timestamp is preserved.

The content-hash returned by both calls is identical.

### Replace-on-change semantics

A subsequent call with an in-memory reference whose canonical rendering differs from the existing file's bytes:

- Reads the existing file and finds a mismatch.
- Writes the new bytes to the same path, in place. The file's modification timestamp updates.
- Returns the new content hash, which differs from the prior call's content hash.

There is no separate "update" code path; "create" and "update" are the same write.

### Field-key character constraint

When parsing a fields-list item, the item's `key` string is checked against the character set `[A-Za-z0-9_-]+`. If the key contains any other character, the item is silently dropped, the rest of the list continues to be parsed, and the rest of the reference still parses normally.

The constraint exists because downstream prompt-block renderers interpolate the key verbatim as an XML attribute name when building the LLM prompt; an XML attribute name cannot be quote-escaped, so a malicious key like `x"><inject` would break the prompt structure. Constraining the character set at parse time closes the round-trip hole where a poisoned persisted item from any source could later corrupt a generated prompt.

The constraint applies on the read side; the writer trusts its callers (the source-definition engine, spec 255) which only emit hard-coded keys that satisfy the constraint by construction.

### Tolerance for malformed field-list items

Each of the following yields a "drop this item and continue" outcome (never aborts the parse, never returns null for the whole reference):

- The line in the list-item position does not parse as JSON.
- The JSON value is not a non-null object.
- The object is missing a `key`, `label`, or `value` property, or any of those properties is not a string.
- The `key` string does not match `[A-Za-z0-9_-]+`.
- The `icon` property is present but is not a string.

The rest of the fields list (and the rest of the reference) is unaffected.

### Tolerance for stray frontmatter lines

Inside the frontmatter region, lines that match neither the `key: value` scalar pattern nor the list-item pattern (e.g., a `# comment` line, a blank line) are silently ignored. They do not cause the parse to fail, and they do not contribute to the parsed reference.

### Legacy formats

Any frontmatter shape that does not satisfy the current required-field set — including the older single-source shape that used a `ticketId:` scalar without a `source:` discriminator — is rejected as malformed and yields a null parse. The on-disk file is not modified or migrated by this layer; resurrection (if any) is a caller concern.

## State Transitions

Per file at `<jollimemory-dir>/references/<source>/<sanitized-key>.md`:

| From               | Trigger                                                                                            | To                                  |
| ------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| absent             | writer called with a reference whose sanitized key maps here, rendered bytes B                     | present with bytes B                |
| present with B     | writer called again with a reference whose rendered bytes are exactly B                            | present with B (mtime preserved)    |
| present with B     | writer called with a reference whose rendered bytes B' differ from B                               | present with B' (mtime updated)     |
| present with any X | delete called on this path                                                                         | absent                              |
| absent             | delete called on this path                                                                         | absent (no error)                   |

The directory `<jollimemory-dir>/references/<source>/` is created on the first transition into the "present" state for any file inside it, and is never removed by this layer.

## Notable Behavior

- **Identity sanitization is load-bearing for the path-safe sources.** The upstream registry stores its map key in a form that includes the bare native id and, after archive, a short content-hash suffix appended to it (`<bareId>-<shortHash>`). The archive round-trip relies on the sanitized filename matching the bare id and the suffix form byte-for-byte for every source that declares itself path-safe. Changing the identity rule to "always hash-suffix" would silently break the cross-stage lookup for those sources.
- **The defensive path-traversal guard never fires on legitimate input.** Real native ids for the identity sources cannot contain `/`, `\`, or `..`. The guard exists solely to defend against future or malicious inputs reaching the file path layer from untrusted-persisted markdown. The error message is intentionally generic ("Refusing unsafe …") and the throw aborts the write before any filesystem syscall.
- **The hash-suffix on the one collision-prone source is computed over the original native id, not the post-replace form.** A pathological input where two different originals would replace to the same form is still resolved by the hash; the hash never sees the lossy replacement.
- **Idempotent write is observable through filesystem modification time.** Callers that rely on "did anything change on disk?" by sampling mtime can trust that an unchanged reference does not perturb the mtime. The check is byte-for-byte; even a single-character difference in any persisted scalar or in the post-strip body will cause a rewrite.
- **Atomic-write is not provided, and for an accumulating source the caller MUST serialize.** A reader racing the writer can see a partially written file. There is no temp-file rename, no fsync, and no advisory lock inside this layer; serialization is the caller's responsibility. For a non-accumulating source that responsibility is soft — the rendered bytes are a pure function of the incoming reference, so two interleaved writers of one key produce identical bytes and the race is harmless. The accumulate-body flag removes that property: the write becomes a read-modify-write, so two writers that both read before either writes each merge into the same pre-merge body and the later write silently drops the other's entries. This is reachable in practice, because an accumulating source's key is the *act* (the tool), not the agent — so independently-scheduled writers (an agent-stop hook and a polling discovery tick) contend for one file. The single caller therefore holds the project's plans lock across the whole write. Note what that lock does *not* cover: the plans-registry writer's per-key merge is a residual mitigation for a failed lock acquisition, and it works only because a registry row is overwritten wholesale; nothing mitigates a lost update on an accumulated body.
- **The `referencedAt`-zeroed content hash is intentional.** It exists so that re-references of the same logical entity by a later transcript event do not trip the "this reference changed" guard that downstream code uses to decide whether to re-process. Without it, every re-reference would invalidate the guard.
- **Render and parse share the body-edge-stripping function.** This is intentional. Any change to one MUST be applied to the other in the same change; otherwise the render → parse → render cycle is not byte-stable and the content-hash guard for any reference whose source description carries edge whitespace would mismatch on every commit forever.
- **The auto-note sentinel is an HTML comment on purpose.** It is invisible in rendered Markdown, so a user browsing the file sees only the horizontal rule and the explanatory blockquote, while the parser still has an unambiguous machine cut-point in the raw text.
- **The note's exact sentinel string is duplicated in a downstream reader and must stay in lockstep.** The editor-extension reader that builds a short description preview for its reference rows performs the same cut before truncating, using its own hard-coded copy of the sentinel rather than importing this layer's. A change to the sentinel that misses that copy would leak the note text into every preview. The JVM port's parser implements **no** equivalent cut at all, so it is not in lockstep; that is currently moot only because the one flag-declaring source is not representable in that port's closed source enumeration, and it would fold the note into the description for any future flag-declaring source that is.
- **GROUNDED BUG — the parse-time cut is unconditional on source, so a sentinel appearing in legitimate content truncates the body.** For an **ordinary** source whose description happens to contain the literal sentinel string, the writer emits that description verbatim (no note is appended, since the source declares neither flag) while the parser truncates the body at that substring. The round-tripped reference therefore hashes differently from the freshly-extracted one, so the downstream "has this reference changed?" guard fires on every commit and the reference is re-upserted and re-archived indefinitely. The same truncation applies to a flag-declaring source whose own stored body contains the sentinel. This is recorded as observed behavior, not as an intended design.
- **The writer is registry-dependent; the parser is not.** Whether a note is emitted depends on the current definition registry, so the same in-memory reference can render with or without a note across builds in which its source was registered or removed. The parser's sentinel-keyed cut is registry-independent by design, precisely so a file written while the source was registered still round-trips after it is removed.
- **An unparseable required scalar leaks no information about which scalar failed.** The parser returns null indistinguishably for "no opening fence" and "title scalar's JSON value won't decode." This is by design — the parser is a binary gate, not a diagnostic surface.
- **Frontmatter lines outside the `key: value` and list-item shapes are ignored, not rejected.** A future schema extension that adds metadata in a different lexical shape will not invalidate existing files (forward-compatible parse), but the current writer never emits such lines.
- **Field-list items are validated strictly per-item; the rest of the reference survives.** A single bad item never makes the surrounding reference unreadable. This is a robustness choice — a poisoned or stale list item dropped from the on-disk source loses only that item, not the entity.
- **The field-key character constraint is enforced on the read side only.** The writer trusts its callers' keys verbatim; the read side scrubs them. The asymmetry exists because the writer's callers are first-party source-definition code with hard-coded keys, while the read side handles untrusted persisted text (which may have flowed through external storage).
- **An unregistered-but-charset-valid source id still parses on read.** Changed behavior: the read/parse path applies only the lenient charset check, so a persisted file whose `source` names a source that is not currently registered (e.g. a definition removed after data was written) is still parsed into a reference rather than dropped — avoiding data loss on a definition removal. Only a `source` failing the charset check (empty, or containing a byte outside `[\w-]`) is rejected wholesale. The strict "is this a registered source?" test is applied elsewhere, at the filesystem-path-interpolation sinks (out of scope here), never on this read path.
- **Delete is per-file, not per-source.** Removing a reference's file never removes the per-source subdirectory, even when it becomes empty. The directory persists as a forward-compatible mount point for the next reference of the same source.
- **`---` detection trims whitespace before comparing.** Trailing whitespace on either fence line is tolerated. This matters only for files hand-edited in editors that auto-trim or auto-extend lines.
- **The opener and closer are positional, not paired with content-typed delimiters.** A frontmatter scalar value that happens to JSON-encode the literal three-character string `---` does not confuse the parser, because the parser inspects whole-line trimmed equality against `---`, not substring matches.
- **There is no maximum file size, line count, or field-list length.** Each source definition applies its own description budget at render time (spec 154); this layer persists whatever it is given.

## Shared Behavior

- The source-id model is open (spec 255): a source id is a plain string, twelve built-ins ship today, and the definition registry — not a closed union — decides registered-vs-unregistered. This layer's read path uses only the lenient charset check; the strict registry-membership check lives at the path sinks. Adding a source requires registering a new definition upstream and is out of this layer's scope.
- The two consumer flags that gate the auto-note block (track-only; arguments-derived) are declared on the source definition and contractually owned by spec 255; which built-in declares them is spec 154. This layer reads them only to decide whether to emit the note, and never changes any other aspect of its output because of them.
- The in-memory reference shape (the input to the writer and the output of the reader) is produced by the source-definition engine (spec 255), whose built-in catalog is spec 154, and the transcript extraction pipeline (spec 153). This layer treats the field-list bag as opaque and does not interpret any individual `key`.
- The canonical content hash produced here is consumed downstream as the "content hash at archive time" guard on the commit-summary side, which decides whether a previously-archived reference's on-disk file is still in sync with what was committed. That consumer is out of scope here.
- The on-disk markdown is also written to the orphan branch by a separate module that can parse the same bytes back via the in-memory-string parser variant; the orphan-branch storage layout is out of scope here.
- The per-project registry (the `references` map in the project's plan-and-note storage) holds a pointer to the absolute file path this layer writes; the registry's add/update/remove lifecycle is a separate spec. This layer does not modify the registry.
