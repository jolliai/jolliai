package ai.jolli.jollimemory.hooks

/** Reads all of stdin as a string. Used by hooks that receive JSON via stdin. */
fun readStdin(): String {
    return System.`in`.bufferedReader().readText()
}
