package io.amar.console.pen

import android.content.Context
import android.content.SharedPreferences

/** Persisted single paired pen MAC (SharedPreferences). Mirrors glasses/PairStore. */
class PairStore(ctx: Context) {
    private val prefs: SharedPreferences =
        ctx.applicationContext.getSharedPreferences("pen_pair", Context.MODE_PRIVATE)

    data class Pair(val mac: String, val name: String?, val firstPairedAt: Long)

    fun load(): Pair? {
        val mac = prefs.getString(KEY_MAC, null) ?: return null
        return Pair(mac, prefs.getString(KEY_NAME, null), prefs.getLong(KEY_PAIRED_AT, 0L))
    }

    fun save(pair: Pair) {
        prefs.edit()
            .putString(KEY_MAC, pair.mac)
            .putString(KEY_NAME, pair.name)
            .putLong(KEY_PAIRED_AT, pair.firstPairedAt)
            .apply()
    }

    fun clear() { prefs.edit().clear().apply() }

    /** Pen unlock password persistence (v34: cleared on start; sent only on explicit unlock). */
    fun savePassword(pw: String) { prefs.edit().putString(KEY_PW, pw).apply() }
    fun loadPassword(): String? = prefs.getString(KEY_PW, null)
    fun clearPassword() { prefs.edit().remove(KEY_PW).apply() }

    companion object {
        private const val KEY_MAC = "mac"
        private const val KEY_NAME = "name"
        private const val KEY_PAIRED_AT = "paired_at"
        private const val KEY_PW = "pw"
    }
}
