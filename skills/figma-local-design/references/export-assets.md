# Save Figma assets into a project

Use `export_assets` when actual files are needed for implementation or delivery. Use `export_node` for a quick visual preview. Both read Figma without changing the design; `export_assets` also writes local files, so its MCP annotation is not read-only.

## Choose the destination

Use an existing asset directory in the user's selected application/project. Check `get_connection.assetAccess.allowedExportRoots`; configure that directory through `scripts/asset-access.mjs --allow-export` as described in [asset-access.md](asset-access.md). An existing import grant does not grant export rights. If the selected directory does not exist, create it with the normal workspace file tools first. Ask only when the intended project/destination cannot be inferred. Never select the integration's source, installed skill, runtime or distribution directories as a destination for user designs.

## Select sources

Pass an absolute `outputDirectory` and 1–20 `items`:

- Rendered scene node: `kind: "node"`, verified `nodeId`, and `format: "PNG" | "JPG" | "SVG" | "PDF"`. Optional `scale` is >0 and <=4 (default 1) and affects PNG/JPG only. Pages/documents are not supported: select relevant frames or individual layers.
- Stored source image: `kind: "image"` and an `imageHash` actually read from a node's image fill/stroke or `get_text_runs` fills. This is the image stored by Figma, before the node's crop/effects; it is not guaranteed to match the file before Figma imported/normalized it. Hashes are not URLs. Supported stored signatures are PNG/JPEG/GIF/WebP.
- Optional `name` is an ASCII filename stem of 1–80 letters/digits/underscore/hyphen, starting with a letter/digit. The server supplies an index and detected extension, so duplicate names do not collide. Do not pass an absolute filename, extension or relative path as the stem.

There is no recursive export or automatic application of Figma export presets. Read the relevant nodes and choose each requested format explicitly. For an icon use SVG; for a photo use stored image bytes when the original is needed, or a rendered export when the Figma crop/effects are intended. A PNG of the whole screen is a reference image, not a replacement for interface code.

Each file is limited to 8 MiB and a batch to 64 MiB. Raster renders are capped at 4096 pixels per side; `scale` in a saved entry reports the actual scale. Originals are not resized. SVG text is outlined. If a file is too large, export a smaller scene or lower raster scale; do not silently substitute a lower-quality image for a requested original.

## Use and recover the results

The result provides a fresh `figma-export-*` directory, `manifestPath`, and one entry for each processed item: source, status, absolute file path, MIME type, byte count and SHA256. Binary payloads are transferred over the local bridge but are not returned as chat text. Verify `status` and individual entries before using saved paths.

`partial` means some resources failed or the batch stopped. Individual export/format errors allow other items to proceed; a connection/session or destination failure stops the batch. `unprocessedIndices` identifies items that were not completed; a failed entry needs its own diagnosis. The plugin session is pinned after the first item, preventing later exports from silently switching files. Manual edits in the same file can still change results; the batch is not an atomic snapshot.

The manifest is updated after each item. `manifestError: true` means the on-disk manifest may be stale. If the MCP call is interrupted or the application exits, inspect the batch folder and verify files/checksums; an in-progress or partial file is not proof of success. A retry creates another folder and never overwrites the previous batch. Do not use `_operationId` or `get_operation` for this tool: it performs no Figma write and is not in the design-edit journal.

Keep SVG as a static asset where possible; do not execute it or inline untrusted exported markup. The output and manifest can contain project resources and source IDs: keep them in the user's project and out of integration releases. Publishing the integration does not authorize publishing these files.
