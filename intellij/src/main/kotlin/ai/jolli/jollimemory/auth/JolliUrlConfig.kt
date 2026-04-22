package ai.jolli.jollimemory.auth

/**
 * Resolves the Jolli login URL.
 * Priority: JOLLI_URL env var > jolli.url system property > default.
 */
// TODO: test comment for jollimemory summary verification
object JolliUrlConfig {

    private const val DEFAULT_URL = "https://jolli.ai"

    fun getJolliUrl(): String {
        return System.getenv("JOLLI_URL")?.takeIf { it.isNotBlank() }
            ?: System.getProperty("jolli.url")?.takeIf { it.isNotBlank() }
            ?: DEFAULT_URL
    }
}
