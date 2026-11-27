"""Run on an API 35 emulator with disposable password-auth Convex and a 390x900 dp display."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from android_test_ui import adb, center, click, find, nodes, shell, sync_notes, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = 'http://127.0.0.1:' + port
package = 'com.zhfahim.anchor.compose'
tunnel = 'tcp:' + port
suffix = uuid.uuid4().hex
email = f'board-{suffix}@example.test'
password = 'Fixture' + suffix


def api(path, payload, token=None, method='POST'):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(
        origin + '/api/' + path, json.dumps(payload).encode() if payload is not None else None,
        headers, method=method
    ), timeout=15) as response:
        return json.load(response)


def left(node):
    return int(re.match(r"\[(\d+),", node.get("bounds"))[1])


SORTS = {
    'Last edited, newest first': ('Last edited', 'Newest first'),
    'Last edited, oldest first': ('Last edited', 'Oldest first'),
    'Date created, newest first': ('Date created', 'Newest first'),
    'Date created, oldest first': ('Date created', 'Oldest first'),
    'Title, A to Z': ('Title', 'A to Z'),
    'Title, Z to A': ('Title', 'Z to A'),
    'Custom order': ('Custom order', None),
}


def choose_sort(label):
    criterion, direction = SORTS[label]
    click('View options')
    click(criterion)
    if direction:
        click(direction)
    shell('input', 'keyevent', '4')


def choose_layout(mode):
    click('View options')
    click(mode)
    shell('input', 'keyevent', '4')


def is_chosen(label):
    return any((n.get('checked') == 'true' or n.get('selected') == 'true') and
               any(item.get('text') == label for item in n.iter('node')) for n in nodes())




def assert_order(*expected):
    for _ in range(8):
        visible = [n for n in nodes() if n.get('text') in expected]
        positions = sorted(visible, key=lambda n: int(center(n)[1]))
        observed = [n.get('text') for n in positions]
        if observed == list(expected):
            return
    raise AssertionError((expected, observed))


def assert_edge_drag(token):
    shell('wm', 'size', '390x900')
    edge_titles = [f'Edge card {index:02}' for index in range(18)]
    edge_ids = [api('notes', {'title': title}, token)['id'] for title in edge_titles]
    api('notes/positions', {'positions': [
        {'noteId': note_id, 'position': 'a' + digit}
        for note_id, digit in zip(edge_ids, '3456789ABCDEFGHIJK')
    ]}, token, method='PUT')
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    sync_notes()
    choose_layout('List')
    choose_sort('Custom order')
    for _ in range(5):
        handles = {node.get('content-desc'): node for node in nodes()}
        sources = [title for title in edge_titles if (label := f'Drag {title}') in handles
                   and 230 <= int(center(handles[label])[1]) <= 660]
        if sources:
            break
        shell('input', 'swipe', '170', '740', '170', '390', '550')
    else:
        raise AssertionError('No edge-drag cards were visible after synchronizing and scrolling')
    source = sources[0]
    unseen_titles = {title for title in edge_titles if f'Drag {title}' not in handles and title > source}
    assert unseen_titles, 'The fixture must extend beyond the visible cards'
    x, y = center(find('Drag ' + source))
    shell(f'input motionevent DOWN {x} {y}; input motionevent MOVE {x} 870; '
          f'sleep 2; input motionevent MOVE {x} 700')
    targets = [node for node in nodes() if (node.get('content-desc') or '').removeprefix('Drag ') in unseen_titles
               and 230 <= int(center(node)[1]) <= 660]
    if not targets:
        shell('input', 'motionevent', 'CANCEL', x, '700')
        raise AssertionError('Holding the drag at the edge did not reveal an initially hidden card')
    target = targets[0]
    target_y = center(target)[1]
    shell('input', 'motionevent', 'MOVE', x, target_y)
    result.with_name(result.stem + '-drag-held.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('input', 'motionevent', 'UP', x, target_y)
    target_title = target.get('content-desc').removeprefix('Drag ')
    target_position = api('notes/' + edge_ids[edge_titles.index(target_title)], None, token, method='GET')['position']
    for _ in range(20):
        position = api('notes/' + edge_ids[edge_titles.index(source)], None, token, method='GET')['position']
        if position > target_position:
            break
        time.sleep(0.25)
    else:
        raise AssertionError('Dragging at the edge did not move the note below any initially hidden card')
    result.with_name(result.stem + '-drag-edge.png').write_bytes(adb('exec-out', 'screencap', '-p'))


def assert_first_manual_order(token):
    added_pin = 'First pinned note'
    added_id = api('notes', {'title': added_pin, 'isPinned': True}, token)['id']
    pin, reading, release, weekend = 'Pinned field note', 'Reading list', 'Release checklist', 'Weekend ideas'
    api('notes/positions', {'positions': [
        {'noteId': ids[pin], 'position': 'a0'},
        {'noteId': added_id, 'position': 'a1'},
    ]}, token, method='PUT')
    shell('wm', 'size', '390x1400')
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    sync_notes()
    choose_layout('List')
    choose_sort('Title, A to Z')
    assert_order(added_pin, pin, reading, release, weekend)
    start = center(find('Drag ' + release))
    destination = center(find('Drag ' + weekend))
    shell('input', 'swipe', *start, *destination, '850')
    find('Note moved down.')
    assert_order(added_pin, pin, reading, weekend, release)
    for group in ((added_id, ids[pin]), (ids[reading], ids[weekend], ids[release])):
        keys = [api('notes/' + note_id, None, token, method='GET')['position'] for note_id in group]
        assert all(keys) and keys == sorted(set(keys)), keys
    adb('reverse', '--remove', tunnel)
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    assert_order(added_pin, pin, reading, weekend, release)
    click('View options')
    find('Custom order')
    assert is_chosen('Custom order')
    result.with_name(result.stem + '-first-manual-order.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('input', 'keyevent', '4')
    adb('reverse', tunnel, tunnel)


account = api('auth/register', {'name': 'Board fixture', 'email': email, 'password': password})
token = account['access_token']
ids = {}
for title, body, color, pinned in (
    ('Pinned field note', 'Rain forest field notes', 'color_teal', True),
    ('Reading list', 'Moonstone research', None, False),
    ('Release checklist', 'Verify offline search and account boundaries.', 'color_yellow', False),
    ('Weekend ideas', 'Train routes and bookshops', None, False),
):
    ids[title] = api('notes', {
        'title': title, 'content': json.dumps({'ops': [{'insert': body + '\n'}]}),
        'background': color, 'isPinned': pinned,
    }, token)['id']
api('notes/' + ids['Reading list'], {
    'content': json.dumps({'ops': [{'insert': 'Moonstone research was edited later.\n'}]}),
}, token, method='PATCH')
api('notes/positions', {'positions': [
    {'noteId': ids['Release checklist'], 'position': 'a0'},
    {'noteId': ids['Weekend ideas'], 'position': 'a1'},
]}, token, method='PUT')

adb('reverse', tunnel, tunnel)
try:
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    find('Sign in')
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell('input', 'keyevent', '4')
    click('Sign in')
    find('View options')
    click('Open menu')
    find('Account menu')
    shell('input', 'keyevent', '4')
    find('View options')
    assert not any(n.get('content-desc') == 'Account menu' for n in nodes()), 'Back did not close the drawer'
    if os.environ.get('ANCHOR_TEST_BOARD_EDGE_ONLY') == '1':
        assert_edge_drag(token)
        result.write_text(json.dumps({'edgeDragMovedPastInitiallyHiddenNote': True}, indent=2) + '\n')
        raise SystemExit(0)
    if os.environ.get('ANCHOR_TEST_BOARD_FIRST_ORDER_ONLY') == '1':
        assert_first_manual_order(token)
        result.write_text(json.dumps({'dragFromTitleSortPersistsManualOrder': True}, indent=2) + '\n')
        raise SystemExit(0)
    shell('wm', 'size', '390x1050')
    pin, reading, release, weekend = 'Pinned field note', 'Reading list', 'Release checklist', 'Weekend ideas'
    assert_order(pin, reading, weekend, release)
    adb('reverse', '--remove', tunnel)
    for label, titles in (
        ('Last edited, oldest first', (release, weekend, reading)),
        ('Date created, newest first', (weekend, release, reading)),
        ('Date created, oldest first', (reading, release, weekend)),
        ('Title, A to Z', (reading, release, weekend)),
        ('Title, Z to A', (weekend, release, reading)),
        ('Custom order', (reading, release, weekend)),
    ):
        choose_sort(label)
        assert_order(pin, *titles)
    adb('reverse', tunnel, tunnel)
    shell('wm', 'size', '390x1400')
    click(release)
    click('More actions')
    find('Move up')
    result.with_name(result.stem + '-reorder.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    click('Move up')
    find('Note moved up.')
    click('Back to notes')
    assert_order(pin, release, reading, weekend)
    ordered = [
        api('notes/' + ids[title], None, token, method='GET')['position']
        for title in (release, reading, weekend)
    ]
    assert all(ordered) and ordered == sorted(set(ordered)), ordered
    for mode, drop_on, direction, expected in (
        ('List', weekend, 'down', (reading, weekend, release)),
        ('Grid', reading, 'up', (release, reading, weekend)),
        ('Masonry', weekend, 'down', (reading, weekend, release)),
    ):
        if mode != 'List':
            choose_layout(mode)
        handle = find('Drag ' + release)
        target = find('Drag ' + drop_on)
        result.with_name(result.stem + '-drag-' + mode.lower() + '.png').write_bytes(adb('exec-out', 'screencap', '-p'))
        shell('input', 'swipe', *center(handle), *center(target), '850')
        find('Note moved ' + direction + '.')
        if mode == 'List':
            assert_order(pin, *expected)
        dragged_order = [
            api('notes/' + ids[title], None, token, method='GET')['position']
            for title in expected
        ]
        assert all(dragged_order) and dragged_order == sorted(set(dragged_order)), (mode, dragged_order)
    choose_layout('List')
    choose_sort('Title, Z to A')
    shell('wm', 'size', '390x900')
    find('Pinned')
    find('Others')
    first = find('Weekend ideas')
    second = find('Release checklist')
    assert abs(left(first) - left(second)) <= 2
    find('Pinned field note')
    result.with_name(result.stem + '-list.png').write_bytes(adb('exec-out', 'screencap', '-p'))

    for mode in ('Grid', 'Masonry'):
        choose_layout(mode)
        first = find('Weekend ideas')
        second = find('Release checklist')
        assert abs(left(first) - left(second)) >= 80
        result.with_name(result.stem + '-' + mode.lower() + '.png').write_bytes(adb('exec-out', 'screencap', '-p'))

    adb('reverse', '--remove', tunnel)
    shell('am', 'force-stop', package)
    shell('am', 'start', '-W', '-n', package + '/anchor.AnchorActivity')
    first = find('Weekend ideas')
    second = find('Release checklist')
    assert abs(left(first) - left(second)) >= 80

    shell('cmd', 'uimode', 'night', 'yes')
    find('Pinned field note')
    result.with_name(result.stem + '-dark.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('cmd', 'uimode', 'night', 'no')
    shell('wm', 'size', '800x1100')
    columns = {left(find(title)) for title in ('Reading list', 'Release checklist', 'Weekend ideas')}
    assert len(columns) == 3
    result.with_name(result.stem + '-tablet.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('wm', 'size', '390x900')
    click('View options')
    find('Z to A')
    assert is_chosen('Title') and is_chosen('Z to A')
    result.with_name(result.stem + '-sort.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('input', 'keyevent', '4')
    click('Search notes')
    type_in(0, 'moonstone')
    shell('input', 'keyevent', '4')
    find('Reading list')
    assert not any('Weekend ideas' in (n.get('text') or '') for n in nodes())
    click('Reading list')
    find('More actions')
    find('Moonstone research was edited later.')
    result.with_name(result.stem + '-note.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('input', 'keyevent', '4')

    adb('reverse', tunnel, tunnel)
    assert_first_manual_order(token)
    assert_edge_drag(token)

    result.write_text(json.dumps({
        'singleColumnList': True, 'twoColumnGridAndMasonry': True, 'groupedPinnedNotes': True,
        'layoutSurvivedOfflineProcessRestart': True, 'adaptiveColumnsOnTablet': True,
        'offlineSearchOpenedCachedNote': True, 'webSortOptionsWhileOffline': True,
        'sortChoiceRestoredAfterOfflineRestart': True,
        'customReorderPersisted': True,
        'dragReorderPersisted': True,
        'edgeDragMovedPastInitiallyHiddenNote': True,
        'dragFromTitleSortPersistsManualOrder': True,
    }, indent=2) + '\n')
finally:
    shell('cmd', 'uimode', 'night', 'no')
    shell('wm', 'size', '390x900')
    subprocess.run(['adb', 'reverse', '--remove', tunnel], capture_output=True, timeout=10)
