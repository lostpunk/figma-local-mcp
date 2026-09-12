import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, chmod, rm, access, realpath } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { downloadPayload, validatePayload, installPayload } from '../skills/figma-local-design/scripts/install.mjs';

const skillSource = new URL('../skills/figma-local-design/', import.meta.url);
const digest = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "figma bootstrap ' $ space-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillRoot = join(directory, 'skill');
  await cp(skillSource, skillRoot, { recursive: true });
  await rm(join(skillRoot, 'installation.json'), { force: true });
  const target = join(directory, 'runtime');
  const buffer = await readFile(join(skillRoot, 'assets/runtime-payload.json.gz'));
  return { directory, skillRoot, target, buffer, sha256: digest(buffer) };
}

test('standalone skill installs offline, preserves key on rerun and updates with a backup', async t => {
  const f = await fixture(t);
  const env = { ...process.env, CODEX_HOME: join(f.directory, 'codex') };
  const run = (...args) => spawnSync(process.execPath, [join(f.skillRoot, 'scripts/install.mjs'), '--target', f.target, '--no-register', '--no-open', ...args], { encoding: 'utf8', env });
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  const keyPath = join(f.target, 'generated/pairing-key.json');
  const key = JSON.parse(await readFile(keyPath, 'utf8')).token;
  assert.ok((await readFile(join(f.target, 'generated/figma-plugin/ui.html'), 'utf8')).includes(key));
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  assert.equal(JSON.parse(await readFile(join(f.skillRoot, 'installation.json'), 'utf8')).packageRoot, f.target);
  const payload = JSON.parse(gunzipSync(f.buffer));
  payload.files.push({ path: 'upgrade-note.txt', data: Buffer.from('New release').toString('base64') });
  const updated = gzipSync(JSON.stringify(payload));
  await assert.rejects(installPayload({ ...f, buffer: updated, sha256: digest(updated) }), /--update/);
  const result = await installPayload({ ...f, buffer: updated, sha256: digest(updated), update: true });
  assert.ok(result.backup);
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  assert.equal(await readFile(join(f.target, 'upgrade-note.txt'), 'utf8'), 'New release');
  await access(join(result.backup, 'runtime/server.mjs'));
});

test('payload validation rejects tampering and path traversal before creating an installation', async t => {
  const f = await fixture(t);
  assert.throws(() => validatePayload(f.buffer, '0'.repeat(64)), /SHA256 mismatch/);
  const payload = JSON.parse(gunzipSync(f.buffer));
  payload.files[0].path = '../escape';
  const bad = gzipSync(JSON.stringify(payload));
  await assert.rejects(installPayload({ ...f, buffer: bad, sha256: digest(bad) }), /Unsafe release path/);
  await assert.rejects(access(f.target), { code: 'ENOENT' });
  await assert.rejects(access(join(f.directory, 'escape')), { code: 'ENOENT' });
});

test('HTTPS downloader follows a secure redirect, enforces limits and rejects downgrade', async () => {
  const buffer = await readFile(new URL('../skills/figma-local-design/assets/runtime-payload.json.gz', import.meta.url));
  const urls = [];
  const downloaded = await downloadPayload('https://releases.example/asset', async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'manual');
    return urls.length === 1 ? new Response(null, { status: 302, headers: { location: '/payload' } }) : new Response(buffer);
  });
  assert.deepEqual(downloaded, buffer);
  assert.deepEqual(urls, ['https://releases.example/asset', 'https://releases.example/payload']);
  await assert.rejects(downloadPayload('http://releases.example/asset'), /HTTPS/);
  await assert.rejects(downloadPayload('https://releases.example/asset', async () => new Response(null, { status: 302, headers: { location: 'http://example.com/file' } })), /HTTPS/);
  await assert.rejects(downloadPayload('https://releases.example/asset', async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1))), /8 MiB/);
});

test('standalone installer registers MCP without reinstalling or overwriting the skill', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const bin = join(f.directory, 'bin');
  const registry = join(f.directory, 'registry.json');
  await mkdir(bin);
  await writeFile(registry, '[]');
  await writeFile(join(f.skillRoot, 'custom-rule.md'), 'Keep my rules');
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\n` + `
const fs=require('node:fs');
const args=process.argv.slice(2), path=process.env.FIGMA_TEST_REGISTRY;
if(args[1]==='list')process.stdout.write(fs.readFileSync(path,'utf8'));
else if(args[1]==='add')fs.writeFileSync(path,JSON.stringify([{name:args[2],enabled:true,transport:{command:args[4],args:args.slice(5)}}]));
else process.exit(2);
`);
  await chmod(join(bin, 'codex'), 0o755);
  const result = spawnSync(process.execPath, [join(f.skillRoot, 'scripts/install.mjs'), '--target', f.target, '--no-open'], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: join(f.directory, 'codex'), PATH: bin + delimiter + process.env.PATH, FIGMA_TEST_REGISTRY: registry },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8'))[0].transport.args, [join(f.target, 'runtime/server.mjs')]);
  assert.equal(await readFile(join(f.skillRoot, 'custom-rule.md'), 'utf8'), 'Keep my rules');
});
