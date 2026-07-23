#!/usr/bin/env bash
#
# Shared helpers for publish-local.sh / publish-dev.sh / publish-prod.sh.
# SOURCED, not executed.
#
# Keeping build + rsync (and the exclusion list) here keeps local, dev, and prod
# in lockstep — a divergence would make "works when I tested it locally" differ
# from what colleagues actually install from GitHub. The git publish FLOW itself
# (build → mirror → commit → push) also lives here, in publish_git_repo(), so the
# only thing that separates dev from prod is their default destination repo.
#
# Why rsync (not `git archive`): dist/ is a build product that is gitignored in
# this monorepo, so a tracked-files-only export can't carry it. rsync mirrors
# the tree on disk and deletes stale files in the target (--delete).

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$_LIB_DIR/.." && pwd)"            # claude-plugin/  (marketplace source of truth)
MONOREPO="$(cd "$SRC/.." && pwd)"            # jolliai/  (repo root)
PLUGIN_DIR="$SRC/plugins/jolli"

# Files build.mjs MUST emit for the plugin to function. A dist missing any of
# these does NOT degrade gracefully: the git hooks resolve back to `node
# <dist>/<Hook>.js` at commit time, so a missing hook/worker BLOCKS the
# installing user's commit (see plugins/jolli/scripts/build.mjs header). Kept in
# lockstep with that build's entryPoints AND with publish-zip.sh's REQUIRED_DIST.
PUBLISH_REQUIRED_DIST=(
	Cli.js PluginBootstrapHook.js StopHook.js SessionStartHook.js
	PostCommitHook.js PostMergeHook.js PostRewriteHook.js PrepareMsgHook.js PrePushHook.js
	QueueWorker.js PrePushWorker.js
)

# Skills the plugin ships (must match plugins/jolli/skills/ exactly). Used for
# the exact-count staging assertion so a partial skill loss is caught.
PUBLISH_EXPECTED_SKILLS=(push recall search)

# Commands and agents the plugin ships (same exact-count pattern as skills —
# a repo-local .gitignore silently dropping one file leaves the count >0 but
# wrong; the exact count catches it).
PUBLISH_EXPECTED_COMMANDS=(init login logout status timeline)
PUBLISH_EXPECTED_AGENTS=(pr-writer)

# Critical singleton config files that MUST be staged. A repo-local .gitignore
# rule (e.g. `*.json`) could silently drop any of these while the dist check
# passes — shipping a plugin with no MCP server registration (10 tools gone),
# no git-hook bootstrap, or no version metadata.
PUBLISH_REQUIRED_CONFIG=(
	plugins/jolli/.mcp.json
	plugins/jolli/hooks/hooks.json
	plugins/jolli/.claude-plugin/plugin.json
)

# publish_assert_dist_built — every required dist file exists and is non-empty on
# disk. Run right after the build so an incomplete bundle fails the publish here
# instead of shipping a commit-breaking plugin to colleagues.
publish_assert_dist_built() {
	local missing=() f
	for f in "${PUBLISH_REQUIRED_DIST[@]}"; do
		[ -s "$PLUGIN_DIR/dist/$f" ] || missing+=("$f")
	done
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: build produced an incomplete dist/ — missing: ${missing[*]}" >&2
		echo "       A plugin missing any git-hook/worker script blocks user commits." >&2
		return 1
	fi
}

# publish_assert_dist_staged <dest> — confirm every required dist file is in the
# index (will be part of the commit's tree). We only neutralize the user's
# MACHINE-GLOBAL excludesFile for the `git add`; the marketplace repo's OWN
# .gitignore is still honored, so a stray `dist/` rule there would silently drop
# the whole bundle from the commit and ship a broken plugin. `git ls-files`
# reflects the post-`add` index (and, unlike `diff --cached`, still passes on a
# re-publish where dist didn't change but is already tracked).
#
# Also asserts that skills, commands, agents, and critical config files are
# staged: a repo-local .gitignore rule (e.g. `SKILL.md` or `*.json`) could
# silently drop them while the dist-only check passes.
publish_assert_dist_staged() {
	local dest="$1" missing=() f
	for f in "${PUBLISH_REQUIRED_DIST[@]}"; do
		[ -n "$(git -C "$dest" ls-files -- "plugins/jolli/dist/$f")" ] || missing+=("dist/$f")
	done
	# Assert critical config singletons are staged (.mcp.json, hooks.json, plugin.json).
	for f in "${PUBLISH_REQUIRED_CONFIG[@]}"; do
		[ -n "$(git -C "$dest" ls-files -- "$f")" ] || missing+=("$f")
	done
	# Assert the EXACT expected skill count is staged (partial loss is a bug).
	local skill_count
	skill_count="$(git -C "$dest" ls-files -- 'plugins/jolli/skills/*/SKILL.md' | wc -l | tr -d ' ')"
	[ "$skill_count" -eq "${#PUBLISH_EXPECTED_SKILLS[@]}" ] || missing+=("skills/*/SKILL.md (expected ${#PUBLISH_EXPECTED_SKILLS[@]}, found $skill_count)")
	# Assert commands and agents directories have the exact expected staged count
	# (same exact-count pattern as skills — a partial gitignore drop is caught).
	local cmd_count
	cmd_count="$(git -C "$dest" ls-files -- 'plugins/jolli/commands/*' | wc -l | tr -d ' ')"
	[ "$cmd_count" -eq "${#PUBLISH_EXPECTED_COMMANDS[@]}" ] || missing+=("commands/* (expected ${#PUBLISH_EXPECTED_COMMANDS[@]}, found $cmd_count)")
	local agent_count
	agent_count="$(git -C "$dest" ls-files -- 'plugins/jolli/agents/*' | wc -l | tr -d ' ')"
	[ "$agent_count" -eq "${#PUBLISH_EXPECTED_AGENTS[@]}" ] || missing+=("agents/* (expected ${#PUBLISH_EXPECTED_AGENTS[@]}, found $agent_count)")
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: required file(s) not staged for commit: ${missing[*]}" >&2
		echo "       The marketplace repo's .gitignore is likely ignoring them." >&2
		echo "       Remove that rule (the plugin MUST ship dist/ + skills/ + commands/ + agents/ + configs) and re-run." >&2
		echo "       If you added or removed a command, agent, or skill, update" >&2
		echo "       PUBLISH_EXPECTED_{COMMANDS,AGENTS,SKILLS} in _publish-lib.sh." >&2
		return 1
	fi
}

publish_build() {
	echo "==> Building dist/ (bundles current cli/src) ..."
	node "$PLUGIN_DIR/scripts/build.mjs"
	publish_assert_dist_built
}

# publish_assert_safe_dest <dest-dir> — refuse to `rsync --delete` into a
# directory that is neither empty nor an existing marketplace checkout. Without
# this guard a stray path argument (e.g. `publish-local.sh ~/Documents`, or a
# MARKETPLACE_REPO pointed at an unrelated clone) would let --delete silently
# wipe every file in it that isn't part of the plugin tree. Safe targets:
#   - already a marketplace checkout (has .claude-plugin/marketplace.json), or
#   - empty apart from a `.git` dir (a fresh clone we're about to populate).
# Override for a deliberate first-time re-target with JOLLI_PUBLISH_FORCE=1.
publish_assert_safe_dest() {
	local dest="$1"
	[ "${JOLLI_PUBLISH_FORCE:-0}" = "1" ] && return 0
	[ -e "$dest/.claude-plugin/marketplace.json" ] && return 0
	local extra
	extra="$(ls -A "$dest" 2>/dev/null | grep -vxF '.git' || true)"
	[ -z "$extra" ] && return 0
	echo "error: refusing to mirror into '$dest' with rsync --delete." >&2
	echo "       It is neither empty nor an existing marketplace checkout" >&2
	echo "       (no .claude-plugin/marketplace.json), so --delete could wipe" >&2
	echo "       unrelated files. Point at the right destination, clear it, or —" >&2
	echo "       if this really is your marketplace target — re-run with" >&2
	echo "       JOLLI_PUBLISH_FORCE=1." >&2
	return 1
}

# publish_sync <dest-dir> — mirror the CONTENTS of claude-plugin/ into <dest-dir>/.
# Exclusions:
#   .git/          never touch the target's own git dir (also guards --delete)
#   scripts/       dev-only tooling (this lib, publish-*.sh, build.mjs), don't ship
#   .gitignore     the plugin's .gitignore hides dist/ — we WANT dist/ published
#   DEVELOPMENT.md monorepo-internal docs, not for distribution
#   docs/          internal ops guides (e.g. MARKETPLACE_SUBMISSION.md, which names
#                  the private marketplace repo) — governance detail, not for the
#                  public marketplace product
#   LICENSE        the marketplace repo carries its OWN root LICENSE; claude-plugin/
#                  has none (it lives at the monorepo root, linked as ../LICENSE),
#                  so WITHOUT this exclude `--delete` would wipe the target's LICENSE
#   .DS_Store      macOS cruft
publish_sync() {
	local dest="$1"
	command -v rsync >/dev/null 2>&1 || { echo "error: 'rsync' not found on PATH" >&2; return 1; }
	publish_assert_safe_dest "$dest" || return 1
	echo "==> Mirroring $SRC/ -> $dest/"
	rsync -a --delete \
		--exclude '.git/' \
		--exclude 'scripts/' \
		--exclude '.gitignore' \
		--exclude 'DEVELOPMENT.md' \
		--exclude 'docs/' \
		--exclude 'LICENSE' \
		--exclude '.DS_Store' \
		"$SRC"/ "$dest"/
}

publish_version() {
	# Pass the path on argv rather than interpolating it into the JS source, so a
	# repo path containing a quote or backslash can't corrupt the expression.
	node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$PLUGIN_DIR/.claude-plugin/plugin.json"
}

# publish_git_repo <dest> — build the plugin, mirror it into the marketplace git
# checkout <dest>, then commit + push. This is the entire git-publish FLOW, shared
# verbatim by publish-dev.sh (private/internal dry-run repo) and publish-prod.sh
# (public community-marketplace sync source) — the two wrappers differ ONLY in the
# default <dest> they pass in, so the release behavior can never drift between them.
#
# The marketplace repo is a pure release artifact generated from claude-plugin/ —
# never hand-edited. Honors:
#   NO_PUSH=1               commit but don't push
#   JOLLI_PUBLISH_FORCE=1   allow a same-version republish (skips the version guard)
publish_git_repo() {
	local dest="$1"
	if [ ! -d "$dest/.git" ]; then
		echo "error: '$dest' is not a git checkout." >&2
		echo "       Clone the marketplace repo first:" >&2
		echo "         git clone <marketplace remote> \"$dest\"" >&2
		return 1
	fi
	dest="$(cd "$dest" && pwd)"

	publish_build
	publish_sync "$dest"

	cd "$dest"
	# Publish exactly what rsync placed on disk. Neutralize the user's MACHINE-GLOBAL
	# gitignore (core.excludesFile, e.g. ~/.gitignore_global) for this add — it may
	# ignore files the plugin legitimately ships (e.g. SKILL.md) and would silently
	# drop them from the release. The marketplace repo's OWN .gitignore is still honored.
	git -c core.excludesFile=/dev/null add -A
	if git -c core.excludesFile=/dev/null diff --cached --quiet; then
		echo "==> Nothing changed — target already up to date."
		return 0
	fi

	local version last_msg last_version
	version="$(publish_version)"

	# Version-bump guard: we're past the `diff --cached --quiet` check, so content
	# DID change. Claude Code's `/plugin update` compares plugin.json version — so
	# re-publishing changed bytes under an unchanged version leaves installed users
	# on "up to date" and they never pull the fix. Refuse when the version equals the
	# last published release. (First publish / non-release last commit falls through:
	# the prefix doesn't strip, so last_msg == last_version and the guard is skipped.)
	# Override a deliberate same-version republish with JOLLI_PUBLISH_FORCE=1.
	last_msg="$(git log -1 --format=%s 2>/dev/null || true)"
	last_version="${last_msg#release: jolli plugin }"
	if [ "${JOLLI_PUBLISH_FORCE:-0}" != "1" ] && [ "$last_msg" != "$last_version" ] && [ "$last_version" = "$version" ]; then
		# `publish_sync` already ran `rsync --delete` + `git add -A`, so the checkout is
		# dirty. Forgetting the version bump is the common trip (production publish
		# always bumps first), so restore the artifact to HEAD before aborting rather
		# than leaving the user to `git checkout .` themselves. Safe because the
		# marketplace repo is a generated artifact, never hand-edited.
		git reset -q --hard HEAD
		git -c core.excludesFile=/dev/null clean -fdq
		echo "error: content changed but plugin.json version is still ${version} (== last published)." >&2
		echo "       Claude Code /plugin update compares versions, so users would never" >&2
		echo "       see this update. Bump 'version' in" >&2
		echo "       claude-plugin/plugins/jolli/.claude-plugin/plugin.json first." >&2
		echo "       (Deliberate same-version republish? re-run with JOLLI_PUBLISH_FORCE=1.)" >&2
		echo "       (The synced changes were reverted — the checkout is back at HEAD.)" >&2
		return 1
	fi

	# Guard against the marketplace repo's own .gitignore silently dropping dist/
	# from the commit (the `git add` above honors it) — a bundle-less plugin blocks
	# every installing user's commits. Runs only once we're certain we'll commit.
	publish_assert_dist_staged "$dest"

	git commit -s -m "release: jolli plugin ${version}"

	if [ "${NO_PUSH:-0}" = "1" ]; then
		echo "==> NO_PUSH set — committed but not pushed."
	else
		echo "==> Pushing"
		git push
	fi

	# Print the ACTUAL install command by deriving owner/repo from the target's
	# origin remote (works for both git@ and https:// forms), so dev and prod each
	# advertise their own slug instead of a hardcoded one.
	local slug
	slug="$(git remote get-url origin 2>/dev/null | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' || true)"
	[ -n "$slug" ] || slug="<owner>/<marketplace-repo>"
	echo ""
	echo "Published jolli ${version}. Install with:"
	echo "  /plugin marketplace add ${slug}"
	echo "  /plugin install jolli@jolli-marketplace"
}
