import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkUpgrade } from '../scripts/check-upgrade.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// These are installation-format fixtures, not mislabeled historical plugin binaries.
// Real earlier release payloads can be tested by the maintained --from runner offline.
for (const markerFormat of ['figma-local-install-v1', 'figma-local-install-v2'])
  test(`upgrade compatibility (${markerFormat}): rollback, private state, imported manifest and same-version repair`, async () => {
    const result = await checkUpgrade({ oldRoot: root, newRoot: root, markerFormat });
    assert.equal(result.rollback, 'passed'); assert.equal(result.sameVersionRepair, 'passed');
    assert.equal(result.historyRecovery, 'passed'); assert.equal(result.tools, 37);
  });
