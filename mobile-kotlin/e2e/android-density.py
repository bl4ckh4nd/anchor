"""Verify display density from the settings screen through an offline Android restart."""
import json
import shlex
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import account_action, adb, center, click, find, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = "http://127.0.0.1:" + port
tunnel = "tcp:" + port
package = "com.zhfahim.anchor.compose"
suffix = uuid.uuid4().hex
email, password = f"density-{suffix}@example.test", "Fixture" + suffix
titles = ("Alpine trail", "Bay loop", "Coastal path")
body = {"ops": [{"insert": "Start at the station.\nBring a paper map.\nStay on the marked trail.\n"}]}


def post(path, payload, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + "/api/" + path, json.dumps(payload).encode(), headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def start():
    shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")


def stop():
    shell("am", "force-stop", package)


def distance():
    positions = [int(center(find(title))[1]) for title in titles]
    assert positions == sorted(positions), positions
    return positions[1] - positions[0]


def preference(mode):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        stored = shell("run-as", package, "cat", "files/note-layout").decode().splitlines()
        if len(stored) == 9 and stored[8] == mode:
            assert stored[:2] == ["List", "TitleAscending"]
            return
        time.sleep(0.2)
    raise AssertionError(stored)


def density(mode):
    account_action("Settings")
    find("Display density")
    click(mode)
    click("Back to notes")


token = post("auth/register", {"name": "Density fixture", "email": email, "password": password})["access_token"]
for title in titles:
    post("notes", {"title": title, "content": json.dumps(body)}, token)

adb("reverse", tunnel, tunnel)
try:
    stop()
    setup = """mkdir -p files/share
printf 'List\nTitleAscending' > files/note-layout
printf '%s' '{"density":"compact"}' > files/share/context.json"""
    shell("run-as", package, "sh", "-c", shlex.quote(setup))
    start()
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    inherited = distance()
    density("Standard")
    standard = distance()
    result.with_name(result.stem + "-standard.png").write_bytes(adb("exec-out", "screencap", "-p"))
    density("Compact")
    compact = distance()
    assert compact + 4 < standard, (standard, compact)
    assert compact == inherited
    preference("Compact")
    result.with_name(result.stem + "-compact.png").write_bytes(adb("exec-out", "screencap", "-p"))

    adb("reverse", "--remove", tunnel)
    stop()
    start()
    assert distance() == compact
    click(titles[0])
    find("More actions")
    click("Back to notes")
    density("Standard")
    assert distance() == standard
    preference("Standard")
    result.write_text(json.dumps({
        "shorterRows": True,
        "legacySharePreferenceInherited": True,
        "offlineRestartKeptCompact": True,
        "noteStillOpens": True,
        "standardRestored": True,
        "standardRowDistancePx": standard,
        "compactRowDistancePx": compact,
    }, indent=2) + "\n")
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
