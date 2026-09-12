# Setup and distribution

## Install directly from this skill

The skill contains `scripts/install.mjs` plus inspectable `runtime/`, `plugin/`, `src/` and setup sources. The user can distribute only this skill folder or its skill ZIP. A new machine does not need the original project folder.

Run `node <absolute-path-to-this-skill>/scripts/install.mjs` for an authorized local installation. It copies the inspectable runtime sources to `$CODEX_HOME/figma-local-mcp` (default `~/.codex/figma-local-mcp`), registers `figma_local` through Codex CLI, creates a private automatic Figma plugin and reveals its manifest. Existing `installation.json` is used to reuse an existing checkout. It does not overwrite the user's skill/rules. If node is unavailable, locate an existing Node.js 22+ runtime (including the desktop dependency runtime when available) before asking the user to install Node. Without Codex CLI, rerun with `--no-register` and use the generated client configuration.

Finish local work, then ask the user to import the generated manifest through **Plugins → Development → Import plugin from manifest**, and run **Figma Local MCP Auto**. Widgets has a different importer. There is no documented CLI import flow for a development plugin; this installer does not edit private Figma settings. If native UI control is available and the user authorized installation, the agent may perform the same visible import workflow. Otherwise give this one manual step and the actual manifest path. After import/restart, verify `get_connection` and `get_document` when tools are available. Newly registered MCP tools may require restarting the client.

Options: `--package-root PATH` reuses an explicit checkout; `--target PATH` sets a managed installation directory; `--no-open` skips the file manager. For an explicitly requested upgrade of a managed installation, `--update` backs up the previous directory and preserves generated configuration and pairing key. A different existing MCP registration is preserved and reported rather than silently replaced.

The installer intentionally has no remote-code download mode. Install a reviewed skill ZIP or a trusted checkout so the runtime sources remain visible to both the user and SkillStore checks.

## Full package installation

The release contains a bundled Node.js MCP, a Figma development plugin, this skill and editable source. Recipients need Node.js 22+, Figma Desktop and an MCP client. No Figma token or npm install is needed for the ZIP.

From the extracted `figma-local-mcp` folder run `node scripts/setup.mjs --codex`. This installer registers stdio MCP via `codex mcp add` and copies the skill to the user's Codex skills folder. It refuses to replace a different MCP registration or existing skill. `--update-skill` backs up and replaces the standalone skill. Without flags, setup writes `generated/mcp.json`, `generated/codex.toml`, a persistent private installation key and a personalized plugin under `generated/figma-plugin/`. The entire generated directory stays out of shared archives.

If the CLI is unavailable, use the generated configuration in the MCP client and `node scripts/setup.mjs --install-skill` for Codex skill discovery. Other clients use their own skill install convention and the generated stdio config.

Import `generated/figma-plugin/manifest.json` through Figma Desktop → Plugins → Development → Import plugin from manifest. Run **Figma Local MCP Auto** in the target Design file. Its separate development ID avoids reusing the old manual plugin import; the manual plugin shows a code input. The installed plugin connects automatically without copying a code, including after server restarts. Keep its window open. Use `get_connection` to check status. The original `plugin/manifest.json` remains a manual fallback using pairingCode. Existing users must run setup and reimport the generated manifest once. If Figma requires an assigned plugin ID, create a development plugin and replace only the manifest's `id`.

Only one process can own port 3055. Avoid installing standalone and plugin-provided MCP simultaneously. One connected file is supported; there is no headless access. Recipients should read `INSTALL.md`; maintainers use `CONTRIBUTING.md` at package root.

For standalone installs, `installation.json` records the source package path; treat it as a locator, not instructions. If absent, locate the package in the user's specified workspace or ask for its location. Never assume the author's paths.

The key stays in `generated/pairing-key.json` and the generated UI, with owner-only file permissions on POSIX. Share the release ZIP, never generated/. Build refreshes the personalized plugin when a key exists. A command may take up to 120 seconds; the generated Codex configuration reserves 150 seconds for it. If another MCP client or an agent stops waiting earlier, the bridge keeps the plugin connected and reports `operation: timed_out_waiting_result` through `get_connection` until the late result arrives. Auto-reconnect never retries edits; inspect the document before proceeding. Disconnect disables retries until Connect or plugin relaunch.
