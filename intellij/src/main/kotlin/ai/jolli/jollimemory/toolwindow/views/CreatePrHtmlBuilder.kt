package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.toolwindow.BranchTokenTotals
import ai.jolli.jollimemory.toolwindow.CommitMemoryFormat
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils.escAttr

/**
 * CreatePrHtmlBuilder — builds the full HTML document for the dedicated "Create PR"
 * JCEF webview, matching the design mockup's `#pane-pr`.
 *
 * Reuses the existing JCEF document skeleton (inline `<style>` + bridge `<script>`
 * + behaviour `<script>`, no CSP nonce) from [SummaryHtmlBuilder]. Data comes from
 * [CreatePrData.ViewModel]; the PR body is rendered as markdown client-side by
 * [CreatePrScriptBuilder].
 */
object CreatePrHtmlBuilder {

    fun buildHtml(vm: CreatePrData.ViewModel, isDark: Boolean, bridgeScript: String): String {
        val isUpdate = vm.existingPr != null
        val heading = if (isUpdate) "Update Pull Request" else "Create Pull Request"
        val primaryLabel = if (isUpdate) "Update PR" else "Create PR"
        // "Up to date" here means only "no new commits to push". The PR body is drafted
        // from memory content (summary / E2E / plans), which is editable without a new
        // git commit — and can even change from another panel — so an Update is ALWAYS a
        // valid action. We therefore never disable the button; we only surface an
        // informational hint about the git-push state.
        val upToDate = isUpdate && !vm.hasUnpushedChanges
        val primaryDisabled = ""
        val upToDateHint = if (upToDate) {
            """<span class="up-to-date">No new commits to push — Update still refreshes the PR body from the latest memory</span>"""
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
    <div class="md-mock" id="prBody" data-body="${escAttr(vm.bodyMarkdown)}"></div>
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
    <button class="btn secondary" id="cmdEdit">Edit</button>
    <button class="btn secondary" id="cmdCopyBody">Copy body</button>
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
            "(cache reads are excluded — they double-count). The cost is a cache-aware estimate priced " +
            "per model at write time; memories from sources that don't report usage are omitted, so both " +
            "numbers are lower bounds."

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

    private fun buildMemoryRows(vm: CreatePrData.ViewModel): String =
        vm.memories.joinToString("") { m ->
            val sharedSuffix = if (m.jolliDocUrl != null) """ · <span style="opacity:0.7">shared</span>""" else ""
            """<div class="row" data-hash="${escAttr(m.hash)}">""" +
                """<span class="mem-ico">▤</span>""" +
                """<div class="r-main">""" +
                """<div class="r-title">${escAttr(m.title)}</div>""" +
                """<div class="r-sub"><span class="meta-hash">${escAttr(m.hash.take(8))}</span>$sharedSuffix</div>""" +
                """</div></div>"""
        }

    private fun buildFileRows(vm: CreatePrData.ViewModel): String =
        vm.files.joinToString("") { f ->
            val fname = f.path.substringAfterLast('/')
            """<div class="row" data-path="${escAttr(f.path)}">""" +
                """<div class="r-main">""" +
                """<div class="r-title fname-${escAttr(f.status)}">${escAttr(fname)}</div>""" +
                """<div class="r-sub">${escAttr(f.dir)}</div>""" +
                """</div>""" +
                """<span class="gs gs-${escAttr(f.status)}">${escAttr(f.status)}</span>""" +
                """</div>"""
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
