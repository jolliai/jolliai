---
description: Show the chronological evolution of a decision topic by its slug.
argument-hint: <topic-slug>
---

The user wants the timeline for topic slug: $ARGUMENTS

Call the `get_decision_timeline` tool with `{ "slug": "$ARGUMENTS" }` and render
the source events oldest-first as a chronological narrative. If the slug is
unknown, use the `search` tool to help the user find the right slug first.
