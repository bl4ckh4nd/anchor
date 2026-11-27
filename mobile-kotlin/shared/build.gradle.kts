plugins {
    id("com.google.devtools.ksp")
    id("androidx.room")
    kotlin("multiplatform")
    id("com.android.kotlin.multiplatform.library")
    kotlin("plugin.compose")
    id("org.jetbrains.compose")
}

val anchorResourceDirectory = layout.buildDirectory.dir("anchor-resources")
val anchorResources by tasks.registering(Sync::class) {
    val source = layout.projectDirectory.dir("../assets/fonts")
    val fontFiles = mapOf(
        "DMSans-Variable.ttf" to "dm_sans.ttf",
        "DMSans-VariableItalic.ttf" to "dm_sans_italic.ttf",
        "Literata-Regular.ttf" to "literata.ttf",
        "Literata-Italic.ttf" to "literata_italic.ttf",
        "Literata-Medium.ttf" to "literata_medium.ttf",
        "Literata-SemiBold.ttf" to "literata_semibold.ttf",
        "Literata-Bold.ttf" to "literata_bold.ttf",
        "Literata-BoldItalic.ttf" to "literata_bold_italic.ttf",
        "JetBrainsMono-Regular.ttf" to "jetbrains_mono.ttf",
        "JetBrainsMono-Bold.ttf" to "jetbrains_mono_bold.ttf",
        "JetBrainsMono-Italic.ttf" to "jetbrains_mono_italic.ttf",
        "JetBrainsMono-BoldItalic.ttf" to "jetbrains_mono_bold_italic.ttf",
    )
    from(source) {
        include(fontFiles.keys)
        into("font")
        rename { checkNotNull(fontFiles[it]) }
    }
    from(source) {
        include("OFL-DMSans.txt", "OFL-JetBrainsMono.txt", "OFL-Literata.txt")
        into("files/licenses")
    }
    from(layout.projectDirectory.dir("src/commonMain/composeResources"))
    into(anchorResourceDirectory)
}

compose.resources {
    packageOfResClass = "anchor.resources"
    customDirectory("commonMain", anchorResources.map { anchorResourceDirectory.get() })
}

kotlin {
    android {
        namespace = "anchor.shared"
        compileSdk = 37
        minSdk = 24
        androidResources.enable = true
        withHostTest { isReturnDefaultValues = true }
    }
    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        target.binaries.framework {
            baseName = "AnchorShared"
            isStatic = true
        }
    }
    sourceSets {
        getByName("androidHostTest").dependencies { implementation("junit:junit:4.13.2") }
        getByName("iosSimulatorArm64Test").dependencies { implementation(kotlin("test")) }
        androidMain.dependencies {
            implementation("androidx.activity:activity-compose:1.12.4")
            implementation("io.ktor:ktor-client-okhttp:3.4.3")
        }
        iosMain.dependencies { implementation("io.ktor:ktor-client-darwin:3.4.3") }
        commonMain.dependencies {
            implementation("org.jetbrains.androidx.lifecycle:lifecycle-runtime-compose:2.9.6")
            implementation("androidx.room:room-runtime:2.8.5")
            implementation("androidx.sqlite:sqlite-bundled:2.6.2")
            implementation("io.ktor:ktor-client-core:3.4.3")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
            implementation("org.jetbrains.compose.foundation:foundation:1.12.2")
            implementation(compose.components.resources)
            implementation("org.jetbrains.compose.material3:material3:1.9.0")
        }
    }
}

dependencies {
    listOf("kspAndroid", "kspIosArm64", "kspIosSimulatorArm64").forEach {
        add(it, "androidx.room:room-compiler:2.8.5")
    }
}

room { schemaDirectory("$projectDir/schemas") }
