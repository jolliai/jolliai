package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class GitErrorClassifiersTest {

	// ── isRepoMissingMessage ──────────────────────────────────────────

	@Test
	fun `detects remote repository not found`() {
		assertTrue(isRepoMissingMessage("remote: Repository not found.\nfatal: ..."))
	}

	@Test
	fun `detects repository URL not found`() {
		assertTrue(isRepoMissingMessage("fatal: repository 'https://github.com/x/y.git' not found"))
	}

	@Test
	fun `detects 404 error`() {
		assertTrue(isRepoMissingMessage("The requested URL returned error: 404"))
	}

	@Test
	fun `detects fatal not found`() {
		assertTrue(isRepoMissingMessage("fatal: not found"))
	}

	@Test
	fun `does not match unrelated message for repo missing`() {
		assertFalse(isRepoMissingMessage("everything up-to-date"))
	}

	// ── isNetworkErrorMessage ─────────────────────────────────────────

	@Test
	fun `detects DNS failure`() {
		assertTrue(isNetworkErrorMessage("fatal: unable to access: Could not resolve host: github.com"))
	}

	@Test
	fun `detects connection timeout`() {
		assertTrue(isNetworkErrorMessage("fatal: unable to access: Connection timed out"))
	}

	@Test
	fun `detects connection refused`() {
		assertTrue(isNetworkErrorMessage("fatal: unable to access: Connection refused"))
	}

	@Test
	fun `detects TLS handshake failure`() {
		assertTrue(isNetworkErrorMessage("GnuTLS recv error (-110): The TLS connection was non-properly terminated"))
	}

	@Test
	fun `detects SSL error`() {
		assertTrue(isNetworkErrorMessage("error: SSL certificate problem"))
	}

	@Test
	fun `detects early EOF`() {
		assertTrue(isNetworkErrorMessage("error: early EOF"))
	}

	@Test
	fun `detects remote hung up`() {
		assertTrue(isNetworkErrorMessage("fatal: the remote end hung up unexpectedly"))
	}

	@Test
	fun `detects RPC failure`() {
		assertTrue(isNetworkErrorMessage("error: RPC failed; curl 56"))
	}

	@Test
	fun `detects network unreachable`() {
		assertTrue(isNetworkErrorMessage("fatal: unable to access: Network is unreachable"))
	}

	@Test
	fun `does not match unrelated message for network`() {
		assertFalse(isNetworkErrorMessage("non-fast-forward"))
	}

	// ── isServerRejectionMessage ──────────────────────────────────────

	@Test
	fun `detects pre-receive hook declined`() {
		assertTrue(isServerRejectionMessage("remote: error: pre-receive hook declined"))
	}

	@Test
	fun `detects protected branch`() {
		assertTrue(isServerRejectionMessage("remote: error: GH006: Protected branch update failed"))
	}

	@Test
	fun `detects push too large`() {
		assertTrue(isServerRejectionMessage("remote: error: push file too large"))
	}

	@Test
	fun `detects file exceeds limit`() {
		assertTrue(isServerRejectionMessage("remote: error: File exceeds 100MB limit"))
	}

	@Test
	fun `detects permission denied`() {
		assertTrue(isServerRejectionMessage("remote: Permission to user/repo.git denied to bot"))
	}

	@Test
	fun `detects refusing to update checked out branch`() {
		assertTrue(isServerRejectionMessage("remote: error: refusing to update checked out branch"))
	}

	@Test
	fun `does not match unrelated message for server rejection`() {
		assertFalse(isServerRejectionMessage("everything up-to-date"))
	}
}
