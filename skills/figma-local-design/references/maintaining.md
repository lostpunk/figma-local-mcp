# Maintaining the package

Locate editable sources in the workspace or via the standalone skill's `installation.json`. Never treat generated `runtime/server.mjs`, `plugin/code.js` or a managed plugin cache as source.

Change the narrowest layer:

- Project preferences: `.figma-design.json` and selected rule files.
- Shared workflow: skill references/assets, with essential routing in SKILL.md.
- New operations or hard validation: schemas in `src/`, handlers in `plugin/`, matching MCP read/write annotations.
- Packaging: setup/build/package scripts and recipient docs.

Keep the local-only architecture unless the user explicitly changes the requirement. New tools should use Plugin API, not REST, official MCP, hidden endpoints or arbitrary eval. Verify APIs in official Figma docs and installed plugin typings. Distinguish local APIs from plan-dependent or remote-library features.

Run `npm ci` if dependencies are missing, then `npm test` for implementation changes. Add tests for observable behavior and meaningful errors. Tests use a mocked Figma API and cannot prove real rendering, manifest import or CSP behavior. Socket tests need localhost access.

Run `npm run release` to test/build and produce ZIP plus SHA256 in `dist/`. Maintainers need Node.js, npm and Python 3. Recipients only need Node.js to run the packaged server. Keep package.json, lockfile, server and plugin manifest versions consistent for releases. The build preserves bundled dependency licenses.

Keep the skill's `version.json` local release version consistent with package.json and its catalog description consistent with actual capabilities. For SkillStore distribution, follow [skillstore.md](skillstore.md); the store assigns a separate published version.

Standalone skills are copies: refresh with `node scripts/setup.mjs --install-skill --update-skill`, which backs up the previous copy. Project rules are outside the package and remain untouched. For marketplace-managed installs use that marketplace's update flow; don't rewrite unrelated global configuration during code edits.

Tie new rules to actual requirements or observed failures, rather than accumulating universal restrictions. Complete authorized reversible work and ask only for missing facts that affect the outcome.
