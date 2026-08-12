# 293. Memory Bank Migration Bridge — REMOVED

> **This topic no longer exists as a command-line surface.** The hidden `migrate-memory-bank` sub-command was deleted. Nothing in this document describes live behavior; it is retained only so the number stays claimed and so a reader who remembers the command learns where the behavior went.

## What replaced it

The out-of-process migration entry point is now an **action on the IDE bridge**, not a sub-command of its own. The JVM host asks the bridge for the `migrate-memory-bank` action; the bridge dispatches it to a shared in-process routine and answers with the migration outcome. Three consequences:

- **There is no invocation form to document.** The command name is gone from the argument parser, so there is nothing to type and nothing hidden from help output. The action is reachable only over the bridge transport.
- **There is no exit-code or single-JSON-line contract any more.** The action returns a value inside the bridge's own response envelope, and a failure propagates as the bridge's ordinary error shape. The old "exactly one JSON line on standard output, exit code 1 on failure" contract described the deleted command and does not apply.
- **Transport is daemon-first with a one-shot fallback.** The host prefers a long-lived bridge process bound to the project; when none is bound, or a *local* failure occurs (the process is gone, the protocol does not match, the socket broke), it falls back to spawning a one-shot process for the same request. Two failure classes deliberately do **not** fall back: a business-logic error raised by the action propagates as-is, and a wait-budget timeout is re-raised rather than retried, because the long-lived process is still running the action and a second process would start it again from scratch.

The **no-sign-in rule survives the move**: this path runs for a user who has never connected a Space, because the local folder migration is on by default. That was the reason the behavior existed as its own surface, and it is unchanged.

## Where the current behavior is specified

- The three-way branch on observed state (no system of record → an empty completed result; migration not complete → the full copy; already complete → the recurring reconciliation sweep) is the **shared migration caller** described in **Memory Bank Migration Engine** (215) under "Out-of-process invocation". One change is worth knowing: the migration **source** is now resolved by the repository's routing state rather than being hard-coded to the version-controlled orphan store, so a repository whose store has moved is migrated from wherever its truth actually lives.
- Everything the engine itself does — the copy sequence, idempotency by manifest match, resumability, the progress document and its status vocabulary, the archive step of the explicit user action, and the two-phase visible-layer reconciliation — is owned by 215.
- The bridge's action dispatch, its request/response envelope, and its error shape are owned by the IDE-bridge command spec.
- The IDE-side wiring — when the host asks for the migration, how it reports the outcome, and the migration lock it holds around the call — is owned by the IntelliJ specs (the settings surface, 135, and the project-service lifecycle).

## Do not restore

Nothing below this line is retained. The previous body of this document described the deleted command's invocation form, its `--cwd` option, its success line, its error envelope, and its exit codes; every one of those is now false. It has been removed rather than kept "for historical context", because a reader skimming a spec corpus cannot tell a historical section from a current one.
