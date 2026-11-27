import re
import subprocess
from xml.etree import ElementTree


def adb(*args):
    return subprocess.check_output(['adb', *args], timeout=20)


def shell(*args):
    return adb('shell', *args)


def nodes():
    path = '/data/local/tmp/anchor-board.xml'
    for _ in range(3):
        xml = shell('sh', '-c', f"'rm -f {path}; uiautomator dump {path} >/dev/null 2>&1;"
                    f" if [ -s {path} ]; then cat {path}; fi'")
        if xml:
            return list(ElementTree.fromstring(xml).iter('node'))
    return []


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
        if len(fields) <= index:
            continue
        shell('input', 'tap', *center(fields[index]))
        if not any(n.get('focused') == 'true' and n.get('class') == 'android.widget.EditText' for n in nodes()):
            continue
        shell('input', 'keycombination', '113', '29')  # Control+A
        shell('input', 'text', value)
        fields = [n for n in nodes() if n.get('class') == 'android.widget.EditText']
        if len(fields) <= index:
            continue
        updated = fields[index]
        if updated.get('text') == value or (updated.get('password') == 'true' and
                                            len(updated.get('text', '')) == len(value)):
            return
    raise AssertionError(f'Could not populate field {index + 1}')


def click_desc(label):
    """Tap the node announced as label, skipping plain text with the same words (such as the top bar title)."""
    for _ in range(8):
        for node in nodes():
            if node.get('content-desc') == label:
                shell('input', 'tap', *center(node))
                return
    raise AssertionError(label)


def open_folder(name):
    click('Open menu')
    click_desc(name)


def sync_notes():
    click('Open menu')
    click('Sync notes')


def account_action(label):
    """Open the account menu from the drawer and choose label (Settings, Sign out, ...)."""
    click('Open menu')
    click_desc('Account menu')
    click(label)


def choose_layout(mode):
    click('View options')
    click(mode)
    shell('input', 'keyevent', '4')
