# Publishing this skill to SkillStore

Read this only when preparing or publishing this skill to the internal Yandex SkillStore. Design tasks and local installation do not require SkillStore.

Use the installed `store` skill and its current platform/upload instructions for authentication and CLI behavior. Do not implement a second uploader or embed credentials. Preparing a package does not publish it; run upload when publication is requested or already authorized.

## Prepare the distributable

- Run `npm run pack:skillstore` in the MCP checkout and upload only its output folder `dist/skillstore/figma-local-design`. The builder uses a strict allowlist and rejects `.github`, `.git`, `.skillstore-meta.json` and `installation.json`. Do not upload the whole MCP checkout or the personalized installed skill folder.
- Keep `version.json` with this skill. Its `name`, `short_description`, `description` and `category` populate the catalog. Keep the short description on one line, at most 200 characters. Descriptions are plain text. The local `version` tracks the bundled release; SkillStore assigns its own published version.
- The selected category is `frontend/design-system` (verified on 2026-09-12). Confirm it still exists with `store categories` before first publication. Update catalog text if capabilities or prerequisites change.
- Include `SKILL.md`, `version.json`, `agents/`, `references/`, `runtime/`, `plugin/`, `src/`, `scripts/install.mjs`, `scripts/setup.mjs` and `scripts/local-plugin.mjs`. The MCP and plugin must remain plain, inspectable source files; do not package executable runtime code into a compressed or base64 payload. Rebuild the bundled runtime and retain dependency notices when the runtime changes.
- Exclude `installation.json`, generated pairing material, personal configuration and backups. The package release script produces a portable skill ZIP; uploading the clean skill directory also lets the CLI read metadata automatically.
- Validate with the skill-creator validator and inspect the resulting archive. Tests of the installer do not prove acceptance by SkillStore's security checker.

## Upload and share

From the installed `store` skill directory, with `SKILL_DIR` set to the generated absolute skill directory:

```bash
bash scripts/store.sh upload "$SKILL_DIR"
bash scripts/store.sh skill-versions figma-local-design
```

For a later release, pass a meaningful `--changelog="..."` explicitly; do not assume the CLI reads changelog from version.json. Check the current slug/maintainer before upload so a contributor implementation is not mistaken for an update to the canonical skill. Use the server's returned identifier and version in the result.

Upload starts an automatic security check. A successful upload is initially `draft`; report it as uploaded and under review, not publicly available. After `ai_checked`, colleagues can ask `store` to install the returned identifier. No author-side `promote` or separate manual approval is part of normal publication. If the check fails, inspect the returned verdict and fix the cause before a new upload.

SkillStore installs the skill folder. The recipient then invokes this skill to install the bundled MCP and prepare the plugin; the Figma manifest import and plugin launch remain manual. SkillStore does not perform that Figma UI step.

For command syntax and lifecycle details, use the current installed `store` skill. It is the source of truth when catalog behaviour changes.
