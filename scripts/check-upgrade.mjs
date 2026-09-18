import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installEmbedded } from '../skills/figma-local-design/scripts/install.mjs';
import { regularFiles } from '../src/install-files.mjs';
import { checkInstallation } from '../src/installation-check.mjs';
import { verifyInstallation } from './verify-install.mjs';
import { createOperationHistory } from '../src/operation-history.mjs';
import { createOperations } from '../src/operations.mjs';

async function inventory(root) {
  const result = {};
  for (const name of (await regularFiles(root)).sort()) result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  return result;
}

// Maintainer regression runner: oldRoot is an unpacked, trusted release. Only disposable paths are written.
export async function checkUpgrade({ oldRoot, newRoot, markerFormat = 'figma-local-install-v2' }) {
  oldRoot = resolve(oldRoot); newRoot = resolve(newRoot);
  const sandbox = await mkdtemp(join(tmpdir(), 'figma upgrade space-'));
  try {
    const target = join(sandbox, 'runtime');
    const oldVersion = JSON.parse(await readFile(join(oldRoot, 'package.json'))).version;
    const newVersion = JSON.parse(await readFile(join(newRoot, 'package.json'))).version;
    await installEmbedded({ source: oldRoot, target });
    await writeFile(join(target, '.skill-install.json'), JSON.stringify({ format: markerFormat, version: oldVersion }));
    const manifestPath = join(target, 'generated/figma-plugin/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath)); manifest.id = 'preserve-imported-plugin-id';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await mkdir(join(sandbox, 'assets'));
    await writeFile(join(target, 'generated/asset-access.json'), JSON.stringify({ version: 1, allowedRoots: [join(sandbox, 'assets')] }));
    await mkdir(join(target, 'generated/logs'), { recursive: true }); await writeFile(join(target, 'generated/logs/events.jsonl'), '{"event":"historical"}\n');
    const project = join(sandbox, 'project'); await mkdir(project);
    await writeFile(join(project, '.figma-design.json'), '{"designSystem":"custom-do-not-overwrite"}');
    const token = JSON.parse(await readFile(join(target, 'generated/pairing-key.json'))).token;
    const historyOptions = { directory: join(target, 'generated/operation-history'), port: 3055, installationToken: token };
    const ops = createOperations({ history: createOperationHistory(historyOptions) });
    const operationId = ops.nextId(); ops.start(operationId, 'update_node', {}); ops.finish(operationId, { result: { id: 'test-only-layer' } });
    // Force a real replacement even when both inputs use the same release in CI.
    const sourceFile = join(target, 'src/pairing.mjs');
    await writeFile(sourceFile, (await readFile(sourceFile, 'utf8')) + '\n// installation drift\n');
    const baseline = await inventory(target);
    let replacements = 0;
    await assert.rejects(installEmbedded({ source: newRoot, target, update: true, move: async (from, to) => {
      if (to.startsWith(target + '/') || to.startsWith(target + '\\')) {
        replacements++;
        if (replacements === 5) throw new Error('Simulated locked file during upgrade');
      }
      await rename(from, to);
    } }), /previous runtime restored/);
    assert.equal(replacements, 5); assert.deepEqual(await inventory(target), baseline);
    await checkInstallation(target, oldVersion);
    const updated = await installEmbedded({ source: newRoot, target, update: true });
    assert.ok(updated.backup);
    assert.equal(JSON.parse(await readFile(manifestPath)).id, manifest.id);
    const upgradedFiles = await inventory(target);
    for (const name of ['generated/pairing-key.json', 'generated/asset-access.json', 'generated/operation-history/port-3055.enc'])
      assert.equal(upgradedFiles[name], baseline[name], name);
    assert.ok((await readFile(join(target, 'generated/logs/events.jsonl'), 'utf8')).startsWith('{"event":"historical"}\n'));
    assert.equal(await readFile(join(project, '.figma-design.json'), 'utf8'), '{"designSystem":"custom-do-not-overwrite"}');
    const restored = createOperations({ history: createOperationHistory(historyOptions) });
    assert.equal(restored.view(operationId).result.id, 'test-only-layer');
    const checked = await verifyInstallation(target, join(newRoot, 'skills/figma-local-design'), newVersion);
    await writeFile(join(target, 'plugin/code.js'), '// deliberate drift');
    await assert.rejects(checkInstallation(target, newVersion), /out of sync/);
    await installEmbedded({ source: newRoot, target, update: true });
    await checkInstallation(target, newVersion);
    return { from: oldVersion, to: newVersion, markerFormat, rollback: 'passed', preservedPrivateState: 'passed',
      importedPluginId: 'preserved', historyRecovery: 'passed', sameVersionRepair: 'passed',
      isolatedMcp: 'passed', tools: checked.toolCount, liveFigma: 'not_tested' };
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (args.length !== 2 || args[0] !== '--from') { console.error('Usage: node scripts/check-upgrade.mjs --from /path/to/unpacked/trusted/release'); process.exitCode = 1; }
  else { try { console.log(JSON.stringify(await checkUpgrade({ oldRoot: args[1], newRoot: root }), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
