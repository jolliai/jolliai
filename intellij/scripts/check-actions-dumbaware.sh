#!/usr/bin/env bash
# DumbAware gate: every action class in actions/ must declare DumbAware.
#
# The platform force-disables a non-dumb-aware action for the WHOLE of indexing,
# ignoring whatever update() computes. None of these actions read the PSI or an
# index — they run git, call the CLI bridge and drive Swing — so all of them
# carry the marker. Before they did, a large project meant minutes of dead
# toolbar after every IDE open, and it read exactly like a broken button rather
# than a busy one. See DEVELOPMENT.md → "Toolbar buttons: DumbAware + an
# explicit refresh".
#
# That regression is invisible to every other check: a new action without the
# marker compiles, lints, and passes the suite. Only a human opening a
# freshly-indexed large project would notice, which is how it shipped the first
# time. Hence a gate rather than a convention.
#
# Like check-no-direct-llm-http.sh and unlike check-global-state.sh this has NO
# baseline: all 14 action classes comply today, so a hit means fix the code.
# The fix is one word — add `, DumbAware` to the supertype list (and the import).
#
# SCOPE, deliberately narrow: only classes in actions/ whose supertype list names
# AnAction or ToggleAction. The plugin's four FileEditorProviders carry the same
# marker for the same reason, but they declare it through a different mechanism
# and are NOT covered here — do not read a pass as "everything dumb-aware".
set -euo pipefail
cd "$(dirname "$0")/.."

# Pin the collation for stable sort ordering across shells / locales (same
# reason the sibling gates set it).
export LC_ALL=C

ACTIONS_DIR="src/main/kotlin/ai/jolli/jollimemory/actions"

# Comment-stripped view of a file. Necessary, not defensive: AddContextAction.kt
# explains its own `[DumbAware]` choice in KDoc, so a bare `grep DumbAware`
# would pass a file that only TALKS about the marker without declaring it —
# exactly the file this gate is supposed to catch. Drops whole-line comments
# (`//`, `/*`, and the ` * ` continuation lines KDoc blocks are formatted with)
# and trailing `//` comments.
strip_comments() {
    sed -E '/^[[:space:]]*(\*|\/\*|\/\/)/d; s://.*::' "$1"
}

# Does this file declare a class extending AnAction / ToggleAction? Matched on
# the comment-stripped text so a doc reference cannot pull a helper file into
# the checked set.
#
# The `^` alternative is load-bearing and was missing at first: with only `[,:]`
# a supertype list broken across lines (`class X :` / `AnAction(),` / `DumbAware {`)
# matched nothing, so the file was skipped ENTIRELY — not checked, not counted,
# no output. A gate that silently declines to look at a file is worse than no
# gate, because the pass line still says OK. Both predicates below accept the
# same three shapes for that reason; keep them in step.
declares_action() {
    strip_comments "$1" | grep -Eq '(^|[,:])[[:space:]]*(AnAction|ToggleAction)[[:space:]]*\('
}

# Is DumbAware in a SUPERTYPE position? Accepts the three shapes Kotlin produces:
#   `... : AnAction(), DumbAware {`      → matches on the leading comma
#   `... ), DumbAware {`                 → same, after a multi-line constructor
#   `    DumbAware {`                    → a supertype list broken across lines
declares_dumbaware() {
    strip_comments "$1" | grep -Eq '(^|[,:])[[:space:]]*DumbAware[[:space:]]*(\{|,|$)'
}

if [ ! -d "$ACTIONS_DIR" ]; then
    echo "ERROR: $ACTIONS_DIR does not exist — did the package move?"
    echo "       Update ACTIONS_DIR in scripts/check-actions-dumbaware.sh."
    exit 1
fi

checked=0
offenders=""
for file in "$ACTIONS_DIR"/*.kt; do
    declares_action "$file" || continue
    checked=$((checked + 1))
    declares_dumbaware "$file" || offenders="$offenders $file"
done

# A glob that matched nothing, or a supertype spelling this script no longer
# recognises, would otherwise report a cheerful pass having checked zero files.
# The count is the gate on the gate.
if [ "$checked" -eq 0 ]; then
    echo "ERROR: found no action classes under $ACTIONS_DIR."
    echo "       Either the package moved or declares_action() no longer matches"
    echo "       how these classes are declared. Fix this script — a pass here"
    echo "       would mean the DumbAware rule is silently unenforced."
    exit 1
fi

if [ -n "$offenders" ]; then
    echo "Action classes missing DumbAware:"
    printf '  %s\n' $offenders
    echo "ERROR: add \`, DumbAware\` to the supertype list (import com.intellij.openapi.project.DumbAware)."
    echo "       The platform disables a non-dumb-aware action for the whole of indexing,"
    echo "       ignoring update() — on a large project that is minutes of dead toolbar."
    echo "       If an action genuinely needs the PSI or an index, it does NOT belong in"
    echo "       this package; move it and narrow ACTIONS_DIR with review."
    exit 1
fi

echo "actions-DumbAware gate OK ($checked action classes)"
