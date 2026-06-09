package io.amar.console

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persists the long-lived hub bearer token issued by the authenticated SPA's
 * "Pair this APK" flow. EncryptedSharedPreferences = AES-GCM blob wrapped by
 * the Android Keystore master key; the file is not readable without the
 * device's user credential (under standard MasterKey settings).
 *
 * Mirrors the shape of glasses/PairStore.kt — same package-level singleton
 * pattern, same lifecycle (init at boot from MainActivity, query from
 * PushService).
 */
object HubTokenStore {
    private const val PREFS_NAME = "hub_token"
    private const val KEY_TOKEN = "bearer"
    private const val KEY_NEEDS_REPAIR = "needs_repair"

    @Volatile
    private var prefs: SharedPreferences? = null
    @Volatile
    private var cached: String? = null

    fun init(ctx: Context) {
        if (prefs != null) return
        synchronized(this) {
            if (prefs != null) return
            val masterKey = MasterKey.Builder(ctx.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            prefs = EncryptedSharedPreferences.create(
                ctx.applicationContext,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            cached = prefs?.getString(KEY_TOKEN, null)
        }
    }

    fun get(): String? = cached

    fun set(token: String) {
        val p = prefs ?: return
        cached = token
        p.edit().putString(KEY_TOKEN, token).putBoolean(KEY_NEEDS_REPAIR, false).apply()
    }

    fun clear() {
        val p = prefs ?: return
        cached = null
        p.edit().remove(KEY_TOKEN).putBoolean(KEY_NEEDS_REPAIR, true).apply()
    }

    fun markNeedsRepair() {
        val p = prefs ?: return
        p.edit().putBoolean(KEY_NEEDS_REPAIR, true).apply()
    }

    fun needsRepair(): Boolean = prefs?.getBoolean(KEY_NEEDS_REPAIR, false) ?: false
}
