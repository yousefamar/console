// Invisible "com.zello" stub.
//
// Why this exists: the rugged phone's Custom-key "Open Zello" action is the ONLY
// Easy-shuttle mode that emits the com.zello.ptt.down/up broadcasts our PTT
// pipeline (PushService) listens for. The broadcasts are firmware-level — they
// fire whether or not Zello is installed. The annoyance is the *launch* half of
// that action: with com.zello absent the firmware deep-links to the Play Store
// listing ("Please install the Zello APP"); with the real Zello present it
// foregrounds Zello's UI. Either way an app pops up on every PTT press.
//
// This stub claims package `com.loudtalks` (Zello's real app id — the
// `com.zello` prefix only names the broadcast actions) with a single
// translucent activity that finishes instantly. getLaunchIntentForPackage(
// "com.loudtalks") now resolves to a no-op, so the firmware's launch is
// invisible — while the PTT broadcasts keep firing and Console keeps capturing
// them. Sideload-only, no update channel.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.loudtalks"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.loudtalks"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
