# File plan and page budget

The public Plugin API does not expose the file's team subscription. `figma.payments` describes payment for the plugin, not a Figma license. Do not use private endpoints or REST to fill this gap.

After every connection, read `get_document.capabilities`:

- `plan` and `planSource`: `unknown`/`not_exposed_by_plugin_api`, a `user_declared` plan, or `figma_error` evidence.
- `pageCount`, `effectivePageLimit`, `remainingPages`, `canCreatePage`: the current page budget and enforcement decision.
- `limitSource: conservative_default`: three pages until the file's plan is confirmed; this is a local policy, not a detected Starter subscription.

The user can select the **team plan of this file** in Figma Local MCP Auto. It is stored as plugin data on this document. The same user can work with different plans in different teams. Do not assume their account or seat proves this file's plan. To revise a saved declaration after moving/upgrading the file, change the selector. A Starter error from Figma overrides a declaration and records a three-page limit.

Prefer one existing page with separate frames for foundations, components and screens. Pass an existing `pageId` to `create_style_guide` when the tool schema supports it. Without a target, the guide uses a new page only when the budget allows it; otherwise it creates a board on the page captured at invocation, to the right of existing content. Its result reports `createdPage` and the actual page/frame IDs. On failure it removes its own resources, never an existing destination page.

`create_page` reuses an exact matching name. Ambiguous duplicates require choosing an existing ID via get_document. When the budget is exhausted, do not repeat creation calls or delete user pages to make room. Continue on existing pages. Ask about the file's plan only when more pages are materially necessary and cannot be replaced with frames.

An old plugin may omit capabilities. Continue ordinary reads/edits on known pages, avoid adding pages, and explain that restarting the updated plugin enables the preflight. A `PAGE_LIMIT` error requires re-reading the document and using existing pages, not retrying the same call.

Sources: [Plugin API fields](https://developers.figma.com/docs/plugins/api/figma/), [plugin payments](https://developers.figma.com/docs/plugins/api/figma-payments/); Figma Help Center article “Create and manage pages” for page limits.
