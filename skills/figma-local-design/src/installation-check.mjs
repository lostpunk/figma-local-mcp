import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readInstallationToken } from './pairing.mjs';

export function installationCheckFailure(result) {
  let reported;
  try { reported = JSON.parse(result.stdout)?.error; } catch {}
  // Never echo child stderr: it can contain source text, local paths or credentials.
  const output = String(result.stderr ?? '').slice(0, 16384);
  const code = result.error?.code ?? reported?.code;
  let category = 'RUNTIME_CHECK_FAILED', hint = 'The isolated MCP check failed; rebuild or reinstall the package.';
  if (code === 'ETIMEDOUT') {
    category = 'CHECK_TIMEOUT'; hint = 'The isolated MCP did not finish within 15 seconds.';
  } else if (reported?.stage === 'asset-access') {
    category = 'ASSET_ACCESS_CHECK_FAILED'; hint = 'Check the installed asset-access settings and their file permissions.';
  } else if (['EPERM', 'EACCES'].includes(code) || /\b(?:EPERM|EACCES)\b/.test(output) && /\b(?:listen|socket)\b/i.test(output)) {
    category = 'LOCAL_SOCKET_DENIED'; hint = 'Local socket access was denied. Allow localhost for the installer and retry.';
  } else if (['ENOENT', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(code) || /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError)\b/.test(output)) {
    category = 'INVALID_RUNTIME'; hint = 'Runtime files are missing, unreadable or invalid. Reinstall the verified package.';
  }
  const stage = ['bridge', 'asset-access'].includes(reported?.stage) ? `; stage=${reported.stage}` : '';
  const status = Number.isInteger(result.status) ? `; exit=${result.status}` : '';
  const error = new Error(`Bundled MCP installation check failed: ${category}${stage}${status}. ${hint}`);
  error.code = category;
  return error;
}

export async function checkInstallation(root, expectedVersion) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== expectedVersion) throw new Error('Installed package version differs from the skill. Run install.mjs --update.');
  const generated = join(root, 'generated/figma-plugin');
  const token = await readInstallationToken(root);
  if (!token) throw new Error('Installation key is missing or invalid');
  const code = await readFile(join(generated, 'code.js'));
  if (!code.equals(await readFile(join(root, 'plugin/code.js')))) throw new Error('Generated Figma plugin code is out of sync');
  const template = await readFile(join(root, 'plugin/ui.html'), 'utf8');
  if (await readFile(join(generated, 'ui.html'), 'utf8') !== template.replace("const installationToken = '';", `const installationToken = '${token}';`)) throw new Error('Generated Figma plugin UI is out of sync');
  const manifest = JSON.parse(await readFile(join(generated, 'manifest.json'), 'utf8'));
  const original = JSON.parse(await readFile(join(root, 'plugin/manifest.json'), 'utf8'));
  if (typeof manifest.id !== 'string' || !manifest.id || JSON.stringify({ ...manifest, id: original.id }) !== JSON.stringify({ ...original, name: original.name + ' Auto' })) throw new Error('Generated Figma plugin manifest is out of sync');
  const messages = [], figma = {
    root: { name: 'Installation check', children: [], getPluginData() { return ''; } },
    currentPage: { name: 'Installation check' }, editorType: 'figma',
    showUI() {}, on() {}, ui: { postMessage(message) { messages.push(message); } },
  };
  vm.runInNewContext(code.toString(), { figma, __html__: '', console }, { timeout: 1000 });
  await figma.ui.onmessage({ type: 'init' });
  const pluginVersion = messages.find(message => message.type === 'document')?.document.pluginVersion;
  if (pluginVersion !== expectedVersion) throw new Error('Compiled plugin version differs from the skill');
  const result = spawnSync(process.execPath, [join(root, 'runtime/server.mjs'), '--check-installation'], {
    cwd: root, env: { ...process.env, FIGMA_BRIDGE_PORT: '0' }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw installationCheckFailure(result);
  let server;
  try { server = JSON.parse(result.stdout); } catch { throw new Error('Bundled MCP returned an invalid installation check'); }
  if (server.version !== expectedVersion || server.isolated !== true) throw new Error('Bundled MCP version differs from the skill');
  return { version: expectedVersion, serverVersion: server.version, pluginVersion, disk: 'verified', live: 'restart_required' };
}
