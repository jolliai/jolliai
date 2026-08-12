---
name: jolli-push
description: Publish the current branch's Jolli memories to a Jolli Space. Use when the user asks to push, publish, share, or sync memories or decisions with a team.
---

# Jolli Push

1. Call `queue_status` with waiting enabled so newly committed memories are ready.
2. Call `push_memory` for the current branch.
3. If it returns `binding_required`, present the returned Spaces, ask the user to
   choose one, then call `push_memory` again with that Space. If authentication is
   missing, route to `/jolli-login` and stop; never request credentials in chat.
4. On success, report the Space and article links. Offer to open links when the host
   provides a browser action.
5. On partial or failed publication, report the exact result and do not claim all
   memories were shared.
