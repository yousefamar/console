plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.amar.console"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.amar.console"
        minSdk = 26
        targetSdk = 35
        // Keep the patch segment synced to versionCode so the user-visible
        // string directly reveals the integer version. If you bump one,
        // bump the other.
        val vCode = 14
        versionCode = vCode
        versionName = "0.1.$vCode"
    }

    signingConfigs {
        create("release") {
            val keystorePath = System.getenv("CONSOLE_KEYSTORE_PATH")
                ?: "${System.getProperty("user.home")}/.config/console/console-release.jks"
            val kf = file(keystorePath)
            if (kf.exists()) {
                storeFile = kf
                storePassword = System.getenv("CONSOLE_KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("CONSOLE_KEY_ALIAS") ?: "console"
                keyPassword = System.getenv("CONSOLE_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            val releaseConfig = signingConfigs.getByName("release")
            if (releaseConfig.storeFile?.exists() == true) {
                signingConfig = releaseConfig
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // Persistent WebSocket client for push notifications
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
