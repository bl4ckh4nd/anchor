#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
case "$(uname -sm)" in
  "Linux x86_64") sqlite_target=linux_x64 ;;
  "Linux aarch64") sqlite_target=linux_arm64 ;;
  *) printf '%s\n' "The Room upgrade host check requires Linux x86_64 or ARM64." >&2; exit 1 ;;
esac

sqlite_version="$(sed -nE 's/.*implementation\("androidx\.sqlite:sqlite-bundled:([^"]+)"\).*/\1/p' shared/build.gradle.kts)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
artifact="https://dl.google.com/dl/android/maven2/androidx/sqlite/sqlite-bundled-jvm/${sqlite_version}/sqlite-bundled-jvm-${sqlite_version}.jar"
curl -fsSL "$artifact" -o "$scratch/sqlite.jar"
unzip -p "$scratch/sqlite.jar" "natives/$sqlite_target/libsqliteJni.so" > "$scratch/libsqliteJni.so"

cat > "$scratch/host.gradle" <<'GRADLE'
allprojects {
    tasks.withType(Test).configureEach {
        systemProperty 'androidx.sqlite.driver.bundled.path', System.getenv('ANCHOR_UPGRADE_TEST_NATIVE')
        systemProperty 'androidx.sqlite.driver.bundled.name', 'libsqliteJni.so'
    }
}
GRADLE

ANCHOR_UPGRADE_TEST_NATIVE="$scratch" ./gradlew -I "$scratch/host.gradle" :shared:testAndroidHostTest "$@"
