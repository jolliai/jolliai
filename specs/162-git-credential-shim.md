# 162. Git Credential Shim

## Topic Statement

Hand a short-lived backend credential to a spawned remote-aware version-control child process through an out-of-band side channel that never appears in the child's command-line arguments.

## Scope

**In scope:**

- The on-disk credential helper script that the version-control tool invokes when it needs a password, including its two platform-specific variants.
- The fixed, agreed environment-variable name that the helper script reads to learn the credential.
- The fixed, machine-global filesystem location of the helper script.
- The first-use creation pathway: directory provisioning, file write, executable-bit setting on POSIX, no-op equivalent on Windows.
- The drift-detection pathway: existing-script content compare on every subsequent call, silent overwrite on mismatch, no-op on match.
- The platform-specific filename suffix and script body chosen by the runtime operating system.
- The composed environment block returned to the caller for every spawn: the inherited-host-variable allowlist, the version-control-namespace prefix passthrough with its denylist, the four fixed assignments that wire up the helper, the credential variable itself.
- The handle returned to the caller (script path, environment-variable name constant, fully composed environment block).
- The threat model the design closes (process-listing argv leakage to other local users) and the residual threat it accepts (per-process environment read by the same uid).

**Out of scope (boundaries — what crosses the boundary but is not re-specified here):**

- The reconciliation cycle that consumes the returned handle, including how many times per cycle the handle is prepared, when its cached form is invalidated, and how authentication failures trigger credential re-minting (separate spec — sync engine reconciliation, 150).
- The minting of the short-lived credential itself (backend token issuance is outside this topic; this shim is told what string to inject).
- The specific version-control hardening flags layered on top of the returned environment by the consumer (e.g., empty credential-helper chain, modal-prompt suppression) — those are properties of the consumer, not this shim.
- The transport URL the consumer points the version-control child at, and any URL-embedded user segment used as the "username" half of the credential prompt — the shim only supplies the password half.
- The transcript and request logging that may record the credential at higher layers.
- Lifecycle of the credential value itself (rotation cadence, expiry, revocation) — the shim treats it as an opaque string.

## Data Contracts

### Caller input

A single opaque credential string per call. The shim makes no claims about the string's format and performs no validation, escaping, or length check.

### Returned handle

The shim returns a record containing exactly three fields:

| Field                      | Type                  | Meaning                                                                                                              |
| -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| script path                | absolute path string  | Where the helper script was written. Suffix is `.sh` on POSIX, `.cmd` on Windows.                                    |
| environment variable name  | fixed string constant | The name the helper script reads from its own environment at run time. Identical for every call and every platform. |
| environment block          | string-to-string map  | Ready to merge into the child-process spawn options. Composed as defined below.                                      |

### Fixed environment-variable name

A single project-scoped constant (a distinctive, non-overloaded identifier) names the credential channel. The helper script body refers to it literally; the caller refers to it through the same shared symbol so a typo on one side cannot silently desynchronize from the other. If the consumer also sets a "no terminal prompt" flag on the spawned child, a typo would cause the child to fail fast rather than hang waiting for a credential that never arrives — but the design intent is exact agreement.

### Helper script body — POSIX variant

Two lines:

1. A line declaring an interpreter located via `env sh`.
2. A line that emits the value of the credential environment variable followed by a single newline, using a formatted-print primitive (so an empty or unset value still produces a clean newline-terminated empty line, rather than the unquoted-`echo` ambiguity around backslash interpretation and leading-dash arguments).

No `read` from standard input. No interactive prompts. No conditionals. No arguments are consulted; the script ignores all positional arguments the version-control tool passes (the tool typically passes a human-readable prompt string).

### Helper script body — Windows variant

Two lines, CRLF-terminated:

1. `@echo off` — required because Windows batch otherwise echoes each command line, including the credential-emitting line, to standard output before executing it.
2. A line that emits the value of the credential environment variable using the batch-style `%name%` expansion.

### Script location

A single, machine-global directory under the user's home, scoped to the product (`<home>/.jolli/jollimemory/askpass/`). Per-project copies are not used. The directory is created lazily on first call with intermediate-component creation enabled, so a missing parent is silently provisioned.

### Inherited-host-variable allowlist

A curated, closed list of host environment-variable names is copied verbatim from the parent process into the returned block. Variables not on the list and not matching the version-control namespace prefix passthrough (see below) are dropped. The allowlist is partitioned into purpose categories:

- **Executable search path** — the `PATH` lookup so the child can find auxiliary helpers (e.g., `ssh`, configured credential helpers, repo hooks).
- **Home / user-profile roots** — so the child reads its global configuration file and any global credential store.
- **Temp directories** — so the child writes lockfiles, pack files, and merge artifacts to the expected scratch location across POSIX and Windows.
- **Locale** — so the child's error messages render in the configured language and any locale-driven path-handling stays consistent with the user's shell.
- **SSH agent socket and agent pid** — so a user who later replaces the credential shim with key-based authentication keeps working.
- **XDG configuration root** — so the child honors the same configuration search path as the user's interactive shell.
- **Windows system roots** — `SystemRoot`, `APPDATA`, `LOCALAPPDATA`, `PATHEXT`, `COMSPEC`. `PATHEXT` is required so the child's executable-suffix resolution finds the `.exe`; `COMSPEC` is the shell-out fallback the child uses for any internal shelling on Windows.
- **HTTP/HTTPS/all/no proxy variables** — both upper- and lower-case spellings — so corporate-proxy users keep working. Both the HTTP layer the version-control tool wraps and any underlying HTTP library typically read these.
- **TLS trust roots** — explicit CA bundle / CA directory / curl CA bundle / Node-runtime extra-CA-certs variables — so self-signed or internally-rooted CAs (corporate MITM proxies, internal PKI) are trusted during HTTPS transport.
- **Author identity fallback** — `USER`, `LOGNAME`, `USERNAME`, `USERDOMAIN`. The child uses these to synthesize a committer identity when the global configuration lacks one; without them, any commit step the child later performs fails with an "author identity unknown" error.
- **Editor fallback** — `EDITOR`, `VISUAL`. Although the consumer passes commit-message-inlining flags everywhere it can, the rebase/merge family can still fall through to an editor; without these, a hung child process waiting on a nonexistent editor binary is possible.

Variables in the allowlist that are absent from the parent process are simply not copied — they are never set to empty strings.

### Version-control namespace prefix passthrough with denylist

After the allowlist pass, every parent-process environment variable whose name begins with the version-control tool's reserved prefix (the literal four-character namespace) is also copied — unless its name is one of three specific variables that are refused even though they share the prefix.

- Allowing the prefix lets a user's set of namespace-prefixed customizations (transport-level options, agent-identification strings, editor overrides, SSL-verification toggles, …) flow through without the shim having to enumerate every one.
- The three denied names are the variables that **rewrite which repository the child operates on**: the dot-directory pointer, the working-tree pointer, and the staging-area file pointer. Honoring them would silently retarget the operation at whatever the user's shell currently points at, mis-syncing or pushing the wrong tree. The consumer always operates on an explicit working directory via the spawn options; these env vars must not override that.

If a name is both in the allowlist and matches the prefix, the allowlist value wins (the passthrough only writes when the slot is still unset).

### Four fixed assignments overlaid on the inherited block

After the inherited block is composed, the shim writes exactly four assignments on top, in this order:

1. The version-control tool's "ask for credential" indirection variable, set to the absolute path of the helper script.
2. A "fail fast rather than prompt at a terminal" flag, set to `0` (which the version-control tool interprets as "never open a TTY prompt"). Combined with the helper script, this means a missing or unreadable credential triggers immediate exit rather than an indefinite wait.
3. A Windows credential-manager interactive-mode kill switch, set to `Never`. This is belt-and-braces: even when the consumer's command-line config-layer hardening empties the credential-helper chain, a stale per-repository helper somewhere in the configuration tree could still resolve to the modal credential manager and pop up a sign-in dialog that blocks the child indefinitely. The env-var form is the credential manager's own kill switch and protects against that case.
4. The fixed-name credential environment variable, set to the caller-supplied credential string. This is the only place the credential exists in the returned block.

The four assignments are unconditional. They are written on every call, even when the helper script on disk is unchanged.

## Behavior

### Single entry point

The shim exposes one preparation entry point that takes the credential string and returns the handle.

### Step 1 — Resolve the script path

The expected path is the join of:

- the user's home directory,
- the project's machine-global subdirectory pair (`.jolli/jollimemory/`),
- the askpass subdirectory,
- the platform-specific filename: `git-askpass.sh` on POSIX, `git-askpass.cmd` on Windows.

The platform discriminator is the runtime operating-system identifier, read once per call. Any non-Windows identifier is treated as POSIX.

### Step 2 — Choose the expected script body

The platform discriminator selects one of the two script bodies (POSIX-shebang variant or Windows-batch variant). The bodies are constants — the caller's credential is **not** baked into the body.

### Step 3 — Ensure the parent directory exists

The askpass directory is created with recursive intermediate-component creation. An already-existing directory is treated as success. A directory creation failure (permissions, filesystem-readonly, etc.) propagates as a thrown error to the caller — the shim makes no attempt to use a fallback path.

### Step 4 — Decide whether to write the script

The shim attempts to read the existing file's contents and compares its SHA-256 hash to the expected body's SHA-256 hash.

- **Read succeeds and hashes match** — the script is already correct; the write step is skipped. This is the steady-state path after first use.
- **Read succeeds and hashes differ** — the script has drifted. The shim silently overwrites it. The drift could come from a prior product version, manual tampering, or partial-write corruption from an interrupted previous call; the shim does not distinguish.
- **Read fails for any reason** (file missing, unreadable, decoding failure, ...) — the shim falls through to the write step. No error is logged; the read failure is swallowed.

The shim compares hashes rather than raw strings as a constant-time-ish defense (although collision resistance is what matters here, not timing).

### Step 5 — Write and chmod (only when step 4 said to write)

The write replaces the file's contents in their entirety. After the write completes:

- On POSIX, the file's mode is set to `0o700` (read/write/execute for the owner only). The shim does **not** verify the prior mode; it sets the mode whether or not it already matched.
- On Windows, the chmod step is skipped entirely. The mode bits would be a documented no-op on that platform, so the test suite explicitly skips the mode assertion when running on Windows; the on-disk mode after creation is the platform default.

### Step 6 — Build the inherited environment block

A fresh empty map is created.

For each name in the allowlist (in declaration order), the parent process's value is looked up. If the value is `undefined`, the slot is left unset; otherwise the value is copied to the new map.

Then, in iteration order of the parent process's environment-variable map, every variable whose name begins with the version-control prefix is considered for passthrough. A variable is passed through only when **all three** conditions hold:

1. Its name starts with the prefix.
2. Its value is not `undefined`.
3. Its name is not already present in the inherited map (so an allowlist-supplied value cannot be silently overwritten).
4. Its name is not on the prefix denylist.

### Step 7 — Overlay the four fixed assignments

On top of the inherited map, the shim writes the four fixed assignments in the order above. Any prior value in the inherited map (e.g., a user-set `GIT_ASKPASS` that survived the prefix passthrough) is unconditionally overwritten — the shim's whole purpose is to install its own helper.

### Step 8 — Return the handle

The handle is composed of the script path computed in step 1, the constant environment-variable name, and the composed environment block. The shim does not retain any reference to the credential after returning.

### Idempotence

Repeated calls with the same credential and an unchanged on-disk script:

- Skip the write/chmod (step 5).
- Still recompose the environment block from scratch (steps 6–7).
- Return a handle whose script path is unchanged but whose environment block reflects the **current** call's credential — see "Credential update without rewrite" below.

Repeated calls with the same on-disk script but a **different** credential string:

- The disk state is unchanged; only the returned environment block changes (the credential variable carries the new string).
- This is the expected re-mint path: each per-call credential gets pushed into the same shim without rewriting the script.

### Credential update without rewrite — notable

The shim never writes the credential to disk. The script body is a constant; the per-call secret travels only in the in-memory returned environment block. Consequence: rotating the credential between calls does **not** touch the filesystem. The script's mtime is the moment of last drift-correction, not the moment of last call.

### Errors thrown vs. swallowed

| Failure                                                | Behavior                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Parent directory cannot be created                     | Throws to the caller.                                                                               |
| Existing script is unreadable                          | Swallowed; the shim writes a fresh script.                                                          |
| Existing script content cannot be decoded as UTF-8     | Swallowed; the shim writes a fresh script.                                                          |
| File write fails                                       | Throws to the caller.                                                                               |
| Chmod fails (POSIX)                                    | Throws to the caller.                                                                               |
| Chmod call on Windows                                  | Never executed (skipped explicitly), so it cannot fail.                                             |
| Parent process has no value for an allowlist variable  | The variable is omitted from the inherited block (not set to empty string).                         |
| Parent process has a `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` | Dropped silently; the consumer's explicit working directory wins.                          |

## State Transitions

The shim is stateless across calls — it holds no in-memory cache of the script path, the script body, or the credential. The only persisted state is the on-disk helper script, which has three observable states:

```
[absent] ──first prepare()─────────────────► [present, correct]
[present, correct] ──prepare() with         [present, correct]
                      matching content───►   (no write, mtime unchanged)
[present, drifted] ──prepare()──────────────► [present, correct]
                                              (overwritten, mtime updated)
[present, unreadable] ──prepare()───────────► [present, correct]
                                              (overwritten, mtime updated)
```

The script never transitions back to `[absent]`; the shim has no delete path. Cleanup, if any, is the responsibility of an external uninstall flow. The script also never carries a credential, so it is safe to leave on disk indefinitely.

## Notable Behavior

- **Argv is never used to carry the credential.** This is the threat the shim closes: a process listing on a multi-user host can see every process's argv, but reading another process's environment block requires the same uid (or elevated privileges). The argv leak is the cheap-to-exploit one; the env leak is post-compromise. The threat model explicitly accepts the env-block residual.
- **Script body contains no secrets.** The script body's only knowledge of the credential is the **name** of the environment variable to read. A copy of the script left on disk by a previous run, or one inspected by a host operator, carries no usable material.
- **Three version-control-prefixed variables are silently dropped.** A user who set `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_INDEX_FILE` in their shell will find the sync engine ignoring them. This is intentional; the consumer always operates on its own explicit working directory, and honoring those vars would silently retarget the sync at the wrong repository.
- **Allowlist excludes all `*_API_KEY`, `*_TOKEN`, and cloud-credential patterns.** Host secrets that have no business reaching the spawned child — Anthropic / OpenAI / GitHub / AWS / GCP credentials — never enter the returned block. The argv-leak threat would still apply to these even if the consumer never names them in command-line arguments, because the child may invoke a credential helper or hook that walks `environ`.
- **`@echo off` in the Windows variant is load-bearing.** A bare batch file would echo the credential-emitting line itself before executing it, leaking the value to whatever stdout the version-control tool surfaces to its caller.
- **POSIX shebang uses `env sh` indirection.** This finds the user's `sh` via `PATH` rather than hard-coding `/bin/sh`. On exotic platforms (Nix, NetBSD, …) `sh` may not live at the canonical path.
- **`printf '%s\n'` rather than `echo`.** `echo`'s handling of credentials starting with `-` (interpreted as flags) and credentials containing backslashes (interpreted as escapes under some shells / when `xpg_echo` is set) makes it unsafe for an opaque secret string. The format-print primitive sidesteps both.
- **The fixed-name credential environment variable's literal name is a project-scoped identifier**, not a generic name like `PASSWORD` or `TOKEN`. Two unrelated tools running in the same shell cannot collide.
- **The "fail fast rather than prompt" flag is a belt-and-braces against shim misconfiguration.** If a typo or upgrade ever desynchronizes the script's expected variable name from the caller's set, the version-control tool would normally fall back to prompting on a TTY; setting the flag to `0` makes it exit non-zero instead, surfacing the bug rather than hanging.
- **The Windows credential-manager kill switch is also belt-and-braces.** Even with the helper installed and the no-terminal-prompt flag set, a per-repository credential-helper configuration could resolve to the modal credential manager, which pops a sign-in dialog from a hidden child process. The kill switch prevents that path.
- **`fs.chmod` on Windows is a documented no-op.** The test suite explicitly skips the mode-bit assertion when running on Windows runners; production code conditions the chmod call on the platform so it isn't issued at all there.
- **Drift detection uses content hash, not modification time.** A user who reset the file's mtime but kept the correct content does not trigger a rewrite; a user who restored the original mtime after editing the body does. The "correct content" comparison is the authoritative one.
- **Drift correction is silent.** No log line is emitted when an unexpected body is overwritten. The shim treats its script as a pure build artifact, not as user state worth preserving.
- **The shim is per-user, not per-project.** All projects on a single machine share one script. There is no per-project copy, no copy in any project's hidden directory, and no copy under any temp directory.
- **A failed chmod on POSIX surfaces as a thrown error.** The shim does not catch and ignore — a script written but not executable would silently break every spawned child later, so the failure is bubbled up immediately.
- **The order of "fixed assignments overlay" guarantees credential survival.** The four fixed assignments are written *after* the inherited block, so even if a user somehow has `GIT_ASKPASS` exported in their shell (which the prefix passthrough would have copied in), the shim's value wins.
- **The shim's environment-variable-name constant is exported for the test suite.** Any tightening of the contract that changes the literal name must also change the script bodies and the caller in lockstep; the shared constant is the single source of truth.

## Shared Behavior

- **Sync engine reconciliation cycle (spec 150)** — the only consumer of this shim. Cross-reference for how often a handle is prepared per cycle, when its cached form is invalidated, and how authentication errors trigger credential re-minting with a fresh handle. This shim is unaware of those policies — it simply produces a handle on demand.
