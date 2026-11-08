#!/usr/bin/env python3
"""Build the reviewed runtime-only ZIP. No network, publishing, or browser changes."""
import argparse
import hashlib
import json
import pathlib
import re
import stat
import zipfile
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent


def safe_relative(name):
    p = pathlib.PurePosixPath(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name or any(ord(c) < 32 for c in name):
        raise ValueError('Invalid package path: ' + name)
    return p


def extension_id(key):
    import base64
    digest = hashlib.sha256(base64.b64decode(key, validate=True)).hexdigest()[:32]
    return ''.join(chr(97 + int(c, 16)) for c in digest)


def build(source, output_dir):
    source = pathlib.Path(source).resolve()
    spec = json.loads((source / 'extension/runtime-files.json').read_text())
    if spec.get('schema') != 1:
        raise ValueError('Unsupported runtime manifest schema')
    payload = {}
    origins = {}
    modes = {}
    for item in spec['files']:
        src = str(safe_relative(item['source']))
        name = str(safe_relative(item['archive']))
        if name == 'PACKAGE-CONTENTS.json' or name in payload:
            raise ValueError('Duplicate or reserved package destination: ' + name)
        if re.search(r'(^|/)(tests|node_modules|camera-profiles|\.git)(/|$)|(^|/)\.env|publishing\.json$|\.(pem|key|mp4|mkv|wav|onnx)$', src, re.I):
            raise ValueError('Private or non-runtime source: ' + src)
        file = source / src
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(source):
            raise ValueError('Runtime source must be a regular in-tree file: ' + src)
        payload[name] = file.read_bytes()
        if len(payload[name]) > 2 * 1024 * 1024:
            raise ValueError('Unexpectedly large runtime file: ' + src)
        origins[name] = src
        modes[name] = 0o755 if item.get('executable') else 0o644
    manifest = json.loads(payload['manifest.json'])
    version = manifest['version']
    if not re.fullmatch(r'\d+(?:\.\d+){1,3}', version):
        raise ValueError('Invalid extension version')
    actual_id = extension_id(manifest['key'])
    if actual_id != spec['extensionId']:
        raise ValueError('Manifest key changed the extension ID')
    required = [manifest['action']['default_popup'], manifest['background']['service_worker']]
    required += list(manifest.get('icons', {}).values())
    required += list(manifest['action'].get('default_icon', {}).values())
    for entry in manifest.get('content_scripts', []):
        required += entry.get('js', []) + entry.get('css', [])
    class References(HTMLParser):
        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            name = attrs.get('src') if tag in ('script', 'img') else attrs.get('href') if tag == 'link' else None
            if name and not name.startswith(('#', 'https:', 'http:', 'data:')):
                required.append(name)
    References().feed(payload[manifest['action']['default_popup']].decode())
    required += ['native/install.sh', 'native/install.cjs', 'native/vidcapture-native-host', 'README.md', 'LICENSE']
    for name in required:
        if str(safe_relative(name)) not in payload:
            raise ValueError('Runtime reference missing from ZIP: ' + name)
    contents = {'schema': 1, 'extensionId': actual_id, 'version': version,
                'files': [{'path': name, 'source': origins[name], 'sha256': hashlib.sha256(payload[name]).hexdigest(), 'mode': oct(modes[name])}
                          for name in sorted(payload)]}
    payload['PACKAGE-CONTENTS.json'] = (json.dumps(contents, indent=2, sort_keys=True) + '\n').encode()
    modes['PACKAGE-CONTENTS.json'] = 0o644
    output_dir = pathlib.Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / ('vidcapture-extension-v' + version + '.zip')
    # Stored entries make byte reproducibility independent of zlib versions.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as out:
        for name in sorted(payload):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | modes[name]) << 16
            info.compress_type = zipfile.ZIP_STORED
            out.writestr(info, payload[name])
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = pathlib.Path(str(archive) + '.sha256')
    checksum.write_text(digest + '  ' + archive.name + '\n')
    return {'archive': str(archive), 'sha256': digest, 'bytes': archive.stat().st_size, 'entries': len(payload), 'version': version, 'extensionId': actual_id}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=str(ROOT))
    parser.add_argument('--output-dir', required=True)
    options = parser.parse_args()
    try:
        print(json.dumps(build(options.source, options.output_dir), indent=2))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, 'Extension package: ' + str(error) + '\n')
