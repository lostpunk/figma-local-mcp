import { checkInstallation } from '../src/installation-check.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// This starts an isolated bridge on an OS-assigned port. It never connects to a user's Figma file.
export async function verifyInstallation(runtime, skill, version) {
  for (const [root, file] of [[runtime, 'package.json'], [skill, 'package.json'], [skill, 'version.json']]) {
    if (JSON.parse(await readFile(join(root, file), 'utf8')).version !== version) throw new Error(`Staged version mismatch: ${file}`);
  }
  const { pluginVersion } = await checkInstallation(runtime, version);
  const client = new Client({ name: 'local-release-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, cwd: runtime,
      args: [join(runtime, 'runtime/server.mjs')], env: { ...process.env, FIGMA_BRIDGE_PORT: '0' }, stderr: 'pipe' }), { timeout: 15000 });
    const serverVersion = client.getServerVersion()?.version;
    const response = await client.callTool({ name: 'get_connection', arguments: { skillVersion: version } }, undefined, { timeout: 15000 });
    const connection = JSON.parse(response.content[0].text);
    const tools = (await client.listTools()).tools;
    if (response.isError || serverVersion !== version || connection.pairingCode !== undefined || connection.pairingMode !== 'automatic'
      || connection.assetAccess?.version !== 1 || !['audit_design', 'preview_audit_fixes', 'preview_design_fixes', 'list_operations'].every(name => tools.some(tool => tool.name === name && tool.annotations?.readOnlyHint))
      || connection.history?.mode !== 'memory' || connection.history?.healthy !== true) {
      throw new Error('Staged MCP verification failed');
    }
    return { serverVersion, pluginVersion, toolCount: tools.length, pairingSecretAbsent: true };
  } finally { await client.close(); }
}
