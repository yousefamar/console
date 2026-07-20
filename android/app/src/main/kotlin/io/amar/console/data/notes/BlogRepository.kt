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

/** Blog tooling — Kotlin mirror of src/store/blog.ts over the hub /blog endpoints. */
class BlogRepository(private val hub: HubClient) {
    private val json = Json { ignoreUnknownKeys = true }

    data class Draft(val path: String, val title: String, val mtime: Long)
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

    // Live status per published post path.
    enum class LiveStatus { LIVE, STALE, BUILDING, UNKNOWN }

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
    private val _liveStatus = MutableStateFlow<Map<String, LiveStatus>>(emptyMap())
    val liveStatus: StateFlow<Map<String, LiveStatus>> = _liveStatus
    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

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

    suspend fun createDraft(title: String, project: String? = null): CreateResult {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return CreateResult(false, error = "Title is required")
        return runCatching {
            val body = buildJsonObject {
                put("title", trimmed)
                project?.let { put("project", it) }
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

    /** ETag / Last-Modified of a live page via the hub (SPA can't HEAD cross-origin). */
    suspend fun fetchPageEtag(url: String): String? = runCatching {
        val resp = hub.get("/blog/page-etag?url=${enc(url)}")
        json.parseToJsonElement(resp).jsonObject["etag"]?.jsonPrimitive?.content
    }.getOrNull()

    /** Last-Modified epoch-ms of a live page, or null when unreachable/unparsable. */
    suspend fun fetchPageLastModifiedMs(url: String): Long? = runCatching {
        val resp = hub.get("/blog/page-etag?url=${enc(url)}")
        val lm = json.parseToJsonElement(resp).jsonObject["lastModified"]?.jsonPrimitive?.content
        lm?.let { runCatching { java.util.Date(it).time }.getOrNull() }
    }.getOrNull()

    /**
     * Probe the permalink; compare page Last-Modified to the local file mtime.
     * pageMs >= mtime → LIVE, else STALE; unparsable → UNKNOWN.
     */
    suspend fun checkLiveStatus(path: String, fileMtime: Long) {
        val url = FrontmatterParser.permalinkForLogPath(path) ?: return
        val pageMs = fetchPageLastModifiedMs(url)
        setLiveStatus(path, when {
            pageMs == null -> LiveStatus.UNKNOWN
            pageMs >= fileMtime -> LiveStatus.LIVE
            else -> LiveStatus.STALE
        })
    }

    private fun mtimeOf(o: JsonObject, key: String): Long? =
        o[key]?.jsonPrimitive?.longOrNull ?: o[key]?.jsonPrimitive?.doubleOrNull?.toLong()

    private fun toDraft(o: JsonObject): Draft? {
        val path = o["path"]?.jsonPrimitive?.content ?: return null
        return Draft(path, o["title"]?.jsonPrimitive?.content ?: "", mtimeOf(o, "mtime") ?: 0L)
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
}
