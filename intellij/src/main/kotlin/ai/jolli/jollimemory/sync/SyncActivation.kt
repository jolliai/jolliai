package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project

/**
 * IntelliJ-specific glue that hooks the sync orchestrator into auth state.
 * Every heavy piece of the sync round lives in the CLI now — this object only
 * decides *when* to start/stop the orchestrator based on sign-in and config.
 */
object SyncActivation {

	private val log = JmLogger.create("SyncActivation")

	/**
	 * Registers an auth listener that calls [reconcileSync] on sign-in / sign-out,
	 * and runs an initial reconcile for the "already signed in at startup" case.
	 *
	 * Returns a [Disposable] that removes the auth listener.
	 */
	fun activateSync(project: Project, service: JolliMemoryService): Disposable {
		log.info("activateSync: registering auth listener for project=${project.name}")
		val disposable = JolliAuthService.addAuthListener {
			log.info("activateSync: auth state changed, reconciling")
			reconcileSync(project, service)
		}
		log.info("activateSync: running initial reconcile")
		reconcileSync(project, service)
		return disposable
	}

	/**
	 * Reconciles sync lifecycle with the current auth + config state.
	 *
	 * - No `jolliApiKey` → stop the orchestrator (sign-out path).
	 * - Signed in → start the orchestrator; when `autoSyncEnabled` is false the
	 *   orchestrator is built but polling is stopped so manual sync still works.
	 */
	internal fun reconcileSync(project: Project, service: JolliMemoryService) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return

		val config = SessionTracker.loadConfig(cwd)
		if (config.jolliApiKey.isNullOrBlank()) {
			log.info("reconcileSync: no jolliApiKey — stopping sync")
			service.stopSync()
			return
		}

		val autoSyncEnabled = config.autoSyncEnabled ?: true
		val pollIntervalSec = config.syncPollIntervalSec
		log.info("reconcileSync: starting sync autoSync=$autoSyncEnabled pollInterval=$pollIntervalSec")

		service.startSync(cwd, pollIntervalSec, autoSyncEnabled)
	}
}
