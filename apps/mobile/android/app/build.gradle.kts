import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing (apps/mobile/README.md, "Release builds"): android/key.properties
// on a developer's machine, or ANDROID_KEYSTORE_* environment variables in CI.
// Neither is ever committed (.gitignore). Without them a release build is
// debug-signed, which is fine for `flutter run --release` on a test phone, and
// building a Play Store bundle (bundleRelease) is refused.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingValue(property: String, env: String): String? =
    keystoreProperties.getProperty(property) ?: System.getenv(env)

val releaseStoreFile = signingValue("storeFile", "ANDROID_KEYSTORE_FILE")
val hasReleaseKey = releaseStoreFile != null

android {
    namespace = "com.amarelaka.amar_elaka_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // The Play Store identity: never changes once published.
        applicationId = "com.amarelaka.amar_elaka_app"
        // Android 8.0 (API 26) minimum, per the platform's device-support target.
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig =
                if (hasReleaseKey) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }
}

// A debug-signed bundle can never be updated on the Play Store: refuse it.
gradle.taskGraph.whenReady {
    if (!hasReleaseKey && allTasks.any { it.name.startsWith("bundleRelease") }) {
        throw GradleException(
            "bundleRelease needs the upload key: add android/key.properties or the " +
                "ANDROID_KEYSTORE_* environment variables (apps/mobile/README.md, Release builds)."
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
