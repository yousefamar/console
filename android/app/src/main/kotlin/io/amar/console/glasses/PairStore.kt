package io.amar.console.glasses

import android.content.Context
import android.content.SharedPreferences

/**
 * Persisted state for the user's single paired G1 pair.
 * Uses SharedPreferences so it survives app restarts without adding a DB dep.
 */
class PairStore(ctx: Context) {

    private val prefs: SharedPreferences =
        ctx.applicationContext.getSharedPreferences("glasses_pair", Context.MODE_PRIVATE)

    data class Pair(
        val leftMac: String,
        val rightMac: String,
        val channel: String,
        val firstPairedAt: Long,
    )

    fun load(): Pair? {
        val l = prefs.getString(KEY_LEFT, null) ?: return null
        val r = prefs.getString(KEY_RIGHT, null) ?: return null
        val c = prefs.getString(KEY_CHANNEL, null) ?: return null
        val ts = prefs.getLong(KEY_PAIRED_AT, 0L)
        return Pair(l, r, c, ts)
    }

    fun save(pair: Pair) {
        prefs.edit()
            .putString(KEY_LEFT, pair.leftMac)
            .putString(KEY_RIGHT, pair.rightMac)
            .putString(KEY_CHANNEL, pair.channel)
            .putLong(KEY_PAIRED_AT, pair.firstPairedAt)
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val KEY_LEFT = "left_mac"
        private const val KEY_RIGHT = "right_mac"
        private const val KEY_CHANNEL = "channel"
        private const val KEY_PAIRED_AT = "paired_at"
    }
}
