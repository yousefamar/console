package io.amar.console.data.notes

import io.amar.console.core.HubClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** Blog tooling — Kotlin mirror of src/store/blog.ts over the hub /blog endpoints.
 *
 *  [vaultFiles] yields every vault file with its REAL disk mtime (the notes
 *  Room rows) — the staleness comparison and the live-status chip both read the
 *  file's own mtime, never a wall clock. */
class BlogRepository(
    private val hub: HubClient,
    private val vaultFiles: suspend () -> List<BlogStale.Candidate> = { emptyList() },
) {
    private val json = Json { ignoreUnknownKeys = true }

    data class Draft(
        val path: String,
        val title: String,
        val mtime: Long,
        /** Project the draft belongs to (path-homed or frontmatter-claimed), else null. */
        val project: String? = null,
        /** Frontmatter tags — an AREA slug here files the draft under that area. */
        val tags: List<String> = emptyList(),
    )
    data class Project(
        val slug: String,
        val title: String,
        val path: String,
        val status: String, // active | dormant | complete
        val lastPostMtime: Long?,
        val lastPostPath: String?,
    )
    data class Post(
        val path: String,
        val title: String,
        val date: String?,
        val mtime: Long,
        val project: String?,
        val tags: List<String>,
    )
    data class PublishResult(
        val ok: Boolean,
        val newPath: String? = null,
        val rebuildOk: Boolean? = null,
        val rebuildBody: String? = null,
        val error: String? = null,
    )
    data class CreateResult(
        val ok: Boolean,
        val path: String? = null,
        val slug: String? = null,
        val alreadyExists: Boolean = false,
        val error: String? = null,
    )
    data class FormatResult(val ok: Boolean, val text: String? = null, val error: String? = null)

    /** A published post saved after the site's last build — its edits aren't live. */
    data class StalePost(
        val path: String,
        val title: String,
        val project: String?,
        val tags: List<String>,
        val mtime: Long,
    )

    /** Live status per published post path. FAILED = the site's last build
     *  errored, so nothing new is live however long you wait. */
    enum class LiveStatus { LIVE, STALE, BUILDING, FAILED, UNKNOWN }

    private val _drafts = MutableStateFlow<List<Draft>>(emptyList())
    val drafts: StateFlow<List<Draft>> = _drafts
    private val _projects = MutableStateFlow<List<Project>>(emptyList())
    val projects: StateFlow<List<Project>> = _projects
    private val _tags = MutableStateFlow<List<String>>(emptyList())
    val tags: StateFlow<List<String>> = _tags
    private val _recent = MutableStateFlow<List<Post>>(emptyList())
    val recentPosts: StateFlow<List<Post>> = _recent
    private val _postsByProject = MutableStateFlow<Map<String, List<Post>>>(emptyMap())
    val postsByProject: StateFlow<Map<String, List<Post>>> = _postsByProject
    /** Every published post carrying an area tag (project posts included) —
     *  the SPA `postsByArea`. Absent key = never loaded; empty list = none. */
    private val _postsByArea = MutableStateFlow<Map<String, List<Post>>>(emptyMap())
    val postsByArea: StateFlow<Map<String, List<Post>>> = _postsByArea
    private val _liveStatus = MutableStateFlow<Map<String, LiveStatus>>(emptyMap())
    val liveStatus: StateFlow<Map<String, LiveStatus>> = _liveStatus
    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

    /** Start of the site's last successful build (ms). Files saved before it
     *  are live. null = no build on record and the site unreachable. */
    private val _siteBuiltAt = MutableStateFlow<Long?>(null)
    val siteBuiltAt: StateFlow<Long?> = _siteBuiltAt

    /** `[11ty]` problem lines when the site's last build FAILED — the site is
     *  frozen at the previous build until it is fixed. */
    private val _siteBuildError = MutableStateFlow<String?>(null)
    val siteBuildError: StateFlow<String?> = _siteBuildError

    /** Published posts whose vault file is newer than [siteBuiltAt] — the rail
     *  twin of drafts ("saved, not live"). */
    private val _stalePosts = MutableStateFlow<List<StalePost>>(emptyList())
    val stalePosts: StateFlow<List<StalePost>> = _stalePosts

    fun setLiveStatus(path: String, status: LiveStatus) {
        _liveStatus.value = _liveStatus.value + (path to status)
    }

    suspend fun refreshDrafts() {
        runCatching {
            val arr = json.parseToJsonElement(hub.get("/blog/drafts")).jsonArray
            _drafts.value = arr.mapNotNull { toDraft(it.jsonObject) }
        }
    }

    suspend fun refreshProjects() {
        runCatching {
            val arr = json.parseToJsonElement(hub.get("/blog/projects")).jsonArray
            _projects.value = arr.mapNotNull { toProject(it.jsonObject) }
        }
    }

    suspend fun refreshTags() {
        runCatching {
            val arr = json.parseToJsonElement(hub.get("/blog/tags")).jsonArray
            _tags.value = arr.mapNotNull { it.jsonPrimitive.content }
        }
    }

    suspend fun refreshRecentPosts(limit: Int = 20) {
        runCatching {
            val arr = json.parseToJsonElement(hub.get("/blog/posts?limit=$limit")).jsonArray
            _recent.value = arr.mapNotNull { toPost(it.jsonObject) }
        }
    }

    suspend fun refreshProjectPosts(slug: String) {
        runCatching {
            val arr = json.parseToJsonElement(
                hub.get("/blog/project/${enc(slug)}/posts")
            ).jsonArray
            _postsByProject.value = _postsByProject.value + (slug to arr.mapNotNull { toPost(it.jsonObject) })
        }
    }

    suspend fun refreshAreaPosts(slug: String) {
        runCatching {
            val arr = json.parseToJsonElement(
                hub.get("/blog/area/${enc(slug)}/posts")
            ).jsonArray
            _postsByArea.value = _postsByArea.value + (slug to arr.mapNotNull { toPost(it.jsonObject) })
        }
    }

    /** Refresh drafts + projects + recent in one go (blog-view mount / manual refresh). */
    suspend fun refreshAll() {
        _refreshing.value = true
        try {
            refreshDrafts(); refreshProjects(); refreshRecentPosts(); refreshTags()
        } finally {
            _refreshing.value = false
        }
    }

    suspend fun formatDictation(text: String): FormatResult = runCatching {
        val resp = hub.post("/blog/format", buildJsonObject { put("text", text) }.toString())
        val o = json.parseToJsonElement(resp).jsonObject
        FormatResult(
            ok = o["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
            text = o["text"]?.jsonPrimitive?.content,
            error = o["error"]?.jsonPrimitive?.content,
        )
    }.getOrElse { FormatResult(false, error = it.message) }

    suspend fun setProjectStatus(slug: String, status: String?): Boolean = runCatching {
        val body = buildJsonObject {
            if (status == null) put("status", kotlinx.serialization.json.JsonNull) else put("status", status)
        }
        val resp = hub.patch("/blog/project/${enc(slug)}", body.toString())
        val ok = json.parseToJsonElement(resp).jsonObject["ok"]?.jsonPrimitive?.booleanOrNull ?: false
        if (ok) {
            _projects.value = _projects.value.map {
                if (it.slug == slug) it.copy(status = status ?: "active") else it
            }
        }
        ok
    }.getOrDefault(false)

    suspend fun publish(path: String): PublishResult = runCatching {
        val resp = hub.post("/blog/publish", buildJsonObject { put("path", path) }.toString())
        toPublishResult(json.parseToJsonElement(resp).jsonObject)
    }.getOrElse { PublishResult(false, error = it.message) }

    suspend fun republish(path: String): PublishResult = runCatching {
        val resp = hub.post("/blog/republish", buildJsonObject { put("path", path) }.toString())
        toPublishResult(json.parseToJsonElement(resp).jsonObject)
    }.getOrElse { PublishResult(false, error = it.message) }

    /** [area] seeds `tags: [<area>]` — the tag IS area membership, which is how
     *  the hub's area-posts listing finds it later. Project wins when both are set. */
    suspend fun createDraft(title: String, project: String? = null, area: String? = null): CreateResult {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return CreateResult(false, error = "Title is required")
        return runCatching {
            val body = buildJsonObject {
                put("title", trimmed)
                project?.let { put("project", it) }
                area?.let { put("area", it) }
            }
            val resp = hub.post("/blog/draft", body.toString())
            toCreateResult(json.parseToJsonElement(resp).jsonObject)
        }.getOrElse { CreateResult(false, error = it.message) }
    }

    suspend fun createProject(title: String, slug: String? = null): CreateResult = runCatching {
        val body = buildJsonObject {
            put("title", title)
            slug?.let { put("slug", it) }
        }
        val resp = hub.post("/blog/project", body.toString())
        toCreateResult(json.parseToJsonElement(resp).jsonObject)
    }.getOrElse { CreateResult(false, error = it.message) }

    /** Last-Modified epoch-ms of a live page, or null when unreachable/unparsable.
     *  Only a FALLBACK lower bound for the build clock — a page's Last-Modified
     *  is not a build clock (see [BlogStale]). */
    suspend fun fetchPageLastModifiedMs(url: String): Long? = runCatching {
        val resp = hub.get("/blog/page-etag?url=${enc(url)}")
        val lm = json.parseToJsonElement(resp).jsonObject["lastModified"]?.jsonPrimitive?.content
        lm?.let { runCatching { java.util.Date(it).time }.getOrNull() }
    }.getOrNull()

    /** The blog server's own build record (null when unreachable). */
    suspend fun fetchSiteStatus(): BlogStale.SiteStatus? = runCatching {
        val o = json.parseToJsonElement(hub.get("/blog/site-status")).jsonObject
        val lb = o["lastBuild"]?.let { it as? JsonObject }
        BlogStale.SiteStatus(
            rebuilding = o["rebuilding"]?.jsonPrimitive?.booleanOrNull ?: false,
            lastBuild = lb?.let {
                BlogStale.SiteBuild(
                    ok = it["ok"]?.jsonPrimitive?.booleanOrNull,
                    startedAt = it["startedAt"]?.jsonPrimitive?.content,
                    finishedAt = it["finishedAt"]?.jsonPrimitive?.content,
                    error = it["error"]?.jsonPrimitive?.content,
                )
            },
        )
    }.getOrNull()

    /** Probe the site's build clock and re-derive [stalePosts]. Never throws. */
    suspend fun refreshSiteBuiltAt() {
        val clock = BlogStale.buildClock(fetchSiteStatus(), _siteBuiltAt.value)
        if (clock.builtAt != null || clock.error != null) {
            _siteBuiltAt.value = clock.builtAt
            _siteBuildError.value = clock.error
        } else {
            // No build on record (blog server restarted) and nothing cached —
            // fall back to a page's Last-Modified as a lower bound. /memo/log/
            // IS regenerated by a publish, unlike the frozen /memo/ index.
            _siteBuiltAt.value = fetchPageLastModifiedMs(SITE_PROBE_URL)
            _siteBuildError.value = null
        }
        recomputeStalePosts()
    }

    /** Re-derive [stalePosts] from the vault file list (cheap; frontmatter is
     *  fetched only for newly-stale paths). */
    suspend fun recomputeStalePosts() {
        val candidates = BlogStale.stalePostCandidates(
            runCatching { vaultFiles() }.getOrDefault(emptyList()),
            _siteBuiltAt.value,
        )
        val prev = _stalePosts.value.associateBy { it.path }
        val next = candidates.map { c ->
            prev[c.path]?.takeIf { it.mtime == c.mtime } ?: run {
                val fallbackTitle = c.path.substringAfterLast('/').removeSuffix(".md")
                runCatching {
                    val resp = hub.get("/notes/file/${enc(c.path)}")
                    val content = json.parseToJsonElement(resp).jsonObject["content"]?.jsonPrimitive?.content ?: ""
                    val fm = FrontmatterParser.parse(content)
                    StalePost(
                        path = c.path,
                        title = fm.title?.trim()?.ifEmpty { null } ?: fallbackTitle,
                        project = BlogStale.projectForPostPath(c.path) ?: fm.project,
                        tags = fm.tags,
                        mtime = c.mtime,
                    )
                }.getOrElse {
                    StalePost(c.path, fallbackTitle, BlogStale.projectForPostPath(c.path), emptyList(), c.mtime)
                }
            }
        }
        val cur = _stalePosts.value
        // Runs on every reconcile tick — skip the emit when nothing moved.
        if (cur.size == next.size && cur.indices.all { cur[it].path == next[it].path && cur[it].mtime == next[it].mtime }) return
        _stalePosts.value = next
    }

    /**
     * Compare the site's build clock against the post's own file mtime.
     * builtAt >= mtime → LIVE, else STALE; a failed build → FAILED; no clock
     * at all → UNKNOWN. (The old implementation probed the permalink's
     * Last-Modified, which never moves for a page Eleventy has stopped
     * building — every post published after 3 Oct 2026 read stale forever.)
     */
    suspend fun checkLiveStatus(path: String) {
        if (!FrontmatterParser.isPublishedPath(path)) return
        val fileMtime = runCatching { vaultFiles().firstOrNull { it.path == path }?.mtime }.getOrNull() ?: 0L
        refreshSiteBuiltAt()
        val builtAt = _siteBuiltAt.value
        setLiveStatus(path, when {
            _siteBuildError.value != null -> LiveStatus.FAILED
            builtAt == null -> LiveStatus.UNKNOWN
            builtAt >= fileMtime -> LiveStatus.LIVE
            else -> LiveStatus.STALE
        })
    }

    /**
     * Poll until the blog server reports a build newer than [baselineStartedAt]
     * (capture it BEFORE triggering the rebuild). `/rebuild` only QUEUES a build
     * (3 s debounce + Syncthing propagation + Eleventy run), so the response
     * says nothing about the post being live — and a page's ETag can never move
     * when Eleventy writes byte-identical output or has dropped the template
     * from the build entirely. The build RECORD also carries the failure reason.
     * Gives up after ~3 minutes.
     */
    suspend fun waitForBuild(baselineStartedAt: String?): Pair<Boolean, String?> {
        repeat(36) {
            kotlinx.coroutines.delay(5_000)
            val last = fetchSiteStatus()?.lastBuild ?: return@repeat
            if (last.startedAt == baselineStartedAt) return@repeat
            refreshSiteBuiltAt()
            if (last.ok == false) return false to (last.error?.trim()?.ifEmpty { null } ?: "the build failed")
            return true to null
        }
        return false to null
    }

    private fun mtimeOf(o: JsonObject, key: String): Long? =
        o[key]?.jsonPrimitive?.longOrNull ?: o[key]?.jsonPrimitive?.doubleOrNull?.toLong()

    private fun toDraft(o: JsonObject): Draft? {
        val path = o["path"]?.jsonPrimitive?.content ?: return null
        return Draft(
            path = path,
            title = o["title"]?.jsonPrimitive?.content ?: "",
            mtime = mtimeOf(o, "mtime") ?: 0L,
            project = o["project"]?.let { if (it is kotlinx.serialization.json.JsonNull) null else it.jsonPrimitive.content }
                ?: Regex("^projects/([^/]+)/log/drafts/").find(path)?.groupValues?.get(1),
            tags = (o["tags"] as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
        )
    }

    private fun toProject(o: JsonObject): Project? {
        val slug = o["slug"]?.jsonPrimitive?.content ?: return null
        return Project(
            slug = slug,
            title = o["title"]?.jsonPrimitive?.content ?: "",
            path = o["path"]?.jsonPrimitive?.content ?: "",
            status = o["status"]?.jsonPrimitive?.content ?: "active",
            lastPostMtime = mtimeOf(o, "lastPostMtime"),
            lastPostPath = o["lastPostPath"]?.jsonPrimitive?.content,
        )
    }

    private fun toPost(o: JsonObject): Post? {
        val path = o["path"]?.jsonPrimitive?.content ?: return null
        return Post(
            path = path,
            title = o["title"]?.jsonPrimitive?.content ?: "",
            date = o["date"]?.jsonPrimitive?.content,
            mtime = mtimeOf(o, "mtime") ?: 0L,
            project = o["project"]?.jsonPrimitive?.content,
            tags = (o["tags"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList(),
        )
    }

    private fun toPublishResult(o: JsonObject) = PublishResult(
        ok = o["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
        newPath = o["newPath"]?.jsonPrimitive?.content,
        rebuildOk = o["rebuildOk"]?.jsonPrimitive?.booleanOrNull,
        rebuildBody = o["rebuildBody"]?.jsonPrimitive?.content,
        error = o["error"]?.jsonPrimitive?.content,
    )

    private fun toCreateResult(o: JsonObject) = CreateResult(
        ok = o["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
        path = o["path"]?.jsonPrimitive?.content,
        slug = o["slug"]?.jsonPrimitive?.content,
        alreadyExists = o["alreadyExists"]?.jsonPrimitive?.booleanOrNull ?: false,
        error = o["error"]?.jsonPrimitive?.content,
    )

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    companion object {
        /** Fallback build-clock probe. Deliberately /memo/log/, which a publish
         *  DOES regenerate — the /memo/ index is a frozen orphan (^jade-yak). */
        const val SITE_PROBE_URL = "https://yousefamar.com/memo/log/"
    }
}
