"""Verify note patterns on a fresh 390x1400 dp Android emulator with disposable Convex."""
import json
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
package = 'com.zhfahim.anchor.compose'
tunnel = 'tcp:' + port
suffix = uuid.uuid4().hex
email = f'patterns-{suffix}@example.test'
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
    path = '/data/local/tmp/anchor-patterns.xml'
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
            if label in ((node.get('text') or '').split('\n')[0], node.get('content-desc')) and (
                resource is None or node.get('resource-id', '').endswith('/' + resource)
            ):
                return node
    shown = [(n.get('text'), n.get('content-desc')) for n in seen
             if n.get('class') != 'android.widget.EditText']
    raise AssertionError((label, resource, shown))


def click(label, resource=None):
    shell('input', 'tap', *center(find(label, resource)))


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



def chosen_background(name, saved_note=True):
    """The background sheet marks the swatch announced as name as the chosen one."""
    if saved_note:
        click('More actions')
    click('Background')
    find('Pattern')
    swatch = find(name)
    chosen = swatch.get('checked') == 'true' or swatch.get('selected') == 'true'
    shell('input', 'keyevent', '4')
    assert chosen, f'{name}: {swatch.attrib}'
    return chosen


patterns = ('Dots', 'Grid', 'Lines', 'Waves', 'Groceries', 'Music', 'Travel', 'Code')
css = (Path(__file__).resolve().parents[2] / 'web/app/styles/notes.css').read_text()


def colors(name, dark):
    selector = ('.dark ' if dark else '') + f'[data-note="pattern_{name.lower()}"]'
    block = re.search(r'^' + re.escape(selector) + r' \{([^}]+)\}', css, re.M)[1]
    return tuple(tuple(bytes.fromhex(re.search(r'--' + key + r': #([0-9a-f]{6});', block)[1]))
                 for key in ('note', 'note-pattern'))


def capture():
    return Image.open(BytesIO(adb('exec-out', 'screencap', '-p'))).convert('RGB')


def bounds(node):
    return tuple(map(int, re.findall(r'\d+', node.get('bounds'))))


def card(screen_nodes, title):
    return next(n for n in screen_nodes if n.get('clickable') == 'true' and
                any(child.get('text') == title for child in n.iter('node')))


def assert_pattern(screen, area, expected):
    left, top, right, bottom = area
    crop = screen.crop((left + 5, top + 5, right - 5, bottom - 5))
    counts = {pixel: count for count, pixel in crop.getcolors(crop.width * crop.height)}
    fill, pattern = expected
    assert counts.get(fill, 0) > 500 and counts.get(pattern, 0) > 8, (
        area, counts.get(fill, 0), counts.get(pattern, 0),
    )


account = api('auth/register', {'name': 'Pattern fixture', 'email': email, 'password': password})
fixtures = {}
for name in patterns:
    fixtures[name] = api('notes', {
        'title': name + ' note',
        'content': json.dumps({'ops': [{'insert': 'Preview of the ' + name.lower() + ' background.\n'}]}),
        'background': 'pattern_' + name.lower(),
    }, account['access_token'])

adb('reverse', tunnel, tunnel)
try:
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    find('Dots note')
    for dark in (False, True):
        shell('cmd', 'uimode', 'night', 'yes' if dark else 'no')
        find('Dots note')
        screen_nodes = nodes()
        screen = capture()
        for name in patterns:
            assert_pattern(screen, bounds(card(screen_nodes, name + ' note')), colors(name, dark))
        screen.save(result.with_name(result.stem + ('-dark.png' if dark else '-light.png')))
        if not dark:
            adb('reverse', '--remove', tunnel)
            shell('am', 'force-stop', package)
            shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')

    click('Code note')
    find('More actions')
    body = [n for n in nodes() if n.get('class') == 'android.widget.EditText'][1]
    assert_pattern(capture(), bounds(body), colors('Code', True))
    result.with_name(result.stem + '-editor.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    click('More actions')
    click('Background')
    find('Travel')
    result.with_name(result.stem + '-picker.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    click('Travel')
    find('Save changes')
    click('Back to notes')
    click('Keep editing')
    find('Save changes')
    body = [n for n in nodes() if n.get('class') == 'android.widget.EditText'][1]
    preview = capture()
    preview.save(result.with_name(result.stem + '-preview.png'))
    assert_pattern(preview, bounds(body), colors('Travel', True))
    click('Save changes')
    find('Saved on device')
    click('Back to notes')
    find('Pending notes')
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    find('Pending notes')

    def synced_background(name, expected, version):
        for _ in range(45):
            saved = api('notes/' + fixtures[name]['id'], None, account['access_token'], method='GET')
            if saved['version'] == version:
                assert saved['background'] == expected, saved
                assert saved['content'] == fixtures[name]['content'], saved
                return
            time.sleep(0.5)
        raise AssertionError(f'{name} note did not sync background {expected}')

    adb('reverse', tunnel, tunnel)
    synced_background('Code', 'pattern_travel', 2)
    click('Open menu')
    click('Sync notes')
    shell('input', 'tap', *center(card(nodes(), 'Code note')))
    assert chosen_background('Travel')
    click('More actions')
    click('Background')
    click('Default')
    click('Save changes')
    synced_background('Code', None, 3)
    click('Back to notes')
    adb('reverse', '--remove', tunnel)
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    click('New note')
    type_in(0, 'New-pattern-fixture')
    shell('input', 'keyevent', '4')
    click('Background')
    click('Music')
    click('Save note')
    find('Pending notes')
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    find('Pending notes')
    adb('reverse', tunnel, tunnel)
    find('Pending notes sent.')
    click('Open menu')
    click('Sync notes')
    find('New-pattern-fixture')
    assert_pattern(capture(), bounds(card(nodes(), 'New-pattern-fixture')), colors('Music', True))
    click('New note')
    assert chosen_background('Default', saved_note=False)
    result.write_text(json.dumps({'lightPatterns': list(patterns), 'darkPatterns': list(patterns),
                                  'offlineRestart': True, 'patternInNoteAndEditor': 'Code',
                                  'queuedBackground': 'pattern_travel', 'resetBackground': None,
                                  'createdBackground': 'pattern_music'}, indent=2) + '\n')
finally:
    shell('cmd', 'uimode', 'night', 'no')
    subprocess.run(['adb', 'reverse', '--remove', tunnel], capture_output=True, timeout=10)
