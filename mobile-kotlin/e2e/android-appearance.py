"""Verify app and note colors, offline preferences and Android system-bar appearance."""
import json
import shlex
import struct
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import account_action, adb, center, click, find, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
tunnel = 'tcp:' + port
package = 'com.zhfahim.anchor.compose'
suffix = uuid.uuid4().hex
email, password = f'appearance-{suffix}@example.test', 'Fixture' + suffix
title = 'Teal appearance fixture'
light, dark = bytes.fromhex('f0f4f8'), bytes.fromhex('111214')
teal_light, teal_dark = bytes.fromhex('daf7f6'), bytes.fromhex('083232')


def post(path, payload, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(origin + '/api/' + path, json.dumps(payload).encode(), headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def start():
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')


def stop():
    shell('am', 'force-stop', package)


def expect_colors(background, card):
    row = int(center(find(title))[1])
    for _ in range(8):
        raw = adb('exec-out', 'screencap')
        width, height, fmt = struct.unpack_from('<III', raw)
        header = len(raw) - width * height * 4
        assert fmt == 1 and header in (12, 16)
        offset = header + (row * width + 23) * 4
        page = header + (300 * width + 2) * 4
        if raw[page:page + 3] == background and raw[offset:offset + 3] == card:
            clock = [raw[header + (y * width + x) * 4] for y in range(5, 22) for x in range(15, 65)]
            if (max(clock) if background == dark else 255 - min(clock)) >= 155:
                return
        # A system appearance change may recreate the activity.
        row = int(center(find(title))[1])
    raise AssertionError((background.hex(), card.hex(), raw[page:page + 3].hex(), raw[offset:offset + 3].hex()))


def appearance(choice):
    account_action('Settings')
    find('Appearance')
    click(choice)
    click('Back to notes')


def preferences(theme):
    for _ in range(16):
        current = shell('run-as', package, 'cat', 'files/note-layout').decode().splitlines()
        if current == ['List', 'TitleAscending', theme, 'true', 'false', 'Sans', 'Default', 'true', 'Standard']:
            return
        time.sleep(0.25)
    raise AssertionError(current)


token = post('auth/register', {'name': 'Appearance fixture', 'email': email, 'password': password})['access_token']
post('notes', {'title': title, 'background': 'color_teal'}, token)
adb('reverse', tunnel, tunnel)
try:
    shell('cmd', 'uimode', 'night', 'no')
    stop()
    script = """mkdir -p files/share
printf 'List\nTitleAscending' > files/note-layout
printf '%s' '{"version":1,"theme":"dark","density":"standard","tags":[]}' > files/share/context.json"""
    shell('run-as', package, 'sh', '-c', shlex.quote(script))
    start()
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    expect_colors(dark, teal_dark)
    appearance('Light')
    expect_colors(light, teal_light)
    preferences('Light')
    stop()
    start()
    expect_colors(light, teal_light)
    appearance('Dark')
    expect_colors(dark, teal_dark)
    preferences('Dark')
    result.with_name(result.stem + '-dark.png').write_bytes(adb('exec-out', 'screencap', '-p'))

    adb('reverse', '--remove', tunnel)
    stop()
    start()
    expect_colors(dark, teal_dark)
    adb('reverse', tunnel, tunnel)
    shell('cmd', 'uimode', 'night', 'yes')
    expect_colors(dark, teal_dark)
    appearance('Light')
    expect_colors(light, teal_light)
    preferences('Light')
    result.with_name(result.stem + '-light.png').write_bytes(adb('exec-out', 'screencap', '-p'))

    appearance('Match system')
    expect_colors(dark, teal_dark)
    preferences('System')
    shell('cmd', 'uimode', 'night', 'no')
    expect_colors(light, teal_light)
    result.write_text(json.dumps({'twoLinePreferencesRetained': True, 'forcedDarkAndLight': True,
                                  'legacyThemeInherited': True, 'explicitThemeOverridesLegacyOnRestart': True,
                                  'coloredCardsMatchedTheApp': True, 'offlineRestartRetainedTheme': True,
                                  'matchSystemReactsToChanges': True, 'statusBarIconsMatchedTheme': True}, indent=2) + '\n')
finally:
    shell('cmd', 'uimode', 'night', 'no')
    if tunnel in adb('reverse', '--list').decode().split():
        adb('reverse', '--remove', tunnel)
