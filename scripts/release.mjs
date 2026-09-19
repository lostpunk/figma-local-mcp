import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readManifest, verifyFiles } from './release-files.mjs';
import { updateLocal } from './update-local.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}${result.stderr ? '\n' + result.stderr : ''}`, { cause: result.error });
  return result.stdout?.trim();
}
function pythonCommand() {
  const candidates = process.platform === 'win32' ? [['py', '-3'], ['python3'], ['python']] : [['python3'], ['python']];
  for (const [command, ...args] of candidates) {
    const result = spawnSync(command, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { stdio: 'ignore', windowsHide: true });
    if (!result.error && result.status === 0) return [command, args];
  }
  throw new Error('Python 3.9+ is required to build releases');
}
async function main() {
  const args = process.argv.slice(2);
  let install = false, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--install-local') install = true;
    else if (args[index] === '--codex-home' && args[index + 1] && !args[index + 1].startsWith('--')) codexHome = resolve(args[++index]);
    else throw new Error('Usage: node scripts/release.mjs [--install-local] [--codex-home PATH]');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required');
  const [python, pythonArgs] = pythonCommand();
  const pack = (...args) => run(python, [...pythonArgs, 'scripts/package.py', ...args], args.includes('--fingerprint'));
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const lockPath = join(root, 'artifacts/release.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Release already locked: artifacts/release.lock. Check that its process has stopped before removing it.');
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n');
    // Never treat artifacts from an earlier attempt as this run's success.
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await rm(join(root, 'dist', `release-${version}.json`), { force: true });
    await rm(join(root, 'artifacts', `validation-${version}.json`), { force: true });
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
    run(process.execPath, ['build.mjs']);
    const fingerprint = pack('--fingerprint');
    const tests = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'test/' + name);
    run(process.execPath, ['--test', ...tests]);
    if (pack('--fingerprint') !== fingerprint) throw new Error('Sources changed during tests. Run release again.');
    pack();
    const manifest = await readManifest(root);
    pack('--verify');
    await verifyFiles(root, manifest.files);
    if (pack('--fingerprint') !== fingerprint) throw new Error('Sources changed during packaging. Run release again.');
    await writeFile(join(root, 'dist', `release-${version}.json`), JSON.stringify(manifest, null, 2) + '\n');
    const report = install ? await updateLocal({ source: root, codexHome }) : { version, published: false };
    Object.assign(report, { tests: 'passed', archives: 'verified' });
    await writeFile(join(root, 'artifacts', `validation-${version}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (install) console.log('Restart Codex and Figma Local MCP Auto to load the new runtime and plugin.');
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
