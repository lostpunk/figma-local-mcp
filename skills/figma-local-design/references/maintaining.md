# Maintaining the package

Locate editable sources in the workspace or via the standalone skill's `installation.json`. Never treat generated `runtime/server.mjs`, `plugin/code.js`, `plugin/ui.html` or a managed plugin cache as source.

Change the narrowest layer:

- Project preferences: `.figma-design.json` and selected rule files.
- Shared workflow: skill references/assets, with essential routing in SKILL.md.
- New operations or hard validation: schemas in `src/`, handlers in `plugin/`, matching MCP read/write annotations.
- Plugin reads: `plugin/node-reader.ts` for trees/exports and `plugin/design-reader.ts` for text runs, component identity and consumer variable values; shared UTF-8 sizing in `plugin/response-size.ts` and limits in `src/response-limits.json`. Supported text fields are shared in `src/text-properties.json`.
- Web import: `src/web-capture.mjs` is a self-contained DOM reader, `src/web-snapshot-schema.mjs` validates the portable snapshot in server and plugin, and `plugin/web-import.ts` previews/imports it. Keep credentials/form data and source scripts out. Test geometry fallback, quotas and cleanup. Optional real-browser smoke: `node scripts/check-web-capture.mjs --playwright-module <installed-playwright-path> [--browser-channel chrome] [--output <temporary-directory>]`; Playwright/browser are maintainer dependencies, never required by the skill installer.
- Libraries/themes: `plugin/libraries-themes.ts` handles bounded library descriptors, imports and previewed mode changes. Preserve explicit inheritance, stale-preview detection, plan errors and rollback. `plugin/resource-revision.ts` provides change detection, not authorization.
- Unified design context: `plugin/design-context.ts` composes focused readers with request-scoped variable caching, traversal/detail budgets and a root preview. Its MCP response separates image content from JSON metadata. Test optional sections, incomplete coverage, consumer-specific token values and small UTF-8 budgets.
- Local asset export: `plugin/asset-export.ts` returns bounded bytes; `src/asset-export.mjs` validates and saves batches. Export directory grants are separate from import grants in `src/asset-access.mjs`. Export changes must cover partial results, source-session changes and path/permission checks.
- Plugin window: `plugin/ui/*.js` and `plugin/ui.template.html`; build bundles them into one self-contained HTML.
- Packaging: `src/package-layout.json` defines runtime files and additions for skill/source distributions. Build, packagers and installation use it; independent archive and private-data checks remain separate.

Keep the local-only architecture unless the user explicitly changes the requirement. New tools should use Plugin API, not REST, official MCP, hidden endpoints or arbitrary eval. Verify APIs in official Figma docs and installed plugin typings. Distinguish local APIs from plan-dependent or remote-library features.

Run `npm ci` if dependencies are missing, then `npm test` for implementation changes. Add tests for observable behavior and meaningful errors. Tests use a mocked Figma API and cannot prove real rendering, manifest import or CSP behavior. Socket tests need localhost access.

Run `npm run release` from the source checkout to test/build, produce both ZIPs, and verify their contents. `dist/release-<version>.json` contains relative paths and SHA256 inventories. `python3 scripts/package.py --verify` rechecks a release against the checkout. Maintainers need Node.js 22+, npm and Python 3.9+; recipients only need Node.js. Update package.json, both lockfile version entries, .codex-plugin/plugin.json and the skill version.json consistently. Server and compiled plugin versions derive from package.json. The build preserves bundled dependency licenses.


For local development, refresh the managed runtime and standalone skill together with `npm run release:local` from the source checkout; use `-- --codex-home PATH` for a separate installation. It validates staged files and starts an isolated MCP before replacing either installed copy, preserves private settings and metadata, and backs up both directories. Runtime files are replaced atomically in place while its mutable generated state stays at a stable path, so active logging cannot recreate a renamed installation directory. A failed replacement restores replaced files, removes newly added files and restores the old skill directory. Additional local files are retained. Same-version updates still install the verified bytes. It requires an existing managed runtime and the matching standalone skill; see CONTRIBUTING.md for interrupted-update recovery. Project rules are outside the package and remain untouched. For marketplace-managed installs use that marketplace's update flow; don't rewrite unrelated global configuration during code edits.

Tie new rules to actual requirements or observed failures, rather than accumulating universal restrictions. Complete authorized reversible work and ask only for missing facts that affect the outcome.


After implementation checks, use the maintained release:local command to build and update both installed copies; do not create temporary updater scripts. Verify their package versions and generated plugin files; an already running MCP or Figma plugin keeps the old code until restarted. Report this explicitly. Publishing is a separate user-requested step; verify the published revision and downloadable package.

For agent behavior and routing evaluation, use [evaluation.md](evaluation.md) and the bundled `evals/evals.json`. Dataset validation and implementation tests do not constitute a model evaluation run.
