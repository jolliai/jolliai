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
# The dashboard assets are listed FILE BY FILE, not by their index.html alone:
# `assembleDashboardHtml` reads the stylesheet and every entry of its SCRIPT_FILES
# at request time, so a marketplace-repo .gitignore matching `js/` or `*.css`
# passed this gate and produced a 500 on the first `jolli dashboard` (this repo has
# already lost a SKILL.md to exactly that). Keep in lockstep — same order — with
# DASHBOARD_SCRIPT_FILES in cli/src/dashboard/DashboardServer.ts; a drift either way
# fails PluginDashboardAssets.test.ts rather than waiting for release time. Both
# directions matter: a script listed here that the build no longer emits makes
# `publish_assert_dist_built` refuse EVERY publish (local/dev/prod/zip alike), and a
# script the server loads but this list omits is exactly the silent-dropout case
# above — this list had already drifted three files behind that way (knowledge.js,
# graph.js, settings.js) while the comment claimed each was asserted.
PUBLISH_REQUIRED_DIST=(
	Cli.js PluginBootstrapHook.js StopHook.js SessionStartHook.js
	PostCommitHook.js PostMergeHook.js PostRewriteHook.js PrepareMsgHook.js PrePushHook.js
	QueueWorker.js PrePushWorker.js
	dashboard-assets/index.html
	dashboard-assets/styles/main.css
	dashboard-assets/js/format.js
	dashboard-assets/js/charts.js
	dashboard-assets/js/shell.js
	dashboard-assets/js/stats.js
	dashboard-assets/js/standup.js
	dashboard-assets/js/memories.js
	dashboard-assets/js/knowledge.js
	dashboard-assets/js/graph.js
	dashboard-assets/js/settings.js
	dashboard-assets/js/main.js
)

# Skills the plugin ships (must match plugins/jolli/skills/ exactly). Used for
# the exact-count staging assertion so a partial skill loss is caught.
PUBLISH_EXPECTED_SKILLS=(push recall search)

# Commands the plugin ships (same exact-count pattern as skills — a repo-local
# .gitignore silently dropping one file leaves the count >0 but wrong; the exact
# count catches it). The plugin ships no subagents.
PUBLISH_EXPECTED_COMMANDS=(init login logout status timeline)

# Critical singleton config files that MUST be staged. A repo-local .gitignore
# rule (e.g. `*.json`) could silently drop any of these while the dist check
# passes — shipping a plugin with no MCP server registration (10 tools gone),
# no git-hook bootstrap, or no version metadata.
#
# The bundle redistributes Apache-2.0 code, so the license text has to travel with
# it — and it is listed TWICE because two different units are distributed:
#   LICENSE                    the marketplace repo root, which is what a reader of
#                              the GitHub page (and `marketplace add`) receives
#   plugins/jolli/LICENSE      the INSTALLED unit — `/plugin install` and the
#                              desktop "Upload plugin" zip carry only this directory
#                              (publish-zip.sh packs `plugins/jolli/` alone), so a
#                              root-only copy never reaches an installed plugin
# Both are verbatim copies of the monorepo root LICENSE, mirrored from this tree.
PUBLISH_REQUIRED_CONFIG=(
	plugins/jolli/.mcp.json
	plugins/jolli/hooks/hooks.json
	plugins/jolli/.claude-plugin/plugin.json
	LICENSE
	plugins/jolli/LICENSE
)

# The neutral token the SOURCE README carries wherever it names the marketplace to
# add. Each publish target resolves it to something different — the public release
# repo, the dev dry-run repo, a local directory — so the monorepo copy cannot name
# any one of them. (The dev mirror used to ship the PROD slug, telling dry-run
# readers to install the public release.) Mirrors codex-plugin's mechanism.
README_SOURCE_PLACEHOLDER='<marketplace-source>'

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
# Also asserts that skills, commands, and critical config files are staged: a
# repo-local .gitignore rule (e.g. `SKILL.md` or `*.json`) could silently drop
# them while the dist-only check passes.
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
	# Assert the commands directory has the exact expected staged count
	# (same exact-count pattern as skills — a partial gitignore drop is caught).
	local cmd_count
	cmd_count="$(git -C "$dest" ls-files -- 'plugins/jolli/commands/*' | wc -l | tr -d ' ')"
	[ "$cmd_count" -eq "${#PUBLISH_EXPECTED_COMMANDS[@]}" ] || missing+=("commands/* (expected ${#PUBLISH_EXPECTED_COMMANDS[@]}, found $cmd_count)")
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: required file(s) not staged for commit: ${missing[*]}" >&2
		echo "       The marketplace repo's .gitignore is likely ignoring them." >&2
		echo "       Remove that rule (the plugin MUST ship dist/ + skills/ + commands/ + configs) and re-run." >&2
		echo "       If you added or removed a command or skill, update" >&2
		echo "       PUBLISH_EXPECTED_{COMMANDS,SKILLS} in _publish-lib.sh." >&2
		return 1
	fi
}

# publish_assert_config_present — every PUBLISH_REQUIRED_CONFIG file exists and is
# non-empty in the SOURCE tree.
#
# The dest-side twin (`publish_assert_dist_staged`) only runs on the git-repo
# publish, because only that path stages anything. The archive and local-install
# paths pack / mirror straight from disk and so were gated on dist completeness
# alone — a tree missing either LICENSE copy produced a zip and a local
# marketplace with no license text and printed nothing. Checked against the source
# so the error names a path the developer can fix.
publish_assert_config_present() {
	local missing=() f
	for f in "${PUBLISH_REQUIRED_CONFIG[@]}"; do
		[ -s "$SRC/$f" ] || missing+=("$f")
	done
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: required plugin file(s) missing or empty: ${missing[*]}" >&2
		echo "       The plugin MUST ship its manifest, hooks, MCP registration and LICENSE." >&2
		return 1
	fi
}

publish_build() {
	echo "==> Building dist/ (bundles current cli/src) ..."
	node "$PLUGIN_DIR/scripts/build.mjs"
	publish_assert_dist_built
	publish_assert_config_present
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
#
# LICENSE is deliberately NOT excluded (it was, until this tree grew its own copy).
# The old arrangement let the PROD repo's hand-created root LICENSE survive
# `--delete` — but it also meant the dev marketplace repo, which was never created
# with one, shipped an Apache-2.0 plugin with no license text, and no copy could ever
# reach the desktop zip. Mirroring our own copies makes the monorepo the single
# source of truth for every target; the prod repo's existing file is byte-identical,
# so this overwrites it with itself. Re-adding the exclude would fail the staged
# check (rsync --delete removes the file, `git add -A` stages the deletion, and
# `git ls-files` then reports nothing) — that is the gate working, and the fix is to
# drop the exclude again, not to drop the inventory entries.
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

# publish_readme_source <dest-dir> <marketplace-source> — resolve the README's
# marketplace name on the MIRRORED copy, so each target names the marketplace its
# readers can actually add.
#
# Run after publish_sync (which would overwrite it) and before the commit, so the
# resolved text is what lands in the target repo. The source README keeps the
# neutral placeholder; publish-zip.sh needs no call because it packs only
# plugins/jolli/ and ships no README at all.
#
# The placeholder MUST be present. Shipping the literal `<marketplace-source>`
# gives users a command that cannot work, and README.md is not even in
# PUBLISH_REQUIRED_CONFIG — so nothing else here would notice a README edit that
# drops, renames or duplicates the token.
publish_readme_source() {
	local dest="$1" source_ref="$2" readme="$1/README.md"
	[ -n "$source_ref" ] || { echo "error: publish_readme_source needs a marketplace source" >&2; return 1; }
	[ -s "$readme" ] || { echo "error: mirrored README is missing or empty: '$readme'" >&2; return 1; }
	if ! grep -Fq "$README_SOURCE_PLACEHOLDER" "$readme"; then
		echo "error: '$readme' has no ${README_SOURCE_PLACEHOLDER} placeholder to resolve." >&2
		echo "       claude-plugin/README.md must keep it wherever it names the marketplace," >&2
		echo "       so each publish target can name its own." >&2
		return 1
	fi
	# Literal index-based replacement, not sed: the value is a slug or an absolute
	# path, and both `/` (delimiter) and `&` (backreference) would need escaping in a
	# sed replacement. awk's substr arithmetic treats it as plain text.
	awk -v ph="$README_SOURCE_PLACEHOLDER" -v val="$source_ref" '
		{ i = index($0, ph); if (i > 0) $0 = substr($0, 1, i - 1) val substr($0, i + length(ph)); print }
	' "$readme" > "$readme.tmp" && mv "$readme.tmp" "$readme"
	# One replacement per line above, so a second occurrence on the SAME line would
	# survive silently. Assert the token is gone rather than trust the loop-free form.
	if grep -Fq "$README_SOURCE_PLACEHOLDER" "$readme"; then
		echo "error: '$readme' still contains ${README_SOURCE_PLACEHOLDER} after rewriting." >&2
		echo "       Keep the placeholder to a single occurrence per line." >&2
		return 1
	fi
	echo "==> README marketplace source -> ${source_ref}"
}

publish_version() {
	# Pass the path on argv rather than interpolating it into the JS source, so a
	# repo path containing a quote or backslash can't corrupt the expression.
	node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$PLUGIN_DIR/.claude-plugin/plugin.json"
}

# publish_version_gt <candidate> <baseline> — is <candidate> a strictly HIGHER
# x.y.z than <baseline>?
#
# Compared component-by-component rather than with `sort -V`, whose availability
# differs between GNU and BSD userlands, and never as strings: "1.0.10" sorts BELOW
# "1.0.9" lexically, which would refuse a legitimate release.
#
# Anything that is not three plain numbers (a prerelease suffix, an empty string)
# answers "not greater". That is the safe direction: the publish stops and the
# operator decides with JOLLI_PUBLISH_FORCE=1, instead of a comparison this function
# cannot actually make being read as approval.
publish_version_gt() {
	local a="$1" b="$2" i av bv
	# Exactly three numeric components, matched whole — NOT a character-class
	# check. Rejecting only non-`[0-9.]` characters is what the first version of
	# this did, and it let five malformed shapes clear the release gate, all
	# measured: `1.0` and `1.0.` (a missing component read as empty, then padded
	# to 0), `1..2` and `.1.2` (an empty component padded the same way), and
	# `1.0.2.1` (a fourth component is never read, so it compares as `1.0.2`).
	# Each was accepted against a lower baseline, so a typo'd plugin.json version
	# could commit and push a prod release without JOLLI_PUBLISH_FORCE.
	#
	# The `${av:-0}` defaults that padding relied on are gone with it: after this
	# match every component is guaranteed to be one or more digits, so a default
	# could only ever mask a shape this function has already refused.
	#
	# The pattern is held in a variable because bash treats a QUOTED right-hand
	# side of `=~` as a literal string; assigning it first is the form that works
	# the same way from bash 3.2 (macOS /bin/bash) up.
	local semver='^[0-9]+\.[0-9]+\.[0-9]+$'
	[[ $a =~ $semver ]] || return 1
	[[ $b =~ $semver ]] || return 1
	for i in 1 2 3; do
		av="$(printf '%s' "$a" | cut -d. -f"$i")"
		bv="$(printf '%s' "$b" | cut -d. -f"$i")"
		if [ "$av" -gt "$bv" ]; then return 0; fi
		if [ "$av" -lt "$bv" ]; then return 1; fi
	done
	return 1
}

# publish_git_repo <dest> <marketplace-source> [target-kind] — build the plugin,
# mirror it into the marketplace git checkout <dest>, then commit + push. This is the
# entire git-publish FLOW, shared by publish-dev.sh (private/internal dry-run repo)
# and publish-prod.sh (public community-marketplace sync source).
#
# The marketplace repo is a pure release artifact generated from claude-plugin/ —
# never hand-edited. Honors:
#   NO_PUSH=1               commit but don't push
#   JOLLI_PUBLISH_FORCE=1   allow a same-version or downgrade republish on a prod
#                           target (skips the version guard)
#
# <marketplace-source> is the `owner/repo` slug readers of THIS target's README will
# type into `/plugin marketplace add`. Passed in rather than derived from the
# checkout's `origin`: the README is written before the push, so a mistyped
# destination path should not silently produce a README documenting whichever repo
# the wrong checkout happens to point at.
#
# <target-kind> is `prod` (default) or `dev`, and it gates ONE thing: the version
# guard. Everything else — build, inventory assertions, mirror, README resolution,
# staged-completeness check, signed commit, push — is identical, which is what makes
# a dev run a rehearsal of the prod run.
#
# Why dev opts out: a rehearsal republishes the SAME build repeatedly, and the guard
# demands a strictly higher version every time content changes. Bumping per rehearsal
# is how the dev marketplace reached 1.0.5 while prod was still on 1.0.1 — at which
# point the guard started refusing legitimate releases on the rehearsal target, i.e.
# the version inflation caused the problem the guard exists to prevent. A version
# number is a RELEASE decision; dev is not a release.
#
# What that costs, and it is real: an installed tester's `/plugin update` compares
# versions, so a same-version dev republish reports "up to date" and they keep running
# the old bundle. Re-add the plugin instead of updating it (the reminder below says
# so). And a green dev run no longer proves prod will accept the version — prod has
# its own history, so check it there.
#
# Defaults to `prod` on purpose: a new call site that forgets the argument gets the
# STRICTER behavior, not a silently unguarded publish.
publish_git_repo() {
	local dest="$1" marketplace_source="$2" target_kind="${3:-prod}"
	if [ ! -d "$dest/.git" ]; then
		echo "error: '$dest' is not a git checkout." >&2
		echo "       Clone the marketplace repo first:" >&2
		echo "         git clone <marketplace remote> \"$dest\"" >&2
		return 1
	fi
	dest="$(cd "$dest" && pwd)"

	publish_build
	publish_sync "$dest"
	publish_readme_source "$dest" "$marketplace_source"

	cd "$dest"
	# Publish exactly what rsync placed on disk. Neutralize the user's MACHINE-GLOBAL
	# gitignore (core.excludesFile, e.g. ~/.gitignore_global) for this add — it may
	# ignore files the plugin legitimately ships (e.g. SKILL.md) and would silently
	# drop them from the release. The marketplace repo's OWN .gitignore is still honored.
	git -c core.excludesFile=/dev/null add -A
	if git -c core.excludesFile=/dev/null diff --cached --quiet; then
		echo "==> Nothing changed — target already up to date."
		# "Nothing to COMMIT" is not proof the release is complete. A destination
		# .gitignore matching a required file keeps it out of the index, so `add -A`
		# stages nothing and the diff is empty — which reads as "already up to date"
		# while the published tree is missing that file. The assertion reads the index,
		# which after a commit still reflects the tracked tree, so it is meaningful
		# here; running it BEFORE the exit is the whole point.
		publish_assert_dist_staged "$dest"
		return 0
	fi

	local version last_msg last_version release_subject
	release_subject="release: jolli plugin "
	version="$(publish_version)"

	# Version-bump guard, prod only: we're past the `diff --cached --quiet` check, so
	# content DID change. Claude Code's `/plugin update` compares plugin.json version —
	# so publishing changed bytes under a version that is not HIGHER than the last
	# release leaves installed users on "up to date" and they never pull the fix.
	#
	# The check used to be `last_version = version`, i.e. equal-only. That let the
	# worse case straight through: this monorepo's source sat at 1.0.0 while the prod
	# marketplace had already published 1.0.1, so a publish from main would have
	# shipped a silent DOWNGRADE — no error anywhere, and every installed user pinned
	# to a newer version than the one being released. Strictly-greater is the actual
	# invariant `/plugin update` needs.
	#
	# The baseline is the last RELEASE commit, found with --grep rather than read off
	# the tip. The tip-and-strip form this replaced disabled the guard entirely
	# whenever the destination's last commit was not a release commit (a README fix,
	# a merge): the prefix didn't strip, the `last_msg != last_version` sanity test
	# went false, and the whole `&&` chain short-circuited into a green downgrade.
	# A first publish has no baseline and says so. Override a deliberate same-version
	# or downgrade republish with JOLLI_PUBLISH_FORCE=1.
	if [ "$target_kind" = "prod" ]; then
		last_msg="$(git log -1 --format=%s --grep="^${release_subject}" 2>/dev/null || true)"
		last_version="${last_msg#"$release_subject"}"
		if [ -z "$last_msg" ]; then
			echo "==> No previous release commit on the target — version guard has no baseline."
		elif [ "${JOLLI_PUBLISH_FORCE:-0}" != "1" ] &&
			! publish_version_gt "$version" "$last_version"; then
			# `publish_sync` already ran `rsync --delete` + `git add -A`, so the checkout is
			# dirty. Forgetting the version bump is the common trip (production publish
			# always bumps first), so restore the artifact to HEAD before aborting rather
			# than leaving the user to `git checkout .` themselves. Safe because the
			# marketplace repo is a generated artifact, never hand-edited.
			git reset -q --hard HEAD
			git -c core.excludesFile=/dev/null clean -fdq
			echo "error: content changed but plugin.json version ${version} is not higher than" >&2
			echo "       the last published release (${last_version})." >&2
			echo "       Both must be exactly three numeric components (e.g. 1.0.2); any other" >&2
			echo "       shape fails this check rather than being padded or truncated." >&2
			echo "       Claude Code /plugin update compares versions, so users would never" >&2
			echo "       see this update. Bump 'version' in" >&2
			echo "       claude-plugin/plugins/jolli/.claude-plugin/plugin.json first." >&2
			echo "       (Deliberate same-version or downgrade republish? re-run with" >&2
			echo "       JOLLI_PUBLISH_FORCE=1.)" >&2
			echo "       (The synced changes were reverted — the checkout is back at HEAD.)" >&2
			return 1
		fi
	else
		# Printed, never silent: this is the one behavioural difference between the
		# rehearsal and the release, so it has to be visible in the rehearsal's output.
		echo "==> ${target_kind} target — version guard skipped (rehearsals republish one version)."
		echo "    Testers: REMOVE + re-add the plugin. /plugin update compares versions and"
		echo "    will report 'up to date' for a same-version republish."
	fi

	# Guard against the marketplace repo's own .gitignore silently dropping dist/
	# from the commit (the `git add` above honors it) — a bundle-less plugin blocks
	# every installing user's commits. Runs only once we're certain we'll commit.
	publish_assert_dist_staged "$dest"

	# Same `release_subject` the guard greps for — a literal here could drift from the
	# pattern and leave every future run without a baseline.
	git commit -s -m "${release_subject}${version}"

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
