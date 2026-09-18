# Local asset access

Local file imports use a separate, installation-local allowlist. With no configuration, `import_image(filePath)`, `import_svg(filePath)` and `set_image_fill_from_path(imagePath)` reject file reads. This does not prevent inline assets created for the task. The policy is not a sandbox for other tools or programs running as the user.

Read `get_connection.assetAccess.allowedRoots`. If the task needs a local asset, use the user's selected asset/project directory; do not grant the whole home directory, Downloads or filesystem merely to silence an error. A request to import one file is not a request to expose all unrelated files beside it. If only a specific file was selected, an isolated task asset directory containing that file is sufficient. Ask only when the intended directory/scope cannot be established from the request. Do not bypass a denied import by reading unrelated files with the shell and sending their base64 content instead.

Resolve the managed runtime root from the skill's `installation.json` (`packageRoot`), or use the known project checkout when running from source. Run the CLI in that runtime:

```bash
node <runtime>/scripts/asset-access.mjs --list
node <runtime>/scripts/asset-access.mjs --allow /absolute/project/assets
node <runtime>/scripts/asset-access.mjs --remove /absolute/project/assets
node <runtime>/scripts/asset-access.mjs --clear
```

Alternatively, the copy inside the skill accepts `--package-root <runtime>`. Paths containing spaces must be quoted. The CLI never reads asset contents. It records canonical directories in `<runtime>/generated/asset-access.json`. Changes apply to subsequent file imports without restarting MCP. Install/update preserves this local policy; it is excluded from release archives. Keep policy-changing commands sequential to avoid overwriting concurrent changes.

Before sending bytes, the server resolves the file's real path, checks it belongs to an allowed directory, opens it without following a final symlink where supported, verifies file identity and reads at most the size limit plus one byte. Links resolving within the allowed directory work; links escaping it are rejected. Directories, special files, oversized assets and unsupported signatures are rejected. These checks reduce unintended reads; they do not isolate the server from a malicious process running as the same OS user. Files should remain stable during import.

SVG supports static geometry, gradients, masks and local `#id` references. Attribute namespaces and style properties use a restricted subset. Duplicate/missing IDs, reference cycles and expansion above 20,000 elements are rejected in addition to the 1 MiB / 5,000 source elements / 64 nesting-level limits. Unsupported input should be simplified/exported as static vectors or imported as a raster image, rather than disabling validation.

The server requires the installation key created by setup, but never includes it in MCP responses. For an old manual plugin, run setup and import `generated/figma-plugin/manifest.json`; do not read or paste the key through chat. The automatic plugin still authenticates every connection, including Figma's opaque `null` origin.
