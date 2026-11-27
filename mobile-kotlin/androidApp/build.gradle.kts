plugins {
    id("com.android.application")
    kotlin("plugin.compose")
}

val releaseKeystore = providers.environmentVariable("ANCHOR_ANDROID_KEYSTORE")

android {
    namespace = "anchor"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.zhfahim.anchor"
        minSdk = 24
        targetSdk = 36
        // Reserve Flutter build 27, including the x86_64 split code 4027, for the exporter.
        versionCode = 4028
        versionName = providers.gradleProperty("anchorVersion").getOrElse("0.18.3")
    }
    if (releaseKeystore.isPresent) {
        signingConfigs.create("release") {
            storeFile = file(releaseKeystore.get())
            storePassword = providers.environmentVariable("ANCHOR_ANDROID_STORE_PASSWORD").get()
            keyAlias = providers.environmentVariable("ANCHOR_ANDROID_KEY_ALIAS").get()
            keyPassword = providers.environmentVariable("ANCHOR_ANDROID_KEY_PASSWORD").get()
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".compose" }
        release { signingConfig = signingConfigs.findByName("release") }
    }
    if (providers.gradleProperty("anchorSplitApks").isPresent) {
        splits.abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = true
        }
    }
}

dependencies {
    implementation(project(":shared"))
    implementation("androidx.activity:activity-compose:1.12.4")
}
