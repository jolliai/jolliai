package ai.jolli.jollimemory.toolwindow

/**
 * Holds references to the main panels so that actions can find them
 * without relying on tab-name-based lookup (which no longer applies in
 * the collapsible panel layout).
 *
 * CommitsPanel serves as the unified "MEMORIES" section — it shows commits
 * in workspace mode and foreign memories in read-only mode.
 *
 * Stored on [ai.jolli.jollimemory.services.JolliMemoryService.panelRegistry].
 */
class PanelRegistry {
	var statusPanel: StatusPanel? = null
	var plansPanel: PlansPanel? = null
	var changesPanel: ChangesPanel? = null
	var commitsPanel: CommitsPanel? = null
}
