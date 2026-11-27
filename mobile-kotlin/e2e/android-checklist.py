"""Exercise checklist commands in the Compose editor and verify the saved Quill delta."""
import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
tunnel = 'tcp:' + port
package = 'com.zhfahim.anchor.compose'
suffix = uuid.uuid4().hex
email, password = f'checklist-{suffix}@example.test', 'Fixture' + suffix


def api(path, payload=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = json.dumps(payload).encode() if payload is not None else None
    with urllib.request.urlopen(urllib.request.Request(origin + '/api/' + path, body, headers),
                                timeout=15) as response:
        return json.load(response)


def operation(value, **attributes):
    return {'insert': value, **({'attributes': attributes} if attributes else {})}


intro = [operation('Trip'), operation('\n', header=2)]
removed = [operation('Packed'), operation('\n', list='checked', keep='line metadata'),
           operation('Shoes'), operation('\n', list='checked', indent=1)]
passport = operation('Passport', link='https://example.test/passport', bold=True)
bullet = operation('Backup ID', italic=True)
embed = [operation({'image': 'https://example.test/reference.png'}), operation('\n')]
tail = [operation('Tickets verified'), operation('\n', list='checked')]
base = {'fixtureVersion': 1, 'ops': intro + removed + [
    passport, operation('\n', list='unchecked', indent=2),
    bullet, operation('\n', list='bullet', indent=1, keep='bullet metadata'),
] + embed + tail}
unchecked = {'fixtureVersion': 1, 'ops': [
    {**op, 'attributes': {**op['attributes'], 'list': 'unchecked'}}
    if op.get('attributes', {}).get('list') == 'checked' else op
    for op in base['ops']
]}
deleted = {'fixtureVersion': 1, 'ops': intro + [
    passport, operation('\n', list='unchecked'), bullet,
    operation('\n', list='bullet', keep='bullet metadata'),
] + embed}
all_checked = {'ops': [operation('Clear me'), operation('\n', list='checked')]}
empty_checklist = {'ops': [operation('\n', list='unchecked')]}
token = api('auth/register', {'name': 'Checklist fixture', 'email': email, 'password': password})['access_token']
reuse, remove, clear = 'Checklist to reset', 'Checklist to shorten', 'Checklist all checked'
ids = {title: api('notes', {'title': title, 'content': json.dumps(delta)}, token)['id']
       for title, delta in ((reuse, base), (remove, base), (clear, all_checked))}


def command(label):
    click('Checklist actions')
    click(label)


def save_and_compare(title, expected):
    click('Save changes')
    for _ in range(40):
        note = api('notes/' + ids[title], token=token)
        if note['version'] == 2:
            assert json.loads(note['content']) == expected, (title, note['content'], expected)
            break
        time.sleep(0.5)
    else:
        raise AssertionError(f'{title} was not synced')
    click('Back to notes')


adb('reverse', tunnel, tunnel)
try:
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')

    click(reuse)
    command('Uncheck all')
    save_and_compare(reuse, unchecked)

    click(remove)
    command('Delete checked items')
    click('Undo checklist change')
    command('Delete checked items')
    find('Undo checklist change')
    result.with_name(result.stem + '-after-delete.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    save_and_compare(remove, deleted)

    click(clear)
    command('Delete checked items')
    save_and_compare(clear, empty_checklist)
    result.write_text(json.dumps({'resetAllCheckedItems': True, 'undoRestoredCheckedItems': True,
                                  'deleteOutdentedSurvivingChildren': True, 'quillLinksAndEmbedsRetained': True,
                                  'allCheckedLeftOneOpenItem': True}, indent=2) + '\n')
finally:
    adb('reverse', '--remove', tunnel)
