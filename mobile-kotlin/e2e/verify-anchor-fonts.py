"""Verify packaged Compose fonts and their license against the shared Anchor assets."""
import hashlib
import json
import sys
from pathlib import Path
from zipfile import ZipFile

package = Path(sys.argv[1])
source = Path(__file__).resolve().parents[1] / "assets/fonts"
fonts = {
    "font/dm_sans.ttf": "DMSans-Variable.ttf",
    "font/dm_sans_italic.ttf": "DMSans-VariableItalic.ttf",
    "font/literata.ttf": "Literata-Regular.ttf",
    "font/literata_italic.ttf": "Literata-Italic.ttf",
    "font/literata_medium.ttf": "Literata-Medium.ttf",
    "font/literata_semibold.ttf": "Literata-SemiBold.ttf",
    "font/literata_bold.ttf": "Literata-Bold.ttf",
    "font/literata_bold_italic.ttf": "Literata-BoldItalic.ttf",
    "font/jetbrains_mono.ttf": "JetBrainsMono-Regular.ttf",
    "font/jetbrains_mono_bold.ttf": "JetBrainsMono-Bold.ttf",
    "font/jetbrains_mono_italic.ttf": "JetBrainsMono-Italic.ttf",
    "font/jetbrains_mono_bold_italic.ttf": "JetBrainsMono-BoldItalic.ttf",
    "files/licenses/OFL-DMSans.txt": "OFL-DMSans.txt",
    "files/licenses/OFL-JetBrainsMono.txt": "OFL-JetBrainsMono.txt",
    "files/licenses/OFL-Literata.txt": "OFL-Literata.txt",
}


def verify(entries, read):
    hashes = {}
    for resource, original in fonts.items():
        expected = (source / original).read_bytes()
        matches = [entry for entry in entries if entry.endswith("/" + resource)]
        assert len(matches) == 1, (resource, matches)
        assert read(matches[0]) == expected, matches[0]
        hashes[resource] = hashlib.sha256(expected).hexdigest()
    return hashes


if package.is_dir():
    resources = package / "compose-resources"
    contents = verify([path.relative_to(package).as_posix() for path in resources.rglob("*") if path.is_file()],
                      lambda entry: (package / entry).read_bytes())
else:
    with ZipFile(package) as apk:
        contents = verify(apk.namelist(), apk.read)

print(json.dumps(contents, indent=2))
