import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareLocalPlugin } from './local-plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!['--codex', '--register-mcp', '--install-skill', '--update-skill', '--help'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
}
if (flags.has('--help')) {
  console.log('node scripts/setup.mjs [--codex | --register-mcp | --install-skill] [--update-skill]\nNo flags: generate MCP configuration and an automatically paired local plugin.\n--codex: register figma_local in Codex and install the skill.\n--register-mcp: register MCP and prepare the plugin without replacing a skill.\n--install-skill: install skill without changing MCP configuration.\n--update-skill: back up and replace a previously installed standalone skill.');
  process.exit(0);
}
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required');
await access(join(root, 'runtime/server.mjs'), constants.R_OK);
await access(join(root, 'plugin/code.js'), constants.R_OK);
const command = process.execPath;
const args = [join(root, 'runtime/server.mjs')];
const config = { mcpServers: { figma_local: { command, args } } };
const output = join(root, 'generated');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'mcp.json'), JSON.stringify(config, null, 2) + '\n');
await writeFile(join(output, 'codex.toml'), `[mcp_servers.figma_local]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(args[0])}]\nstartup_timeout_sec = 10\ntool_timeout_sec = 150\n`);

const skillName = 'figma-local-design';
const skillRoot = process.env.FIGMA_LOCAL_SKILL_DIR || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
const destination = join(skillRoot, skillName);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
const installSkill = flags.has('--codex') || flags.has('--install-skill');
if (installSkill && await exists(destination) && !flags.has('--update-skill')) {
  throw new Error(`Skill already exists at ${destination}. To update it with a backup, repeat with --update-skill. No MCP configuration was changed.`);
}
function codex(argv) {
  // No shell: paths containing spaces, apostrophes or $ are passed literally.
  return spawnSync('codex', argv, { encoding: 'utf8', windowsHide: true });
}
if (flags.has('--codex') || flags.has('--register-mcp')) {
  const listed = codex(['mcp', 'list', '--json']);
  if (listed.error || listed.status !== 0) throw new Error('Cannot run codex mcp list. Install/configure the Codex CLI, or use generated/codex.toml manually.');
  let servers;
  try { servers = JSON.parse(listed.stdout); } catch { throw new Error('Unexpected Codex MCP listing format; use generated/codex.toml manually.'); }
  if (!Array.isArray(servers)) throw new Error('Unexpected Codex MCP listing format');
  const existing = servers.find(server => server.name === 'figma_local');
  if (existing) {
    if (existing.enabled === false) throw new Error('figma_local is registered but disabled. Review its configuration before enabling it.');
    const transport = existing.transport ?? existing;
    if (transport.command !== command || JSON.stringify(transport.args) !== JSON.stringify(args)) {
      throw new Error('figma_local is already registered with another command. Review that registration before replacing it. Generated config is ready; existing config was preserved.');
    }
  } else {
    const added = codex(['mcp', 'add', 'figma_local', '--', command, ...args]);
    if (added.error || added.status !== 0) throw new Error('Codex MCP registration failed. Inspect codex mcp list and use generated/codex.toml if needed.');
  }
  console.log('Codex MCP: figma_local registered.');
}
if (installSkill) {
  await mkdir(skillRoot, { recursive: true });
  if (await exists(destination)) {
    const backup = join(root, 'generated', `${skillName}-backup-${Date.now()}`);
    await cp(destination, backup, { recursive: true, errorOnExist: true, force: false });
    // Keep backup outside the skills discovery root to avoid duplicate skills.
    // cp rather than rename across filesystems; replacement below is explicit.
    const { rm } = await import('node:fs/promises');
    await rm(destination, { recursive: true });
    console.log(`Previous skill backed up to ${backup}`);
  }
  await cp(join(root, 'skills', skillName), destination, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(destination, 'installation.json'), JSON.stringify({ packageRoot: root }, null, 2) + '\n');
  console.log(`Skill installed: ${destination}`);
}
const manifest = await prepareLocalPlugin(root);
console.log(`MCP configuration: ${join(output, 'mcp.json')}\nCodex configuration: ${join(output, 'codex.toml')}\nFigma manifest: ${manifest}\nKeep this folder in place. Restart your MCP client and run this Figma plugin: it connects automatically. Share only the release ZIP, not generated/.`);
