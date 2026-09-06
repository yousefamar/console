package io.amar.console.data.agents

/** `/home/<user>/x` → `~/x` for display (the hub reports absolute Linux paths). SPA src/utils/cwd.ts. */
fun shortCwd(path: String): String = path.replace(Regex("^/home/[^/]+(?=/|$)"), "~")

/**
 * A bound session runs OUTSIDE its space's home. Inside it — the home itself
 * or any subdir (AL's `projects/al/workspace`) — is fine (SPA e4779bf9).
 * Unknown on either side (older hub payload, pre-init session) is never a stray.
 */
fun isStrayCwd(sessionCwd: String?, spaceCwd: String?): Boolean {
    if (sessionCwd.isNullOrEmpty() || spaceCwd.isNullOrEmpty()) return false
    val home = spaceCwd.trimEnd('/')
    val cwd = sessionCwd.trimEnd('/')
    return cwd != home && !cwd.startsWith("$home/")
}
