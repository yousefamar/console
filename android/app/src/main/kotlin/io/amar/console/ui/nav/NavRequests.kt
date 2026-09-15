package io.amar.console.ui.nav

/**
 * One-shot screen-entry requests. The command bar navigates through the
 * ordinary routes (`openApp` + the detail routes); for targets that have NO
 * route of their own — a calendar day/event, a feed subscription, a bookmark,
 * or an app root opened straight into its create form — it posts the intent
 * here first and the destination screen takes it on entry (the
 * `notes.remoteOpen` shape: a request is not state).
 *
 * A request older than [TTL_MS] is dropped, so one posted for a screen that
 * never opened cannot fire on an unrelated visit later.
 */
object NavRequests {
    sealed interface Request

    /** Calendar: focus [dayMs] in Day view and, when set, open [eventKey]'s detail sheet. */
    data class CalendarFocus(val dayMs: Long, val eventKey: String?) : Request
    data object CalendarCreate : Request
    /** Feeds: scope the list to one subscription. */
    data class FeedSelect(val feedId: String) : Request
    data object FeedAdd : Request
    /** Bookmarks: open one bookmark's detail sheet. */
    data class BookmarkOpen(val file: String) : Request
    data object BookmarkAdd : Request
    data object MailCompose : Request
    /** Notes: open the create dialog pre-filled with [title]. */
    data class NoteCreate(val title: String) : Request

    const val TTL_MS = 10_000L

    private var pending: Pair<Request, Long>? = null

    fun post(r: Request, nowMs: Long = System.currentTimeMillis()) {
        pending = r to nowMs
    }

    /** Take the pending request if it is a [T] and still fresh; anything else is left alone. */
    inline fun <reified T : Request> take(nowMs: Long = System.currentTimeMillis()): T? = takeIf(nowMs) { it is T } as T?

    fun takeIf(nowMs: Long, pred: (Request) -> Boolean): Request? {
        val (r, at) = pending ?: return null
        if (nowMs - at > TTL_MS) { pending = null; return null }
        if (!pred(r)) return null
        pending = null
        return r
    }

    fun clear() { pending = null }
}
