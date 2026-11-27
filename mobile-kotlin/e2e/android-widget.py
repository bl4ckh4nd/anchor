"""Run on a fresh API 35 Pixel Launcher emulator (720x2160) with disposable Convex."""
import json
import re
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path
from xml.etree import ElementTree

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
package = 'com.zhfahim.anchor.compose'
component = package + '/com.zhfahim.anchor.widget.NotesWidgetProvider'
tunnel = 'tcp:' + port
suffix = uuid.uuid4().hex
email = f'widget-{suffix}@example.test'
password = 'Fixture' + suffix


def adb(*args):
    return subprocess.check_output(['adb', *args], timeout=20)


def shell(*args):
    return adb('shell', *args)


def api(path, payload, token=None, method='POST'):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(
        origin + '/api/' + path, json.dumps(payload).encode() if payload is not None else None,
        headers, method=method
    ), timeout=15) as response:
        return json.load(response)


def nodes():
    path = '/data/local/tmp/anchor-widget.xml'
    xml = shell('sh', '-c', f"'rm -f {path}; uiautomator dump {path} >/dev/null 2>&1;"
                f" if [ -s {path} ]; then cat {path}; fi'")
    return list(ElementTree.fromstring(xml).iter('node')) if xml else []


def center(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    return str((left + right) // 2), str((top + bottom) // 2)


def find(label, resource=None):
    seen = []
    for _ in range(8):
        seen = nodes()
        for node in seen:
            if label in (node.get('text'), node.get('content-desc')) and (
                resource is None or node.get('resource-id', '').endswith('/' + resource)
            ):
                return node
    shown = [(n.get('text'), n.get('content-desc')) for n in seen
             if n.get('class') != 'android.widget.EditText']
    raise AssertionError((label, resource, shown))


def click(label, resource=None):
    shell('input', 'tap', *center(find(label, resource)))


def hold(x, y):
    shell('input', 'swipe', x, y, x, y, '900')


def type_in(index, value):
    for _ in range(3):
        fields = [n for n in nodes() if n.get('class') == 'android.widget.EditText']
        shell('input', 'tap', *center(fields[index]))
        assert any(n.get('focused') == 'true' and n.get('class') == 'android.widget.EditText' for n in nodes())
        shell('input', 'keycombination', '113', '29')  # Control+A
        shell('input', 'text', value)
        updated = [n for n in nodes() if n.get('class') == 'android.widget.EditText'][index]
        if updated.get('text') == value or (updated.get('password') == 'true' and
                                            len(updated.get('text', '')) == len(value)):
            return
    raise AssertionError(f'Could not populate sign-in field {index + 1}')


assert component in shell('dumpsys', 'appwidget').decode(), 'Notes provider is missing from the installed APK'

title = 'Pinned widget fixture'
private_title = 'Archived widget fixture'
account = api('auth/register', {'name': 'Widget fixture', 'email': email, 'password': password})
token = account['access_token']
api('notes', {
    'title': title,
    'content': json.dumps({'ops': [{'insert': 'Widget body fixture\n'}]}),
    'isPinned': True,
    'background': 'color_teal',
}, token)
archived = api('notes', {'title': private_title}, token)
api('notes/' + archived['id'], {'isArchived': True}, token, method='PATCH')
adb('reverse', tunnel, tunnel)

try:
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    find(title)

    shell('input', 'keyevent', 'HOME')
    find('Home')
    hold('615', '1200')
    click('Widgets')
    click('Anchor Compose')
    click('Notes widget, 3 wide by 3 high See your notes and start a new one from the home screen.')
    click('Add Notes widget')
    find(title, 'item_title')
    assert not any(n.get('text') == private_title for n in nodes())
    find('Widget body fixture', 'item_snippet')
    result.with_name(result.stem + '-light.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('cmd', 'uimode', 'night', 'yes')
    find(title, 'item_title')
    result.with_name(result.stem + '-dark.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('cmd', 'uimode', 'night', 'no')
    find(title, 'item_title')
    original_pid = shell('pidof', package).decode().strip()
    assert original_pid.isdecimal()
    shell('run-as', package, 'kill', '-9', original_pid)
    click(title, 'item_title')
    find('More actions')
    find('Widget body fixture\n')
    assert shell('pidof', package).decode().strip() != original_pid

    shell('input', 'keyevent', 'HOME')
    click('New note', 'widget_new_note')
    find('Save note')
    assert any(n.get('focused') == 'true' and n.get('class') == 'android.widget.EditText' for n in nodes())
    shell('input', 'text', 'Widget%screated')
    shell('input', 'keyevent', '4')
    click('Save note')
    find('Widget created')
    assert any(note['title'] == 'Widget created' for note in api('notes', None, token, method='GET'))
    click('Open menu')
    click('Account menu')
    click('Sign out')
    find('Sign in')
    shell('input', 'keyevent', 'HOME')
    find('Sign in to Anchor\nto see your notes here.', 'widget_empty')
    assert not any(n.get('text') in (title, 'Widget created') or n.get('resource-id', '').endswith('/widget_new_note')
                   for n in nodes())
    result.write_text(json.dumps({
        'pinnedNoteAndSnippet': True, 'archivedNoteExcluded': True,
        'openedAfterProcessExit': True, 'createdFromWidget': True, 'clearedOnSignOut': True,
    }, indent=2) + '\n')
finally:
    shell('cmd', 'uimode', 'night', 'no')
    adb('reverse', '--remove', tunnel)
