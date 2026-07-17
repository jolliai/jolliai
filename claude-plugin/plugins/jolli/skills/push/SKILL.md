---
name: push
description: Push this branch's Jolli memories to a Jolli Space so teammates can see them. Use when the user wants to push, share, publish, or sync their memory / decisions to Jolli or a Space, even without naming Jolli.
---

# Jolli Push

Publish the current branch's commit memories to a Jolli Space as articles, so
they are shareable with the team.

**Requires being signed in to Jolli** — pushing talks to the Jolli backend. If
the user is not signed in (check `/jolli:status`), tell them to run `/jolli:login`
first.

## Step 1: Make sure memories are ready

Call the `queue_status` tool with `{ "wait": true }` so freshly-committed
summaries are included. Do not proceed while generation is still in progress.

## Step 2: Push

Call the `push_memory` tool (defaults to the current branch, range `base..HEAD`).
Handle the result by `type`:

- `type:"pushed"` → report `pushed` (articles created/updated) and `skipped`,
  then show the returned `urls`.
- `type:"binding_required"` → the repo is not bound to a Space yet. The result
  carries the available `spaces` and `defaultSpaceId`. Show them and ask which
  Space to use, then either:
  - call `bind_space` with `{ "space": "<id|slug|name>" }`, then `push_memory`
    again; or
  - call `push_memory` again with `{ "space": "<id|slug|name>" }` (binds and
    pushes in one step).

  If the user has no preference and `defaultSpaceId` is present, offer that Space.
- `type:"error"` → surface `message`. If it mentions sign-in / auth, suggest
  `/jolli:login`; if it mentions an outdated client, relay the upgrade hint.

## Notes

Push only what `push_memory` returns — never invent article content. If you need
the full Space list to help the user choose, call `list_spaces`.
