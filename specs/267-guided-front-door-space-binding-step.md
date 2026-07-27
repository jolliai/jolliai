# 267. Guided Front-Door Space-Binding Step

## Topic Statement

Proactively resolve — and, when needed, interactively establish — this repository's Jolli Space binding as one step of the bare-`jolli` guided front door, driven by a single "binding status + setup-if-needed" round-trip to the backend that returns one of three outcomes (already bound, unbound with a list of bindable Spaces, or no Spaces at all), prompting the user to pick a Space only when several are bindable, and staying entirely best-effort so cloud state never blocks or noises up the front door. The step now **warns** — rather than silently confirming sync — when the resolved binding is unusable to the caller (no view permission, or view-only without push rights) and, in the latter case, offers an interactive rebind when the server has a bindable pool; it is backed by a local short-circuiting cache so a repeatedly-healthy binding costs zero network I/O, and it remains entirely best-effort.

## Scope

**In scope:**

- The credential gate that decides whether this step runs at all.
- The single front-door round-trip (`POST /api/jolli-memory/front-door`), its request, its three-outcome response, and the strict validation of that response.
- The three outcomes and what the step does for each: confirm the existing binding, prompt-then-bind, or print a "create a Space first" hint.
- The interactive Space-choice prompt shown only when two or more Spaces are bindable.
- The follow-up binding call after the user picks, and its fail-closed handling of the concurrent-bind race.
- The best-effort failure posture: which errors are swallowed and which single case is surfaced.
- The placement of this step in the front-door flow (after credentials are settled, before the backlog push).
- The local binding cache: a fresh healthy binding prints the sync line with zero network I/O, and which answers populate vs. clear it.
- The read-only / no-access degraded-bound warning, and the interactive rebind offer it triggers when the server attaches a bindable pool.

**Out of scope (boundaries):**

- The reactive, editor-side chooser triggered by a `412 binding_required` on an attempted push — a distinct, second variant of Space-binding UX covered by **Binding Required Flow**. This spec's step runs *proactively*, before any push, and never in response to a `412`.
- The explicit CLI `bind` / `spaces` / push commands and their tool mirrors — a third variant covered by **CLI Space Push / Spaces / Bind Commands**.
- The wire shape of the register-binding call (`POST /api/jolli-memory/bindings`) and its `409 binding_already_exists` body, covered by **Binding Required Flow**.
- The rest of the guided front door — the auth axis, the enable axis, the capability ladder, the status line, the closing confirmation, and the backlog push that follows this step — covered by **Guided Front Door**.
- How the canonical repo URL and the derived repo name are computed from the git remote, covered by **Canonical Repo URL and Name Derivation**.
- How `(origin, tenantSlug)` and the bearer/headers are derived from the saved API key, covered by **Tenant Resolution Modes** and **Jolli API Key Format and Parsing**.

## Data Contracts

### Credential gate

The step runs only when a **`jolliApiKey`** is configured. This is deliberately narrower than the front door's own notion of "can sync" (which also counts an OAuth session token): a user signed in only via an OAuth token, with no `jolliApiKey`, produces **no** front-door round-trip and no output from this step. When the key is absent the step returns immediately and silently — the front door's status line has already told the user how to sign in.

The configured key is read once per run and reused for both the key check and every request the step makes, so the two can never observe different keys.

### Front-door endpoint

| Property | Value                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Method   | `POST`                                                                                                          |
| Path     | `/api/jolli-memory/front-door`                                                                                  |
| Headers  | `Authorization: Bearer <jolliApiKey>`, `x-jolli-client`, a request-correlation trace header, plus `x-tenant-slug` / `x-org-slug` under the same conditions as the push (see **Summary Push to Jolli Space**). |
| Body     | `{ repoUrl: string, repoName: string }` — the canonical repo URL and the repo name derived from it.             |
| Timeout  | 30 s per request (a request that exceeds it is aborted and treated as a swallowed error).                       |

### Front-door response — three outcomes

The response is validated field-by-field into exactly one of three outcomes:

| Outcome     | Response fields                                                                 | Meaning                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bound`     | `status: "bound"`, `binding: { jmSpaceId, spaceName, canPush }`, and — only on a **degraded** bound response — `spaces` / `defaultSpaceId` | The repo already has a binding **or** the server auto-bound it (see below). `jmSpaceId` and `spaceName` are each **`null` when the caller lacks view permission** on the bound Space — the server withholds the Space identity but still reports bound-ness. `canPush` mirrors the server's push-right check: `false` means the next push will be rejected; `null` means an older server that doesn't report it (unknown, not broken). |
| `unbound`   | `status: "unbound"`, `spaces: [{ id, name, slug }]`, `defaultSpaceId: number \| null` | Several Spaces are bindable; the caller must pick one and bind it. `defaultSpaceId` is the tenant's configured default when set, otherwise `null`.                  |
| `no_spaces` | `status: "no_spaces"`                                                            | The tenant has no Space this repo can be bound to.                                                                                                                 |

**Server-side auto-bind.** The server binds the repo itself when **exactly one** Space is bindable, and reports that as `bound`. Consequently the client only ever needs a follow-up binding call after an `unbound` outcome (several Spaces → the user picked one). A correct server therefore never returns `unbound` with a single-Space list, nor `unbound` with an empty list — the client tolerates both as contract drift (see Behavior).

**Fields on `bound`.** The confirmed binding is reported by Space **id** and, when permitted, Space **name**; either may be `null`. Missing values on the wire (`undefined`) are normalized to `null`.

**Degraded bound.** A `bound` response is **degraded** when it is unusable to the caller — the name was withheld (no view permission) **or** `canPush` is `false`. Only on a degraded response does the server attach the caller's bindable-Spaces pool (`spaces` + `defaultSpaceId`), so the step can offer a rebind in the same round-trip; both fields stay empty on a healthy binding and on older servers that don't report them.

### Response validation (fail-loud, never "empty state")

The response is dispatched by status code first, then by body shape:

| Condition                                        | Result                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `HTTP 426`                                        | Client-outdated error (installed CLI/extension too old — see **Plugin Outdated Flow**).     |
| `HTTP 401` or `HTTP 403`                          | Not-authenticated error.                                                                    |
| Any other non-2xx                                 | Error carrying the body's `message` (else `error`, else `HTTP <status>`).                   |
| `2xx` whose body is **not JSON** (proxy/gateway HTML or plain text) | **Fail loudly** with a "malformed (non-JSON) response" error — never read as empty state.  |
| `2xx` JSON with `status: "bound"` and a well-formed `binding` | `bound` outcome.                                                                            |
| `2xx` JSON with `status: "unbound"`               | `unbound` outcome.                                                                          |
| `2xx` JSON with `status: "no_spaces"`             | `no_spaces` outcome.                                                                        |
| `2xx` JSON with an **unrecognized / missing** `status` (or a `bound` status with a malformed `binding`) | **Fail loudly** with an "unexpected response shape" error — the caller must not misread the repo state. |

An empty but valid JSON body (`{}`) is *not* a parse failure; it has no recognized `status`, so it lands in the fail-loud "unexpected shape" arm. The distinction matters: a non-JSON `2xx` from an intermediary must never be silently read as "no Spaces" and mask an outage. All of these errors are then absorbed by the step's best-effort posture (below) — the point of failing loud at the client boundary is to keep a malformed body from being mistaken for a *legitimate* empty/unknown state, not to abort the front door.

> A `bound` status requires the `binding` object to be present and its `jmSpaceId` to be absent, `null`, or a number; a `bound` status whose `binding` is missing or whose `jmSpaceId` is a wrong type falls through to the fail-loud "unexpected shape" arm rather than being reported as bound.

## Behavior

### Step entry

1. Read the local config once. If no `jolliApiKey` is configured, return immediately (silent).
2. Build the front-door client bound to that key.
3. Resolve the canonical repo URL for the working directory and derive the repo name from it.
4. Call the front-door endpoint with `{ repoUrl, repoName }`.

### Dispatch on the outcome

**`bound`** — first, cache maintenance: a **healthy** binding (`canPush !== false` and `spaceName` present) is written to the local binding cache; a **degraded** one is never cached, and clears any stale cache entry. Then print exactly one status line:

- Healthy → `  ✓ syncing · Space "<name>"`.
- No view permission (`spaceName` is `null`) → `  ⚠ bound · no access to the Space — memories won't sync (ask for access)`.
- Read-only (`canPush` is `false`, name present) → `  ⚠ bound · Space "<name>" — read-only access, memories won't sync (ask for access)`.

When the server attached a non-empty bindable pool to a degraded response, drop the `(ask for access)` hint (the rebind prompt supplies the way out instead) and run the interactive rebind offer (below) immediately after. Done.

**`no_spaces`, or `unbound` with an empty Space list** — clear the local binding cache first, then print `  No Jolli Spaces available to you — create one at <host>`, where `<host>` is the host of the site URL embedded in the API key; if that host can't be determined, print `… create one in the Jolli web app` instead. Done. (An empty `unbound` list is contract drift — a correct server answers `no_spaces` when nothing is bindable — so it is folded into the same hint rather than prompting with zero choices.)

**`unbound` with one or more Spaces** — pick a Space, then bind:

1. **Choose the Space.**
   - A single-entry list is taken directly without a prompt (contract drift — the server auto-binds that case; a one-option prompt would be pointless).
   - Two or more entries → run the interactive choice prompt (below).
2. **Bind** by calling the register-binding endpoint with `{ repoUrl, repoName, jmSpaceId: <chosen id> }` (see **Binding Required Flow** for that call's contract). `canPush` is `true` by construction for a fresh bind — the server's bindable pool is filtered by the same push-right check — so the binding cache is written healthy at the same time.
3. On success, print `  ✓ syncing · Space "<chosen name>"` using the locally-chosen Space name.
4. On the concurrent-bind race, handle fail-closed (below).

### Interactive Space choice (two or more Spaces)

1. Compute the default index: the position of the Space whose id equals `defaultSpaceId`, or the **first** entry when the default is absent or not in the list.
2. Print `  <N> Spaces on your tenant. Which Space should this repo sync to?`, then a numbered list `    <n>) <name>` with ` (default)` appended to the entry whose id equals `defaultSpaceId`.
3. Prompt `  Choice [<defaultIndex+1>]: `.
4. Parse the answer as an integer. A value in `1..N` selects that entry (1-based). **Any** other input — empty, non-numeric, or out of range — falls back to the default entry. (Same "anything else means the default" convention as the front door's other prompts.)

### Fail-closed handling of the register-binding race

The follow-up binding call can lose a race to a concurrent binder, which the server reports as `409 binding_already_exists` carrying the *existing* binding's Space id:

1. If the binding call fails with anything **other** than the already-exists race, re-throw — it is caught and swallowed by the step's best-effort posture.
2. On the already-exists race, proceed **only** when the existing binding's Space id is *confirmed equal* to the id the user picked. A confirmed match is treated as success and prints the `  ✓ syncing · Space "<chosen name>"` line.
3. Otherwise — the existing binding is to a **different** Space, **or** the server withheld the existing Space id so equality cannot be confirmed — print `  ⚠ this repo is already bound to a different Jolli Space — your pick was not applied. Re-run \`jolli\` to see the active binding.` and stop. The user's pick is **not** applied.

This mirrors the fail-closed pre-bind of the CLI push engine: because a wrong binding would silently misroute memories, the step refuses to confirm a Space it cannot prove matches the user's choice. An undefined existing Space id is a mismatch, not a pass.

### Interactive rebind offer (degraded binding with a bindable pool)

Shown only when the `bound` response was **degraded** (see Data Contracts) **and** carried a non-empty bindable pool. Defaults to **No**.

1. Prompt `Rebind this repo to Space "<name>"? [y/N]` when the pool has exactly one Space, else `Rebind this repo to another Space? [y/N]`.
2. On anything but explicit yes, do nothing.
3. On yes, resolve the target Space — the single pool entry, or a numbered choice (same convention as the several-Spaces bind flow above) — then call register-binding with `replace: true`. This is honored only while the existing binding remains unusable (a concurrent fix elsewhere is not clobbered).
4. Fail-closed on the concurrent-rebind race: a `409 binding_already_exists` is treated as success **only** when the existing Space id provably equals the one chosen; any other failure logs at debug and prints `  ⚠ rebind failed — re-run jolli to retry`.
5. On success, write the binding cache healthy (`canPush` true by construction) and print `  ✓ syncing · Space "<name>"`.

### Best-effort failure posture

The entire step body is wrapped so that any thrown error — not signed in, client outdated, a non-2xx or malformed front-door response, a re-thrown non-race binding failure, a network/abort/timeout — is logged at debug level and **swallowed**. The front door must never be blocked or noised up by cloud state. The **only** user-visible failure output is the fail-closed race warning above, which is printed directly (not thrown) precisely so a wrong-Space binding is never silently accepted.

### Placement in the front door

The front door calls this step exactly once, after the auth and enable axes have run and the generation/sync credentials are settled, and **before** it kicks off the backlog push to the bound Space. The repo is always in the enabled state and an interactive TTY is guaranteed by the caller by the time this step runs.

## State / Outcomes

The step is backed by a **local binding cache** (`space-binding.json`, keyed by canonical repo URL + tenant origin, 7-day TTL) — a fresh healthy entry answers with **zero network I/O**. Only a healthy binding is ever cached: every degraded / unbound / no-Spaces answer clears it, so a warning or prompt is always backed by a live round-trip — the cache is a display accelerator, never the authority. A cache miss costs one fresh front-door round-trip plus, at most, one register/rebind call. A rebind or unbind performed elsewhere (web app, another client) is picked up the next time the cache misses or expires.

Terminal outcomes of a single run:

- **Silent no-op** — no `jolliApiKey` configured, or any swallowed error.
- **Confirmed** — `  ✓ syncing · Space "<name>"` printed (from a healthy `bound`, from a fresh bind, from a confirmed-match race, or from a successful rebind).
- **Hint** — `  No Jolli Spaces available to you …` printed (from `no_spaces` or an empty `unbound`).
- **Degraded warning** — `  ⚠ bound · no access to the Space …` or `  ⚠ bound · Space "<name>" — read-only access …` printed (from a degraded `bound`), optionally followed by the interactive rebind offer.
- **Race warning** — `  ⚠ this repo is already bound to a different Jolli Space …` printed (from an unconfirmable already-exists race), or `  ⚠ rebind failed — re-run jolli to retry` (from an unconfirmable rebind race).

## Notable Behavior

- **One round-trip resolves four cases.** The front-door call collapses "already bound", "server auto-bound the only Space", "several Spaces — ask", and "no Spaces" into a single request. Only the several-Spaces first run needs a second call (the user's pick → register-binding). (Notable.)
- **The credential gate is `jolliApiKey`-only, narrower than the front door's "can sync".** A user signed in solely via an OAuth token, without a `jolliApiKey`, gets no front-door call and no output here — even though the surrounding front door considers them able to sync. (Surprising; intentional.)
- **`bound` can withhold the Space identity.** When the caller lacks view permission on the bound Space, `jmSpaceId` and `spaceName` come back `null`; this is one of the two conditions that makes a `bound` response **degraded** (the other is `canPush: false`), so the step now prints the no-access warning instead of a sync confirmation. (Notable; behavior changed from a prior version that always confirmed sync on `bound`.)
- **Malformed and unrecognized `2xx` bodies fail loud, they are not read as empty state.** A non-JSON `2xx` (proxy/gateway page) or a `2xx` with a missing/renamed `status` is turned into an explicit error at the client boundary rather than silently becoming "no Spaces" — which would mask an outage as an empty tenant. The error is then swallowed by the best-effort posture. (Surprising; safety.)
- **Contract-drift shapes are tolerated, not trusted.** A single-entry `unbound` list is bound without prompting (the server should have auto-bound it); an empty `unbound` list is treated as `no_spaces` (the server should have said so). Neither is allowed to produce a pointless one-option prompt or a zero-choice prompt. (Notable.)
- **The register-binding follow-up is fail-closed on the race.** An already-exists `409` is accepted only when the existing Space id provably equals the user's pick; a different Space, or a withheld existing id, is refused with a warning and the pick is dropped — never silently applied to the wrong Space. (Surprising; safety-critical.)
- **Best-effort everywhere except the wrong-Space warning.** Every error is swallowed to keep the front door flowing, with the single exception of the fail-closed race warning, which is surfaced so memories are never silently confirmed for a Space the user did not choose. (Notable.)
- **The binding cache is shared with `jolli status`.** A binding confirmed here or by a push renders `status`'s row with no network call, and vice versa; `jolli status --refresh` bypasses it for one run. This step always trusts a fresh cache hit. (Notable.)
- **A read-only / no-access binding warns instead of silently confirming sync.** `canPush: false` or a withheld name prints a warning and, when the server offers a bindable pool, an interactive rebind; `canPush: null` still renders healthy — unknown must not false-alarm. (Notable.)

## Shared Behavior

- This is the *proactive* variant of Space binding. The *reactive* editor chooser triggered by a `412 binding_required` on an attempted push is defined by **Binding Required Flow**; the *explicit* CLI `bind` / `spaces` / push commands and their tool mirrors are defined by **CLI Space Push / Spaces / Bind Commands**. All three drive the same server binding model but differ in trigger and UX.
- The register-binding call (`POST /api/jolli-memory/bindings`), its success shape, and its `409 binding_already_exists` body (carrying the existing Space id) are defined by **Binding Required Flow**.
- The surrounding guided front door — auth axis, enable axis, capability ladder, status line, closing confirmation, and the backlog push that follows — is defined by **Guided Front Door**.
- The canonical repo URL and derived repo name are defined by **Canonical Repo URL and Name Derivation**.
- The `426` client-outdated mapping is defined by **Plugin Outdated Flow**.
- The `(origin, tenantSlug)` derivation and the bearer/tenant/org headers are defined by **Tenant Resolution Modes**, **Jolli API Key Format and Parsing**, and **Summary Push to Jolli Space**.
- The HTTPS allowlist the resolved origin must satisfy is defined by **Jolli Origin Allowlist Enforcement**.
- The Space-binding cache's file shape, TTL, and writer/clearer rules are also consumed by `jolli status` (spec 58) and every push path (`processPushPending` / `processPrePushInline`, spec 269).
