package ai.jolli.jollimemory.auth

/**
 * Resolves the Jolli login URL.
 * Priority: JOLLI_URL env var > jolli.url system property > default.
 *
 * The default is the auth host, not a bare apex: the apex serves a different
 * product, so pointing at it would be a successful connection to the wrong
 * place rather than a clean failure. Must equal the CLI's `DEFAULT_JOLLI_URL`
 * (`cli/src/auth/AuthConfig.ts`) — `AuthConfig.test.ts` reads this line to
 * hold the two in lockstep.
 */
object JolliUrlConfig {

    private const val DEFAULT_URL = "https://auth.jollidev.com"

    fun getJolliUrl(): String {
        return System.getenv("JOLLI_URL")?.takeIf { it.isNotBlank() }
            ?: System.getProperty("jolli.url")?.takeIf { it.isNotBlank() }
            ?: DEFAULT_URL
    }
}
