#!/usr/bin/env bash
#
# GIT publish (production marketplace) — build the plugin and publish it into the
# INDEPENDENT git repo (claude-plugin-marketplace) that colleagues install from,
# then commit + push.
#
# The marketplace repo is a pure release artifact generated from this monorepo's
# claude-plugin/ tree — never hand-edited. Source of truth:
#   claude-plugin/.claude-plugin/marketplace.json   (marketplace manifest)
#   claude-plugin/README.md                         (marketplace README)
#   claude-plugin/plugins/jolli/**                  (the plugin, incl. built dist/)
#
# Usage:
#   bash claude-plugin/scripts/publish-git.sh                 # -> ../claude-plugin-marketplace
#   bash claude-plugin/scripts/publish-git.sh /path/to/repo   # custom checkout
#   MARKETPLACE_REPO=/path bash claude-plugin/scripts/publish-git.sh
#   NO_PUSH=1 bash claude-plugin/scripts/publish-git.sh       # commit, don't push
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../claude-plugin-marketplace}}"
if [ ! -d "$DEST/.git" ]; then
	echo "error: '$DEST' is not a git checkout." >&2
	echo "       Clone the independent repo first:" >&2
	echo "         git clone <claude-plugin-marketplace remote> \"$DEST\"" >&2
	exit 1
fi
DEST="$(cd "$DEST" && pwd)"

publish_build
publish_sync "$DEST"

cd "$DEST"
# Publish exactly what rsync placed on disk. Neutralize the user's MACHINE-GLOBAL
# gitignore (core.excludesFile, e.g. ~/.gitignore_global) for this add — it may
# ignore files the plugin legitimately ships (e.g. SKILL.md) and would silently
# drop them from the release. The marketplace repo's OWN .gitignore is still honored.
git -c core.excludesFile=/dev/null add -A
if git -c core.excludesFile=/dev/null diff --cached --quiet; then
	echo "==> Nothing changed — target already up to date."
	exit 0
fi

VERSION="$(publish_version)"

# Version-bump guard: we're past the `diff --cached --quiet` check, so content
# DID change. Claude Code's `/plugin update` compares plugin.json version — so
# re-publishing changed bytes under an unchanged version leaves installed users
# on "up to date" and they never pull the fix. Refuse when the version equals the
# last published release. (First publish / non-release last commit falls through:
# the prefix doesn't strip, so LAST_MSG == LAST_VERSION and the guard is skipped.)
# Override a deliberate same-version republish with JOLLI_PUBLISH_FORCE=1.
LAST_MSG="$(git log -1 --format=%s 2>/dev/null || true)"
LAST_VERSION="${LAST_MSG#release: jolli plugin }"
if [ "${JOLLI_PUBLISH_FORCE:-0}" != "1" ] && [ "$LAST_MSG" != "$LAST_VERSION" ] && [ "$LAST_VERSION" = "$VERSION" ]; then
	# `publish_sync` already ran `rsync --delete` + `git add -A`, so the checkout is
	# dirty. Forgetting the version bump is the common trip (production publish
	# always bumps first), so restore the artifact to HEAD before aborting rather
	# than leaving the user to `git checkout .` themselves. Safe because the
	# marketplace repo is a generated artifact, never hand-edited.
	git reset -q --hard HEAD
	git -c core.excludesFile=/dev/null clean -fdq
	echo "error: content changed but plugin.json version is still ${VERSION} (== last published)." >&2
	echo "       Claude Code /plugin update compares versions, so users would never" >&2
	echo "       see this update. Bump 'version' in" >&2
	echo "       claude-plugin/plugins/jolli/.claude-plugin/plugin.json first." >&2
	echo "       (Deliberate same-version republish? re-run with JOLLI_PUBLISH_FORCE=1.)" >&2
	echo "       (The synced changes were reverted — the checkout is back at HEAD.)" >&2
	exit 1
fi

# Guard against the marketplace repo's own .gitignore silently dropping dist/
# from the commit (the `git add` above honors it) — a bundle-less plugin blocks
# every installing user's commits. Runs only once we're certain we'll commit.
publish_assert_dist_staged "$DEST"

git commit -s -m "release: jolli plugin ${VERSION}"

if [ "${NO_PUSH:-0}" = "1" ]; then
	echo "==> NO_PUSH set — committed but not pushed."
else
	echo "==> Pushing"
	git push
fi

echo ""
echo "Published jolli ${VERSION}. Colleagues install with:"
echo "  /plugin marketplace add <owner>/claude-plugin-marketplace"
echo "  /plugin install jolli@jolli-marketplace"
