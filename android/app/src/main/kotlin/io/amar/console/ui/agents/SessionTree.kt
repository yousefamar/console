package io.amar.console.ui.agents

import io.amar.console.data.db.AgentSessionRow

/**
 * Sidebar session ordering — pure port of src/components/agent/session-tree.ts.
 * Sessions cluster by cwd into a group tree (ordered within + across groups by
 * the persisted flat `sessionOrder`), with fork lineage nesting each fork right
 * after its parent. Al is excluded here (the list pins it first separately).
 */

data class SessionGroupNode(
    val cwd: String,          // "" = "(no directory)" bucket
    val label: String,        // path segment relative to parent
    val fullPath: String,
    val sessions: List<AgentSessionRow>,
    val children: List<SessionGroupNode>,
    val depth: Int,
)

/** A flat, renderable row: a group header, or a session at some indent depth. */
sealed interface SidebarRow {
    data class Group(val node: SessionGroupNode) : SidebarRow
    data class Session(val session: AgentSessionRow, val depth: Int) : SidebarRow
}

private fun dirBasename(path: String): String {
    val parts = path.trimEnd('/').split("/")
    return parts.lastOrNull()?.ifEmpty { path } ?: path
}

fun buildGroupTree(sessions: List<AgentSessionRow>, order: List<String>): List<SessionGroupNode> {
    val orderIdx = order.withIndex().associate { (i, id) -> id to i }
    fun sessionKey(s: AgentSessionRow) = orderIdx[s.id] ?: Int.MAX_VALUE
    val cmp = Comparator<AgentSessionRow> { a, b ->
        val ai = sessionKey(a); val bi = sessionKey(b)
        if (ai != bi) ai - bi else (b.createdAt - a.createdAt).let { if (it > 0) 1 else if (it < 0) -1 else 0 }
    }

    val byCwd = LinkedHashMap<String, MutableList<AgentSessionRow>>()
    for (s in sessions) byCwd.getOrPut(s.cwd ?: "") { mutableListOf() }.add(s)
    for (list in byCwd.values) list.sortWith(cmp)

    val cwds = byCwd.keys.sortedBy { it.length }
    val nodeByCwd = LinkedHashMap<String, MutableNode>()
    for (cwd in cwds) nodeByCwd[cwd] = MutableNode(cwd, if (cwd.isEmpty()) "(no directory)" else dirBasename(cwd), cwd, byCwd[cwd]!!, mutableListOf(), 0)

    val roots = mutableListOf<MutableNode>()
    for (cwd in cwds) {
        val node = nodeByCwd[cwd]!!
        var parentCwd: String? = null
        if (cwd.isNotEmpty()) {
            for (other in cwds) {
                if (other.isEmpty() || other == cwd) continue
                if (cwd.startsWith("$other/") && (parentCwd == null || other.length > parentCwd!!.length)) parentCwd = other
            }
        }
        if (parentCwd != null) {
            val parent = nodeByCwd[parentCwd]!!
            parent.children.add(node)
            node.depth = parent.depth + 1
            node.label = cwd.substring(parentCwd!!.length + 1)
        } else roots.add(node)
    }

    fun groupKey(n: MutableNode): Int =
        if (n.sessions.isNotEmpty()) sessionKey(n.sessions.first())
        else if (n.children.isNotEmpty()) groupKey(n.children.first()) else Int.MAX_VALUE
    fun sortRec(arr: MutableList<MutableNode>) { arr.sortBy { groupKey(it) }; for (n in arr) sortRec(n.children) }
    sortRec(roots)
    return roots.map { it.freeze() }
}

private class MutableNode(
    val cwd: String, var label: String, val fullPath: String,
    val sessions: MutableList<AgentSessionRow>, val children: MutableList<MutableNode>, var depth: Int,
) {
    fun freeze(): SessionGroupNode = SessionGroupNode(cwd, label, fullPath, sessions, children.map { it.freeze() }, depth)
}

/** If a single root shares one cwd, drop its redundant header — promote its
 *  sessions to the top level and its children become roots. */
fun peelUniversalRoot(roots: List<SessionGroupNode>): Pair<List<AgentSessionRow>, List<SessionGroupNode>> {
    if (roots.size != 1) return emptyList<AgentSessionRow>() to roots
    val only = roots[0]
    fun shift(n: SessionGroupNode, d: Int): SessionGroupNode = n.copy(depth = n.depth + d, children = n.children.map { shift(it, d) })
    return only.sessions to only.children.map { shift(it, -1) }
}

/** Arrange sessions (all one group) into fork lineage: each fork right after
 *  its parent, one indent deeper. */
fun arrangeLineage(sessions: List<AgentSessionRow>): List<Pair<AgentSessionRow, Int>> {
    val inSet = sessions.mapNotNull { it.claudeSessionId }.toSet()
    val childrenOf = HashMap<String, MutableList<AgentSessionRow>>()
    for (s in sessions) {
        val p = s.parentClaudeSessionId
        if (p != null && p in inSet) childrenOf.getOrPut(p) { mutableListOf() }.add(s)
    }
    val out = mutableListOf<Pair<AgentSessionRow, Int>>()
    fun emit(s: AgentSessionRow, depth: Int) {
        out.add(s to depth)
        s.claudeSessionId?.let { csid -> childrenOf[csid]?.forEach { emit(it, depth + 1) } }
    }
    for (s in sessions) {
        val isRoot = s.parentClaudeSessionId == null || s.parentClaudeSessionId !in inSet
        if (isRoot) emit(s, 0)
    }
    return out
}

/** Flatten the group tree into renderable rows (headers + indented sessions),
 *  skipping collapsed groups' contents. Al excluded (caller prepends it). */
fun flattenSidebar(
    sessions: List<AgentSessionRow>,
    order: List<String>,
    collapsed: Set<String>,
): List<SidebarRow> {
    val (rootSessions, roots) = peelUniversalRoot(buildGroupTree(sessions, order))
    val out = mutableListOf<SidebarRow>()
    for ((s, d) in arrangeLineage(rootSessions)) out.add(SidebarRow.Session(s, d))
    fun walk(nodes: List<SessionGroupNode>) {
        for (n in nodes) {
            out.add(SidebarRow.Group(n))
            if (n.cwd in collapsed) continue
            for ((s, d) in arrangeLineage(n.sessions)) out.add(SidebarRow.Session(s, d))
            walk(n.children)
        }
    }
    walk(roots)
    return out
}
