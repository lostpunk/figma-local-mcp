# Preview existing-layer changes

`preview_changes` reads layer properties and stores a short-lived plan in plugin memory. It does not edit the document, create copies/pages, or render an alternative design. `apply_changes` accepts only a plan ID and selected change IDs; it cannot add different values to that plan.

## Workflow

1. Check connection readiness and inspect the intended layers. Send each node once in `changes: [{nodeId, props}]`.
2. Present the returned `changes` as property differences (`before` → `after`), using the returned IDs rather than assuming their order. No-op properties are omitted. Paint differences contain the actual paint lists: replacing a gradient or image with a solid color removes the previous fill.
3. Select changes within the user's authorized scope. Ask only when the intended selection is ambiguous or the user asked to approve a preview; an ordinary authorized edit does not require a new permission round.
4. Obtain a fresh `nextOperationId` and call `apply_changes({planId, changeIds, _operationId})`. Unselected changes are discarded when the plan is consumed. To apply them later, make a new preview.
5. Inspect the affected nodes and export the intended frame for visual verification. Report the actual result and any limitations.

Example tool arguments (replace node/plan/change IDs with returned IDs):

```json
{"changes":[{"nodeId":"12:3","props":{"width":240,"fill":"#FFFFFF"}}]}
```

```json
{"planId":"returned-plan-id","changeIds":["returned-width-change-id"],"_operationId":"nextOperationId"}
```

## Supported scope

- Rectangle and ellipse: `name`, `x`, `y`, `width`, `height`, `opacity`, `visible`, `locked`, `fill`, `stroke`, `strokeWeight`; rectangle also supports `cornerRadius`.
- Text: metadata plus increasing a fixed, top-aligned text height to contain existing ink. Requires a regular frame, available uniform font, no strokes/effects or transformed ancestors. Growth must fit inside the parent and avoid sibling bounds; horizontal/top overflow is manual. Does not change text, width, font or resize mode. Sibling changes invalidate the plan.
- Existing horizontal/vertical Auto Layout frames with both axes FIXED: `width`, `height`, `itemSpacing` and four paddings. Predictions include direct visible child positions and sizes in `layoutEffects`. No wrap, baseline alignment, min/max constraints, fill/stretch/absolute children, transformed/masked ancestors or nested Auto Layout ancestors. At most 100 descendants; their states are checked for conflicts. Fixed measured component instances may move as children, but their definitions/overrides are not edited.
- `atomicNodeIds` lists layout frames whose changed properties must be selected together; preview a smaller property set if only part is wanted. Parent geometry is checked after writing, and actual child positions must match predictions. Ordinary frames without Auto Layout remain metadata-only.
- Text-height/layout sizing edits preserve unrelated color and typography bindings, and reject a changed sizing property that is itself variable-bound. Outside these supported sizing edits, bound/styled layers and layers inside groups or Auto Layout: only `name` and `locked`. Preserve variable/style bindings. Editing component/instance hierarchies and mixed individual stroke widths is unsupported. A parent and its descendant cannot share one plan.
- Maximum 50 nodes / 200 requested properties; stored state is bounded to 32,000 serialized characters per layer and 256,000 per plan. Large layers require a narrower operation through the appropriate tool, not silent truncation.
- Plans expire after five minutes. Only the latest ten are retained. Closing/restarting the plugin loses them. They are not persistent operation history.

## Conflicts and errors

Before any write, the plugin resolves every selected node and checks snapshots of supported layer properties, parent IDs and ancestor geometry/layout context. A conflicting edit, reparenting or deletion stops the batch. This is a bounded property/context check, not a full document revision or visual-equivalence guarantee. Changes on unselected target nodes do not block the selected subset unless they affect its captured context.

On a conflict or expiration, read the current layers and create a new plan. Do not silently overwrite manual edits. If the operation outcome is uncertain, first recover the original `_operationId` with `get_operation`; never allocate a new ID just to retry it.

A write attempt consumes its plan even if it fails. The plugin checks stored values after applying and attempts to restore touched layers on error. Read the error: `Rollback incomplete` requires inspecting affected layers and possibly Figma Undo. A rollback attempt is not a general Figma transaction. Successful batches form an undo group; preview-only calls do not add one.

## Design-system binding plans

`preview_design_fixes({nodeId, nodeIds, rules})` accepts the same explicit design-system rules described in quality-checks.md. It proposes a binding only when one supplied color variable matches the single solid paint including opacity in this consumer’s mode, or one text style matches the uniform typography exactly. Several identical candidates require a semantic choice; no closest-color/font heuristic is used. Paint-style links, mixed paints/typography, component swaps, hidden/locked/masked/component hierarchies are skipped. Node exceptions are respected.

These plans expose `fillVariableId`, `strokeVariableId` and `textStyleId` differences through the same apply_changes tool. They preserve appearance and recheck resources, modes, node properties and fonts before applying. Text-style assignment is asynchronous; later targets are checked again and unexpected side effects stop the operation. Rollback is best effort, especially after an interrupted style setter or concurrent manual edits. Inspect errors and affected nodes; never treat partial failure as a transaction. A proposed semantic binding still needs to fit the user’s intent even when its present color is identical.

Each binding write is checked separately, including fields already written earlier in the same layer and its ancestor context. If a setter fails or the resulting state conflicts, that layer is left for inspection rather than restoring old values over a manual edit; unchanged independent layers can still be restored. `Rollback incomplete` can therefore include bindings already applied to the conflicted layer. Exact typography matching and conflict snapshots include the text wrapping mode (`textWrapStyle`).
