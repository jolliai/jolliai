package ai.jolli.jollimemory.toolwindow

/**
 * A panel that reports how many rows it currently shows, so its section header can
 * display a live count, e.g. "CONTEXT (4)". Implementers invoke [onRowCountChanged]
 * (on the EDT) whenever their row set changes and return the latest value from
 * [currentRowCount] for the initial header sync.
 */
interface RowCountSource {
	var onRowCountChanged: ((Int) -> Unit)?
	fun currentRowCount(): Int
}
