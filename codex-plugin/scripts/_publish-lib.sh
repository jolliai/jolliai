#!/usr/bin/env bash
#
# Shared helpers for the Codex plugin's publish scripts. SOURCED, not executed.
#
# Sibling of claude-plugin/scripts/_publish-lib.sh. Kept as its own file rather
# than parameterizing that one: the two differ in manifest path, marketplace path,
# required dist set, and shipped skill list, and a shared script with four host
# switches would be harder to audit than two explicit ones — these run rarely and
# are read carefully when they do.
#
# Why rsync (not `git archive`): dist/ is a build product that is gitignored in
# this monorepo, so a tracked-files-only export cannot carry it. rsync mirrors the
# tree on disk and deletes stale files in the target (--delete).

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$_LIB_DIR/.." && pwd)"            # codex-plugin/  (marketplace source of truth)
MONOREPO="$(cd "$SRC/.." && pwd)"            # jolliai/  (repo root)
PLUGIN_DIR="$SRC/plugins/jolli"

# Files build.mjs MUST emit for the plugin to function. A dist missing any of
# these does NOT degrade gracefully: the git hooks resolve back to
# `node <dist>/<Hook>.js` at commit time, so a missing hook/worker BLOCKS the
# installing user's commit. StopHook/SessionStartHook are here even though the
# Codex bootstrap never installs Claude's agent hooks — dist completeness is a
# machine-global contract (DistPathWriter.REQUIRED_RUNTIME_FILES), and a dist that
# wins the version race must be able to serve another host's repo hooks too.
# Kept in lockstep with plugins/jolli/scripts/build.mjs entryPoints.
PUBLISH_REQUIRED_DIST=(
	Cli.js CodexPluginBootstrapHook.js McpLauncher.js StopHook.js SessionStartHook.js
	PostCommitHook.js PostMergeHook.js PostRewriteHook.js PrepareMsgHook.js PrePushHook.js
	QueueWorker.js PrePushWorker.js DashboardServerEntry.js
	dashboard-assets/index.html
	dashboard-assets/styles/main.css
	dashboard-assets/js/format.js
	dashboard-assets/js/charts.js
	dashboard-assets/js/shell.js
	dashboard-assets/js/stats.js
	dashboard-assets/js/standup.js
	dashboard-assets/js/repositories.js
	dashboard-assets/js/memories.js
	dashboard-assets/js/main.js
)

# Skills the plugin ships (must match plugins/jolli/skills/ exactly). The EXACT
# count is asserted, not just ">0": a .gitignore rule dropping one file leaves the
# count nonzero but wrong. This repo has already lost SKILL.md that way once — a
# global gitignore matched it and `git add` reported success.
PUBLISH_EXPECTED_SKILLS=(
	jolli init local-run login logout push
	recall remote-run search status timeline
)

# Critical singleton config files that MUST be present. A .gitignore rule (this
# monorepo ignores `.agents/` for the copies Jolli writes into USER repos) could
# silently drop any of these while the dist check passes — shipping a plugin with no
# bootstrap hook, or no manifest.
#
# No `.mcp.json` here, deliberately: the plugin ships none. A plugin MCP entry has to
# pin `cwd` to the plugin root, and the server reads the repository it serves off its
# cwd, so it would answer for the plugin's own cache directory. MCP reaches Codex
# through the global `~/.codex/config.toml` entry the bootstrap registers, which Codex
# launches with the session cwd. See cli/src/install/mcp/HostRegistrars.ts.
PUBLISH_REQUIRED_CONFIG=(
	plugins/jolli/hooks/hooks.json
	plugins/jolli/.codex-plugin/plugin.json
	.agents/plugins/marketplace.json
	README.md
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
		echo "         npx tsx codex-plugin/plugins/jolli/scripts/generate-skills.ts" >&2
		return 1
	fi

	# Present and non-empty is not the same as CURRENT. The skills are committed static
	# files rendered from builders in cli/src, and publish_build has just rebuilt dist/
	# from that same source — so the combination this must catch is a fresh bundle
	# shipped with stale skill text, which fails no other check here. The drift test
	# that would catch it (CodexPluginSkills.test.ts) runs in CI and `npm run all`, not
	# from these scripts, and publish-prod.sh reaches users irreversibly. So assert it
	# again here, the same way dist completeness is asserted after a successful build.
	command -v npx >/dev/null 2>&1 || {
		echo "error: 'npx' not found on PATH — cannot verify the committed skills are current" >&2
		return 1
	}
	echo "==> Verifying committed skills match their builders ..."
	( cd "$MONOREPO" && npx tsx codex-plugin/plugins/jolli/scripts/generate-skills.ts --check ) || return 1
}

# publish_assert_safe_dest <dest-dir> — refuse to `rsync --delete` into a directory
# that is neither empty nor an existing marketplace checkout. Without this a stray
# path argument would let --delete wipe every file in it that isn't part of the
# plugin tree. Safe targets: an existing marketplace (has
# .agents/plugins/marketplace.json), or empty apart from a `.git` dir.
# Override for a deliberate first-time re-target with JOLLI_PUBLISH_FORCE=1.
publish_assert_safe_dest() {
	local dest="$1"
	[ "${JOLLI_PUBLISH_FORCE:-0}" = "1" ] && return 0
	[ -e "$dest/.agents/plugins/marketplace.json" ] && return 0
	local extra
	extra="$(ls -A "$dest" 2>/dev/null | grep -vxF '.git' || true)"
	[ -z "$extra" ] && return 0
	echo "error: refusing to mirror into '$dest' with rsync --delete." >&2
	echo "       It is neither empty nor an existing marketplace checkout" >&2
	echo "       (no .agents/plugins/marketplace.json), so --delete could wipe" >&2
	echo "       unrelated files. Point at the right destination, clear it, or —" >&2
	echo "       if this really is your marketplace target — re-run with" >&2
	echo "       JOLLI_PUBLISH_FORCE=1." >&2
	return 1
}

# publish_sync <dest-dir> — mirror the CONTENTS of codex-plugin/ into <dest-dir>/.
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
# command on the MIRRORED copy, so each target names the marketplace its readers can
# actually add.
#
# Run after publish_sync (which would overwrite it) and before the commit, so the
# resolved text is what lands in the target repo. The source README keeps the neutral
# placeholder: dev and prod are the same repository NAME in two different orgs, so a
# hardcoded slug in the monorepo copy would send half of all readers to the wrong one.
#
# The placeholder MUST be present. Shipping the literal `<marketplace-source>` gives
# users a command that cannot work, and it fails no other check here — so a README edit
# that drops, renames or duplicates the token has to fail loudly at publish time rather
# than reach the marketplace.
publish_readme_source() {
	local dest="$1" source_ref="$2" readme="$1/README.md"
	[ -n "$source_ref" ] || { echo "error: publish_readme_source needs a marketplace source" >&2; return 1; }
	[ -s "$readme" ] || { echo "error: mirrored README is missing or empty: '$readme'" >&2; return 1; }
	if ! grep -Fq "$README_SOURCE_PLACEHOLDER" "$readme"; then
		echo "error: '$readme' has no ${README_SOURCE_PLACEHOLDER} placeholder to resolve." >&2
		echo "       codex-plugin/README.md must keep it in the 'marketplace add' command so" >&2
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
	node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$PLUGIN_DIR/.codex-plugin/plugin.json"
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
# type into `codex plugin marketplace add`. It is passed in rather than derived from
# the checkout's `origin` on purpose: the README is written before the push, and a
# mistyped destination path should not silently produce a README that documents
# whichever repo the wrong checkout happens to point at.
publish_git_repo() {
	local dest="$1" marketplace_source="$2"
	if [ ! -d "$dest/.git" ]; then
		echo "error: '$dest' is not a git checkout." >&2
		echo "       Clone the target marketplace repository first." >&2
		return 1
	fi
	dest="$(cd "$dest" && pwd)"

	publish_build
	publish_assert_skills
	publish_sync "$dest"
	publish_readme_source "$dest" "$marketplace_source"

	# Subshell: this `cd` must not leak into the caller's shell. It does not today —
	# publish_git_repo is the last statement in publish-dev.sh and publish-prod.sh — but
	# that is a property of those call sites, not of this function, and any line appended
	# after it would silently run inside the marketplace checkout instead of the monorepo.
	# The helpers below are documented as running inside that checkout, so scoping the cd
	# is the surgical fix; rewriting each one to take an explicit -C is not.
	(
		cd "$dest"
		git -c core.excludesFile=/dev/null add -A
		if git -c core.excludesFile=/dev/null diff --cached --quiet; then
			echo "==> Nothing changed — target already up to date."
			# ... but "nothing to COMMIT" is not "nothing to PUBLISH". A previous
			# NO_PUSH=1 rehearsal or a failed push leaves the release commit local-only,
			# and every later run also finds nothing to commit — so without this the
			# commit would sit unpushed forever and the release would silently never
			# reach users.
			if publish_has_unpushed; then
				echo "==> Local release commit is not on the remote yet."
				# Same completeness gate as the commit path below. This branch pushes a commit
				# THIS run did not create, so without the check an incomplete commit — one an
				# older script version or a hand-run `git commit` landed here — would go out to
				# users unexamined. `git ls-files` reads the index, which after a commit still
				# reflects the tracked tree, so the assertion is meaningful here too.
				publish_assert_staged "$dest"
				publish_push
			fi
			exit 0
		fi

		local version last_msg last_version
		version="$(publish_version)"
		last_msg="$(git log -1 --format=%s 2>/dev/null || true)"
		last_version="${last_msg#release: jolli codex plugin }"
		if [ "${JOLLI_PUBLISH_FORCE:-0}" != "1" ] &&
			[ "$last_msg" != "$last_version" ] &&
			[ "$last_version" = "$version" ]; then
			echo "error: content changed but plugin version is still ${version}." >&2
			echo "       Bump codex-plugin/plugins/jolli/.codex-plugin/plugin.json first," >&2
			echo "       or use JOLLI_PUBLISH_FORCE=1 for a deliberate same-version publish." >&2
			# The mirror runs BEFORE this guard (the guard needs the staged diff to decide),
			# so the destination now holds this build even though nothing was committed.
			# Left in place rather than auto-reverted — it may hold deliberate local edits,
			# and the safe-dest guard cannot tell those from mirror output. Say so, so the
			# next run's diff is not mistaken for a real change.
			echo "note: '${dest}' already holds this build, uncommitted. Discard it with:" >&2
			echo "        git -C '${dest}' checkout . && git -C '${dest}' clean -fd" >&2
			exit 1
		fi

		publish_assert_staged "$dest"
		git commit -s -m "release: jolli codex plugin ${version}"

		publish_push

		local slug
		slug="$(git remote get-url origin 2>/dev/null | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' || true)"
		[ -n "$slug" ] || slug="<owner>/<marketplace-repo>"
		echo ""
		echo "Published jolli ${version}. Install with:"
		echo "  codex plugin marketplace add ${slug}"
		echo "  codex plugin add jolli@jolli-marketplace"
	)
}
