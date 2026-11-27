"""Verify that Compose applies selection actions only to the picked notes."""
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, open_folder, shell, sync_notes, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
tunnel = 'tcp:' + port
suffix = uuid.uuid4().hex
email, password = f'selection-{suffix}@example.test', 'Fixture' + suffix


def api(path, payload=None, token=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = json.dumps(payload).encode() if payload is not None else None
    with urllib.request.urlopen(urllib.request.Request(origin + '/api/' + path, body, headers, method=method),
                                timeout=15) as response:
        return json.load(response)


account = api('auth/register', {'name': 'Selection fixture', 'email': email, 'password': password})
token = account['access_token']
first, second, third = 'Select first', 'Select second', 'Keep unselected'
ids = {title: api('notes', {'title': title}, token)['id'] for title in (first, second, third)}


def flags(title):
    note = api('notes/' + ids[title], token=token)
    assert note['version'] == 1
    return note['isPinned'], note['isArchived']


def trash_ids():
    return {note['id'] for note in api('notes/trash', token=token)}


def assert_absent(note_id):
    try:
        api('notes/' + note_id, token=token)
    except urllib.error.HTTPError as error:
        assert error.code == 404
    else:
        raise AssertionError('The removed note is still accessible')


def choose(*titles):
    click('Select')
    for title in titles:
        click(title)
    find(f'{len(titles)} selected')


adb('reverse', tunnel, tunnel)
try:
    shell('am', 'start', '-W', '-n', 'com.zhfahim.anchor.compose/anchor.AnchorActivity')
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    find(third)
    click('Select')
    click('Select all')
    find('3 selected')
    click(third)
    find('2 selected')
    result.with_name(result.stem + '-selected.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    click('Pin selected')
    find('2 notes updated.')
    assert [flags(title) for title in ids] == [(True, False), (True, False), (False, False)]

    click('Select')
    click(first)
    click(second)
    click('Unpin selected')
    find('2 notes updated.')
    assert all(flags(title) == (False, False) for title in ids)

    click('Select')
    click(first)
    click(second)
    click('Archive selected')
    find('2 notes updated.')
    assert [flags(title) for title in ids] == [(False, True), (False, True), (False, False)]
    open_folder('Archive')
    find(first)
    click('Select')
    click('Select all')
    find('2 selected')
    click('Unarchive selected')
    find('2 notes updated.')
    assert all(flags(title) == (False, False) for title in ids)

    tag = api('tags', {'name': 'Selection tag'}, token)['id']
    open_folder('Notes')
    sync_notes()
    choose(first, second)
    click('Tag selected')
    click('Selection tag')
    find('2 notes updated.')
    assert [api('notes/' + ids[title], token=token)['tagIds'] for title in ids] == [[tag], [tag], []]

    owner = api('auth/register', {'name': 'Shared owner', 'email': f'owner-{suffix}@example.test', 'password': password})
    owner_token = owner['access_token']
    shared = api('notes', {'title': 'Shared selection item'}, owner_token)['id']
    api(f'notes/{shared}/shares', {'sharedWithUserId': account['user']['id'], 'permission': 'viewer'}, owner_token)
    sync_notes()
    choose(first, second, 'Shared selection item')
    click('Delete selected')
    find('Move selected notes to trash?')
    click('Cancel')
    assert trash_ids() == set()
    assert api('notes/' + shared, token=token)['id'] == shared
    click('Delete selected')
    click('Move to trash')
    find('3 notes updated.')
    assert trash_ids() == {ids[first], ids[second]}
    assert api('notes/' + shared, token=owner_token)['version'] == 1
    assert_absent(shared)

    open_folder('Trash')
    choose(first, second)
    click('Restore selected')
    find('2 notes updated.')
    assert trash_ids() == set()
    open_folder('Notes')
    choose(first, second)
    click('Delete selected')
    click('Move to trash')
    find('2 notes updated.')
    open_folder('Trash')
    choose(first)
    click('Delete selected permanently')
    find('Delete selected notes permanently?')
    click('Cancel')
    assert trash_ids() == {ids[first], ids[second]}
    click('Delete selected permanently')
    click('Delete permanently')
    find('1 note updated.')
    assert trash_ids() == {ids[second]}
    assert_absent(ids[first])

    click('Empty trash')
    find('Empty trash?')
    late = api('notes', {'title': 'Arrived after confirmation'}, token)['id']
    api('notes/' + late, token=token, method='DELETE')
    find('1 note will be permanently deleted. This can’t be undone.')
    result.with_name(result.stem + '-empty-trash-confirmation.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    click('Delete permanently')
    find('1 note updated.')
    assert trash_ids() == {late}
    assert_absent(ids[second])
    assert flags(third) == (False, False)

    eligible = 'Still eligible for selection'
    api('notes', {'title': eligible}, token)
    open_folder('Notes')
    sync_notes()
    find(eligible)
    adb('reverse', '--remove', tunnel)
    # Restart so no pooled connection outlives the tunnel and the edit stays pending.
    shell('am', 'force-stop', 'com.zhfahim.anchor.compose')
    shell('am', 'start', '-W', '-n', 'com.zhfahim.anchor.compose/anchor.AnchorActivity')
    click(third)
    type_in(0, 'PendingEditStaysHere')
    shell('input', 'keyevent', '4')
    click('Save changes')
    find('Saved on device')
    click('Back to notes')
    find('Pending notes')
    click('Select')
    click('Select all')
    find('1 selected')
    find('PendingEditStaysHere')
    assert flags(third) == (False, False)
    adb('reverse', tunnel, tunnel)

    result.write_text(json.dumps({'selectAllAndDeselect': True, 'pinAndUnpinSelected': True,
                                  'archiveAndUnarchiveSelected': True, 'unselectedNoteUnchanged': True,
                                  'taggedOnlySelection': True, 'trashAndRestoreSelected': True,
                                  'shareRemovedOnlyForRecipient': True, 'cancelPreservedNotes': True,
                                  'permanentDeleteOnlySelection': True, 'emptyTrashUsedConfirmedSnapshot': True,
                                  'pendingEditExcludedFromSelection': True},
                                 indent=2) + '\n')
finally:
    if tunnel in adb('reverse', '--list').decode().split():
        adb('reverse', '--remove', tunnel)
