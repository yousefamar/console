package io.amar.console.data.spaces

import io.amar.console.data.db.AgentSessionRow

// Pure display-name helpers for agent keys on boards (SPA labelFor/rootOf
// parity, SpacesTab.tsx). NEW file so parallel card-forks don't contend.

/** Root agent key of a (possibly dead) fork key: strip the ticket-fork
 *  convention `-<id>-fork[-N]` suffixes until a LIVE session's agentKey
 *  matches, else return the input. */
fun rootAgentKey(key: String, sessions: List<AgentSessionRow>): String {
    val liveKeys = sessions.filter { it.status != "ended" }.mapNotNull { it.agentKey }.toSet()
    if (key in liveKeys) {
        // Live fork: prefer its parent lineage root when resolvable.
        var cur = sessions.firstOrNull { it.agentKey == key && it.status != "ended" }
        var guard = 0
        while (cur?.parentClaudeSessionId != null && guard++ < 6) {
            val parent = sessions.firstOrNull { it.claudeSessionId == cur?.parentClaudeSessionId && it.status != "ended" }
                ?: break
            cur = parent
        }
        return cur?.agentKey ?: key
    }
    // Dead key: strip -fork(-N)? then trailing segments until a live key matches.
    var candidate = key.replace(Regex("-fork(-\\d+)?$"), "")
    var guard = 0
    while (candidate.isNotEmpty() && guard++ < 8) {
        if (candidate in liveKeys) return candidate
        val cut = candidate.lastIndexOf('-')
        if (cut <= 0) break
        candidate = candidate.substring(0, cut)
    }
    return key
}

/** Human label for an agent key: live session name (fork-suffix stripped) →
 *  root key's live session name → the raw key. */
fun agentLabel(key: String, sessions: List<AgentSessionRow>): String {
    fun nameOf(k: String): String? =
        sessions.firstOrNull { it.agentKey == k && it.status != "ended" }?.name?.removeSuffix(" (fork)")
    nameOf(key)?.let { return it }
    val root = rootAgentKey(key, sessions)
    if (root != key) nameOf(root)?.let { return it }
    return key
}
