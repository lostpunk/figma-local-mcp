#!/usr/bin/env python3
"""Deterministic, allowlisted release archives and an inspectable checksum manifest."""
import hashlib
import json
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
FILES = ['.codex-plugin/plugin.json', '.mcp.json', '.gitignore', '.gitattributes', 'CHANGELOG.md', 'package.json',
         'package-lock.json', 'build.mjs', 'tsconfig.json', 'README.md',
         'INSTALL.md', 'CUSTOMIZE.md', 'CONTRIBUTING.md', 'codex.example.toml', 'LICENSE']
DIRECTORIES = ['src', 'plugin', 'runtime', 'scripts', 'test', 'examples']
SKILL_ROOT = ROOT / 'skills' / 'figma-local-design'
SKILL_FILES = ['SKILL.md', 'version.json', 'agents/openai.yaml', 'package.json',
               'scripts/install.mjs', 'scripts/setup.mjs', 'scripts/local-plugin.mjs', 'scripts/asset-access.mjs', 'scripts/project-rules.mjs', 'scripts/onboarding.mjs']
SKILL_DIRECTORIES = ['assets', 'references', 'runtime', 'plugin', 'src']
FORBIDDEN_SKILL_PARTS = {'.github', '.git', '.skillstore-meta.json', 'installation.json',
                         'distribution-profile.md', 'private-distributions'}
PRIVATE_PARTS = {'generated', '.env', '.skill-install.json', 'pairing-key.json', 'asset-access.json', '.figma-design.json'}


def skill_inputs():
    inputs = [SKILL_ROOT / path for path in SKILL_FILES]
    for directory in SKILL_DIRECTORIES:
        for path in (SKILL_ROOT / directory).rglob('*'):
            if path.is_symlink():
                raise ValueError(f'Forbidden symlink: {path.relative_to(SKILL_ROOT)}')
            if path.is_file():
                inputs.append(path)
    for path in inputs:
        relative = path.relative_to(SKILL_ROOT)
        if path.is_symlink() or any(part in FORBIDDEN_SKILL_PARTS for part in relative.parts):
            raise ValueError(f'Forbidden or symlinked skill input: {relative}')
    return inputs


def inputs():
    files = [ROOT / name for name in FILES]
    for directory in DIRECTORIES:
        for path in (ROOT / directory).rglob('*'):
            if path.is_symlink():
                raise ValueError(f'Forbidden symlink: {path.relative_to(ROOT)}')
            if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                files.append(path)
    files.extend(skill_inputs())
    return sorted(set(files))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory():
    result = {}
    for path in inputs():
        relative = path.relative_to(ROOT)
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing file or symlink: {relative}')
        if any(part in PRIVATE_PARTS or part.startswith('.env.') for part in relative.parts):
            raise ValueError(f'Private file in release: {relative}')
        data = path.read_bytes()
        if str(pathlib.Path.home()).encode() in data:
            raise ValueError(f'Personal absolute path in release: {relative}')
        if re.search(rb"const installationToken\s*=\s*['\"][a-f0-9]{64}['\"]", data):
            raise ValueError(f'Embedded pairing secret in release: {relative}')
        result[relative.as_posix()] = digest(data)
    return result


def manifest_path():
    return ROOT / 'dist' / f'release-{VERSION}.json'


def archive_specs():
    return [('figma-local-mcp', f'figma-local-mcp-{VERSION}.zip', inputs(), ROOT),
            ('figma-local-design', f'figma-local-design-skill-{VERSION}.zip', skill_inputs(), SKILL_ROOT)]


def package():
    file_hashes = inventory()
    artifacts = []
    (ROOT / 'dist').mkdir(exist_ok=True)
    # An incomplete rebuild must never leave an old success manifest behind.
    manifest_path().unlink(missing_ok=True)
    for prefix, name, files, base in archive_specs():
        target = ROOT / 'dist' / name
        temporary = target.with_suffix('.zip.tmp')
        try:
            with zipfile.ZipFile(temporary, 'w') as archive:
                for path in sorted(set(files)):
                    info = zipfile.ZipInfo(prefix + '/' + path.relative_to(base).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        checksum = digest(target.read_bytes())
        target.with_suffix('.zip.sha256').write_text(f'{checksum}  {name}\n', encoding='utf8')
        artifacts.append({'path': name, 'sha256': checksum, 'bytes': target.stat().st_size})
        print(f'{name}: {target.stat().st_size:,} bytes; SHA256 {checksum}')
    if inventory() != file_hashes:
        raise ValueError('Release inputs changed during packaging; run release again')
    manifest_path().write_text(json.dumps({'format': 1, 'version': VERSION, 'artifacts': artifacts,
                                           'files': file_hashes}, indent=2, sort_keys=True) + '\n', encoding='utf8')
    verify()


def verify():
    manifest = json.loads(manifest_path().read_text())
    if manifest['format'] != 1 or manifest['version'] != VERSION or manifest['files'] != inventory():
        raise ValueError('Release manifest does not match current sources')
    specs = archive_specs()
    if [a['path'] for a in manifest['artifacts']] != [s[1] for s in specs]:
        raise ValueError('Unexpected release artifacts')
    for artifact, (prefix, name, files, base) in zip(manifest['artifacts'], specs):
        target = ROOT / 'dist' / name
        if digest(target.read_bytes()) != artifact['sha256'] or target.stat().st_size != artifact['bytes']:
            raise ValueError(f'Archive checksum mismatch: {name}')
        if target.with_suffix('.zip.sha256').read_text() != f"{artifact['sha256']}  {name}\n":
            raise ValueError(f'Checksum file mismatch: {name}')
        expected = {prefix + '/' + p.relative_to(base).as_posix(): p for p in files}
        with zipfile.ZipFile(target) as archive:
            if len(archive.namelist()) != len(expected) or set(archive.namelist()) != set(expected):
                raise ValueError(f'Unexpected archive entries: {name}')
            for entry, path in expected.items():
                if archive.read(entry) != path.read_bytes():
                    raise ValueError(f'Archive content mismatch: {entry}')
                if archive.getinfo(entry).external_attr >> 16 != 0o100644:
                    raise ValueError(f'Unexpected archive permissions: {entry}')
    if 'catalogFiles' in manifest:
        catalog = ROOT / 'dist' / 'skillstore' / 'figma-local-design'
        actual = {}
        for path in catalog.rglob('*'):
            if path.is_symlink():
                raise ValueError('Symlink in catalog package')
            if path.is_file():
                actual[path.relative_to(catalog).as_posix()] = digest(path.read_bytes())
        if actual != manifest['catalogFiles']:
            raise ValueError('Catalog files do not match release manifest')
    print(f'Release {VERSION}: archives, checksums and source inventory verified')


if __name__ == '__main__':
    if sys.argv[1:] == ['--verify']:
        verify()
    elif sys.argv[1:] == ['--fingerprint']:
        print(digest(json.dumps(inventory(), sort_keys=True).encode()))
    elif sys.argv[1:]:
        raise SystemExit('Usage: package.py [--verify | --fingerprint]')
    else:
        package()
