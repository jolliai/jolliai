#!/usr/bin/env bash
#
# Shared helpers for publish-local.sh / publish-git.sh. SOURCED, not executed.
#
# Keeping build + rsync (and the exclusion list) here keeps local and prod in
# lockstep — a divergence would make "works when I tested it locally" differ
# from what colleagues actually install from GitHub.
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
# lockstep with that build's entryPoints.
PUBLISH_REQUIRED_DIST=(
	Cli.js StopHook.js SessionStartHook.js
	PostCommitHook.js PostMergeHook.js PostRewriteHook.js PrepareMsgHook.js PrePushHook.js
	QueueWorker.js PrePushWorker.js
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
publish_assert_dist_staged() {
	local dest="$1" missing=() f
	for f in "${PUBLISH_REQUIRED_DIST[@]}"; do
		[ -n "$(git -C "$dest" ls-files -- "plugins/jolli/dist/$f")" ] || missing+=("$f")
	done
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: dist/ file(s) not staged for commit: ${missing[*]}" >&2
		echo "       The marketplace repo's .gitignore is likely ignoring dist/." >&2
		echo "       Remove that rule (the plugin MUST ship dist/) and re-run." >&2
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
		--exclude '.DS_Store' \
		"$SRC"/ "$dest"/
}

publish_version() {
	# Pass the path on argv rather than interpolating it into the JS source, so a
	# repo path containing a quote or backslash can't corrupt the expression.
	node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$PLUGIN_DIR/.claude-plugin/plugin.json"
}
