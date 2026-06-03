# Development Notes

## Conversation Syncing

- `sessions.json` cannot be used as the source of truth for branch-tagged conversations because `SessionTracker.pruneStale()` removes sessions after they go idle. Branch tags in `branch-tags.json` outlive the sessions they reference, causing a mismatch where tagged sessions disappear from the UI. The syncing feature needs a session source that doesn't get pruned — either branch-tags.json itself should act as a secondary session registry, or tagged sessions need to be exempt from pruning.
