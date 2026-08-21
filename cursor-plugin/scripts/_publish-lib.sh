#!/usr/bin/env bash
#
# Shared helpers for the Cursor plugin's publish scripts. SOURCED, not executed.
#
# Sibling of codex-plugin/scripts/_publish-lib.sh. Kept as its own file rather
# than parameterizing that one: the two differ in manifest path, marketplace path,
# required dist set, and shipped skill list, and a shared script with four host
# switches would be harder to audit than three explicit ones — these run rarely and
# are read carefully when they do.
#
# Why rsync (not `git archive`): dist/ is a build product that is gitignored in
# this monorepo, so a tracked-files-only export cannot carry it. rsync mirrors the
# tree on disk and deletes stale files in the target (--delete).

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$_LIB_DIR/.." && pwd)"            # cursor-plugin/  (marketplace source of truth)
MONOREPO="$(cd "$SRC/.." && pwd)"            # jolliai/  (repo root)
PLUGIN_DIR="$SRC/plugins/jolli"

# Files build.mjs MUST emit for the plugin to function. A dist missing any of
# these does NOT degrade gracefully: the git hooks resolve back to
# `node <dist>/<Hook>.js` at commit time, so a missing hook/worker BLOCKS the
# installing user's commit. StopHook/SessionStartHook are here even though the
# Cursor bootstrap never installs Claude's agent hooks — dist completeness is a
# machine-global contract (DistPathWriter.REQUIRED_RUNTIME_FILES), and a dist that
# wins the version race must be able to serve another host's repo hooks too.
# No McpLauncher.js: unlike Codex, this host's MCP entry is repo-scoped
# (`.cursor/mcp.json`) and needs no per-launch runtime resolution.
# Kept in lockstep with plugins/jolli/scripts/build.mjs entryPoints.
PUBLISH_REQUIRED_DIST=(
	Cli.js CursorPluginBootstrapHook.js StopHook.js SessionStartHook.js
	PostCommitHook.js PostMergeHook.js PostRewriteHook.js PrepareMsgHook.js PrePushHook.js
	QueueWorker.js PrePushWorker.js
	dashboard-assets/index.html
	dashboard-assets/styles/main.css
	dashboard-assets/js/format.js
	dashboard-assets/js/charts.js
	dashboard-assets/js/shell.js
	dashboard-assets/js/stats.js
	dashboard-assets/js/skills.js
	dashboard-assets/js/standup.js
	dashboard-assets/js/memories.js
	dashboard-assets/js/knowledge.js
	dashboard-assets/js/graph.js
	dashboard-assets/js/settings.js
	dashboard-assets/js/main.js
)

# Skills the plugin ships (must match plugins/jolli/skills/ exactly). The EXACT
# count is asserted, not just ">0": a .gitignore rule dropping one file leaves the
# count nonzero but wrong. This repo has already lost a SKILL.md that way once — a
# global gitignore matched it and `git add` reported success.
#
# Mirrors CURSOR_PLUGIN_SKILL_NAMES. These keep the canonical `jolli-` prefix (the
# Codex bundle drops it); see cli/src/install/CursorPluginSkills.ts for why.
#
# TWELVE — every skill this plugin has, `jolli` umbrella included. Cursor reads
# `.agents/skills/` and this bundle into one flat pool and collapses neither, so a repo
# that also ran `jolli enable` shows two entries for the five shared names, differing
# only by a brand icon. That duplicate is ACCEPTED, twice over:
#
#   - the four host-neutral skills (recall, search, local-run, remote-run) were once
#     mirrored per-repo on demand to avoid it, which meant a Cursor-only user — this
#     bundle's whole audience — got no recall and no search at all until they found
#     `/jolli-init`, because the mirror was planted by a bootstrap gated on the repo
#     already being set up;
#   - the `jolli` umbrella was once written machine-global to `~/.cursor/skills/jolli/`
#     by the bootstrap. Measured: a freshly installed plugin's hooks are not registered
#     until Cursor FULLY restarts, so that write did not happen on a new install and the
#     user had every other skill and no front door.
#
# The cost of bundling the umbrella, stated so nobody re-litigates it by accident:
# `~/.cursor/skills/` is in Cursor's always-loaded group while `.cursor/plugins/` is
# gated behind `thirdPartyExtensibilityEnabled` plus a server-side flag, so with a gate
# off the umbrella now goes with the other eleven instead of surviving alone.
PUBLISH_EXPECTED_SKILLS=(
	jolli jolli-dashboard jolli-init jolli-local-run jolli-login jolli-logout
	jolli-push jolli-recall jolli-remote-run jolli-search jolli-status jolli-timeline
)

# Critical singleton config files that MUST be present. A .gitignore rule could
# silently drop any of these while the dist check passes — shipping a plugin with no
# bootstrap hook, or no manifest.
#
# No `mcp.json` here, deliberately: the plugin ships none. A plugin MCP entry
# resolves its relative `cwd` against the plugin root, and the server reads the
# repository it serves off its cwd, so it would answer for the plugin's own cache
# directory. MCP reaches Cursor through the repo-scoped `.cursor/mcp.json` the
# bootstrap writes. See cli/src/install/mcp/HostRegistrars.ts.
#
# The bundle redistributes Apache-2.0 code, so the license text has to travel with
# it — and it is listed TWICE because two different units are distributed:
#   LICENSE                    the marketplace repo root, which is what a reader of
#                              the GitHub page (and a team marketplace) receives
#   plugins/jolli/LICENSE      the INSTALLED unit — an install copies only this
#                              directory (the marketplace cache under
#                              ~/.cursor/plugins/, or ~/.cursor/plugins/local/<name>/
#                              via publish-local.sh, which mirrors plugins/jolli/
#                              alone), so a root-only copy never reaches an
#                              installed plugin
# Both are verbatim copies of the monorepo root LICENSE, mirrored from this tree; the
# same pair is listed in claude-plugin/ and codex-plugin/'s _publish-lib.sh. Do NOT
# add an `--exclude 'LICENSE'` to publish_sync: these entries would then fail the
# staged check (rsync --delete removes the file, `git add -A` stages the deletion),
# which is the gate working — the fix is to drop the exclude, not to drop these lines.
#
# The `assets/` entry backs the top-level `logo` in plugin.json. It is listed here
# because a missing one fails SILENTLY on the host, and on Cursor it fails at a
# distance: a relative `logo` is not read off disk, it is rewritten to
# `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/plugins/jolli/<logo>`
# (measured in Cursor 3.15.x) and fetched at render time — so an unpublished or
# gitignored file is a 404 nobody sees, in a repository that has already lost a
# committed `SKILL.md` to a stray global ignore rule. Both checks below cover it:
# present-and-non-empty in this tree, and actually staged in the mirror.
PUBLISH_REQUIRED_CONFIG=(
	plugins/jolli/hooks/hooks.json
	plugins/jolli/.cursor-plugin/plugin.json
	.cursor-plugin/marketplace.json
	README.md
	LICENSE
	plugins/jolli/LICENSE
	plugins/jolli/assets/logo.svg
)

# The neutral token the SOURCE README carries in its install command. Every publish
# target resolves it to something different — a dev org slug, the public org slug, a
# local directory — so the monorepo copy cannot name any one of them.
README_SOURCE_PLACEHOLDER='<marketplace-source>'

# publish_build — build dist/, then assert it is complete on disk.
publish_build() {
	echo "==> Building dist/ (bundles current cli/src) ..."
	node "$PLUGIN_DIR/scripts/build.mjs"
	publish_assert_dist_built
}

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

# publish_assert_skills — the generated skills are committed static files, so a
# stale or partially-lost skills/ ships wrong instructions rather than failing
# loudly. Checked against the source tree before the mirror, so the error names a
# path the developer can actually fix.
publish_assert_skills() {
	local missing=() name
	for name in "${PUBLISH_EXPECTED_SKILLS[@]}"; do
		[ -s "$PLUGIN_DIR/skills/$name/SKILL.md" ] || missing+=("skills/$name/SKILL.md")
	done
	local found
	found="$(find "$PLUGIN_DIR/skills" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
	if [ "$found" -ne "${#PUBLISH_EXPECTED_SKILLS[@]}" ]; then
		missing+=("skills/*/SKILL.md (expected ${#PUBLISH_EXPECTED_SKILLS[@]}, found $found)")
	fi
	local f
	for f in "${PUBLISH_REQUIRED_CONFIG[@]}"; do
		[ -s "$SRC/$f" ] || missing+=("$f")
	done
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: required plugin file(s) missing or empty: ${missing[*]}" >&2
		echo "       If you added or removed a skill, update PUBLISH_EXPECTED_SKILLS." >&2
		echo "       If a skill is stale, regenerate:" >&2
		echo "         npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts" >&2
		echo "       If a branding asset is missing, commit the real file under" >&2
		echo "         cursor-plugin/plugins/jolli/assets/ — the path comes from the top-level "logo" in plugin.json." >&2
		return 1
	fi

	# Present and non-empty is not the same as CURRENT. The skills are committed static
	# files rendered from builders in cli/src, and publish_build has just rebuilt dist/
	# from that same source — so the combination this must catch is a fresh bundle
	# shipped with stale skill text, which fails no other check here. The drift test
	# that would catch it (CursorPluginSkills.test.ts) runs in CI and `npm run all`, not
	# from these scripts, and publish-prod.sh reaches users irreversibly. So assert it
	# again here, the same way dist completeness is asserted after a successful build.
	command -v npx >/dev/null 2>&1 || {
		echo "error: 'npx' not found on PATH — cannot verify the committed skills are current" >&2
		return 1
	}
	echo "==> Verifying committed skills match their builders ..."
	( cd "$MONOREPO" && npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts --check ) || return 1
}

# publish_assert_safe_dest <dest-dir> — refuse to `rsync --delete` into a directory
# that is neither empty nor an existing marketplace checkout. Without this a stray
# path argument would let --delete wipe every file in it that isn't part of the
# plugin tree. Safe targets: an existing marketplace (has
# .cursor-plugin/marketplace.json), or empty apart from a `.git` dir.
# Override for a deliberate first-time re-target with JOLLI_PUBLISH_FORCE=1.
publish_assert_safe_dest() {
	local dest="$1"
	[ "${JOLLI_PUBLISH_FORCE:-0}" = "1" ] && return 0
	[ -e "$dest/.cursor-plugin/marketplace.json" ] && return 0
	local extra
	extra="$(ls -A "$dest" 2>/dev/null | grep -vxF '.git' || true)"
	[ -z "$extra" ] && return 0
	echo "error: refusing to mirror into '$dest' with rsync --delete." >&2
	echo "       It is neither empty nor an existing marketplace checkout" >&2
	echo "       (no .cursor-plugin/marketplace.json), so --delete could wipe" >&2
	echo "       unrelated files. Point at the right destination, clear it, or —" >&2
	echo "       if this really is your marketplace target — re-run with" >&2
	echo "       JOLLI_PUBLISH_FORCE=1." >&2
	return 1
}

# publish_sync <dest-dir> — mirror the CONTENTS of cursor-plugin/ into <dest-dir>/.
# Excludes the monorepo-only scaffolding a consumer must not receive.
publish_sync() {
	local dest="$1"
	command -v rsync >/dev/null 2>&1 || { echo "error: 'rsync' not found on PATH" >&2; return 1; }
	publish_assert_safe_dest "$dest" || return 1
	echo "==> Mirroring $SRC/ -> $dest/"
	rsync -a --delete \
		--exclude '.git/' \
		--exclude 'scripts/' \
		--exclude 'plugins/jolli/scripts/' \
		--exclude '.gitignore' \
		--exclude 'DEVELOPMENT.md' \
		--exclude 'docs/' \
		--exclude '.DS_Store' \
		"$SRC"/ "$dest"/
}

# publish_readme_source <dest-dir> <marketplace-source> — resolve the README's install
# instructions on the MIRRORED copy, so each target names the marketplace its readers
# can actually add.
#
# Run after publish_sync (which would overwrite it) and before the commit, so the
# resolved text is what lands in the target repo. The source README keeps the neutral
# placeholder: dev and prod are the same repository NAME in two different orgs, so a
# hardcoded slug in the monorepo copy would send half of all readers to the wrong one.
#
# The placeholder MUST be present. Shipping the literal `<marketplace-source>` gives
# users an instruction that cannot work, and it fails no other check here — so a README
# edit that drops, renames or duplicates the token has to fail loudly at publish time
# rather than reach the marketplace.
publish_readme_source() {
	local dest="$1" source_ref="$2" readme="$1/README.md"
	[ -n "$source_ref" ] || { echo "error: publish_readme_source needs a marketplace source" >&2; return 1; }
	[ -s "$readme" ] || { echo "error: mirrored README is missing or empty: '$readme'" >&2; return 1; }
	if ! grep -Fq "$README_SOURCE_PLACEHOLDER" "$readme"; then
		echo "error: '$readme' has no ${README_SOURCE_PLACEHOLDER} placeholder to resolve." >&2
		echo "       cursor-plugin/README.md must keep it in the install instructions so" >&2
		echo "       each publish target can name its own marketplace." >&2
		return 1
	fi
	# Literal index-based replacement, not sed: the value is a slug or an absolute path,
	# and both `/` (delimiter) and `&` (backreference) would need escaping in a sed
	# replacement. awk's substr arithmetic treats it as plain text.
	awk -v ph="$README_SOURCE_PLACEHOLDER" -v val="$source_ref" '
		{ i = index($0, ph); if (i > 0) $0 = substr($0, 1, i - 1) val substr($0, i + length(ph)); print }
	' "$readme" > "$readme.tmp" && mv "$readme.tmp" "$readme"
	# One replacement per line above, so a second occurrence on the same line would
	# survive silently. Assert the token is gone rather than trust the loop-free form.
	if grep -Fq "$README_SOURCE_PLACEHOLDER" "$readme"; then
		echo "error: '$readme' still contains ${README_SOURCE_PLACEHOLDER} after rewriting." >&2
		echo "       Keep the placeholder to a single occurrence per line." >&2
		return 1
	fi
	echo "==> README install source -> ${source_ref}"
}

publish_version() {
	# Pass the path on argv rather than interpolating it into the JS source, so a
	# repo path containing a quote or backslash cannot corrupt the expression.
	node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$PLUGIN_DIR/.cursor-plugin/plugin.json"
}

# publish_version_gt <candidate> <baseline> — is <candidate> a strictly HIGHER
# x.y.z than <baseline>? Hand-kept twin of the same helper in claude-plugin/ and
# codex-plugin/'s _publish-lib.sh.
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
	# check. Rejecting only non-`[0-9.]` characters was the shape this started as
	# on the other two plugins, and it let five malformed versions clear the
	# release gate, all measured there: `1.0` and `1.0.` (a missing component read
	# as empty, then padded to 0), `1..2` and `.1.2` (an empty component padded the
	# same way), and `1.0.2.1` (a fourth component is never read, so it compares as
	# `1.0.2`). Each was accepted against a lower baseline, so a typo'd plugin.json
	# version could commit and push a prod release without JOLLI_PUBLISH_FORCE.
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

# Confirm the marketplace checkout holds a complete plugin. Reads the INDEX
# (`git ls-files`), which reflects the staged tree before a commit and HEAD's tracked
# tree after one — so it is equally valid as a pre-commit gate and as a pre-push gate
# on an already-committed tree. Both call sites depend on that.
publish_assert_staged() {
	local dest="$1" missing=() file
	for file in "${PUBLISH_REQUIRED_DIST[@]}"; do
		[ -n "$(git -C "$dest" ls-files -- "plugins/jolli/dist/$file")" ] || missing+=("dist/$file")
	done
	for file in "${PUBLISH_REQUIRED_CONFIG[@]}"; do
		[ -n "$(git -C "$dest" ls-files -- "$file")" ] || missing+=("$file")
	done
	local skill_count
	skill_count="$(git -C "$dest" ls-files -- 'plugins/jolli/skills/*/SKILL.md' | wc -l | tr -d ' ')"
	[ "$skill_count" -eq "${#PUBLISH_EXPECTED_SKILLS[@]}" ] ||
		missing+=("skills/*/SKILL.md (expected ${#PUBLISH_EXPECTED_SKILLS[@]}, found $skill_count)")
	if [ "${#missing[@]}" -gt 0 ]; then
		echo "error: required file(s) not staged: ${missing[*]}" >&2
		echo "       Check the marketplace checkout's .gitignore and the publish inventory." >&2
		return 1
	fi
}

# publish_slug_of_remote <dest-dir> — the `owner/repo` slug of a checkout's origin, or
# empty when it has none. Normalizes both remote forms (`git@host:owner/repo.git` and
# `https://host/owner/repo`), so the answer is comparable to the slug a call site passes
# in no matter how the target was cloned.
publish_slug_of_remote() {
	git -C "$1" remote get-url origin 2>/dev/null |
		sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' || true
}

# publish_clone_url <slug> — the canonical SSH remote for a marketplace slug:
#   dev   git@github.com:jolli-plugin-dev/jolli-cursor-plugin.git
#   prod  git@github.com:jolliai/jolli-cursor-plugin.git
#
# Derived from the slug rather than stored beside it. The slug is already the single
# source of truth — it is what `publish_readme_source` writes into the shipped README —
# and a second literal per target would be one more pair to keep in lockstep, in a file
# whose whole job is to fail loudly when two lists disagree.
publish_clone_url() {
	printf 'git@github.com:%s.git' "$1"
}

# publish_assert_origin <dest-dir> <expected-slug> — refuse a checkout that points at a
# DIFFERENT repository than the one this target publishes to.
#
# publish_assert_safe_dest validates only the destination's SHAPE, and the two targets
# are the same repository NAME in two different orgs, living in sibling directories that
# differ by a `-dev` suffix. So a swapped positional argument or a stale MARKETPLACE_REPO
# passes every other check here and pushes a rehearsal to the PUBLIC release repo — or a
# release to the rehearsal one — while the README, whose slug is passed in rather than
# derived, still correctly names the target that was intended. That split is exactly what
# passing the slug in was chosen to protect, and it protected only the README.
#
# Checked BEFORE the build and the mirror, so a wrong target costs nothing and leaves the
# destination untouched.
#
# A checkout with NO origin passes: it cannot be the wrong repository, and a local
# `git init` destination is a legitimate NO_PUSH=1 dry run. Only a mismatch fails.
publish_assert_origin() {
	local dest="$1" expected="$2" actual
	[ "${JOLLI_PUBLISH_FORCE:-0}" = "1" ] && return 0
	actual="$(publish_slug_of_remote "$dest")"
	[ -z "$actual" ] && return 0
	[ "$actual" = "$expected" ] && return 0
	echo "error: '$dest' points at ${actual}, but this target publishes to ${expected}." >&2
	echo "       Refusing to publish — pushing here would land this build in the wrong" >&2
	echo "       repository while the README still names the intended one." >&2
	echo "       Clone the right target, or re-run with JOLLI_PUBLISH_FORCE=1:" >&2
	echo "         git clone $(publish_clone_url "$expected") <dir>" >&2
	return 1
}

# publish_has_unpushed — is the local release commit absent from the remote?
# Run inside the marketplace checkout.
publish_has_unpushed() {
	git rev-parse --verify -q HEAD >/dev/null || return 1
	# No upstream: either a just-committed unborn-branch clone or a checkout that
	# has never pushed. Both mean the commit is local-only.
	git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 || return 0
	[ -n "$(git log --oneline '@{upstream}'..HEAD 2>/dev/null)" ]
}

# publish_push — push unless NO_PUSH. Run inside the marketplace checkout.
publish_push() {
	if [ "${NO_PUSH:-0}" = "1" ]; then
		echo "==> NO_PUSH set — committed but not pushed."
		return 0
	fi
	echo "==> Pushing"
	# A freshly created marketplace repo is EMPTY, so its cloned branch is unborn
	# and has no upstream — a bare `git push` aborts asking for --set-upstream,
	# AFTER the release commit has already landed locally. Set the upstream on that
	# first publish; every later run takes `git push`.
	if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
		git push
	else
		git push -u origin HEAD
	fi
}

# Build, mirror, commit with DCO sign-off, and optionally push a marketplace repo.
#
# <marketplace-source> is the `owner/repo` slug readers of THIS target's README will
# point Cursor at. It is passed in rather than derived from the checkout's `origin` on
# purpose: the README is written before the push, and a mistyped destination path
# should not silently produce a README that documents whichever repo the wrong
# checkout happens to point at.
#
# <target-kind> is `prod` (default) or `dev`, and it gates ONE thing: the version
# guard. Everything else is identical, which is what makes a dev run a rehearsal of
# the prod run. A rehearsal republishes the same build repeatedly, and the guard
# demands a strictly higher version each time content changes — bumping per rehearsal
# is how the Claude dev marketplace reached 1.0.5 while prod was still on 1.0.1, at
# which point the guard began refusing legitimate releases on the rehearsal target.
# A version number is a RELEASE decision; dev is not a release.
#
# The cost is real: an installed tester's plugin update compares versions, so a
# same-version dev republish looks like "up to date" and they keep running the old
# bundle — re-add the plugin instead (the reminder below says so, and note this host
# also keeps a version-stamped copy in its marketplace cache). A green dev run also
# stops proving prod will accept the version; prod has its own history.
#
# Defaults to `prod`: a call site that forgets the argument gets the STRICTER
# behaviour, not a silently unguarded publish.
publish_git_repo() {
	local dest="$1" marketplace_source="$2" target_kind="${3:-prod}"
	if [ ! -d "$dest/.git" ]; then
		echo "error: '$dest' is not a git checkout." >&2
		echo "       Clone the target marketplace repository first:" >&2
		echo "         git clone $(publish_clone_url "$marketplace_source") '$dest'" >&2
		return 1
	fi
	dest="$(cd "$dest" && pwd)"
	publish_assert_origin "$dest" "$marketplace_source" || return 1

	publish_build
	publish_assert_skills
	publish_sync "$dest"
	publish_readme_source "$dest" "$marketplace_source"

	# Subshell: this `cd` must not leak into the caller's shell. It does not today —
	# publish_git_repo is the last statement in publish-dev.sh and publish-prod.sh — but
	# that is a property of those call sites, not of this function, and any line appended
	# after it would silently run inside the marketplace checkout instead of the monorepo.
	(
		cd "$dest"
		git -c core.excludesFile=/dev/null add -A
		if git -c core.excludesFile=/dev/null diff --cached --quiet; then
			echo "==> Nothing changed — target already up to date."
			# Unconditionally, BEFORE the unpushed branch below: a destination
			# .gitignore matching a required file keeps it out of the index, so
			# `add -A` stages nothing and this branch is reached with the published
			# tree incomplete. Gating the assertion on "has an unpushed commit" left
			# exactly that case green.
			publish_assert_staged "$dest"
			# ... but "nothing to COMMIT" is not "nothing to PUBLISH". A previous
			# NO_PUSH=1 rehearsal or a failed push leaves the release commit local-only,
			# and every later run also finds nothing to commit — so without this the
			# commit would sit unpushed forever and the release would silently never
			# reach users.
			if publish_has_unpushed; then
				echo "==> Local release commit is not on the remote yet."
				# The completeness gate for this branch already ran above — it pushes a
				# commit THIS run did not create, so an incomplete one (an older script
				# version, a hand-run `git commit`) must not go out unexamined.
				publish_push
			fi
			exit 0
		fi

		# Strictly greater, not merely different, and prod only: an equal version leaves
		# installed users on "up to date", and a LOWER one does the same while looking
		# like a release. The equal-only form this replaced would have waved a downgrade
		# through — see the twin guard in claude-plugin/scripts/_publish-lib.sh, where
		# exactly that gap was live (source 1.0.0, prod already on 1.0.1).
		local version last_msg last_version release_subject
		version="$(publish_version)"
		release_subject="release: jolli cursor plugin "
		if [ "$target_kind" = "prod" ]; then
			# The baseline is the last RELEASE commit, looked up in history — not the
			# tip. Reading the tip and stripping the prefix made the guard vanish
			# whenever the destination's last commit was anything else (a README fix, a
			# merge): the strip was a no-op, the `last_msg != last_version` sanity test
			# went false, and the `&&` chain short-circuited into a green downgrade.
			last_msg="$(git log -1 --format=%s --grep="^${release_subject}" 2>/dev/null || true)"
			last_version="${last_msg#"$release_subject"}"
			if [ -z "$last_msg" ]; then
				# No release commit on the target: a first publish has no baseline to be
				# higher than. Said out loud, because "guard skipped" must never be silent.
				echo "==> No previous release commit on the target — version guard has no baseline."
			elif [ "${JOLLI_PUBLISH_FORCE:-0}" != "1" ] &&
				! publish_version_gt "$version" "$last_version"; then
				echo "error: content changed but plugin version ${version} is not higher than" >&2
				echo "       the last published release (${last_version})." >&2
				echo "       Both must be exactly three numeric components (e.g. 1.0.2); any other" >&2
				echo "       shape fails this check rather than being padded or truncated." >&2
				echo "       Bump cursor-plugin/plugins/jolli/.cursor-plugin/plugin.json first," >&2
				echo "       or use JOLLI_PUBLISH_FORCE=1 for a deliberate same-version or" >&2
				echo "       downgrade publish." >&2
				# The mirror runs BEFORE this guard (the guard needs the staged diff to decide),
				# so the destination now holds this build even though nothing was committed.
				# Left in place rather than auto-reverted — it may hold deliberate local edits,
				# and the safe-dest guard cannot tell those from mirror output. Say so, so the
				# next run's diff is not mistaken for a real change.
				echo "note: '${dest}' already holds this build, uncommitted. Discard it with:" >&2
				echo "        git -C '${dest}' checkout . && git -C '${dest}' clean -fd" >&2
				exit 1
			fi
		else
			# Printed, never silent: this is the one behavioural difference between the
			# rehearsal and the release, so it has to be visible in the rehearsal's output.
			echo "==> ${target_kind} target — version guard skipped (rehearsals republish one version)."
			echo "    Testers: REMOVE + re-add the plugin. A same-version republish leaves the"
			echo "    version-stamped copy in the marketplace cache untouched."
		fi

		publish_assert_staged "$dest"
		# Same `release_subject` the guard greps for — a literal here could drift from
		# the pattern and leave every future run without a baseline.
		git commit -s -m "${release_subject}${version}"

		publish_push

		local slug
		slug="$(publish_slug_of_remote .)"
		[ -n "$slug" ] || slug="<owner>/<marketplace-repo>"
		echo ""
		echo "Published jolli ${version} to ${slug}."
		echo "Point a Cursor team marketplace at that repository, or submit it at"
		echo "  https://cursor.com/marketplace/publish"
	)
}
