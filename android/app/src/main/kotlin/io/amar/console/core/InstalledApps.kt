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
