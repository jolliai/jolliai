# 232. Canonical Repo URL and Name Derivation

## Topic Statement

Normalize a workspace's git remote into a single stable string that is identical across clone transports and owner/repo casing, so that the same physical repository always yields the same key — the key the Jolli backend uses to look up a repository's Space binding — and derive from it the human-facing repo name, the owner/repo full name, a same-repo comparison used by share-import lookups, and the path-safe branch slug used to place documents under a per-branch folder.

## Scope

**In scope:**

- Canonical-URL normalization from every remote form (SSH scp-form, `ssh://`, `git://`, `http(s)://`, `file://`, and the no-remote fallback).
- Port handling (which schemes drop a default port and which always preserve it).
- Host/path case-folding for a known set of case-insensitive forges, and case preservation for all other hosts.
- Repo-name derivation (the chooser/bind default name) and owner/repo full-name derivation.
- A same-canonical-remote comparison with a guard against a `file://` sentinel collision.
- A three-tier shared-repo-identity match used by foreign-bank and share-import lookups.
- Branch-slug sanitization and the flat per-branch relative-path construction.

**Out of scope (boundaries):**

- The server-side use of the canonical repo URL as the binding key (covered by **Summary Push to Jolli Space** and **Binding Required Flow**).
- The share-import consumer that calls the shared-identity match (referenced only; its own spec).
- The push loop and command surface that consume these helpers (covered by **CLI Space Push / Spaces / Bind Commands** and **Jolli Space Push Article Assembly**).

## Data Contracts

### Canonical repo URL

The output is always a single normalized string. For a real remote it is an `https://host[:port]/path` string (the `https` scheme is forced regardless of the input transport); for no/unparseable remote it is a `file://` URL of the workspace root.

| Input form                                  | Canonical output                                            |
| ------------------------------------------- | ---------------------------------------------------------- |
| SSH scp-form `user@host:owner/repo[.git]`   | `https://host/owner/repo`                                   |
| `ssh://user@host[:port]/path[.git]`         | `https://host[:port]/path` (default SSH port dropped)       |
| `git://host[:port]/path[.git]`              | `https://host[:port]/path` (default git port dropped)       |
| `http(s)://host[:port]/path[.git]`          | `https://host[:port]/path` (port always preserved)          |
| `file://path`                               | `file://` URL of that path (forward slashes)                |
| No remote / unparseable / other scheme      | `file://` URL of the workspace root                         |

Common to all real-remote forms: a single trailing `.git` and any trailing slashes are stripped; the host is lower-cased; the scheme is forced to `https`.

## Behavior

### Canonicalization

1. Read the workspace's `origin` remote. An empty/unset remote falls back to a `file://` URL of the workspace root.
2. If the string is SSH scp-form (`user@host:path`, no `://`), rewrite to `https://<lowercased host>/<normalized path>`.
3. Otherwise parse as a URL. If it doesn't parse, fall back to the workspace-root `file://` URL.
4. For scheme `ssh`, `git`, `http`, or `https`: lower-case the host, strip the leading slash and trailing `.git`/slashes from the path, apply the port rule and the path-case rule, and emit `https://<host>[<port>]/<path>`.
5. For scheme `file`: emit a `file://` URL of the path.
6. For any other scheme: fall back to the workspace-root `file://` URL.

**Port rule.** For `http`/`https`, always preserve the port (self-hosted forges on non-default HTTPS ports are common). For `ssh`/`git`, drop the port only when it equals the scheme's default (SSH 22, git 9418); a non-default port is preserved. Dropping the default lets an `ssh://host/x` clone collapse onto the `https://host/x` clone of the same repo, while distinct repos on the same host but different non-default ports stay distinct.

**Path-case rule.** For a fixed set of known case-insensitive forges (the major public git hosts), lower-case the path so casing drift in the owner/repo the user happened to type collapses to one key. For all other hosts, preserve path case (self-hosted forges may have case-sensitive owner/repo segments). This host set is shared with the local vault-identity/folder-reuse canonicalizers so the binding key and the local comparers never drift on which hosts get folded.

### Repo-name derivation

Used as the chooser/bind default repo name. From the canonical (or any) URL:

1. For `http`/`https`/`ssh`/`git`: the last non-empty path segment with a trailing `.git` stripped; if the path is empty, the host.
2. For `file`: the last non-empty path segment, else the input clipped to a bounded length.
3. Unparseable / other: the input clipped to a bounded length.

### Owner/repo full-name derivation

Returns the `owner/repo` two-segment name (for a two-part "owner / repo" display) from a URL's path, or the empty string when the URL carries no owner segment (a `file://` URL, a bare host, or a single-segment path) so callers can fall back to the bare name. Applies only to `http`/`https`/`ssh`/`git`.

### Same-canonical-remote comparison

Two raw remote strings denote the same repo when their canonical forms are equal — with one guard: an empty or unparseable remote canonicalizes to an empty `file://` sentinel. Two *distinct* unparseable remotes both collapse to that sentinel, so when the equal canonical form is the sentinel the comparison falls back to raw-string equality (requiring non-empty) so two different unparseable remotes are not judged equal, while an identical local-path remote still matches. A real `file://` remote normalizes to a `file://<path>` and still compares by path.

### Three-tier shared-repo-identity match

One identity rule shared by the foreign-bank lookup and the current-repo share-import lookup, tried in order:

1. **Both sides have a remote** → compare canonically (the same-canonical-remote comparison). The share payload carries the backend's normalized URL while the local bank keeps the raw git remote, so a strict equality would miss `…/x.git` vs `…/x`.
2. **Share withheld its URL (public-tier) but the candidate has a remote** → reconstruct the backend's path-stripped `ownerrepo` form from the candidate's owner/repo and compare **case-insensitively** to the share's repo name. This preserves the owner dimension (two repos sharing a basename under different owners don't collide) while tolerating GitHub-family case-insensitivity.
3. **Last-ditch** → bare repo-name equality, for the remote-less-on-both-sides case.

### Branch slug and relative path

- **Branch slug:** replace every character outside `[A-Za-z0-9._-/]` with `_`, collapse runs of `_` and of `/`, trim leading/trailing separators; an empty result becomes `_`. This mirrors the server's path-safety strip.
- **Relative path:** the flat `<branchSlug>` — summary, plan, and note documents all share this one per-branch path; the document kind is carried on the push body's type discriminator, not encoded in the path.
- **Shared-name sanitization:** a helper strips the path-unsafe class (notably `/`) from a name, mirroring the server's repo-name sanitization, so `owner/repo` becomes `ownerrepo`; used only by the tier-2 identity match. Drift from the server regex only ever yields a safe false-negative (falling through to a read-only sandbox), never a wrong-repo write.

## Notable Behavior

- **The canonical URL is the binding's primary key, so it must be transport- and case-stable.** Every clone form of one repo — SSH, HTTPS, with or without `.git`, with owner/repo case drift on a case-insensitive forge — must collapse to one string, or teammates would end up with divergent binding keys (one binds, another gets binding-required or a duplicate). (Central.)
- **The scheme is always forced to `https` in the output**, even for SSH/git inputs, because the key is an identity string, not a fetch URL. (Notable.)
- **Default ports are dropped only for `ssh`/`git`; `http(s)` ports are always kept.** Self-hosted forges legitimately serve on explicit non-default HTTPS ports, so the wire form the user typed is preserved. (Surprising; intentional.)
- **Path case is folded only for known case-insensitive forges.** For everything else the owner/repo segments may be case-sensitive, so their case is preserved. The host set is shared with the local identity comparers to prevent drift. (Notable.)
- **This normalizer is deliberately blind to host aliases, and it now diverges from the local vault/folder normalizer on exactly that.** The host token here is taken as written and only lower-cased: an SSH remote spelled with a locally-defined SSH-client host alias yields a canonical URL naming the *alias*, not the real host it resolves to. The local normalizer that decides which Memory Bank folder a repository reuses does resolve the alias, so the two answer differently for the same remote. The consequence is asymmetric rather than symmetrical breakage: an alias user gets a single local Memory Bank folder for a repository they cloned both ways, while potentially getting **two different binding keys** for it — so the same physical repository can bind to a Space under one key from the aliased clone and require binding again under the other. The blindness is deliberate at this layer — the binding key must be reproducible from the remote string alone, on a server that has no access to the user's SSH configuration, and must be identical for every teammate regardless of what aliases each of them happens to define. Nothing detects or reports the divergence. (Surprising; the alias-awareness the local side gained was not extended here, on purpose.)
- **The `file://` sentinel guard prevents two distinct unparseable remotes from matching.** Both collapse to the same empty sentinel, so the comparison falls back to raw equality for that case. (Surprising; defensive.)
- **The three-tier identity match preserves the owner dimension even when the server withholds the URL.** The tier-2 reconstruction compares `ownerrepo` (owner-inclusive) case-insensitively rather than a bare basename, so two same-named repos under different owners don't collide. (Notable.)
- **All document kinds share one flat per-branch path; the type discriminator disambiguates them.** The path does not encode summary vs plan vs note. (Notable.)

## Shared Behavior

- The server-side treatment of the canonical repo URL as the binding key is defined by **Summary Push to Jolli Space** and **Binding Required Flow**.
- The push loop and command surface that consume the canonical URL, repo name, and relative path are defined by **CLI Space Push / Spaces / Bind Commands** and **Jolli Space Push Article Assembly**.
- The share-import consumer of the shared-repo-identity match is defined by its own spec (referenced only).
- The **local** repository-identity normalizer — the one that keys the cross-device folder registry and decides which Memory Bank folder a repository reuses, and which resolves SSH host aliases through the local SSH client configuration — is defined by the repo-identity-and-folder-naming spec. The case-insensitive-host set is shared between the two; the alias resolution is not.
