"""Verify private tag filtering, offline search and the selection boundary."""
import json
import sys
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, nodes, open_folder, shell, sync_notes, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
tunnel = 'tcp:' + port
package = 'com.zhfahim.anchor.compose'
suffix = uuid.uuid4().hex
email, password = f'tag-filter-{suffix}@example.test', 'Fixture' + suffix


def api(path, payload=None, token=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = json.dumps(payload).encode() if payload is not None else None
    with urllib.request.urlopen(urllib.request.Request(origin + '/api/' + path, body, headers, method=method),
                                timeout=15) as response:
        return json.load(response)


def start():
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')


def tag_filter(label):
    open_folder(label)


def visible(*expected):
    for title in expected:
        find(title)
    for _ in range(8):
        titles = {node.get('text') for node in nodes()} & all_titles
        if titles == set(expected):
            return
    raise AssertionError((titles, expected))


token = api('auth/register', {'name': 'Tag filter fixture', 'email': email, 'password': password})['access_token']
work = api('tags', {'name': 'Work'}, token)['id']
home = api('tags', {'name': 'Home'}, token)['id']
fixtures = [('WorkProject', work, False), ('WorkBudget', work, False), ('HomeProject', home, False),
            ('ArchivedWork', work, True), ('ArchivedHome', home, True)]
all_titles = {title for title, _, _ in fixtures}
for title, tag, archived in fixtures:
    api('notes', {'title': title, 'tagIds': [tag], 'isArchived': archived}, token)

adb('reverse', tunnel, tunnel)
try:
    start()
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    visible('WorkProject', 'WorkBudget', 'HomeProject')
    tag_filter('Work')
    visible('WorkProject', 'WorkBudget')

    adb('reverse', '--remove', tunnel)
    shell('am', 'force-stop', package)
    start()
    tag_filter('Work')
    visible('WorkProject', 'WorkBudget')
    click('Search notes')
    type_in(0, 'Project')
    shell('input', 'keyevent', '4')
    visible('WorkProject')
    click('Close search')
    visible('WorkProject', 'WorkBudget')
    click('Select')
    click('Select all')
    find('2 selected')
    result.with_name(result.stem + '-offline.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    click('Done')

    open_folder('Archive')
    visible('ArchivedWork', 'ArchivedHome')
    tag_filter('Home')
    visible('ArchivedHome')
    open_folder('Archive')
    visible('ArchivedWork', 'ArchivedHome')
    open_folder('Notes')
    visible('WorkProject', 'WorkBudget', 'HomeProject')
    adb('reverse', tunnel, tunnel)
    tag_filter('Work')
    visible('WorkProject', 'WorkBudget')
    api('tags/' + work, token=token, method='DELETE')
    sync_notes()
    visible('WorkProject', 'WorkBudget', 'HomeProject')
    result.write_text(json.dumps({'tagFilterUsedAssignments': True, 'filterAvailableOfflineAfterRestart': True,
                                  'tagAndTextSearchIntersected': True, 'selectAllLimitedToFilteredNotes': True,
                                  'archiveAndFolderChangesHandled': True, 'deletedTagClearedFilter': True}, indent=2) + '\n')
finally:
    if tunnel in adb('reverse', '--list').decode().split():
        adb('reverse', '--remove', tunnel)
