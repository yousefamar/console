package io.amar.console.core

import android.content.Context
import android.content.SharedPreferences

/**
 * Hub endpoint configuration. Replaces the hardcoded `con.amar.io` constants
 * that were scattered through PushService/NotificationActionReceiver in the
 * WebView era. The base URL is set once on the pairing screen (default is
 * right for the single real user) and read process-wide, including from
 * receivers running in fresh processes — hence SharedPreferences, not memory.
 */
object HubConfig {
    private const val PREFS = "hub_config"
    private const val KEY_BASE = "hubBaseUrl"
    const val DEFAULT_BASE = "https://con.amar.io/hub"

    @Volatile private var prefs: SharedPreferences? = null
    @Volatile private var cached: String? = null

    /** Idempotent; safe to call from any process entry point. */
    fun init(context: Context) {
        if (prefs != null) return
        synchronized(this) {
            if (prefs != null) return
            prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            cached = prefs?.getString(KEY_BASE, null)
        }
    }

    /** e.g. `https://con.amar.io/hub` — no trailing slash. */
    val hubBase: String
        get() = (cached ?: DEFAULT_BASE).trimEnd('/')

    fun setHubBase(url: String) {
        val clean = url.trim().trimEnd('/')
        cached = clean.ifEmpty { null }
        prefs?.edit()?.apply {
            if (clean.isEmpty()) remove(KEY_BASE) else putString(KEY_BASE, clean)
            apply()
        }
    }

    /** `https://con.amar.io` — the public origin (for /public/apk etc.). */
    val publicOrigin: String
        get() = hubBase.removeSuffix("/hub")

    private val wsBase: String
        get() = hubBase.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")

    val pushWsUrl: String get() = "$wsBase/push"
    val syncWsUrl: String get() = "$wsBase/sync"
    val sttWsUrl: String get() = "$wsBase/stt"
    // NOT bare `/hub`: Caddy's `handle_path /hub/*` needs a path segment, so a
    // bare-`/hub` upgrade never reaches the hub (times out). `/agents` doesn't
    // match any named hub WS path → lands on the default (agent-protocol)
    // dispatch — same trick as the SPA (src/store/agent.ts agentWsUrl).
    val agentsWsUrl: String get() = "$wsBase/agents"
}
