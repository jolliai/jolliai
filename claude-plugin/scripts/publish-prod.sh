#!/usr/bin/env bash
#
# PROD publish — build the plugin and publish it into the PUBLIC community-
# marketplace sync-source repo (jolliai/jolli-claude-plugin, cloned at
# ../jolli-claude-plugin) that end users add with
# `/plugin marketplace add jolliai/jolli-claude-plugin`, then commit + push.
#
# This is the public release target. Identical flow to publish-dev.sh — the ONLY
# difference is the default target repo (dev points at the private/internal
# ../claude-plugin-marketplace dry-run checkout). For a no-git local test dir use
# publish-local.sh; for a desktop-app zip use publish-zip.sh. The shared
# build → mirror → commit → push flow lives in _publish-lib.sh's publish_git_repo().
#
# The marketplace repo is a pure release artifact generated from this monorepo's
# claude-plugin/ tree — never hand-edited. Source of truth:
#   claude-plugin/.claude-plugin/marketplace.json   (marketplace manifest)
#   claude-plugin/README.md                         (marketplace README)
#   claude-plugin/plugins/jolli/**                  (the plugin, incl. built dist/)
# The target's own root LICENSE is preserved (see publish_sync's LICENSE exclude).
#
# Reminder: a prod release must bump `version` in
# claude-plugin/plugins/jolli/.claude-plugin/plugin.json first — the version guard
# refuses a same-version republish (Claude Code /plugin update compares versions).
#
# Usage:
#   bash claude-plugin/scripts/publish-prod.sh                 # -> ../jolli-claude-plugin
#   bash claude-plugin/scripts/publish-prod.sh /path/to/repo   # custom checkout
#   MARKETPLACE_REPO=/path bash claude-plugin/scripts/publish-prod.sh
#   NO_PUSH=1 bash claude-plugin/scripts/publish-prod.sh       # commit, don't push
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_publish-lib.sh"

DEST="${MARKETPLACE_REPO:-${1:-$MONOREPO/../jolli-claude-plugin}}"
publish_git_repo "$DEST"
