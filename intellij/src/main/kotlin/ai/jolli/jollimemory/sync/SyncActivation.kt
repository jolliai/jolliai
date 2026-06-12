package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project

/**
 * IntelliJ-specific glue that constructs a [SyncEngine] on sign-in
 * and tears it down on sign-out.
 *
 * Port of `vscode/src/sync/VsCodeSyncBootstrap.ts:activateSync()`.
 */
object SyncActivation {

	private val log = JmLogger.create("SyncActivation")

	/**
	 * Registers an auth listener that calls [reconcileSync] on sign-in/sign-out,
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
		// Initial reconcile for "already signed in" case.
		log.info("activateSync: running initial reconcile")
		reconcileSync(project, service)
		return disposable
	}

	/**
	 * Checks config and either starts or stops sync accordingly.
	 *
	 * - No API key → stop sync (sign-out path)
	 * - Engine built → start sync (engine is always built so manual sync works)
	 * - `autoSyncEnabled == false` → stop polling (but engine remains for manual sync)
	 */
	internal fun reconcileSync(project: Project, service: JolliMemoryService) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return

		val config = SessionTracker.loadConfig(cwd)
		if (config.jolliApiKey.isNullOrBlank()) {
			log.info("reconcileSync: no jolliApiKey — stopping sync")
			service.stopSync()
			return
		}

		val engine = buildSyncEngine(cwd)
		if (engine == null) {
			log.info("reconcileSync: engine could not be built — stopping sync")
			service.stopSync()
			return
		}

		val autoSyncEnabled = config.autoSyncEnabled ?: true
		val pollIntervalSec = config.syncPollIntervalSec
		log.info("reconcileSync: engine built, autoSync=$autoSyncEnabled pollInterval=$pollIntervalSec")

		service.startSync(engine, cwd, pollIntervalSec)

		if (!autoSyncEnabled) {
			log.info("reconcileSync: autoSyncEnabled=false — stopping polling (manual sync still available)")
			service.stopSync()
		}
	}
}
