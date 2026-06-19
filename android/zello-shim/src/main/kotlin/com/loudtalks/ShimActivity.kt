package com.loudtalks

import android.app.Activity
import android.os.Bundle

/**
 * No-op launch target. The rugged phone's "Open Zello" Custom-key action checks
 * for / launches the real Zello app, whose package is `com.loudtalks` (Zello's
 * legacy "Loud Talks" id) — NOT `com.zello` (that prefix only names the PTT
 * broadcast actions com.zello.ptt.down/up). With com.loudtalks absent the
 * firmware deep-links to the Play Store; this stub claims the package and
 * finishes instantly (translucent theme + zero transition) so the launch is
 * invisible. The PTT broadcasts riding the same key press are unaffected —
 * Console's PushService captures them independently.
 */
class ShimActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
