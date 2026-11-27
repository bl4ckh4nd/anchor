"""Check the Compose iOS release bundle and, optionally, its upgrade signing identity."""
import argparse
import json
import plistlib
import shutil
import subprocess
from pathlib import Path


def read_plist(path):
    with path.open("rb") as source:
        return plistlib.load(source)


def require(condition, problem):
    if not condition:
        raise SystemExit(problem)


APP_GROUP = "group.com.zhfahim.anchor"


def signed_identity(codesign, bundle, bundle_id):
    verified = subprocess.run(
        [codesign, "--verify", "--strict", "-R=anchor apple generic", bundle],
        capture_output=True, text=True, check=False,
    )
    require(verified.returncode == 0, f"{bundle}: code signature verification failed: {verified.stderr.strip()}")
    display = subprocess.run(
        [codesign, "--display", "--verbose=4", "--entitlements", ":-", bundle],
        capture_output=True, check=False,
    )
    require(display.returncode == 0 and display.stdout, f"{bundle}: could not read signed entitlements")
    try:
        entitlements = plistlib.loads(display.stdout)
    except plistlib.InvalidFileException:
        raise SystemExit(f"{bundle}: invalid signed entitlements") from None
    require(isinstance(entitlements, dict), f"{bundle}: invalid signed entitlements")

    identifier = entitlements.get("application-identifier")
    suffix = "." + bundle_id
    require(isinstance(identifier, str) and identifier.endswith(suffix) and len(identifier) > len(suffix),
            f"{bundle}: signed application-identifier does not match {bundle_id}")
    team = entitlements.get("com.apple.developer.team-identifier")
    teams = [line.removeprefix("TeamIdentifier=") for line in display.stderr.decode(errors="replace").splitlines()
             if line.startswith("TeamIdentifier=")]
    require(isinstance(team, str) and team and team != "not set" and teams == [team],
            f"{bundle}: signing team differs from the signed entitlement")
    groups = entitlements.get("com.apple.security.application-groups")
    require(isinstance(groups, list) and APP_GROUP in groups,
            f"{bundle}: missing signed Anchor App Group entitlement")
    return {"applicationIdentifier": identifier, "teamIdentifier": team}


def signed_upgrade(previous, candidate, candidate_extension, app, extension):
    codesign = shutil.which("codesign")
    require(codesign, "Signed iOS verification requires codesign on macOS")
    previous_info = read_plist(previous / "Info.plist")
    app_id = app["CFBundleIdentifier"]
    extension_id = extension["CFBundleIdentifier"]
    require(previous_info["CFBundleIdentifier"] == app_id, "Incorrect signed predecessor app bundle ID")
    previous_extensions = [
        (bundle, read_plist(bundle / "Info.plist"))
        for bundle in (previous / "PlugIns").glob("*.appex")
    ]
    predecessors = [
        (bundle, info) for bundle, info in previous_extensions
        if info["CFBundleIdentifier"] == extension_id
    ]
    require(len(predecessors) == 1, "The signed predecessor must contain the Anchor Share Extension")
    previous_extension, previous_extension_info = predecessors[0]
    require(int(app["CFBundleVersion"]) > max(
        int(previous_info["CFBundleVersion"]), int(previous_extension_info["CFBundleVersion"]),
    ), "Release build must be newer than the signed predecessor")

    report = {"previousBuild": previous_info["CFBundleVersion"]}
    for name, old, new, bundle_id in (
        ("app", previous, candidate, app_id),
        ("shareExtension", previous_extension, candidate_extension, extension_id),
    ):
        old_identity = signed_identity(codesign, old, bundle_id)
        new_identity = signed_identity(codesign, new, bundle_id)
        require(old_identity["applicationIdentifier"] == new_identity["applicationIdentifier"],
                f"{new}: signed application-identifier differs from the predecessor")
        require(old_identity["teamIdentifier"] == new_identity["teamIdentifier"],
                f"{new}: signing team differs from the predecessor")
        report[name] = new_identity
    require(report["app"]["teamIdentifier"] == report["shareExtension"]["teamIdentifier"],
            "The app and its share extension must have the same signing team")
    return report


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("app", type=Path)
parser.add_argument("generated", type=Path)
parser.add_argument("--previous-app", type=Path)
parser.add_argument("--platform", choices=("iPhoneOS", "iPhoneSimulator"))
args = parser.parse_args()
app_path = args.app.resolve()
generated = args.generated
extension_path = app_path / "PlugIns/AnchorShareExtension.appex"
app = read_plist(app_path / "Info.plist")
extension = read_plist(extension_path / "Info.plist")

require(app["CFBundleIdentifier"] == "com.zhfahim.anchor", "Incorrect release app bundle ID")
require(extension["CFBundleIdentifier"] == "com.zhfahim.anchor.ShareExtension", "Incorrect release extension bundle ID")
require(int(app["CFBundleVersion"]) > 27, "Release build must be newer than Flutter exporter build 27")
for name, info in (("app", app), ("extension", extension)):
    if args.platform:
        require(info.get("CFBundleSupportedPlatforms") == [args.platform],
                f"The {name} must target {args.platform}")
    require(set(info["UIDeviceFamily"]) == {1, 2}, f"The {name} must support both iPhone and iPad")
    require(info["MinimumOSVersion"] == "15.0", f"The {name} must retain the iOS 15.0 deployment target")
    for key in ("CFBundleVersion", "CFBundleShortVersionString"):
        require(info[key] == app[key], f"The {name} differs from the app in {key}")

schemes = {scheme for item in app["CFBundleURLTypes"] for scheme in item["CFBundleURLSchemes"]}
require("com.zhfahim.anchor.compose" in schemes, "The app must register its Compose OIDC callback scheme")
require(extension["AnchorShareNamespace"] == "compose", "The extension must write to the Compose share inbox")
share = extension["NSExtension"]
require(share["NSExtensionPointIdentifier"] == "com.apple.share-services", "Incorrect share extension point")
require(share["NSExtensionPrincipalClass"] == "ShareViewController", "Incorrect share extension controller")
rule = share["NSExtensionAttributes"]["NSExtensionActivationRule"]
for media_type in ("public.image", "public.audio", "public.url", "public.plain-text"):
    require(media_type in rule, f"The share activation rule must include {media_type}")

for filename in ("AnchorIOS.entitlements", "ShareExtension.entitlements"):
    entitlements = read_plist(generated / filename)
    require(entitlements["com.apple.security.application-groups"] == [APP_GROUP],
            f"{filename} must use the existing Anchor App Group")

report = {
    "app": app["CFBundleIdentifier"],
    "shareExtension": extension["CFBundleIdentifier"],
    "build": app["CFBundleVersion"],
    "version": app["CFBundleShortVersionString"],
    "deviceFamilies": sorted(app["UIDeviceFamily"]),
    "appGroup": APP_GROUP,
}
if args.previous_app:
    report["signedUpgrade"] = signed_upgrade(args.previous_app.resolve(), app_path, extension_path, app, extension)
if args.platform:
    report["platform"] = args.platform
print(json.dumps(report, indent=2))
