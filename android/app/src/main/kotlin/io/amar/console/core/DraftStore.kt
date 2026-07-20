package io.amar.console.core

import android.content.Context

/**
 * Composer drafts, keyed by composer identity ("chat:<roomId>", "agent:<id>").
 * SharedPreferences-backed so a draft survives navigating away, process death,
 * and app restarts — rememberSaveable only survives config changes while the
 * back-stack entry is alive.
 */
object DraftStore {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("composer_drafts", Context.MODE_PRIVATE)

    fun get(ctx: Context, key: String): String = prefs(ctx).getString(key, "") ?: ""

    fun put(ctx: Context, key: String, text: String) {
        prefs(ctx).edit().apply {
            if (text.isBlank()) remove(key) else putString(key, text)
        }.apply()
    }
}
