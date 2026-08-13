# 352. Local Dashboard HTTP Server

## Topic Statement

The loopback-only HTTP service that renders the local dashboard's pages and answers its JSON endpoints: how it binds and advertises itself, the complete route surface it serves, the browser-facing checks each route is subject to, and how a page is assembled entirely from inlined assets.

## Scope

**In scope:**

- Process start: the detached entry, its runtime refusal, the port it is told to use, and the signal/idle teardown.
- Bind address, the ordered port candidates, and the state record written on a successful bind and cleared on shutdown.
- The full route surface: every method and path, its inputs, and its response body — including the redirects and the paths that deliberately answer 404.
- The browser security model in the order the checks run: host allowlist, origin rejection, framing denial, the mutation token, and the fetch-metadata signal.
- **The access boundary**: which routes require the token and which do not.
- Page assembly: how the asset directory is located, what a partial tree does, and what is inlined into the served HTML.
- The one model-spending read path and the two conditions that suppress it, plus the one model-spending mutation and its concurrency guard.
- The two database writes this process makes, and the different version conditions each is subject to.
- Per-request work that is skipped or memoised (reachability, per-worktree git identity, the asset directory).

**Boundaries (consumed here, owned elsewhere):**

- The launcher command that spawns this process, probes it, waits for it, opens the browser, and runs the history import — a separate topic. Only the contract between them (the state record, the health route, the port environment variable) is stated here.
- The dashboard database, its schema, and every model-building query behind `/api/model`, `/api/memories` and `/api/context`.
- The browser-side page modules that consume the inlined model and call these routes.
- The repository registry, the identity derivation, and the folder probe — the Repository Registry and Probe topic.
- Telemetry buffering, consent, and the event registry that decides whether a forwarded event is recorded at all.
- The settings mutation semantics (masked-key reuse, the cross-repo hook sweep, folder validation wording) and the install/uninstall functions the repository routes drive. **The split with that topic is deliberate and one-directional: the access boundary is enumerated here and nowhere else** — it is a property of the route surface, not of any one payload — and that topic states only which of the settings routes are exceptions to the rule stated here, plus what those exceptions expose.
- Sign-in's browser OAuth flow, the memory-bank migration, the manual sync, and the backfill engine.

## Data Contracts

### Bind address and port candidates

The listener always binds **`127.0.0.1`** — never a wildcard address.

Port selection:

- An explicit port (supplied by the launcher through the environment variable **`JOLLI_DASHBOARD_PORT`**, parsed as a base-10 integer and used only when finite) is the **only** candidate. There is no fallback from it.
- Otherwise the candidates are tried in order: **`1818`**, then **`18118`**, then **`0`** (OS-assigned). A bind failure on one candidate discards that listener and tries the next; the trailing `0` cannot collide, so the loop always settles.

### The state record

Written to **`~/.jolli/jollimemory/dashboard.json`** immediately after a successful bind, with owner-only permissions (`0600`), pretty-printed JSON plus a trailing newline:

```json
{
  "pid": 12345,
  "port": 1818,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "schemaVersion": 5
}
```

Reading it tolerates anything: a parse failure, or a body whose `port` is not a number, reads as **absent**. A missing file reads as absent silently; any other read error is logged.

Clearing it is **conditional on a pid** when the caller supplies one: the record is re-read first, and if it now names a different pid it is left alone. Read-then-unlink is not atomic, so a record rewritten inside that window can still be removed.

### The mutation token

Minted per server as **32 random bytes rendered as 64 hexadecimal characters**, held only in process memory — never written to disk, never placed in a URL.

It travels in the request header **`X-Jolli-Dashboard-Token`**. Comparison is constant-time over the **UTF-8 byte buffers** of the presented and expected values, with a length check first (a length mismatch is rejected before the constant-time compare, which would otherwise throw on unequal lengths; the leaked fact is a fixed, public length).

### Page globals

An assembled page carries exactly two inlined globals, in this order:

- `window.__JOLLI_DASHBOARD_TOKEN__` — the mutation token, as a JSON string (only when a token is supplied to the assembly step).
- `window.__JOLLI_DASHBOARD__` — the built model for that view, as JSON.

Both are hardened before inlining by escaping every `<` (plus the two raw JS line terminators), so no value in the model can escape the script block.

### The asset tree

One page template, one stylesheet, and **nine** application scripts held in a fixed load order (shared helpers, then the per-view modules, then the boot script).

That same nine-script inventory is restated in **three** places outside the server's own list: the template's own script block, and each of the two agent-plugin publish inventories. Both publish inventories currently name only **eight** of the nine — the settings module is absent from both — so a bundle that dropped it passes both publish checks and then fails this server's own door check at run time. (Notable; see the plugin-package topics.)

### Response conventions

| Kind | Headers |
| --- | --- |
| JSON | `Content-Type: application/json`, `Cache-Control: no-store` |
| Page HTML | `Content-Type: text/html`, `Cache-Control: no-store` |
| Plain text (403 / 404 / 405 / 500) | `Content-Type: text/plain` |
| Redirect | `Location: <path>`, status 302, empty body |

**No `Access-Control-Allow-Origin` — or any other CORS header — is emitted on any response, ever.**

## Behavior

### Process start

1. Refuse outright when the runtime cannot load the built-in database module without an experimental flag: the process throws before binding, so the launcher's health probe fails fast and its own message names the runtime floor.
2. Read the port from the environment variable.
3. Prime telemetry for this process and start its periodic flush. Best-effort — a failure here never blocks serving.
4. Bind (below), then write the state record.
5. Register `SIGINT` and `SIGTERM` handlers.

### Binding

For each candidate port in order: construct a listener, attach a **bind-phase-only** error listener, and listen on `127.0.0.1`. On success the bind-phase listener is detached and replaced with one that merely logs later errors; on failure the listener is closed (which is what releases its idle poll) and the next candidate is tried.

The idle clock starts and the idle poll is armed **when a listener actually starts serving**, not when it was constructed — so a candidate that lost the port never arms a timer that could later shut down the winner sharing the same process.

### Per-request gate order

Every request, whatever its method or path:

1. **Host allowlist.** The `Host` header must be one of `127.0.0.1`, `localhost`, `127.0.0.1:<bound port>`, `localhost:<bound port>`, compared case-insensitively. An absent or other host → **403** `Forbidden` (plain text). This is the anti-DNS-rebinding layer.
2. **Origin rejection.** An `Origin` header, when present, must parse, use the `http:` scheme, have hostname `127.0.0.1` or `localhost`, **and carry exactly this server's port**. Anything else — including an unparseable value, `https:`, or the same host on a different port — → **403** `Forbidden`. An **absent** `Origin` passes.
3. **Framing denial.** `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` are set on **every** response from here on — API responses included, not just HTML.
4. Method dispatch: `POST` (telemetry first, then the token-gated set), `GET`, otherwise **405** `Method not allowed` (plain text) — which is also what a CORS preflight receives.

Any exception thrown while handling a request is logged and answered **500** `Internal error` (plain text) when no headers have been sent yet; otherwise the response is simply ended.

**The two 403s in steps 1–2 are returned *before* the framing headers are set**, so a rejected request is the one response this server emits without them.

### The access boundary

Stated plainly, because it is the security-relevant default:

- **Almost every read is unauthenticated.** Session counts, token totals, cost, commit subjects, mined insights, memory bodies, plan and note documents, the per-repo push list, and the missing-summary count are all served to **any** caller that satisfies the host and origin checks — which a local process making a plain request does trivially (no `Origin` header, a loopback `Host`). So any other process, or any other user, on this machine can read them for as long as the server is up.
- **Exactly three reads require the token**: the repository folder probe, the memory-bank folder check, and `/api/model` **when and only when** `view=settings` is requested (that payload carries masked keys, sign-in state and the memory-bank folder path). The first two are gated because they probe the filesystem or feed a mutation — but the mutation the repository probe fed no longer has a caller in the shipped page, so of the three only the folder check and the settings view are reached by anything the browser loads.
- **The settings view is the one place two conditions are demanded rather than one**: the token **and** a same-site indication, refused with the plain-text 403. **That second condition cannot be tripped from the shipped page** — the token is inlined on every page render and a same-origin fetch is never cross-site — so its entire effect is on other local processes and hostile tabs, which could otherwise read masked keys, sign-in state and the folder path. In a browser a trip is indistinguishable from any other failed load. (Unreachable from the product's own surface; reachable by everything else.)
- **Every mutation requires the token**, except the telemetry beacon, which is deliberately ungated.
- The token is inlined into **every** page this server renders, so any tab showing a dashboard page holds it. A cross-origin page cannot read it back (no CORS headers, and a cross-origin `Origin` is rejected), and a framing attack is blocked by the framing headers.

### GET routes, in evaluation order

| Path | Token | Inputs | Response |
| --- | --- | --- | --- |
| `/api/repo-probe` | **required** | `path` (query) | 403 plain `Forbidden` on a bad/absent token; **400** `{"error":"path is required"}` when `path` is empty; else **200** with the folder probe result. **No shipped caller** — see the note below |
| `/api/settings/check-folder` | **required** | `path` (query, defaults to `""`) | 403 as above; **200** `{"status":"empty"\|"ok"\|"relative"\|"missing"\|"not-a-dir"\|"not-writable"}` |
| `/health` | no | — | **200** `{"ok":true,"pid":<number>,"port":<number>,"schemaVersion":<number>}` |
| `/` | no | window params (ignored except scope) | **302** to `/repositories` when no enabled repository exists, else to `/dashboard` |
| `/decisions` | no | — | **302** to `/memories`, unconditionally |
| `/repositories`, `/dashboard`, `/dashboard/standup`, `/memories` | no | window params | **200** assembled HTML — or **302** to `/repositories` for the three gated paths (below) |
| `/api/model` | conditional | `view`, window params | **403** plain `Forbidden` when `view=settings` and the caller is not both token-bearing and same-site; else **200** with the built model |
| `/api/memories` | no | `repo`, `afterRepo`, `afterHash` | **400** `{"error":"afterRepo and afterHash must be given together"}` when exactly one is present; **200** `{"items":[…],"totalCount":<number>,"cursorMissing"?:true}`; **500** `{"error":"could not read that page of memories"}` |
| `/api/context` | no | `repo`, `kind`, `key` | **400** `{"error":"repo, kind (plan\|note\|reference\|skills) and key are required"}`; **404** `{"error":"not found"}`; **200** `{"kind":…,"title":…,"bodyMd":…}`; **500** `{"error":"could not read that document"}` |
| `/api/settings/push-repos` | no | — | **200** `{"repos":[…]}`; **500** `{"error":"could not list repositories"}` |
| `/api/settings/missing-summaries` | no | — | **200** `{"missing":<n>,"total":<n>,"repoName":…}`, or `{"missing":null}` when the launch directory is not a git project; **500** `{"error":"could not count missing summaries"}` |
| *anything else* | — | — | **404** `Not found` (plain text) |

Notes on the table:

- **Page paths are the complete set.** There is no `/settings` page — settings is a modal opened over any page, which fetches its payload from `/api/model?view=settings`. `/settings`, `/knowledge` and `/graph` therefore 404, as do the retired `/stats` and `/standup`. The set of accepted `?view=` **tokens** is deliberately larger than the set of served paths: `stats`, `standup`, `repositories`, `memories`, `settings`.
- **`/api/model` never 404s on a bad view.** An unrecognized `view` silently falls back to `stats`.
- **The gated pages build a full model before deciding to redirect.** `/dashboard`, `/dashboard/standup` and `/memories` redirect to `/repositories` when no enabled repository exists — but only after their model has been built. `/repositories` is deliberately not gated: it is the page that opens the gate.
- **Window parameters** accepted by every model-building route: `repo` (selects a repo-scoped view; absent means all), `range` (one of `today`, `week`, `2w`, `month`, `3m`, `custom` — anything else is dropped), `from` / `to` (forwarded verbatim), `dimension` (one of `model`, `agent`, `project`, `branch`, `ticket`, `category` — anything else is dropped), `hash` (which memory's detail to build) and `detailRepo` (which repository owns that hash, kept separate from `repo` so opening one memory does not narrow the page).
- **Assets are never served as files.** There is no static-file route: a request for a stylesheet or a script path is an unmatched path and 404s. Everything the page needs is inlined into the page itself.
- **The repository probe has no caller in the shipped page.** It exists to report on a candidate folder before it is added, and the only surface that ever asked — a folder-browser add flow on the Repositories page — was removed along with its own browse endpoint (which now 404s) when the settings folder control became a validated text field. The probe is still routed, still token-gated and still answers; nothing the browser loads reaches it. The same is true of two POSTs, `/api/repos/enable` and `/api/hooks/reinstall` (below). (Unreachable from the shipped page; live over the wire — a token-bearing local client still gets all three.)

### POST routes

The telemetry beacon is dispatched **before** the token gate; every other POST is token-gated first.

**`/api/telemetry`** — no token. Reads and JSON-parses the body, and forwards the event only when the body is an object, its `event` is a registered event name, **and** that name is one of the four dashboard-UI events (`dashboard_opened`, `dashboard_view_switched`, `range_changed`, `chart_split_changed`), stamping it with the `web-local` surface; `properties` defaults to an empty object when absent or non-object. **It answers `204` unconditionally** — an unreadable body, an oversized body, a non-object payload, an unregistered name, and a successfully forwarded event are all indistinguishable to the caller. (Deliberate: a beacon must never learn to retry.)

For every other POST, in order:

1. **Token check** → **403** `Forbidden` (plain text) on failure, before the body is read and before anything touches the filesystem.
2. **Body read**, capped at **64 KiB** → over cap **413** `{"error":"request body too large"}`; unreadable or unparseable → **400** `{"error":"invalid JSON body"}`. An empty body parses as `{}`.
3. **Shape check** → **400** `{"error":"expected a JSON object body"}` for a non-object or `null`. An **array** body passes this check (it is an object) and then fails per-route on its missing fields.

| Path | Inputs | Response |
| --- | --- | --- |
| `/api/repos/enable` | `path` | **400** `{"error":"path is required"}`; **400** `{"error":"path is not a git repository"}`; **500** `{"error":<install failure message>}`; **200** `{"ok":true,"repoIdentity":…,"warning"?:…}`. **No shipped caller** |
| `/api/repos/disable` | `repoIdentity` | **400** `{"error":"repoIdentity is required"}`; **404** `{"error":"no repository with that identity is registered"}`; **500** `{"error":<uninstall failure message>}`; **200** `{"ok":true,"warning"?:…}` |
| `/api/repos/resume` | `repoIdentity` | same errors as disable; **200** `{"ok":true,"warning"?:…}` |
| `/api/hooks/reinstall` | `repoIdentity` | same errors; **200** `{"ok":true}` — no warning field, because this route makes no database write. **No shipped caller** |
| `/api/settings/apply` | the full settings object | **400** `{"error":<validation message>}`; **500** `{"error":"could not save settings"}`; **200** `{"ok":true,"hookFailures":[{"integration":"Claude"\|"Gemini","worktree":…,"cause":…}]}` |
| `/api/settings/set-push` | `repoIdentity`, `disabled` (boolean), `isCurrentRepo` (optional) | **400** `{"error":"repoIdentity is required"}`; **400** `{"error":"disabled (boolean) is required"}`; **500** `{"error":"could not change push setting"}`; **200** `{"ok":true,"disabled":<boolean>,"recoveredFromCorrupt"?:true}` |
| `/api/settings/signin` | — | **200** `{"ok":true}`; **400** `{"error":<reason>}`, including the timeout message after **5 minutes** waiting for the browser callback |
| `/api/settings/signout` | — | **200** `{"ok":true}`; **500** `{"error":"could not sign out"}` |
| `/api/settings/generate-missing` | — | **400** `{"error":"the dashboard was not started inside a git repository"}`; **409** `{"error":"a summary generation is already running — wait for it to finish"}`; **500** `{"error":"could not generate summaries"}`; **200** `{"ok":true,"generated":<n>,"errors":<n>,"total":<n>}` |
| `/api/settings/probe-local-agent` | `tool` | **400** `{"error":"tool is required"}`; **500** `{"error":"could not probe the local agent"}`; **200** `{"ok":true,"usable":<boolean>}` |
| `/api/settings/migrate` | — | **200** with the migration result; **400** `{"error":<result message>, …result}` on a failed/partial result; **500** `{"ok":false,"message":"could not migrate the Memory Bank"}` |
| `/api/settings/sync-now` | — | **200** `{"ok":true}`; **400** `{"error":"sync did not complete — check that you are signed in to Jolli"}`; **500** `{"error":"could not sync the Memory Bank"}` |
| *anything else* | — | **404** `Not found` (plain text) — after the token check has already passed |

**Disable, resume and reinstall** resolve their target identity to **every surviving checkout** and act on each in turn, stopping at the first failure — a registry entry is keyed by identity, so one row's button speaks for every clone, while the hooks and the opt-out it toggles are per-clone. When no recorded checkout survives, the recorded path is used anyway rather than acting on nothing. **Enable is the exception**: it acts only on the path the request named, since that path is what the caller is enabling.

Enable and resume additionally clear the user's own per-checkout opt-out; reinstall deliberately does not, so repairing hooks cannot silently un-pause a repository the user turned off, and disable sets it.

`/api/settings/migrate` drops the memoised launch-repository state on both a successful and a failed/partial **result** — but not when the migration itself throws, which is answered 500 with the memo left in place.

### Page assembly

1. **Locate the asset directory, once per server** (memoised after the first page render). Three candidate locations are probed in a fixed order, relative to the directory the serving module was loaded from — a built layout, a from-source layout, and one intermediate.
2. A candidate qualifies only if **every** file the render will read exists: the template, the stylesheet, and **each** of the nine scripts. A candidate that has the template but is missing the stylesheet or any script is **skipped**, not used — so a partially-shipped tree falls through to the next candidate.
3. If no candidate qualifies, the assembly throws; the request handler turns that into the plain-text **500**. Because that page carries no scripts, nothing then polls for a recovery — the browser stays on the error until the user reloads.
4. Read the template; replace its stylesheet link with an inline `<style>` holding the stylesheet's contents (a template missing that link is an error).
5. Replace the region between the template's script markers with: the token script (only when a token was supplied), the model script, then every app script inlined in load order (a template missing those markers is an error).

The result is entirely self-contained: no request the page makes leaves this origin, which is what makes the no-CORS policy free.

### Building a model for one request

For every model-building route:

1. Ensure the database file exists (creating an empty schema if it vanished under a running server) — a read-only open on a missing file would otherwise surface as the scriptless plain-text 500.
2. For `view=settings` only, build that payload **before** the database is opened, and hand the launch directory to it — a long-lived server reused across repositories therefore reports whichever repository it was *first* launched in. (Its contents and its memoisation are the read model's.)
3. Open the database **read-only**, then:
   - Compute per-repository git reachability — one branch-listing subprocess per enabled repository, run concurrently — but **only** for the `stats`, `memories` and `repositories` views, and only when the caller has not asked to skip it. A repository row with an empty worktree path is never given a subprocess (an empty working directory would silently run in this process's own directory and answer for some other repository); it contributes no filter. A repository whose call fails also contributes no filter.
   - For `repositories`, build that page's model from the database plus the registry.
   - For `standup` only, read every enabled repository's local git identity (two config reads per repository, concurrently) and union the results, so the "mine only" filter covers a per-checkout identity override. Each worktree's answer is cached for **5 minutes** for the life of the server, including the empty answer for a repository that has no identity configured.
4. Build the view's model, then optionally attach the compressed decision gist (below).

### The model-spending paths

Two, and only two:

- **The decisions gist.** After the model is built, and only when *all* of: the request is allowed to spend, the view is `stats`, and the built model actually carries a latest decision — the decision's text is compressed to one sentence by a model call. A failure leaves the un-compressed text in place.

  "Allowed to spend" is decided per route: a **page render** may spend unless the request is cross-site; **`/api/model`** may spend only when the caller both presents a valid token and is not cross-site; the `/` redirect never may (it deliberately builds the `repositories` model, and additionally skips reachability, precisely so that opening the base URL by hand neither spends model budget nor pays a per-repository git fan-out for a value it discards).

  "Cross-site" is read from **`Sec-Fetch-Site`**: any value other than `same-origin` or `none` counts as cross-site. **An absent header is trusted** (treated as not cross-site) — that is a non-browser client on the user's own machine.

- **Generate-missing summaries.** The one mutation that spends model budget: it resolves the launch directory's repository root, then backfills that repository's un-summarized commits. Serialised process-wide by an in-flight flag, so a second click (from a refresh or a second tab, either of which loses the page's own busy state) is answered **409** instead of paying for every summary twice. The flag is cleared however the run ends.

  **The serialisation is process-scoped only, and that is narrower than it sounds.** No run-level lock is taken, so a concurrent command-line backfill still duplicates the spend; the storage write lock serialises individual writes, not runs. What the flag stops is two clicks against **this** server, which is the case that made every memory get paid for twice — the missing set is computed once at run start, so both runs walked the same candidate set.

### The database writes this process makes

Two, not one — and the widely-repeated rule that this process never migrates the schema is **false as an absolute**.

**The schema-existence open** runs while building the model for *any* model-building route. It first reads the version read-only; if the file is missing, or its schema is **behind** this build, it opens writable and brings it up to date. A file **ahead** of this build is left alone. So the real guarantee is one-directional: a lagging server cannot downgrade or migrate a newer file, but a current server will happily upgrade an older one mid-request. The step exists because a read-only open on a missing file surfaces as the scriptless plain-text 500 that nothing polls its way out of.

**The registry projection** runs after a successful enable, disable or resume, so the change is visible to the very next request rather than at the next launcher run. Mechanically it is not a table poke: it re-reads the registry and puts the resulting repository event through the same write protocol every producer uses (spec 354).

It carries the stricter gate: the version is read through a read-only open first, and the projection is **skipped unless the file is already at exactly this build's version**. The reasoning is that this is the one long-lived process whose build can lag behind whatever spawned it — a launcher reuses whatever server the state record names once its health probe answers, and that probe's verdict is built from the reported liveness and pid alone, never from the version the route also returns.

Failure never fails the request. The route answers 200 with a `warning` string ("the repository list may be out of date until the next `jolli dashboard` run"), because the install or uninstall it follows has already succeeded and a 500 would claim a rollback that did not happen. A registry entry that cannot be found at all yields no warning and no projection.

A third route reaches a write indirectly: generate-missing stores the summaries it produces through the ordinary storage layer, which for a cut-over repository is this database.

### Idle shutdown and signals

- The idle timeout defaults to **2 hours**. It is enforced by a **60-second unref'd poll** comparing "now" against the timestamp of the last request received (updated on every request, before dispatch, and reset when the listener starts serving). A non-positive timeout arms no poll.
- On expiry: disarm the poll, close all open connections, close the listener, and on the close callback run the shutdown sequence.
- `SIGINT` / `SIGTERM` run the same sequence directly.
- The shutdown sequence is: stop telemetry (which does one final best-effort flush), clear the state record **guarded by this process's own pid**, then exit with code `0`.
- Closing the listener by any route also disarms the idle poll.

## State Transitions

### The state record

| From | Event | To |
| --- | --- | --- |
| absent | a candidate port bound successfully | present: this pid, the bound port, the start instant, the build's schema version |
| present (this pid) | idle timeout or signal | removed |
| present (another pid) | this process shuts down | **left alone** — it belongs to the successor |
| present | process killed without a signal handler running | left behind, stale; a later reader's health probe is what detects it |

### The idle poll

| From | Event | To |
| --- | --- | --- |
| unarmed | listener starts serving | armed (60 s interval), idle clock reset |
| armed | any request | idle clock reset |
| armed | idle interval elapsed | disarmed, connections closed, shutdown sequence |
| armed | listener closed for any reason | disarmed |
| unarmed | candidate lost the port and was closed | stays unarmed |

### The generate-missing guard

| From | Event | To |
| --- | --- | --- |
| idle | request accepted | in flight |
| in flight | second request | 409, state unchanged |
| in flight | run finishes or throws | idle |

## Notable Behavior

- **Most of what this server exposes needs no credential at all.** Session counts, token and cost totals, commit subjects, mined insights, memory bodies, and plan/note document bodies are readable by any local process for as long as the server is up. Only the folder probe, the folder check, `/api/model?view=settings`, and the mutations are gated. (Notable; a deliberate product call — "opening the URL by hand just works" — with a real consequence on a shared machine.)
- **The token is inlined into every page, not only the ones with buttons.** A comment on the telemetry dispatch still describes it as reaching only the write-surface pages; the render path passes it for all four served pages. (Surprising; the comment is stale, the behavior is uniform.)
- **The origin check is stricter than the host check, on purpose.** A `Host` may legitimately omit a default port, so the host allowlist accepts the port-less forms; an `Origin` is an origin, so `http://localhost` (port 80) is a *different* origin and is rejected. (Notable.)
- **The two access-control 403s are the only responses without the framing headers**, because the headers are set after those checks. (Surprising; harmless, since the response is an eight-byte refusal.)
- **The telemetry beacon answers 204 for everything.** A malformed body, an oversized body, an unregistered event name and a forwarded event are indistinguishable to the caller. It is also the one POST that is not token-gated. (Notable; deliberate.)
- **An unrecognized `?view=` silently becomes `stats`** rather than 404ing, so a typo returns a plausible payload for the wrong view. (Surprising.)
- **`/settings` is a 404.** Settings is a modal, and its payload is the one `/api/model` view that is token-gated. The accepted view-token set is strictly larger than the served page set. (Notable.)
- **The same-site condition on that view cannot be tripped by the shipped page.** The token is on every page and a same-origin fetch is never cross-site, so the check exists entirely for other local processes and hostile tabs — the only callers that can fail it. (Unreachable from the product's own surface, reachable by everything else.)
- **The generate-missing guard is process-scoped only.** It stops two clicks in two tabs against this server; it does not stop a concurrent command-line backfill from paying for the same memories again, since the storage write lock serialises individual writes rather than runs. (Notable; the obvious reading of "serialised" is wrong here.)
- **A gated page pays for its whole model before redirecting away from it.** The redirect decision is made from the built model's repository list. (Notable.)
- **`/decisions` redirects unconditionally and forever**, including when the target page would itself be gated away. (Notable.)
- **A partially-shipped asset tree is skipped, not used.** The door check requires the template, the stylesheet and every script; a candidate that has only the template falls through, and a total failure produces a scriptless plain-text 500 that nothing polls its way out of. (Notable; this is why the asset list is restated in the publish inventories — where it is currently one file short.)
- **An absent `Sec-Fetch-Site` header is trusted as a non-browser caller and may spend model budget.** The reasoning is that a local process can spend the user's budget by far easier routes; the practical effect is that the cheapest possible client is the one with the fewest restrictions. (Surprising.)
- **The base URL builds the `repositories` model, not the `stats` one**, and asks it to skip reachability — so that merely opening the server by hand costs neither a model call nor one git subprocess per repository, for a value that is then thrown away in favour of a 302. (Notable.)
- **"This process never migrates the schema" is stated all over this subsystem and is not true.** The per-request schema-existence step opens the database writable and migrates any file behind this build. What holds is the weaker, still-load-bearing half: a file *ahead* of this build is never touched, and the registry projection additionally refuses to run on any version mismatch at all, returning a warning to the page instead. (Surprising; the absolute form is what the code's own commentary claims, and it is why this is the one long-lived process whose build can lag.)
- **A repository row with an empty worktree path is deliberately given no git subprocess**, in both the reachability and the standup-identity reads: an empty working directory would silently execute in this process's own directory and answer for whichever repository the server happens to have been launched in. (Notable.)
- **The per-worktree git identity cache has a 5-minute TTL, and caches the empty answer too.** A repository with no configured identity would otherwise pay two subprocesses on every poll precisely because it has nothing to remember. (Notable.)
- **An array body passes the object-shape check** and then fails on the per-route required-field checks. (Surprising; benign.)
- **Pause, resume and reinstall fan out over every surviving checkout of that identity and stop at the first failure**, so a partial application is possible: earlier checkouts have been changed, later ones have not, and the response is a 500. Enable does not fan out — it acts on the one path it was handed. (Notable; the asymmetry is easy to misread as an oversight.)
- **Three routed, token-gated routes have no caller in the shipped page**: the repository probe, `/api/repos/enable` and `/api/hooks/reinstall`. All three served a folder-browser add flow on the Repositories page that was deleted, together with its own browse endpoint — which now answers 404, so a token-bearing local client can no longer walk the home tree. The three survivors still route, still gate on the token, and still act; only nothing in the browser asks them. Re-adding an "add from here" surface means building a front end against endpoints that are already there. (Unreachable from the shipped page, not unreachable over the wire — a distinction the route table alone cannot show.)
- **The bind-phase error listener is detached the moment the listener starts serving.** Leaving it attached would swallow every later error — rejecting an already-settled promise is a no-op, yet the listener's presence stops the runtime from surfacing the error at all. (Notable.)

## Shared Behavior

- The launcher that spawns this process detached, probes `/health`, verifies that the recorded pid still answers on the recorded port, waits for the state record to appear, opens the browser, and runs the history import — a separate topic. Its `--stop` path and its spawn lock are also there.
- The registry file, identity derivation and folder probe behind `/api/repo-probe`, `/api/repos/*` and the repositories model — the Repository Registry and Probe topic.
- The dashboard database, its schema version, its read-only/writable open modes, and the runtime floor that decides whether it can be used at all.
- Every model-building query behind `/api/model`, the memories page cursor semantics behind `/api/memories`, and the context-document lookup behind `/api/context`.
- Telemetry buffering, consent handling, the registered event names, and the periodic flush this process arms.
- The settings mutation semantics behind `/api/settings/apply` (masked-key reuse, tri-state global instructions, the cross-repository hook sweep), the folder-status verdicts shared with `/api/settings/check-folder`, what the two open settings reads expose, and what the deleted folder-browser took with it — spec 363. **The access boundary is not shared with that topic**: it is enumerated here, and that topic names only the settings routes that are exceptions to it. Same for the generate-missing guard, which is stated here in full and referenced there.
- The inline-script escaping applied to both page globals, which is shared with the other surfaces that inline model JSON into a page.
