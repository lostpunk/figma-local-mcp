# Libraries and variable themes

Use Plugin API tools on the connected file. They do not use REST or the official MCP. Library operations can still contact Figma through its own APIs and require existing access. Never imply unlimited library access, automatic library enablement or bypassed plan limits.

## Reuse published assets

1. Read `get_library_variables` without a collectionKey to list variable collections in libraries enabled for this file. Enable missing libraries in Figma's UI; the Plugin API cannot do that. An empty list is not a license diagnosis. The manifest includes `teamlibrary`; if an older imported manifest still causes permission errors after an update, inspect the prepared manifest and reimport that manifest via Development plugins. Do not reinstall everything merely for an access failure.
2. Pass a returned `collectionKey` to list its variables (key, name, type). Continue with `nextOffset` and the same `revision`. A changed library requires starting over; a blocked entry needs a larger byte budget. These calls do not import anything or enumerate published components. They list descriptors, not all token values.
3. For a verified published key, call `import_library_asset` with kind `component`, `componentSet` or `variable`, and an operation ID. A component key can come from `get_component_details` on an existing instance or a trusted project/user mapping. A name or URL is insufficient; never invent keys. Imports may fail when unpublished or inaccessible. Inspect after uncertain failures and recover the operation status before retrying.
4. Imports return actual IDs. For a component, inspect it and use `create_instance` to place an instance separately. For a set, read its children with `get_node` and select the intended variant COMPONENT ID. For a variable, read its collection modes and use its returned variable ID in supported bindings. Importing alone does not place instances, bind layers, or copy values into an editable local collection.

There is no component catalog search, library publishing, remote style import, automatic updates or substitute vendor kit. Use actual accessible assets; stop or use an explicitly selected reference workflow when required assets are unavailable. `library.components` may record verified accessible component IDs for this specific file; validate them again after switching files. Keep real keys and IDs in the user's project, never in this integration's release.

## Inspect and switch modes

`LIBRARY_ACCESS_FAILED` includes a bounded Figma error cause with URLs and long keys redacted. Diagnose that cause before asking for another restart: an older manifest permission requires re-import, while account/network/library-access failures need their corresponding recovery. The presence of `teamlibrary` in the generated file alone does not prove the running Figma registration refreshed its permissions.

`get_variable_modes({collectionId, nodeId?})` returns modes of a local or already accessible remote collection. With nodeId it also returns the explicitly selected mode and the resolved mode when Figma reports it. `explicitModeId: null` means inheritance. `resolvedModeId: null` means unreported, not necessarily the default. IDs must come from Figma, not a theme name.

Use `set_variable_mode({nodeId, collectionId, modeId, dryRun: true})` first. Inspect its current/target mode and scope, then apply the same arguments with `dryRun: false`, its `revision` and a new operation ID. `modeId: null` clears only this node's override and restores inheritance. Descendants without their own overrides can change; unrelated collection overrides and token definitions stay intact. Preview is metadata, not a rendered preview. Export representative screens after applying and inspect consumer values with `get_bound_variables`.

A change to the node's mode, inherited mode, collection modes, target arguments or plugin session invalidates the preview. Retry only after a new read. A failed setter attempts to restore the original override; an explicit restore failure requires inspecting the node before further edits. Do not use direct writes to bypass an invalid preview. These two-phase tools participate in the normal operation journal even for dry runs.

## Create a local theme

Read the local collection first. To add a mode, preview `create_variable_mode({collectionId, name, sourceModeId?, dryRun: true})`; source defaults to that collection's defaultModeId. Apply with the returned revision and `dryRun: false` only within an authorized theme change. It copies source values and aliases for up to 1000 variables/1 MiB, preserves existing modes/default mode, and does not switch any layer. Edit desired COLOR/FLOAT tokens in the returned mode with `set_variable`, then preview/apply a mode override on the intended frame or page. Copying modes does not infer a good dark palette; select actual theme values and verify contrast.

Existing mode names must be reused by ID, not duplicated. Remote and extended collections cannot be edited by this command. A plan-limit error is returned from Figma on the real requested creation; do not probe by creating throwaway modes, infer a subscription, or split collections to evade limits. On failure only the newly created mode is removed; incomplete cleanup is explicit. Read existing mode IDs before recovering a timed-out creation. No rename/delete mode tool, collection extension, publishing, automatic project theme enforcement or arbitrary BOOLEAN/STRING/alias authoring is provided yet. Such values can be preserved while copying an existing source mode.

`foundation.theme` remains a project preference, not an automatic mode binding. Existing `create_style_guide` still creates one default mode, and `sync_style_guide` patches that mode. Never call either merely to switch the theme of an existing screen.

API references: [team libraries](https://developers.figma.com/docs/plugins/api/figma-teamlibrary/), [variable workflows](https://developers.figma.com/docs/plugins/working-with-variables/), [mode overrides](https://developers.figma.com/docs/plugins/api/properties/ExplicitVariableModesMixin-setexplicitvariablemodeforcollection/).
