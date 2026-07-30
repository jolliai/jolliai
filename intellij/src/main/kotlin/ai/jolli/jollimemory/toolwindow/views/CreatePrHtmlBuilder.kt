package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.toolwindow.BranchTokenTotals
import ai.jolli.jollimemory.toolwindow.CommitMemoryFormat
import ai.jolli.jollimemory.toolwindow.views.CreatePrBodyMarkdown.renderPrBodyMarkdown
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.escAttr

/**
 * CreatePrHtmlBuilder — builds the full HTML document for the dedicated "Create PR"
 * JCEF webview, matching the design mockup's `#pane-pr`.
 *
 * Reuses the existing JCEF document skeleton (inline `<style>` + bridge `<script>`
 * + behaviour `<script>`, no CSP nonce) from [SummaryHtmlBuilder]. Data comes from
 * [CreatePrData.ViewModel]; the PR body is rendered server-side by
 * [CreatePrBodyMarkdown.renderPrBodyMarkdown] — matching the VS Code pane — so
 * whole-line structural tags (`<details>`/`<summary>`/`<blockquote>`/`<br>`)
 * emitted by [SummaryPrMarkdownBuilder.wrapInGithubDetails] pass through and
 * fold natively instead of showing as escaped text.
 */
object CreatePrHtmlBuilder {

    fun buildHtml(vm: CreatePrData.ViewModel, isDark: Boolean, bridgeScript: String): String {
        val isUpdate = vm.existingPr != null
        val heading = if (isUpdate) "Update Pull Request" else "Create Pull Request"
        // Skeleton state disables the primary until hydrate lands. When hydrate
        // failed [loadError] gets set — treat that like "no longer loading":
        // the button re-enables so the user isn't staring at a disabled
        // "Loading…" forever, and the label reads normally so a retry can be
        // initiated by re-clicking Create PR from the sidebar. The error strip
        // rendered below explains why the memory/file lists are empty.
        val hasLoadError = vm.loadError != null
        val primaryLabel = when {
            vm.skeleton && !hasLoadError -> "Loading…"
            isUpdate -> "Update PR"
            else -> "Create PR"
        }
        // "Up to date" here means only "no new commits to push". The PR body is drafted
        // from memory content (summary / E2E / plans), which is editable without a new
        // git commit — and can even change from another panel — so an Update is ALWAYS a
        // valid action. We therefore never disable the button; we only surface an
        // informational hint about the git-push state.
        val upToDate = isUpdate && !vm.hasUnpushedChanges
        val primaryDisabled = if (vm.skeleton && !hasLoadError) " disabled" else ""
        // Also disable Edit + Copy body while the vm is skeleton (no
        // memories/body loaded yet). Otherwise a click on Edit during the
        // 1-3 s hydrate window unhides the empty title/body inputs — the
        // first keystroke there fires editState=true, and [CreatePrPanel]'s
        // webviewDirty guard then makes the still-in-flight hydrate() bail.
        // The panel latches on the skeleton until the user submits or
        // closes the tab (memories/files stay shimmer, existingPr appears
        // as null so the button label lies about Update-vs-Create, and
        // cross-panel memory-state events are silently dropped for the
        // lifetime of the tab).
        //
        // hasLoadError re-enables both so the failure banner state is
        // interactive: nothing worth hydrating is coming, and the user
        // should be able to eyeball / copy whatever partial fields we
        // filled from the skeleton before retrying via the sidebar.
        val secondaryDisabled = if (vm.skeleton && !hasLoadError) " disabled" else ""
        val upToDateHint = if (upToDate) {
            """<span class="up-to-date">No new commits to push — Update still refreshes the PR body from the latest memory</span>"""
        } else {
            ""
        }
        val loadErrorBanner = if (hasLoadError) {
            """<div class="pr-load-error" role="alert">""" +
                """<b>Couldn't finish loading this PR view.</b> """ +
                escAttr(vm.loadError.orEmpty()) +
                """ Re-click Create PR to retry.""" +
                """</div>"""
        } else {
            ""
        }

        return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>$heading</title>
  <style>${CreatePrCssBuilder.buildCss(isDark)}</style>
</head>
<body>
<div class="pane" id="pane-pr">
  <h1>$heading</h1>
  $loadErrorBanner
  ${buildTokenBanner(vm.branchTokenTotals)}
  ${buildMetaStrip(vm)}
  ${buildShipSub(vm)}
  <div class="panel">
    <div class="panel-header"><span class="panel-title">Title</span></div>
    <p id="prTitleDisplay">${escAttr(vm.title)}</p>
    <input id="prTitleInput" class="pr-input hidden" value="${escAttr(vm.title)}" />
  </div>
  <div class="panel">
    <div class="panel-header"><span class="panel-title">Body — drafted from this branch&#39;s memories</span></div>
    <div class="md-body" id="prBody">${buildBodyHtml(vm)}</div>
    <textarea id="prBodyInput" class="pr-textarea hidden" rows="12">${escAttr(vm.bodyMarkdown)}</textarea>
  </div>
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Memories included</span>
      <span class="sec-count">${vm.memoryCount}</span>
    </div>
    ${buildMemoryRows(vm)}
  </div>
  ${buildE2ePanel(vm.e2eScenarios)}
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Files changed</span>
      <span class="sec-count">${vm.filesChanged}</span>
    </div>
    ${buildFileRows(vm)}
  </div>
  <div class="actions">
    <button class="btn" id="cmdCreatePr" data-uptodate="$upToDate"$primaryDisabled>$primaryLabel</button>
    <button class="btn secondary" id="cmdEdit"$secondaryDisabled>Edit</button>
    <button class="btn secondary" id="cmdCopyBody"$secondaryDisabled>Copy body</button>
    $upToDateHint
  </div>
  <p class="ship-sub" id="prStatusText"></p>
</div>
<div class="toast" id="prToast"></div>
<script>$bridgeScript</script>
<script>${CreatePrScriptBuilder.buildScript()}</script>
</body>
</html>"""
    }

    /**
     * Branch-level token/cost banner shown under the heading — the aggregate
     * counterpart of the per-memory meter in the detail webview. Sums input +
     * output + cache-creation tokens and the estimated USD cost across every
     * committed memory on the branch (via [CommitMemoryFormat.aggregateTokens]).
     * Three states mirror the detail meter: full breakdown, total-only, and the
     * "not reported" empty state. Segment widths use inline `style="width"` — the
     * IntelliJ JCEF webview enforces no CSP (see [CreatePrScriptBuilder]).
     */
    private fun buildTokenBanner(totals: BranchTokenTotals?): String {
        if (totals == null || !totals.hasData) {
            return """<div class="tmeter tmeter-na">""" +
                """<div class="tmeter-head">""" +
                """<span class="tmeter-total">Token usage not reported for this branch</span>""" +
                """<span class="tmeter-help" title="$USAGE_HELP">?</span>""" +
                """</div></div>"""
        }
        val input = totals.input
        val output = totals.output
        val cached = totals.cached
        val segSum = (input + output + cached).coerceAtLeast(1)
        val wIn = Math.round(input * 100.0 / segSum).toInt()
        val wOut = Math.round(output * 100.0 / segSum).toInt()
        val wCache = maxOf(0, 100 - wIn - wOut)
        val cost = totals.estimatedCostUsd
        val costStr = if (cost != null && cost > 0.0) CommitMemoryFormat.formatCost(cost) else "cost N/A"
        val partial = if (totals.partial) """<span class="tmeter-note">&middot; partial</span>""" else ""
        return """<div class="tmeter">""" +
            """<div class="tmeter-head">""" +
            """<span class="tmeter-total">${CommitMemoryFormat.formatTokens(totals.total)}</span> tokens """ +
            """<span class="tmeter-cost">&middot; $costStr</span> """ +
            """<span class="tmeter-note">&middot; this branch</span>""" +
            partial +
            """<span class="tmeter-help" title="$USAGE_HELP">?</span>""" +
            """</div>""" +
            """<div class="tmeter-bar">""" +
            """<span class="seg-in" style="width:$wIn%"></span>""" +
            """<span class="seg-out" style="width:$wOut%"></span>""" +
            """<span class="seg-cache" style="width:$wCache%"></span>""" +
            """</div>""" +
            """<div class="tmeter-legend">""" +
            """<span><i class="lg-dot seg-in"></i>${CommitMemoryFormat.formatTokens(input)} input</span>""" +
            """<span><i class="lg-dot seg-out"></i>${CommitMemoryFormat.formatTokens(output)} output</span>""" +
            """<span><i class="lg-dot seg-cache"></i>${CommitMemoryFormat.formatTokens(cached)} cached</span>""" +
            """</div></div>"""
    }

    /** Tooltip explaining what the branch token total counts and how cost is derived. */
    private const val USAGE_HELP =
        "Sums input + output + cache-creation tokens across every committed memory on this branch " +
            "(cache reads are excluded — they double-count). The cost is a cache-aware estimate: priced per " +
            "model when known, otherwise at Sonnet rates; memories from sources that don't report usage are " +
            "omitted, so both numbers are approximate."

    private fun buildMetaStrip(vm: CreatePrData.ViewModel): String {
        val countLabel = if (vm.memoryCount == 1) "memory" else "memories"
        val fileLabel = if (vm.filesChanged == 1) "file" else "files"
        val prLink = vm.existingPr?.let {
            """<span class="meta-sep">·</span>""" +
                """<span class="pr-open-link" id="prOpenLink" data-pr-url="${escAttr(it.url)}">PR #${it.number}</span>"""
        } ?: ""
        return """<div class="meta-strip">""" +
            """<span class="meta-branch">${escAttr(vm.branch)}</span>""" +
            """<span class="meta-sep">→</span>""" +
            """<span class="meta-branch">${escAttr(vm.mainBranch)}</span>""" +
            prLink +
            """<span class="meta-sep">·</span>""" +
            """<span>drafted from ${vm.memoryCount} $countLabel</span>""" +
            """<span class="meta-sep">·</span>""" +
            """<span class="ship-status">+${vm.insertions} −${vm.deletions} · ${vm.filesChanged} $fileLabel</span>""" +
            """</div>"""
    }

    /** Sign-in-aware sub-message describing the one-click "also share to Jolli" behaviour. */
    private fun buildShipSub(vm: CreatePrData.ViewModel): String {
        return if (vm.signedIn) {
            """<div class="ship-sub">Signed in — creating this PR also shares the included memories to Jolli.</div>"""
        } else {
            """<div class="ship-sub">""" +
                """<span class="sw-link" id="prSignInLink" role="button" tabindex="0">Sign in</span>""" +
                """<span>to also share these memories to Jolli when you create the PR — or create the PR now; it stays a normal git PR.</span>""" +
                """</div>"""
        }
    }

    private fun buildMemoryRows(vm: CreatePrData.ViewModel): String {
        // Skeleton mode: memoryCount was set from the brief list, but the per-row
        // titles + jolliDocUrl come from full summaries (not loaded yet). Render
        // that many placeholder rows so the panel's height doesn't jump on hydrate.
        // Suppress the shimmer when loadError is set — the row list will never
        // arrive, and animated placeholders would read as "still loading".
        if (vm.skeleton && vm.loadError == null) {
            val rows = vm.memoryCount.coerceAtLeast(1).coerceAtMost(8)
            return (1..rows).joinToString("") {
                """<div class="row skeleton-row">""" +
                    """<span class="mem-ico">▤</span>""" +
                    """<div class="r-main">""" +
                    """<div class="r-title skeleton-bar" style="width:60%">&nbsp;</div>""" +
                    """<div class="r-sub"><span class="skeleton-bar" style="width:30%">&nbsp;</span></div>""" +
                    """</div></div>"""
            }
        }
        return vm.memories.joinToString("") { m ->
            val sharedSuffix = if (m.jolliDocUrl != null) """ · <span style="opacity:0.7">shared</span>""" else ""
            """<div class="row" data-hash="${escAttr(m.hash)}">""" +
                """<span class="mem-ico">▤</span>""" +
                """<div class="r-main">""" +
                """<div class="r-title">${escAttr(m.title)}</div>""" +
                """<div class="r-sub"><span class="meta-hash">${escAttr(m.hash.take(8))}</span>$sharedSuffix</div>""" +
                """</div></div>"""
        }
    }

    private fun buildFileRows(vm: CreatePrData.ViewModel): String {
        // Skeleton mode: filesChanged came from shortstat, but the per-file
        // path + status came from --name-status (not run yet). Same
        // placeholder-count trick as buildMemoryRows — also suppressed when
        // loadError is set so the shimmer isn't lying about progress.
        if (vm.skeleton && vm.loadError == null) {
            val rows = vm.filesChanged.coerceAtLeast(1).coerceAtMost(8)
            return (1..rows).joinToString("") {
                """<div class="row skeleton-row">""" +
                    """<div class="r-main">""" +
                    """<div class="r-title skeleton-bar" style="width:45%">&nbsp;</div>""" +
                    """<div class="r-sub"><span class="skeleton-bar" style="width:65%">&nbsp;</span></div>""" +
                    """</div></div>"""
            }
        }
        return vm.files.joinToString("") { f ->
            val fname = f.path.substringAfterLast('/')
            """<div class="row" data-path="${escAttr(f.path)}">""" +
                """<div class="r-main">""" +
                """<div class="r-title fname-${escAttr(f.status)}">${escAttr(fname)}</div>""" +
                """<div class="r-sub">${escAttr(f.dir)}</div>""" +
                """</div>""" +
                """<span class="gs gs-${escAttr(f.status)}">${escAttr(f.status)}</span>""" +
                """</div>"""
        }
    }

    /**
     * Renders the body panel content: shimmer bars during skeleton mode (so the
     * panel has visible height and reads as "loading"), otherwise the PR body
     * markdown rendered to HTML server-side by [renderPrBodyMarkdown]. Matches
     * VS Code's CreatePrHtmlBuilder — the body HTML is baked in at build time,
     * not read from a `data-body` attribute and re-parsed in JS.
     */
    private fun buildBodyHtml(vm: CreatePrData.ViewModel): String {
        if (vm.skeleton && vm.loadError == null) {
            return """<div class="skeleton-bar" style="width:80%; height:1em; margin:6px 0">&nbsp;</div>""" +
                """<div class="skeleton-bar" style="width:95%; height:1em; margin:6px 0">&nbsp;</div>""" +
                """<div class="skeleton-bar" style="width:65%; height:1em; margin:6px 0">&nbsp;</div>""" +
                """<div class="skeleton-bar" style="width:88%; height:1em; margin:6px 0">&nbsp;</div>"""
        }
        return renderPrBodyMarkdown(vm.bodyMarkdown)
    }

    private fun buildE2ePanel(scenarios: List<E2eTestScenario>): String {
        if (scenarios.isEmpty()) return ""
        val label = if (scenarios.size == 1) "SCENARIO" else "SCENARIOS"
        val body = scenarios.joinToString("") { s ->
            """<p><b>${escAttr(s.title)}</b></p>""" +
                """<ol>${s.steps.joinToString("") { "<li>${escAttr(it)}</li>" }}</ol>""" +
                """<p><i>Expect:</i> ${s.expectedResults.joinToString("; ") { escAttr(it) }}</p>"""
        }
        return """<div class="panel">""" +
            """<div class="panel-header">""" +
            """<span class="panel-title">E2E Test Guide</span>""" +
            """<span class="ship-status is-ok">${scenarios.size} $label</span>""" +
            """</div>""" +
            """<div class="md-mock">$body</div>""" +
            """</div>"""
    }
}
