"""Verify that signed Android candidates can replace the selected predecessor APKs."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

PACKAGE = re.compile(r"^package: name='([^']+)' versionCode='(\d+)'", re.MULTILINE)
VERSION = re.compile(r"\bversionName='([^']*)'")
MIN_SDK = re.compile(r"^(?:minSdkVersion|sdkVersion):'([^']+)'$", re.MULTILINE)
NATIVE_CODE = re.compile(r"^native-code: (.+)$", re.MULTILINE)
SIGNER = re.compile(
    r"^(?:V\d+(?:\.\d+)? )?Signer(?: #\d+)?:? certificate SHA-256 digest: ([a-f\d]{64})$",
    re.MULTILINE | re.IGNORECASE,
)


def apk_info(path, tools, expected_id):
    path = path.resolve()
    before = path.stat()
    with path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    manifest = subprocess.run(
        [tools / "aapt2", "dump", "badging", path],
        capture_output=True, text=True, check=False,
    )
    package = PACKAGE.search(manifest.stdout)
    if manifest.returncode or not package:
        raise SystemExit(f"{path}: unable to read the APK manifest")
    application_id, code = package.groups()
    if application_id != expected_id:
        raise SystemExit(f"{path}: expected application ID {expected_id}, got {application_id}")
    minimum = MIN_SDK.search(manifest.stdout)
    if minimum and not minimum[1].isdigit():
        raise SystemExit(f"{path}: unsupported minimum Android API {minimum[1]}")
    native_code = NATIVE_CODE.search(manifest.stdout)
    abis = sorted(re.findall(r"'([^']+)'", native_code[1])) if native_code else []

    signatures = subprocess.run(
        [tools / "apksigner", "verify", "--print-certs", path],
        capture_output=True, text=True, check=False,
    )
    if signatures.returncode:
        raise SystemExit(f"{path}: APK signature verification failed")
    signers = sorted({digest.lower() for digest in SIGNER.findall(signatures.stdout)})
    if not signers:
        raise SystemExit(f"{path}: no SHA-256 signer certificate digests reported")

    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino, after.st_size, after.st_mtime_ns
    ):
        raise SystemExit(f"{path}: APK changed during verification")
    version = VERSION.search(manifest.stdout.splitlines()[0])
    return {
        "file": str(path),
        "sha256": checksum,
        "versionCode": int(code),
        "versionName": version[1] if version else None,
        "minSdk": int(minimum[1]) if minimum else 1,
        "abis": abis,
        "signerSha256": signers,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-tools", required=True, type=Path)
    parser.add_argument("--application-id", default="com.zhfahim.anchor")
    parser.add_argument("--previous", required=True, action="append", type=Path)
    parser.add_argument("candidates", nargs="+", type=Path)
    args = parser.parse_args()

    previous = [apk_info(path, args.build_tools, args.application_id) for path in args.previous]
    candidates = [apk_info(path, args.build_tools, args.application_id) for path in args.candidates]
    signers = previous[0]["signerSha256"]
    highest = max(apk["versionCode"] for apk in previous)
    for apk in previous + candidates:
        if apk["signerSha256"] != signers:
            raise SystemExit(f"{apk['file']}: signer certificate does not match the predecessor")
    for apk in candidates:
        if apk["versionCode"] <= highest:
            raise SystemExit(f"{apk['file']}: version code {apk['versionCode']} is not greater than {highest}")
    for predecessor in previous:
        for abi in predecessor["abis"] or [None]:
            if not any(
                candidate["minSdk"] <= predecessor["minSdk"]
                and (abi is None or not candidate["abis"] or abi in candidate["abis"])
                for candidate in candidates
            ):
                architecture = abi or "the predecessor"
                raise SystemExit(
                    f"{predecessor['file']}: no compatible candidate for {architecture} "
                    f"from Android API {predecessor['minSdk']}"
                )
    print(json.dumps({
        "applicationId": args.application_id,
        "highestPreviousVersionCode": highest,
        "signerSha256": signers,
        "previous": previous,
        "candidates": candidates,
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        raise SystemExit(str(error)) from error
