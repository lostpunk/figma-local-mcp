#!/usr/bin/env python3
"""Build a shareable ZIP from an allowlist; never include local settings or dependencies."""
import hashlib
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
FILES = ['.codex-plugin/plugin.json', '.mcp.json', '.gitignore', 'package.json',
         'package-lock.json', 'build.mjs', 'tsconfig.json', 'README.md',
         'INSTALL.md', 'CUSTOMIZE.md', 'CONTRIBUTING.md', 'codex.example.toml']
DIRECTORIES = ['src', 'plugin', 'runtime', 'scripts', 'test', 'examples']
SKILL_ROOT = ROOT / 'skills' / 'figma-local-design'
SKILL_FILES = ['SKILL.md', 'version.json', 'agents/openai.yaml', 'package.json',
               'scripts/install.mjs', 'scripts/setup.mjs', 'scripts/local-plugin.mjs']
SKILL_DIRECTORIES = ['assets', 'references', 'runtime', 'plugin', 'src']
FORBIDDEN_SKILL_PARTS = {'.github', '.git', '.skillstore-meta.json', 'installation.json'}

def skill_inputs():
    inputs = [SKILL_ROOT / path for path in SKILL_FILES]
    for directory in SKILL_DIRECTORIES:
        inputs.extend(path for path in (SKILL_ROOT / directory).rglob('*') if path.is_file())
    for path in inputs:
        relative = path.relative_to(SKILL_ROOT)
        if path.is_symlink() or any(part in FORBIDDEN_SKILL_PARTS for part in relative.parts):
            raise ValueError(f'Forbidden or symlinked skill input: {relative}')
    return inputs

def package():
    files = [ROOT / f for f in FILES]
    for directory in DIRECTORIES:
        files.extend(p for p in (ROOT / directory).rglob('*')
                     if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc')
    packaged_skill_inputs = skill_inputs()
    files.extend(packaged_skill_inputs)
    for path in files:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing file or symlink: {path}')
    for directory in DIRECTORIES:
        if any(p.is_symlink() for p in (ROOT / directory).rglob('*')):
            raise ValueError(f'Symlinks are not allowed in release inputs: {directory}')
    target = ROOT / 'dist' / f'figma-local-mcp-{VERSION}.zip'
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(set(files)):
            relative = path.relative_to(ROOT)
            # Source comments/docs should also remain portable.
            data = path.read_bytes()
            if str(pathlib.Path.home()).encode() in data:
                raise ValueError(f'Personal absolute path in release: {relative}')
            info = zipfile.ZipInfo('figma-local-mcp/' + relative.as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n')
    print(f'{target}\n{target.stat().st_size:,} bytes\nSHA256 {digest}')
    skill_target = target.parent / f'figma-local-design-skill-{VERSION}.zip'
    with zipfile.ZipFile(skill_target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(set(packaged_skill_inputs)):
            info = zipfile.ZipInfo('figma-local-design/' + path.relative_to(SKILL_ROOT).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    skill_digest = hashlib.sha256(skill_target.read_bytes()).hexdigest()
    skill_target.with_suffix('.zip.sha256').write_text(f'{skill_digest}  {skill_target.name}\n')
    print(f'{skill_target}\n{skill_target.stat().st_size:,} bytes\nSHA256 {skill_digest}')

if __name__ == '__main__':
    package()
