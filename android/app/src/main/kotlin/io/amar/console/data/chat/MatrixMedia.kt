package io.amar.console.data.chat

import io.amar.console.core.HubConfig

/**
 * mxc:// → hub media-proxy HTTP URL. The hub's matrix-media routes fetch
 * from the homeserver with ITS credentials (MSC3916-aware) — the app only
 * needs its bearer, which Coil's OkHttp client attaches.
 */
object MatrixMedia {
    private fun parse(mxc: String): Pair<String, String>? {
        if (!mxc.startsWith("mxc://")) return null
        val rest = mxc.removePrefix("mxc://")
        val slash = rest.indexOf('/')
        if (slash <= 0) return null
        return rest.substring(0, slash) to rest.substring(slash + 1)
    }

    fun thumbnailUrl(mxc: String?, width: Int = 128, height: Int = 128): String? {
        val (server, id) = parse(mxc ?: return null) ?: return null
        return "${HubConfig.hubBase}/matrix/media/thumbnail/$server/$id?width=$width&height=$height&method=crop"
    }

    fun downloadUrl(mxc: String?): String? {
        val (server, id) = parse(mxc ?: return null) ?: return null
        return "${HubConfig.hubBase}/matrix/media/download/$server/$id"
    }
}
