plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
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
        val vCode = 112
        versionCode = vCode
        versionName = "0.2.$vCode"
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
        compose = true
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
        }
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            // Pin the forked test JVM rather than inheriting a machine-dependent
            // default: at 987 tests the suite OOM'd here (23 GiB desktop) while
            // passing on forge (64 GiB), so a fork's green run said nothing about
            // the parent's. Robolectric accumulates a sandbox + classloader per
            // SDK/config combo, so forkEvery caps the live set as the suite grows.
            all {
                it.maxHeapSize = "3g"
                it.forkEvery = 40
            }
        }
    }

    // Room schema JSONs reach MigrationTestHelper via a symlink at
    // src/test/assets/io.amar.console.data.db.ConsoleDb → ../schemas/…
}

// Room: export schema JSON for migration tests.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.core.splashscreen)
    implementation(libs.activity.ktx)
    implementation(libs.activity.compose)
    implementation(libs.browser)
    implementation(libs.okhttp)
    implementation(libs.security.crypto)

    val composeBom = platform(libs.compose.bom)
    implementation(composeBom)
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.navigation.compose)

    implementation(libs.lifecycle.process)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)
    implementation(libs.coil.compose)
    implementation(libs.coil.svg)
    implementation(libs.coil.gif)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.maplibre)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.room.testing)
}
