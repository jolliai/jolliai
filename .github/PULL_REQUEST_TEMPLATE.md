## Summary

<!-- What does this PR do? Keep it to 1-3 sentences. -->

## Motivation

<!-- Why is this change needed? Link to any related issue with #123. -->

## Changes

<!-- Bullet list of the main changes. -->
-
-

## Testing

<!-- How did you verify this works? -->

- [ ] Added/updated unit tests
- [ ] Ran `npm run all` locally (clean → build → typecheck → lint → test)
- [ ] Tested on: (e.g. macOS + Node 22.13)

If you touched `intellij/` (its Gradle project is not covered by `npm run all`):

- [ ] Ran `./gradlew test` locally
- [ ] Tested in sandbox IDE via `./gradlew runIde`
- [ ] No new warnings from Plugin Verifier

## Screenshots / Recordings

<!-- For UI changes, attach before/after screenshots. Delete section if not applicable. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`) — CI rejects PRs without a `Signed-off-by:` trailer
- [ ] Code follows the existing style
- [ ] Documentation updated (README / CHANGELOG) if user-facing
