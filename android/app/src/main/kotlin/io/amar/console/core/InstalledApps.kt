package io.amar.console.core

import android.content.Context
import android.content.pm.LauncherApps
import android.graphics.drawable.Drawable
import android.os.Process
import android.os.UserHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

/**
 * Installed-app registry for the launcher drawer. Backed by LauncherApps
 * (profile-aware — work apps enumerate too) with a package-change callback
 * keeping the list live across installs/uninstalls/updates. Icons are loaded
 * once per entry and cached; labels sorted case-insensitively.
 */
object InstalledApps {
    data class Entry(
        val label: String,
        val packageName: String,
        val activityName: String,
        val user: UserHandle,
        val icon: Drawable?,
    )

    private val _apps = MutableStateFlow<List<Entry>>(emptyList())
    val apps: StateFlow<List<Entry>> = _apps

    private var registered = false

    fun init(ctx: Context) {
        if (registered) return
        registered = true
        val la = ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
        la.registerCallback(object : LauncherApps.Callback() {
            override fun onPackageRemoved(pkg: String?, user: UserHandle?) = refreshBlocking(ctx)
            override fun onPackageAdded(pkg: String?, user: UserHandle?) = refreshBlocking(ctx)
            override fun onPackageChanged(pkg: String?, user: UserHandle?) = refreshBlocking(ctx)
            override fun onPackagesAvailable(pkgs: Array<out String>?, user: UserHandle?, replacing: Boolean) = refreshBlocking(ctx)
            override fun onPackagesUnavailable(pkgs: Array<out String>?, user: UserHandle?, replacing: Boolean) = refreshBlocking(ctx)
        })
        refreshBlocking(ctx)
    }

    private fun refreshBlocking(ctx: Context) {
        // Callback thread is fine for this; the list is small.
        runCatching { _apps.value = enumerate(ctx) }
    }

    suspend fun refresh(ctx: Context) = withContext(Dispatchers.IO) { refreshBlocking(ctx) }

    private fun enumerate(ctx: Context): List<Entry> {
        val la = ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
        val out = ArrayList<Entry>()
        for (user in la.profiles) {
            for (info in la.getActivityList(null, user)) {
                // Console itself lives on the grid as panes — skip its own tile.
                if (info.applicationInfo.packageName == ctx.packageName) continue
                out.add(
                    Entry(
                        label = info.label?.toString() ?: info.applicationInfo.packageName,
                        packageName = info.applicationInfo.packageName,
                        activityName = info.componentName.className,
                        user = user,
                        icon = runCatching { info.getIcon(0) }.getOrNull(),
                    )
                )
            }
        }
        return out.sortedBy { it.label.lowercase() }
    }

    fun launch(ctx: Context, entry: Entry) {
        val la = ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
        runCatching {
            la.startMainActivity(
                android.content.ComponentName(entry.packageName, entry.activityName),
                entry.user, null, null,
            )
        }
        bumpUsage(ctx, entry.packageName)
    }

    // --- frequency ranking (launcher "most used first") ------------------- //
    // Same ledger pattern as RecentEmoji: pkg\tcount\tlastUsed lines in
    // SharedPreferences, capped, frequency-then-recency sort.

    private const val USAGE_PREFS = "app_usage"

    private fun bumpUsage(ctx: Context, pkg: String) {
        val prefs = ctx.getSharedPreferences(USAGE_PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString("counts", "") ?: ""
        val now = System.currentTimeMillis()
        val entries = raw.lineSequence().mapNotNull { line ->
            val p = line.split('\t')
            if (p.size == 3) Triple(p[0], p[1].toIntOrNull() ?: 0, p[2].toLongOrNull() ?: 0L) else null
        }.toMutableList()
        val i = entries.indexOfFirst { it.first == pkg }
        if (i >= 0) entries[i] = Triple(pkg, entries[i].second + 1, now)
        else entries.add(Triple(pkg, 1, now))
        val kept = entries.sortedByDescending { it.second }.take(128)
        prefs.edit().putString("counts", kept.joinToString("\n") { "${it.first}\t${it.second}\t${it.third}" }).apply()
        usageVersion.value++
    }

    /** Bumped on every launch so composables re-sort without polling. */
    val usageVersion = MutableStateFlow(0)

    /** pkg → (count, lastUsed). */
    fun usage(ctx: Context): Map<String, Pair<Int, Long>> {
        val raw = ctx.getSharedPreferences(USAGE_PREFS, Context.MODE_PRIVATE).getString("counts", "") ?: ""
        return raw.lineSequence().mapNotNull { line ->
            val p = line.split('\t')
            if (p.size == 3) p[0] to Pair(p[1].toIntOrNull() ?: 0, p[2].toLongOrNull() ?: 0L) else null
        }.toMap()
    }

    /** Open the system app-info page (long-press action). */
    fun appInfo(ctx: Context, entry: Entry) {
        val la = ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
        runCatching {
            la.startAppDetailsActivity(
                android.content.ComponentName(entry.packageName, entry.activityName),
                entry.user, null, null,
            )
        }
    }

    fun isWorkProfile(entry: Entry): Boolean = entry.user != Process.myUserHandle()
}
