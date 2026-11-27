#!/usr/bin/env bash
set -euo pipefail

output="$(realpath -m -- "${1:?Pass the output APK path}")"
sdk="${ANDROID_HOME:?Set ANDROID_HOME}"
android_jar="$sdk/platforms/android-37.0/android.jar"
build_tools="$(find -H "$sdk/build-tools" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -n 1)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
cd -- "$scratch"

cat > AndroidManifest.xml <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="anchor.share.fixture">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="35" />
  <application android:label="Share verifier">
    <activity android:name=".Receive" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="image/*" />
        <data android:mimeType="audio/*" />
      </intent-filter>
    </activity>
  </application>
</manifest>
XML
cat > Receive.java <<'JAVA'
package anchor.share.fixture;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.provider.OpenableColumns;
import android.widget.TextView;
import java.io.InputStream;
import java.security.MessageDigest;

public final class Receive extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        TextView result = new TextView(this);
        setContentView(result);
        try {
            Intent intent = getIntent();
            Uri source = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (!"content".equals(source.getScheme())
                    || checkUriPermission(source, Process.myPid(), Process.myUid(),
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED) {
                throw new IllegalArgumentException("Expected read-only content URI");
            }
            String name;
            try (Cursor row = getContentResolver().query(source,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (!row.moveToFirst()) throw new IllegalArgumentException("Missing filename");
                name = row.getString(0);
            }
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            try (InputStream stream = getContentResolver().openInputStream(source)) {
                byte[] bytes = new byte[8192];
                int length;
                while ((length = stream.read(bytes)) != -1) sha.update(bytes, 0, length);
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : sha.digest()) hash.append(String.format("%02x", value & 0xff));
            result.setText(intent.getType() + " " + name + " " + hash);
        } catch (Exception error) {
            result.setText("Share failed: " + error.getClass().getSimpleName());
        }
    }
}
JAVA

javac --release 8 -classpath "$android_jar" -d . Receive.java
"$build_tools/d8" --lib "$android_jar" --output . anchor/share/fixture/Receive.class
"$build_tools/aapt" package -f -M AndroidManifest.xml -I "$android_jar" -F unsigned.apk
"$build_tools/aapt" add unsigned.apk classes.dex
"$build_tools/zipalign" -f 4 unsigned.apk aligned.apk
keytool -genkeypair -keystore fixture.p12 -storepass fixtures -alias fixture \
    -keyalg RSA -keysize 2048 -validity 30 -dname "CN=Anchor test recipient"
"$build_tools/apksigner" sign --ks fixture.p12 --ks-pass pass:fixtures --out "$output" aligned.apk
