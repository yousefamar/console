package io.amar.console.data.notes

/**
 * Client-side YAML-frontmatter parse/stamp — Kotlin port of the SPA's
 * src/utils/frontmatter.ts (itself kept in sync with server/src/blog.ts).
 * Ported rather than shared because the vault may be hub-local and the write
 * mode round-trips frontmatter through the editor buffer without a server hop.
 *
 * Only the small subset the writing-mode UI needs: title / tags / project +
 * the permalink mapping and draft/published detection.
 */
data class Frontmatter(
    val title: String? = null,
    val date: String? = null,
    val project: String? = null,
    val status: String? = null,
    val tags: List<String> = emptyList(),
    /** Everything else, verbatim scalar values (true/false/strings). */
    val extra: Map<String, String> = emptyMap(),
)

object FrontmatterParser {
    const val DRAFTS_DIR = "scratch/blog-drafts"
    const val LOG_DIR = "log"

    private val blockRe = Regex("^---\\n([\\s\\S]*?)\\n---\\n?([\\s\\S]*)$")
    private val kvRe = Regex("^([a-zA-Z_][a-zA-Z0-9_-]*):\\s*(.*)$")
    private val listItemRe = Regex("^\\s*-\\s+(.+?)\\s*$")

    /** Parse the frontmatter block; returns fm + body (never null). */
    fun parse(content: String): Frontmatter {
        val m = blockRe.find(content) ?: return Frontmatter()
        val raw = m.groupValues[1]
        val lines = raw.split('\n')
        var title: String? = null
        var date: String? = null
        var project: String? = null
        var status: String? = null
        var tags: List<String> = emptyList()
        val extra = LinkedHashMap<String, String>()

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val kv = kvRe.find(line)
            if (kv == null) { i++; continue }
            val key = kv.groupValues[1]
            val valRaw = kv.groupValues[2].trim()
            if (key == "tags") {
                tags = parseTags(valRaw, lines, i)
                i++
                continue
            }
            if (valRaw.isEmpty()) { i++; continue }
            val v = valRaw.trim('"', '\'')
            when (key) {
                "title" -> title = v
                "date" -> date = v
                "project" -> project = v
                "status" -> status = v
                else -> extra[key] = v
            }
            i++
        }
        return Frontmatter(title, date, project, status, tags, extra)
    }

    /** Just the tags list — used by the tag-autocomplete + meta bar. */
    fun parseTags(content: String): List<String> = parse(content).tags

    private fun parseTags(valRaw: String, lines: List<String>, keyIndex: Int): List<String> {
        // Three forms:  tags: foo   |   tags: [a, b]   |   tags:\n  - a\n  - b
        if (valRaw.startsWith("[") && valRaw.endsWith("]")) {
            return valRaw.substring(1, valRaw.length - 1).split(',')
                .map { it.trim().trim('"', '\'') }.filter { it.isNotEmpty() }
        }
        if (valRaw.isEmpty() || valRaw == "[]") {
            val out = ArrayList<String>()
            var j = keyIndex + 1
            while (j < lines.size) {
                val item = listItemRe.find(lines[j]) ?: break
                out.add(item.groupValues[1].trim('"', '\''))
                j++
            }
            return out
        }
        val parts = (if (valRaw.contains(',')) valRaw.split(',') else valRaw.split(Regex("\\s+")))
            .map { it.trim().trim('"', '\'') }.filter { it.isNotEmpty() }
        return parts
    }

    /**
     * Stamp keys into frontmatter, replacing existing lines or appending; array
     * values (tags) serialize as a YAML block list, replacing ANY existing form
     * of the key. Returns full file content (with `---` fences).
     */
    fun stamp(content: String, updates: List<Pair<String, Any>>): String {
        val m = blockRe.find(content)
        var body = if (m != null) m.groupValues[2] else content
        val rawInit = if (m != null) m.groupValues[1] else ""
        val lines = if (rawInit.isNotEmpty()) ArrayList(rawInit.split('\n')) else ArrayList()

        for ((k, v) in updates) {
            val keyLineRe = Regex("^${Regex.escape(k)}:")
            val idx = lines.indexOfFirst { keyLineRe.containsMatchIn(it) }
            var insertAt = lines.size
            if (idx >= 0) {
                var end = idx + 1
                while (end < lines.size && listItemRe.containsMatchIn(lines[end])) end++
                repeat(end - idx) { lines.removeAt(idx) }
                insertAt = idx
            }
            when (v) {
                is List<*> -> {
                    val items = v.map { it.toString() }
                    val block = if (items.isNotEmpty()) listOf("$k:") + items.map { "  - $it" } else listOf("$k: ")
                    lines.addAll(insertAt, block)
                }
                else -> lines.add(insertAt, "$k: $v")
            }
        }
        val raw = lines.joinToString("\n")
        val cleanBody = if (body.startsWith("\n")) body.substring(1) else body
        return "---\n$raw\n---\n$cleanBody"
    }

    /** Byte range [from,to) of the frontmatter block (incl. fences + trailing NL), or null. */
    fun range(content: String): IntRange? {
        val re = Regex("^---\\n[\\s\\S]*?\\n---\\n?")
        val m = re.find(content) ?: return null
        if (m.range.first != 0) return null
        return 0 until m.value.length
    }

    /** log/<name>.md → https://yousefamar.com/memo/log/<name>/ ; else null. */
    fun permalinkForLogPath(path: String): String? {
        val m = Regex("^log/(.+)\\.md$").find(path) ?: return null
        return "https://yousefamar.com/memo/log/${m.groupValues[1]}/"
    }

    fun isDraftPath(path: String?): Boolean = path != null && path.startsWith("$DRAFTS_DIR/")

    fun isPublishedPath(path: String?): Boolean =
        path != null && Regex("^log/[^/]+\\.md$").matches(path)

    /** Slug of a project index page (projects/<slug>.md or projects/<slug>/index.md). */
    fun projectSlugFromPath(path: String?): String? {
        if (path == null) return null
        val m = Regex("^projects/([^/]+?)(?:/index)?\\.md$").find(path) ?: return null
        return m.groupValues[1]
    }

    /** Slug of the project ENCLOSING a path (any file under projects/<slug>/…). */
    fun enclosingProjectSlug(path: String?): String? {
        if (path == null || !path.startsWith("projects/")) return null
        val rest = path.removePrefix("projects/")
        val slash = rest.indexOf('/')
        if (slash == -1) return rest.removeSuffix(".md").ifEmpty { null }
        return rest.substring(0, slash).ifEmpty { null }
    }

    /** Writing-mode chrome applies to drafts + published posts. */
    fun isWritingFile(path: String?): Boolean = isDraftPath(path) || isPublishedPath(path)
}
