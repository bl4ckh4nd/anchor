"""Check note-card image order, the appearance preference and the offline cache."""
import base64
import json
import sys
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import account_action, adb, choose_layout, click, find, nodes, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
tunnel = 'tcp:' + port
package = 'com.zhfahim.anchor.compose'
title = 'Card picture fixture'
suffix = uuid.uuid4().hex
email, password = f'pictures-{suffix}@example.test', 'Fixture' + suffix
fixture = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOQ6N5OFcQwatCoQaMGjRo0atCoQQNvEAArIQqu/dnjaAAAAABJRU5ErkJggg=='
)
names = [f'Card-picture-{index}.png' for index in range(1, 5)]


def post(path, payload, token=None, method='POST'):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(origin + '/api/' + path, json.dumps(payload).encode(), headers, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def start():
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')


def restart():
    shell('am', 'force-stop', package)
    start()
    find(title)


def expect_images(count):
    labels = ['Preview of ' + name for name in names[:count]]
    for label in labels:
        find(label)
    assert [node.get('content-desc') for node in nodes()
            if (node.get('content-desc') or '').startswith('Preview of ')] == labels


def toggle():
    account_action('Settings')
    click('Pictures on note cards')
    click('Back to notes')


token = post('auth/register', {'name': 'Card picture fixture', 'email': email, 'password': password})['access_token']
note = post('notes', {'title': title}, token)['id']
convex = post('auth/convex-token', {}, token)['token']
ids = []
for name in names:
    upload = urllib.request.Request(
        f'{origin}/api/compose/attachments?noteId={note}&attachmentId={uuid.uuid4()}', fixture,
        {'Authorization': 'Bearer ' + convex, 'Content-Type': 'image/png', 'X-Anchor-Filename-Encoded': name},
    )
    with urllib.request.urlopen(upload, timeout=15) as response:
        assert response.status == 201
        ids.append(json.load(response)['id'])
ordered = post('compose/attachments/list?noteId=' + note, {'orderedIds': ids}, convex, method='PATCH')
assert [file['id'] for file in ordered] == ids

adb('reverse', tunnel, tunnel)
try:
    start()
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    find(title)
    expect_images(1)
    result.with_name(result.stem + '-list.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    choose_layout('Grid')
    expect_images(1)
    choose_layout('Masonry')
    expect_images(4)
    result.with_name(result.stem + '-masonry.png').write_bytes(adb('exec-out', 'screencap', '-p'))

    toggle()
    expect_images(0)
    adb('reverse', '--remove', tunnel)
    restart()
    expect_images(0)
    adb('reverse', tunnel, tunnel)
    toggle()
    expect_images(4)
    adb('reverse', '--remove', tunnel)
    restart()
    expect_images(4)
    click(title)
    find('More actions')
    result.write_text(json.dumps({'listAndGridShowFirstPicture': True, 'masonryShowsFirstFourPictures': True,
                                  'disabledPreferenceSurvivedRestart': True, 'cachedPicturesAppearedOffline': True,
                                  'cardPicturesKeptNoteNavigation': True}, indent=2) + '\n')
finally:
    if tunnel in adb('reverse', '--list').decode().split():
        adb('reverse', '--remove', tunnel)
