"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // plugin/capabilities.ts
  var policyKey = "document-plan-v1";
  var plans = ["unknown", "starter", "professional", "education", "organization", "enterprise"];
  function readPolicy() {
    try {
      const value = JSON.parse(figma.root.getPluginData(policyKey) || "null");
      if (value && plans.includes(value.plan) && ["user_declared", "figma_error"].includes(value.source)) return value;
    } catch (e) {
    }
    return void 0;
  }
  function getCapabilities() {
    var _a, _b;
    const policy = readPolicy();
    const plan = (_a = policy == null ? void 0 : policy.plan) != null ? _a : "unknown";
    const pageCount = figma.root.children.length;
    const supportedEditor = figma.editorType === "figma";
    const observedLimit = (policy == null ? void 0 : policy.source) === "figma_error" && policy.observedPageLimit === 3 ? 3 : null;
    const effectivePageLimit = observedLimit != null ? observedLimit : plan === "unknown" || plan === "starter" ? 3 : null;
    return {
      editorType: figma.editorType,
      plan,
      planSource: (_b = policy == null ? void 0 : policy.source) != null ? _b : "not_exposed_by_plugin_api",
      planAutomaticallyDetected: (policy == null ? void 0 : policy.source) === "figma_error",
      pageCount,
      effectivePageLimit,
      limitSource: observedLimit ? "figma_error" : plan === "unknown" ? "conservative_default" : "declared_plan",
      canCreatePage: supportedEditor && (effectivePageLimit === null || pageCount < effectivePageLimit),
      remainingPages: effectivePageLimit === null ? null : Math.max(0, effectivePageLimit - pageCount),
      recommendation: "Reuse existing pages and place screens, components and style guides in separate frames. Do not probe the plan by creating a page."
    };
  }
  function setDeclaredPlan(plan) {
    if (!plans.includes(plan)) throw new Error("Unsupported file plan");
    figma.root.setPluginData(policyKey, JSON.stringify({ plan, source: "user_declared" }));
    return getCapabilities();
  }
  function createPageChecked(name) {
    const capability = getCapabilities();
    if (!capability.canCreatePage) {
      throw new Error(`PAGE_LIMIT: ${capability.pageCount} pages; effective limit ${capability.effectivePageLimit}. Reuse an existing page. Plan: ${capability.plan} (${capability.planSource}). Confirm this file's team plan in the plugin if the conservative limit is not applicable.`);
    }
    let page;
    try {
      page = figma.createPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Starter plan only comes with 3 pages/i.test(message)) {
        figma.root.setPluginData(policyKey, JSON.stringify({ plan: "starter", source: "figma_error", observedPageLimit: 3 }));
        throw new Error("PAGE_LIMIT: Figma reported the Starter three-page limit. Reuse an existing page; the limit has been recorded for this file.");
      }
      throw error;
    }
    try {
      page.name = name;
      return page;
    } catch (error) {
      page.remove();
      throw error;
    }
  }

  // plugin/variables.ts
  function variableResolver() {
    let local;
    return async (id, localOnly = false) => {
      local != null ? local : local = figma.variables.getLocalVariablesAsync().then((variables2) => new Map(variables2.map((variable2) => [variable2.id, variable2])));
      let variables;
      try {
        variables = await local;
      } catch (e) {
        throw new Error("LOCAL_VARIABLES_UNAVAILABLE: Could not read variables in this file. Check Figma connectivity and read get_design_system before retrying.");
      }
      const variable = variables.get(id);
      if (variable) return variable;
      if (localOnly) return null;
      try {
        return await figma.variables.getVariableByIdAsync(id);
      } catch (e) {
        throw new Error("VARIABLE_LOOKUP_FAILED: The variable was not found locally and Figma could not resolve it by ID. Check the ID with get_design_system and check Figma connectivity.");
      }
    };
  }

  // plugin/sync-guide.ts
  var rgb = (hex) => ({
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255
  });
  var same = (a, b) => {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
  };
  async function syncGuide(args) {
    var _a, _b, _c, _d, _e, _f;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = collections.find((c) => c.id === args.collectionId);
    if (!collection || collection.remote) throw new Error("Local collection not found; inspect get_design_system first.");
    const variables = (await figma.variables.getLocalVariablesAsync()).filter((v) => v.variableCollectionId === collection.id);
    const styles = await figma.getLocalTextStylesAsync();
    if (((_a = args.typography) == null ? void 0 : _a.length) && collections.filter((c) => c.name === collection.name).length > 1) {
      throw new Error("Several collections share this name; text style namespace is ambiguous. Resolve names before syncing typography.");
    }
    const modeId = collection.defaultModeId;
    const variablePlan = [];
    const stylePlan = [];
    for (const [group, prefix, type] of [["colors", "color", "COLOR"], ["spacing", "spacing", "FLOAT"], ["radii", "radius", "FLOAT"]]) {
      for (const token of (_b = args[group]) != null ? _b : []) {
        const name = `${prefix}/${token.name}`;
        const matches = variables.filter((v) => v.name === name);
        if (matches.length > 1) throw new Error(`Ambiguous variable name: ${name}. Resolve duplicate names before syncing.`);
        const existing = matches[0];
        if (existing && (existing.remote || existing.resolvedType !== type)) throw new Error(`Variable type/locality conflict: ${name}`);
        if (existing && existing.valuesByMode[modeId] === void 0) throw new Error(`Default mode has no value for ${name}`);
        const value = type === "COLOR" ? rgb(token.value) : token.value;
        const previous = existing == null ? void 0 : existing.valuesByMode[modeId];
        const equal = type === "COLOR" && previous && typeof previous === "object" && "r" in previous ? same(__spreadProps(__spreadValues({}, previous), { a: "a" in previous ? previous.a : 1 }), __spreadProps(__spreadValues({}, value), { a: 1 })) : same(previous, value);
        variablePlan.push({
          name,
          type,
          value,
          existing,
          changed: !existing || !equal
        });
      }
    }
    for (const spec of (_c = args.typography) != null ? _c : []) {
      const name = `${collection.name}/${spec.name}`;
      const matches = styles.filter((s) => s.name === name);
      if (matches.length > 1) throw new Error(`Ambiguous text style name: ${name}. Resolve duplicate names before syncing.`);
      const existing = matches[0];
      if (existing == null ? void 0 : existing.remote) throw new Error(`Text style is remote: ${name}`);
      const lineHeight = spec.lineHeight === void 0 ? (_d = existing == null ? void 0 : existing.lineHeight) != null ? _d : { unit: "AUTO" } : { unit: "PIXELS", value: spec.lineHeight };
      const desired = { fontName: { family: spec.fontFamily, style: spec.fontStyle }, fontSize: spec.fontSize, lineHeight };
      const changed = !existing || existing.fontName.family !== desired.fontName.family || existing.fontName.style !== desired.fontName.style || !same(existing.fontSize, desired.fontSize) || !same(existing.lineHeight, desired.lineHeight);
      if (changed && existing && Object.keys((_e = existing.boundVariables) != null ? _e : {}).length) {
        throw new Error(`Text style has variable bindings: ${name}. Update its variables instead; sync will not detach them.`);
      }
      stylePlan.push({ name, spec: desired, existing, changed });
    }
    const changes = [
      ...variablePlan.map((p) => {
        var _a2, _b2, _c2, _d2;
        return {
          kind: "variable",
          name: p.name,
          id: (_b2 = (_a2 = p.existing) == null ? void 0 : _a2.id) != null ? _b2 : null,
          action: !p.existing ? "create" : p.changed ? "update" : "unchanged",
          before: (_d2 = (_c2 = p.existing) == null ? void 0 : _c2.valuesByMode[modeId]) != null ? _d2 : null,
          after: p.value
        };
      }),
      ...stylePlan.map((p) => {
        var _a2, _b2;
        return {
          kind: "textStyle",
          name: p.name,
          id: (_b2 = (_a2 = p.existing) == null ? void 0 : _a2.id) != null ? _b2 : null,
          action: !p.existing ? "create" : p.changed ? "update" : "unchanged",
          before: p.existing ? { fontName: p.existing.fontName, fontSize: p.existing.fontSize, lineHeight: p.existing.lineHeight } : null,
          after: p.spec
        };
      })
    ];
    const result2 = {
      collectionId: collection.id,
      modeId,
      dryRun: args.dryRun !== false,
      changes,
      note: "Updates affect all layers bound to these resources. Omitted resources and non-default modes are preserved. Existing boards are reused; creation-time captions are not rewritten."
    };
    if (args.dryRun !== false) return result2;
    const changedStyles = stylePlan.filter((p) => p.changed);
    const fonts = /* @__PURE__ */ new Map();
    for (const plan of changedStyles) {
      for (const font of [plan.spec.fontName, (_f = plan.existing) == null ? void 0 : _f.fontName]) if (font) fonts.set(JSON.stringify(font), font);
    }
    for (const font of fonts.values()) await figma.loadFontAsync(font);
    const created = [];
    const restore = [];
    let mutated = false;
    try {
      for (const plan of variablePlan.filter((p) => p.changed)) {
        let variable = plan.existing;
        if (variable) {
          const previous = variable.valuesByMode[modeId];
          if (previous === void 0) throw new Error(`Default mode has no value for ${plan.name}`);
          const target = variable;
          restore.push(() => target.setValueForMode(modeId, previous));
        } else {
          variable = figma.variables.createVariable(plan.name, collection, plan.type);
          created.push(variable);
        }
        mutated = true;
        variable.setValueForMode(modeId, plan.value);
        changes.find((c) => c.kind === "variable" && c.name === plan.name).id = variable.id;
      }
      for (const plan of changedStyles) {
        let style = plan.existing;
        if (style) {
          const target = style;
          const previous = { fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight };
          restore.push(() => {
            target.fontName = previous.fontName;
            target.fontSize = previous.fontSize;
            target.lineHeight = previous.lineHeight;
          });
        } else {
          style = figma.createTextStyle();
          created.push(style);
          style.name = plan.name;
        }
        mutated = true;
        style.fontName = plan.spec.fontName;
        style.fontSize = plan.spec.fontSize;
        style.lineHeight = plan.spec.lineHeight;
        changes.find((c) => c.kind === "textStyle" && c.name === plan.name).id = style.id;
      }
      if (mutated) figma.commitUndo();
      return result2;
    } catch (error) {
      let failures = 0;
      for (const undo of restore.reverse()) {
        try {
          undo();
        } catch (e) {
          failures++;
        }
      }
      for (const resource of created.reverse()) {
        try {
          resource.remove();
        } catch (e) {
          failures++;
        }
      }
      if (mutated) figma.commitUndo();
      throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures ? "Rollback incomplete; inspect the design system or use Figma Undo." : "Sync changes rolled back; existing IDs preserved."}`);
    }
  }

  // plugin/design-system.ts
  var designCommands = /* @__PURE__ */ new Set(["create_style_guide", "sync_style_guide", "get_design_system", "create_page", "create_scene", "create_instance", "set_variable"]);
  var rgb2 = (hex) => ({
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255
  });
  async function createGuide(args, helpers) {
    const previousPage = figma.currentPage;
    const specifiedPage = args.pageId ? await helpers.getNode(args.pageId) : void 0;
    if (specifiedPage && specifiedPage.type !== "PAGE") throw new Error("pageId must identify a page");
    const { name, colors, typography, spacing, radii } = args;
    const prefix = `${name}/`;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const existingStyles = await figma.getLocalTextStylesAsync();
    if (collections.some((c) => c.name === name) || existingStyles.some((s) => s.name.startsWith(prefix)) || figma.root.children.some((p) => p.name === `${name} \u2014 Style guide`)) {
      throw new Error(`Design system '${name}' already exists. Use get_design_system and set_variable, or choose a new name.`);
    }
    const fontNames = [
      { family: "Inter", style: "Regular" },
      { family: "Inter", style: "Bold" },
      ...typography.map((t) => ({ family: t.fontFamily, style: t.fontStyle }))
    ];
    const fonts = new Map(fontNames.map((font) => [JSON.stringify(font), font]));
    for (const font of fonts.values()) await figma.loadFontAsync(font);
    let page;
    let createdPage = false;
    let board;
    let collection;
    const variables = [];
    const styles = [];
    try {
      if (specifiedPage) page = specifiedPage;
      else if (!getCapabilities().canCreatePage) page = previousPage;
      else {
        try {
          page = createPageChecked(`${name} \u2014 Style guide`);
          createdPage = true;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("PAGE_LIMIT:")) page = previousPage;
          else throw error;
        }
      }
      await page.loadAsync();
      collection = figma.variables.createVariableCollection(name);
      const modeId = collection.defaultModeId;
      const createVariable = (tokenName, value, type) => {
        const variable = figma.variables.createVariable(tokenName, collection, type);
        variables.push(variable);
        variable.setValueForMode(modeId, value);
        return variable;
      };
      const colorTokens = colors.map((c) => __spreadProps(__spreadValues({}, c), { variable: createVariable(`color/${c.name}`, rgb2(c.value), "COLOR") }));
      const spacingTokens = spacing.map((s) => __spreadProps(__spreadValues({}, s), { variable: createVariable(`spacing/${s.name}`, s.value, "FLOAT") }));
      const radiusTokens = radii.map((s) => __spreadProps(__spreadValues({}, s), { variable: createVariable(`radius/${s.name}`, s.value, "FLOAT") }));
      for (const spec of typography) {
        const style = figma.createTextStyle();
        styles.push(style);
        style.name = prefix + spec.name;
        style.fontName = { family: spec.fontFamily, style: spec.fontStyle };
        style.fontSize = spec.fontSize;
        style.lineHeight = spec.lineHeight ? { unit: "PIXELS", value: spec.lineHeight } : { unit: "AUTO" };
      }
      const create = (type, props, parentId = page.id) => helpers.createNode({ type, props, parentId });
      const rightEdge = page.children.reduce((edge, child) => Math.max(edge, child.x + child.width), 0);
      board = await create("FRAME", {
        name: `${name} / Foundations`,
        x: page.children.length ? rightEdge + 160 : 0,
        y: 0,
        width: 1120,
        height: 600,
        fill: "#FFFFFF",
        clipsContent: false
      });
      const label = (text, x, y2, size = 14, bold = false) => create("TEXT", {
        name: text,
        characters: text,
        x,
        y: y2,
        fontSize: size,
        fontName: { family: "Inter", style: bold ? "Bold" : "Regular" },
        fill: "#0F172A",
        textAutoResize: "HEIGHT",
        width: 980
      }, board.id);
      const title = await label(name, 48, 40, 40, true);
      const subtitleY = 40 + title.height + 16;
      const subtitle = await label("Style guide \xB7 Colors / Typography / Spacing / Radius", 48, subtitleY);
      let y = subtitleY + subtitle.height + 40;
      async function heading(title2) {
        const node = await label(title2, 48, y, 24, true);
        y += node.height + 24;
      }
      await heading("01 / Colors");
      for (const token of colorTokens) {
        await create("RECTANGLE", {
          name: token.name,
          x: 48,
          y,
          width: 64,
          height: 48,
          cornerRadius: 8,
          fillVariableId: token.variable.id,
          stroke: "#CBD5E1"
        }, board.id);
        const caption = await label(`${token.name}   ${token.value}`, 136, y + 10);
        await helpers.applyProps(caption, { width: 880 });
        y += Math.max(48, caption.height + 10) + 16;
      }
      y += 24;
      await heading("02 / Typography");
      for (let i = 0; i < styles.length; i++) {
        const spec = typography[i];
        const title2 = await label(`${spec.name} \xB7 ${spec.fontFamily} ${spec.fontStyle} \xB7 ${spec.fontSize}px`, 48, y);
        y += title2.height + 12;
        const specimen = await create("TEXT", {
          name: spec.name,
          characters: "The quick brown fox \xB7 0123456789",
          textStyleId: styles[i].id,
          x: 48,
          y,
          width: 1e3,
          textAutoResize: "HEIGHT",
          fill: "#0F172A"
        }, board.id);
        y += specimen.height + 32;
      }
      await heading("03 / Spacing");
      for (const token of spacingTokens) {
        const title2 = await label(`${token.name} \xB7 ${token.value}px`, 48, y);
        y += title2.height + 10;
        const row = await create("FRAME", {
          name: `spacing/${token.name}`,
          x: 48,
          y,
          width: 48 + token.value,
          height: 24,
          fill: null,
          layoutMode: "HORIZONTAL",
          primaryAxisSizingMode: "FIXED",
          itemSpacing: token.value,
          clipsContent: false,
          variableBindings: { itemSpacing: token.variable.id }
        }, board.id);
        for (let n = 0; n < 2; n++) await create("RECTANGLE", { name: "Gap marker", width: 24, height: 24, fill: "#2563EB" }, row.id);
        y += 48;
      }
      await heading("04 / Radius");
      for (const token of radiusTokens) {
        await create("RECTANGLE", {
          name: `radius/${token.name}`,
          x: 48,
          y,
          width: 80,
          height: 56,
          fill: "#DBEAFE",
          variableBindings: {
            topLeftRadius: token.variable.id,
            topRightRadius: token.variable.id,
            bottomLeftRadius: token.variable.id,
            bottomRightRadius: token.variable.id
          }
        }, board.id);
        const caption = await label(`${token.name} \xB7 ${token.value}px`, 152, y + 16);
        await helpers.applyProps(caption, { width: 880 });
        y += Math.max(56, caption.height + 16) + 20;
      }
      await helpers.applyProps(board, { width: 1120, height: y + 48 });
      figma.commitUndo();
      return {
        pageId: page.id,
        frameId: board.id,
        createdPage,
        capabilities: getCapabilities(),
        collectionId: collection.id,
        modeId,
        colors: colorTokens.map((t) => ({ name: t.name, id: t.variable.id, value: t.value })),
        spacing: spacingTokens.map((t) => ({ name: t.name, id: t.variable.id, value: t.value })),
        radii: radiusTokens.map((t) => ({ name: t.name, id: t.variable.id, value: t.value })),
        textStyles: styles.map((style) => ({ id: style.id, name: style.name })),
        note: "Specimens are bound to variables/styles. Numeric/hex captions describe creation-time values. Use get_design_system for current values."
      };
    } catch (error) {
      const failures = [];
      if (createdPage && page && figma.currentPage.id === page.id) {
        try {
          await figma.setCurrentPageAsync(previousPage);
        } catch (e) {
          failures.push("restore current page");
        }
      }
      for (const resource of [createdPage ? page : board, ...styles, ...variables, collection]) {
        if (!resource) continue;
        try {
          resource.remove();
        } catch (e) {
          failures.push(resource.id);
        }
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures.length ? `Cleanup incomplete: ${failures.join(", ")}` : "New guide resources cleaned up."}`);
    }
  }
  async function executeDesignCommand(command, args, helpers) {
    var _a, _b, _c, _d, _e, _f;
    switch (command) {
      case "create_style_guide":
        return createGuide(args, helpers);
      case "sync_style_guide":
        return syncGuide(args);
      case "get_design_system": {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const selected = collections.filter((c) => c.name.startsWith(args.prefix));
        const ids = new Set(selected.map((c) => c.id));
        const variables = (await figma.variables.getLocalVariablesAsync()).filter((v) => ids.has(v.variableCollectionId));
        const styles = (await figma.getLocalTextStylesAsync()).filter((s) => s.name.startsWith(args.prefix));
        return {
          collections: selected.slice(0, args.limit).map((c) => ({ id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId })),
          variables: variables.slice(0, args.limit).map((v) => ({ id: v.id, name: v.name, type: v.resolvedType, collectionId: v.variableCollectionId, valuesByMode: v.valuesByMode })),
          textStyles: styles.slice(0, args.limit).map((s) => ({ id: s.id, name: s.name, fontName: s.fontName, fontSize: s.fontSize, lineHeight: s.lineHeight })),
          truncated: selected.length > args.limit || variables.length > args.limit || styles.length > args.limit
        };
      }
      case "create_page": {
        const matches = figma.root.children.filter((p) => p.name === args.name);
        if (matches.length > 1) throw new Error("Several pages have this name. Use get_document and an explicit page ID.");
        if (matches.length === 1) return { id: matches[0].id, name: matches[0].name, reused: true, capabilities: getCapabilities() };
        const page = createPageChecked(args.name);
        figma.commitUndo();
        return { id: page.id, name: page.name, reused: false, capabilities: getCapabilities() };
      }
      case "create_scene": {
        const rootParentId = (_a = args.parentId) != null ? _a : figma.currentPage.id;
        const refs = /* @__PURE__ */ new Map();
        const repaired = [];
        try {
          for (const spec of args.nodes) {
            if (refs.has(spec.ref) || spec.parentRef && !refs.has(spec.parentRef)) throw new Error("Invalid scene references");
            const parentId = spec.parentRef ? refs.get(spec.parentRef).id : rootParentId;
            const node = await helpers.createNode({ type: spec.type, parentId, props: spec.props });
            refs.set(spec.ref, node);
          }
          for (const spec of args.nodes) {
            const node = refs.get(spec.ref);
            const expectedId = spec.parentRef ? refs.get(spec.parentRef).id : rootParentId;
            if (((_b = node.parent) == null ? void 0 : _b.id) === expectedId) continue;
            const expected = await helpers.getNode(expectedId);
            if (!["PAGE", "FRAME", "COMPONENT", "SECTION"].includes(expected.type)) throw new Error(`Invalid expected parent for ${spec.ref}`);
            if (expected.type !== "PAGE" && expected.layoutMode !== "NONE") {
              throw new Error(`Hierarchy verification failed for ${spec.ref}: destination uses auto layout`);
            }
            const bounds = (_c = node.absoluteBoundingBox) != null ? _c : { x: node.x, y: node.y };
            const parentBounds = expected.type === "PAGE" ? { x: 0, y: 0 } : (_d = expected.absoluteBoundingBox) != null ? _d : { x: 0, y: 0 };
            expected.appendChild(node);
            node.x = bounds.x - parentBounds.x;
            node.y = bounds.y - parentBounds.y;
            if (((_e = node.parent) == null ? void 0 : _e.id) !== expectedId) throw new Error(`Hierarchy recovery failed for ${spec.ref}`);
            repaired.push(spec.ref);
          }
          figma.commitUndo();
          return { nodes: Array.from(refs, ([ref, node]) => ({ ref, id: node.id, type: node.type, name: node.name })), hierarchyVerified: true, repaired };
        } catch (error) {
          const failures = [];
          for (const node of [...refs.values()].reverse()) {
            try {
              if (!node.removed) node.remove();
            } catch (e) {
              failures.push(node.id);
            }
          }
          throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures.length ? `Cleanup incomplete: ${failures.join(", ")}` : "New scene nodes cleaned up."}`);
        }
      }
      case "create_instance": {
        const component = await helpers.getNode(args.componentId);
        if (component.type !== "COMPONENT") throw new Error("componentId must refer to a local COMPONENT");
        const parent = args.parentId ? await helpers.getNode(args.parentId) : figma.currentPage;
        if (!["PAGE", "FRAME", "COMPONENT", "SECTION"].includes(parent.type)) throw new Error("Unsupported instance parent");
        let ancestor = parent;
        while (ancestor) {
          if (ancestor.id === component.id) throw new Error("Cannot nest an instance inside its own component");
          ancestor = ancestor.parent;
        }
        const instance = component.createInstance();
        try {
          parent.appendChild(instance);
          await helpers.applyProps(instance, args.props);
          figma.commitUndo();
          return { id: instance.id, componentId: component.id, name: instance.name };
        } catch (error) {
          instance.remove();
          throw error;
        }
      }
      case "set_variable": {
        const variable = await variableResolver()(args.variableId, true);
        if (!variable || variable.remote) throw new Error("Local variable not found");
        const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find((c) => c.id === variable.variableCollectionId);
        if (!collection) throw new Error("Variable collection not found");
        const modeId = (_f = args.modeId) != null ? _f : collection.defaultModeId;
        if (!collection.modes.some((m) => m.modeId === modeId)) throw new Error("Mode does not belong to this collection");
        let value;
        if (variable.resolvedType === "COLOR" && typeof args.value === "string" && /^#[0-9a-fA-F]{6}$/.test(args.value)) value = rgb2(args.value);
        else if (variable.resolvedType === "FLOAT" && typeof args.value === "number" && Number.isFinite(args.value)) value = args.value;
        else throw new Error("Value must match the variable type: COLOR #RRGGBB or FLOAT number");
        variable.setValueForMode(modeId, value);
        figma.commitUndo();
        return { id: variable.id, name: variable.name, modeId, value };
      }
      default:
        throw new Error(`Unknown design command: ${command}`);
    }
  }

  // plugin/extended.ts
  var extendedCommands = /* @__PURE__ */ new Set([
    "import_image",
    "import_svg",
    "create_component_set",
    "set_instance_properties",
    "set_prototype_link",
    "set_prototype_start",
    "move_component"
  ]);
  function pageOf(node) {
    let current = node;
    while (current && current.type !== "PAGE") current = current.parent;
    if (!current) throw new Error("Node must belong to a page");
    return current;
  }
  async function parentFor(args, helpers) {
    var _a;
    const parent = await helpers.getNode((_a = args.parentId) != null ? _a : figma.currentPage.id);
    if (!["PAGE", "FRAME", "COMPONENT", "SECTION"].includes(parent.type)) throw new Error("Unsupported parent");
    return parent;
  }
  function result(node) {
    var _a;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      parentId: (_a = node.parent) == null ? void 0 : _a.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height
    };
  }
  async function executeExtended(command, args, helpers) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o;
    switch (command) {
      case "move_component": {
        const node = await helpers.getNode(args.nodeId);
        const parent = await helpers.getNode(args.parentId);
        if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") throw new Error("Move a COMPONENT or whole COMPONENT_SET");
        if (node.remote) throw new Error("Cannot move a remote component");
        if (!["PAGE", "FRAME", "SECTION"].includes(parent.type)) throw new Error("Destination must be PAGE, FRAME or SECTION");
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new Error("Explicit finite destination x/y are required");
        for (let a = node.parent; a; a = a.parent) {
          if (["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(a.type)) throw new Error("Move the whole component set or outer component; nested components cannot be extracted");
        }
        for (let a = parent; a; a = a.parent) {
          if (a.id === node.id) throw new Error("Cannot move a component into its descendant");
          if (["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(a.type)) throw new Error("Destination cannot be inside a component or instance");
        }
        const previous = { parentId: (_a = node.parent) == null ? void 0 : _a.id, x: node.x, y: node.y };
        try {
          parent.appendChild(node);
          node.x = args.x;
          node.y = args.y;
          figma.commitUndo();
          return __spreadProps(__spreadValues({}, result(node)), { previous, preservedId: true });
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Move may be partial; inspect ${node.id} or use Figma Undo.`);
        }
      }
      case "import_image": {
        const parent = args.nodeId ? void 0 : await parentFor(args, helpers);
        const target = args.nodeId ? await helpers.getNode(args.nodeId) : void 0;
        if (target && (target.type === "PAGE" || target.type === "DOCUMENT" || !("fills" in target))) throw new Error("nodeId must have editable fills");
        if (target && target.type === "TEXT") throw new Error("Use a shape or frame as an image target");
        if (typeof args.dataBase64 !== "string" || args.dataBase64.length > 11184812) throw new Error("Image payload is missing or too large");
        const bytes = figma.base64Decode(args.dataBase64);
        if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Image exceeds 8 MiB");
        const image = figma.createImage(bytes);
        const original = await image.getSizeAsync();
        if (original.width > 4096 || original.height > 4096) throw new Error("Image exceeds 4096 pixels per side; resize it first");
        const fill = { type: "IMAGE", imageHash: image.hash, scaleMode: args.scaleMode };
        let node;
        if (target && "fills" in target) {
          target.fills = [fill];
          node = target;
        } else {
          const created = figma.createRectangle();
          try {
            parent.appendChild(created);
            const width = (_b = args.width) != null ? _b : args.height ? args.height * original.width / original.height : original.width;
            const height = (_c = args.height) != null ? _c : width * original.height / original.width;
            created.resize(width, height);
            created.x = (_d = args.x) != null ? _d : 0;
            created.y = (_e = args.y) != null ? _e : 0;
            created.name = (_f = args.name) != null ? _f : "Image";
            created.fills = [fill];
            node = created;
          } catch (error) {
            created.remove();
            throw error;
          }
        }
        figma.commitUndo();
        return __spreadProps(__spreadValues({}, result(node)), { imageHash: image.hash, original, replacedFill: !!target });
      }
      case "import_svg": {
        const parent = await parentFor(args, helpers);
        if (typeof args.svg !== "string" || args.svg.length > 1048576) throw new Error("SVG is missing or too large");
        const node = figma.createNodeFromSvg(args.svg);
        try {
          parent.appendChild(node);
          if (args.width !== void 0) {
            if (node.width <= 0) throw new Error("SVG has no usable width");
            node.rescale(args.width / node.width);
          }
          node.name = (_g = args.name) != null ? _g : "SVG";
          node.x = (_h = args.x) != null ? _h : 0;
          node.y = (_i = args.y) != null ? _i : 0;
          figma.commitUndo();
          return __spreadProps(__spreadValues({}, result(node)), { childCount: node.children.length });
        } catch (error) {
          node.remove();
          throw error;
        }
      }
      case "create_component_set": {
        const parent = await parentFor(args, helpers);
        const sources = [];
        for (const variant of args.variants) {
          const node = await helpers.getNode(variant.componentId);
          if (node.type !== "COMPONENT" || node.remote) throw new Error("Each source must be a local COMPONENT");
          let ancestor = parent;
          while (ancestor) {
            if (ancestor.id === node.id) throw new Error("Cannot create variants inside their own source component");
            ancestor = ancestor.parent;
          }
          sources.push(node);
        }
        const clones = [];
        let set;
        try {
          for (let i = 0; i < sources.length; i++) {
            const clone = sources[i].clone();
            clones.push(clone);
            parent.appendChild(clone);
            clone.name = Object.keys(args.variants[i].properties).sort().map((key) => `${key}=${args.variants[i].properties[key]}`).join(", ");
          }
          set = figma.combineAsVariants(clones, parent);
          set.name = args.name;
          set.layoutMode = "HORIZONTAL";
          set.itemSpacing = args.spacing;
          set.paddingTop = set.paddingBottom = set.paddingLeft = set.paddingRight = 24;
          set.primaryAxisSizingMode = "AUTO";
          set.counterAxisSizingMode = "AUTO";
          set.x = args.x;
          set.y = args.y;
          figma.commitUndo();
          return __spreadProps(__spreadValues({}, result(set)), {
            componentPropertyDefinitions: set.componentPropertyDefinitions,
            variants: clones.map((node, i) => ({ id: node.id, sourceComponentId: sources[i].id, properties: args.variants[i].properties })),
            note: "Variant components are copies; source components and their instances are unchanged."
          });
        } catch (error) {
          const failures = [];
          for (const node of [...clones, set]) if (node && !node.removed) {
            try {
              node.remove();
            } catch (e) {
              failures.push(node.id);
            }
          }
          throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures.length ? "Cleanup incomplete: " + failures.join(", ") : "New variant resources cleaned up."}`);
        }
      }
      case "set_instance_properties": {
        const node = await helpers.getNode(args.nodeId);
        if (node.type !== "INSTANCE") throw new Error("nodeId must be an INSTANCE");
        const main = await node.getMainComponentAsync();
        if (!main) throw new Error("Main component is unavailable");
        const definitions = ((_j = main.parent) == null ? void 0 : _j.type) === "COMPONENT_SET" ? main.parent.componentPropertyDefinitions : main.componentPropertyDefinitions;
        for (const [key, value] of Object.entries(args.properties)) {
          const def = definitions[key];
          if (!def || !node.componentProperties[key]) throw new Error(`Unknown property: ${key}. Use exact names from get_node.`);
          if (def.type === "BOOLEAN" ? typeof value !== "boolean" : typeof value !== "string") throw new Error(`Invalid value type for ${key}`);
          if (def.type === "VARIANT" && !((_k = def.variantOptions) == null ? void 0 : _k.includes(value))) throw new Error(`Unknown variant value for ${key}`);
          if (!["BOOLEAN", "TEXT", "VARIANT"].includes(def.type)) throw new Error("Only BOOLEAN, TEXT and VARIANT properties are supported");
        }
        if (Object.keys(args.properties).some((key) => definitions[key].type === "TEXT")) {
          const texts = node.findAllWithCriteria({ types: ["TEXT"] });
          for (const text of texts) {
            const fonts = text.characters.length ? [...text.getRangeAllFontNames(0, text.characters.length)] : [];
            if (text.fontName !== figma.mixed) fonts.push(text.fontName);
            for (const font of fonts) await figma.loadFontAsync(font);
          }
        }
        try {
          node.setProperties(args.properties);
        } catch (error) {
          figma.commitUndo();
          throw new Error(`${String(error)}. Inspect the instance or use Undo; overrides may have changed.`);
        }
        figma.commitUndo();
        return { id: node.id, componentProperties: node.componentProperties, variantProperties: node.variantProperties };
      }
      case "set_prototype_link": {
        const node = await helpers.getNode(args.nodeId);
        if (!("setReactionsAsync" in node)) throw new Error("Source node does not support prototype reactions");
        const previous = [...node.reactions];
        const matching = previous.filter((r) => {
          var _a2;
          return ((_a2 = r.trigger) == null ? void 0 : _a2.type) === args.trigger;
        });
        if (matching.length && !args.replaceExisting) throw new Error("This trigger already has reactions. Inspect get_node; set replaceExisting=true to replace only this trigger.");
        let action;
        if (args.action === "BACK" || args.action === "CLOSE") {
          if (args.destinationId || args.transition !== "INSTANT") throw new Error("BACK/CLOSE do not accept a destination or transition");
          action = { type: args.action };
        } else {
          if (!args.destinationId) throw new Error("destinationId is required");
          const destination = await helpers.getNode(args.destinationId);
          if (pageOf(destination).id !== pageOf(node).id) throw new Error("Prototype source and destination must be on the same page");
          if (args.action === "CHANGE_TO") {
            let component = node;
            while (component && component.type !== "COMPONENT") component = component.parent;
            if (!component || ((_l = component.parent) == null ? void 0 : _l.type) !== "COMPONENT_SET" || destination.type !== "COMPONENT" || ((_m = destination.parent) == null ? void 0 : _m.id) !== component.parent.id || destination.id === component.id) {
              throw new Error("CHANGE_TO requires different variants in the same component set");
            }
          } else if (destination.type !== "FRAME" || ((_n = destination.parent) == null ? void 0 : _n.type) !== "PAGE") {
            throw new Error("NAVIGATE/OVERLAY destination must be a top-level FRAME");
          }
          if (args.action === "NAVIGATE") {
            let ancestor = node;
            while (ancestor && ancestor.type !== "PAGE") {
              if (ancestor.id === destination.id) {
                throw new Error("NAVIGATE destination must be a different screen from the source. No reactions were changed.");
              }
              ancestor = ancestor.parent;
            }
          }
          action = {
            type: "NODE",
            destinationId: destination.id,
            navigation: args.action,
            transition: args.transition === "INSTANT" ? null : { type: args.transition, easing: { type: "EASE_OUT" }, duration: args.durationMs / 1e3 },
            resetScrollPosition: true
          };
        }
        const reactions = [...previous.filter((r) => {
          var _a2;
          return ((_a2 = r.trigger) == null ? void 0 : _a2.type) !== args.trigger;
        }), { trigger: { type: args.trigger }, actions: [action] }];
        try {
          await node.setReactionsAsync(reactions);
        } catch (error) {
          figma.commitUndo();
          throw new Error(`${String(error)}. Inspect reactions or use Undo before retrying.`);
        }
        figma.commitUndo();
        return { id: node.id, reactions: node.reactions };
      }
      case "set_prototype_start": {
        const frame = await helpers.getNode(args.frameId);
        if (frame.type !== "FRAME" || ((_o = frame.parent) == null ? void 0 : _o.type) !== "PAGE") throw new Error("Prototype start must be a top-level FRAME");
        const page = frame.parent;
        const starts = page.flowStartingPoints.filter((s) => s.nodeId !== frame.id);
        if (starts.some((s) => s.name === args.name)) throw new Error("A different prototype flow already uses this name");
        page.flowStartingPoints = [...starts, { nodeId: frame.id, name: args.name }];
        figma.commitUndo();
        return { pageId: page.id, flowStartingPoints: page.flowStartingPoints };
      }
      default:
        throw new Error(`Unknown extended command: ${command}`);
    }
  }

  // plugin/audit.ts
  var bounded = (value) => value.slice(0, 200);
  var finite = (value) => typeof value === "number" && Number.isFinite(value);
  function localBounds(node) {
    const m = node.relativeTransform;
    const corners = [[0, 0], [node.width, 0], [0, node.height], [node.width, node.height]];
    const xs = corners.map(([x, y]) => m[0][0] * x + m[0][1] * y + m[0][2]);
    const ys = corners.map(([x, y]) => m[1][0] * x + m[1][1] * y + m[1][2]);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }
  async function auditDesign(root, args) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (root.type === "DOCUMENT") throw new Error("Audit one page or scene node, not the entire document");
    const maxNodes = (_a = args.maxNodes) != null ? _a : 2e3, maxFindings = (_b = args.maxFindings) != null ? _b : 100;
    const tolerance = (_c = args.tolerance) != null ? _c : 0.5, maxStyles = (_d = args.maxStyles) != null ? _d : 500;
    const rules = (_e = args.rules) != null ? _e : {};
    const findings = [];
    let findingCount = 0, visited = 0, checked = 0, hiddenSubtrees = 0, failedChecks = 0;
    let stylesChecked = 0, stylesTruncated = false;
    const seenStateRules = /* @__PURE__ */ new Set();
    const add = (finding) => {
      findingCount++;
      if (findings.length < maxFindings) findings.push(finding);
    };
    const note = (node, code, message, evidence, severity = "warning") => add({ code, severity, nodeId: node.id, name: bounded(node.name), message, evidence });
    const check = (node) => {
      var _a2, _b2, _c2, _d2;
      const parent = node.parent;
      if (node !== root && node.type !== "PAGE" && parent && ["FRAME", "COMPONENT", "INSTANCE", "SECTION"].includes(parent.type) && "width" in parent) {
        const box = localBounds(node);
        const scrolling = "overflowDirection" in parent ? parent.overflowDirection : "NONE";
        const scrollX = scrolling === "HORIZONTAL" || scrolling === "BOTH";
        const scrollY = scrolling === "VERTICAL" || scrolling === "BOTH";
        const outsideX = !scrollX && (box.left < -tolerance || box.right > parent.width + tolerance);
        const outsideY = !scrollY && (box.top < -tolerance || box.bottom > parent.height + tolerance);
        if (outsideX || outsideY) note(
          node,
          "OUTSIDE_PARENT",
          "Layer geometry extends beyond its parent. Review clipping, masks and intentional decoration.",
          {
            parentId: parent.id,
            bounds: box,
            parentSize: { width: parent.width, height: parent.height },
            clipsContent: "clipsContent" in parent ? parent.clipsContent : false
          }
        );
      }
      if ("layoutMode" in node && ["HORIZONTAL", "VERTICAL"].includes(node.layoutMode) && ((_a2 = rules.spacing) == null ? void 0 : _a2.length)) {
        const properties2 = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
        if (node.primaryAxisAlignItems !== "SPACE_BETWEEN") properties2.push("itemSpacing");
        if (node.layoutWrap === "WRAP" && node.counterAxisAlignContent !== "SPACE_BETWEEN") properties2.push("counterAxisSpacing");
        const values = node;
        const offScale = properties2.filter((key) => finite(values[key]) && ![0, ...rules.spacing].some((value) => Math.abs(values[key] - value) <= tolerance));
        if (offScale.length) note(
          node,
          "SPACING_OFF_SCALE",
          "Auto-layout spacing differs from the supplied project scale.",
          { properties: Object.fromEntries(offScale.map((key) => [key, values[key]])), allowed: [0, ...rules.spacing] }
        );
      }
      if (node.type === "TEXT") {
        if (node.hasMissingFont) note(node, "MISSING_FONT", "Text uses a font unavailable in this document.");
        if (node.textTruncation === "ENDING" || node.textAutoResize === "TRUNCATE") {
          note(
            node,
            "TEXT_TRUNCATION_ENABLED",
            "Ellipsis is enabled; verify that shortened text is intentional. This does not prove overflow.",
            { maxLines: (_b2 = node.maxLines) != null ? _b2 : null },
            "info"
          );
        } else if (node.textAutoResize === "NONE") {
          const rendered = node.absoluteRenderBounds, box = node.absoluteBoundingBox;
          if (!node.effects.some((effect) => effect.visible !== false) && !node.strokes.some((paint2) => paint2.visible !== false) && rendered && box && (rendered.x < box.x - tolerance || rendered.y < box.y - tolerance || rendered.x + rendered.width > box.x + box.width + tolerance || rendered.y + rendered.height > box.y + box.height + tolerance)) {
            note(
              node,
              "TEXT_RENDER_OUTSIDE_BOX",
              "Rendered text extends beyond its fixed box. Check overflow or intentional glyph overhang in the preview.",
              { bounds: box, rendered },
              "warning"
            );
          }
        }
      }
      for (const rule of (_c2 = rules.componentStates) != null ? _c2 : []) {
        if (rule.nodeId !== node.id) continue;
        seenStateRules.add(rule);
        if (node.type !== "COMPONENT_SET") {
          failedChecks++;
          note(node, "STATE_RULE_TARGET_INVALID", "State rules must target a verified component set.");
          continue;
        }
        const property = node.componentPropertyDefinitions[rule.property];
        const actual = (property == null ? void 0 : property.type) === "VARIANT" ? (_d2 = property.variantOptions) != null ? _d2 : [] : [];
        const missing = rule.required.filter((value) => !actual.includes(value));
        if (missing.length) note(
          node,
          "COMPONENT_STATES_MISSING",
          "Required values are absent from the specified variant property.",
          { property: rule.property, missing, available: actual.slice(0, 50), availableTruncated: actual.length > 50 }
        );
      }
    };
    let hiddenAncestor = false;
    for (let parent = root.parent; parent; parent = parent.parent) {
      if ("visible" in parent && !parent.visible || "opacity" in parent && parent.opacity === 0) hiddenAncestor = true;
    }
    const stack = [[root][Symbol.iterator]()];
    let nodesTruncated = false;
    while (stack.length) {
      const next = stack[stack.length - 1].next();
      if (next.done) {
        stack.pop();
        continue;
      }
      if (visited >= maxNodes) {
        nodesTruncated = true;
        break;
      }
      const node = next.value;
      visited++;
      if (hiddenAncestor || "visible" in node && !node.visible || "opacity" in node && node.opacity === 0) {
        hiddenSubtrees++;
        continue;
      }
      try {
        check(node);
        checked++;
      } catch (e) {
        failedChecks++;
        note(node, "NODE_CHECK_FAILED", "Could not inspect all properties of this node; this part of the audit is incomplete.");
      }
      if ("children" in node) stack.push(node.children[Symbol.iterator]());
    }
    if (args.checkTextStyles !== false) {
      try {
        const styles = await figma.getLocalTextStylesAsync();
        stylesTruncated = styles.length > maxStyles;
        const names = /* @__PURE__ */ new Map();
        for (const style of styles.slice(0, maxStyles)) {
          stylesChecked++;
          const group = (_f = names.get(style.name)) != null ? _f : { count: 0, ids: [] };
          group.count++;
          if (group.ids.length < 20) group.ids.push(style.id);
          names.set(style.name, group);
        }
        for (const [name, group] of names) if (group.count > 1) add({
          code: "DUPLICATE_TEXT_STYLE_NAME",
          severity: "info",
          name: bounded(name),
          message: "Multiple local text styles share this exact name; compare their definitions before merging.",
          evidence: { styleIds: group.ids, count: group.count, idsTruncated: group.count > group.ids.length }
        });
      } catch (e) {
        failedChecks++;
        add({ code: "STYLE_CHECK_FAILED", severity: "warning", message: "Local text styles could not be inspected." });
      }
    }
    const uncheckedStateRules = ((_g = rules.componentStates) != null ? _g : []).filter((rule) => !seenStateRules.has(rule)).map((rule) => ({ nodeId: rule.nodeId, property: rule.property, reason: "Target outside the visited visible subtree, missing, or traversal truncated." }));
    return {
      rootId: root.id,
      readOnly: true,
      findings,
      findingCount,
      complete: !nodesTruncated && findingCount <= maxFindings && !stylesTruncated && !failedChecks && !uncheckedStateRules.length,
      coverage: {
        visited,
        checked,
        hiddenSubtrees,
        nodesTruncated,
        findingsTruncated: findingCount > maxFindings,
        textStyles: { scope: "local_file", enabled: args.checkTextStyles !== false, checked: stylesChecked, truncated: stylesTruncated },
        spacingChecked: Boolean((_h = rules.spacing) == null ? void 0 : _h.length),
        stateRulesChecked: seenStateRules.size,
        uncheckedStateRules,
        failedChecks
      },
      limitations: [
        "Findings are review candidates, not automatic fixes or an accessibility certification.",
        "Text checks detect render-bound overflow and configured ellipsis, not all truncation or wrapping problems. Inspect an export.",
        "Geometry excludes shadows/strokes and allows declared scrolling axes. Masks, overlaps and intentional decoration need visual review.",
        "Spacing checks cover explicit linear auto-layout gaps/padding, not arbitrary positions or grid layout. Zero is always allowed.",
        "Duplicate checks compare local text-style names only. Variant checks cover supplied property values, not every combination or prototype behavior."
      ]
    };
  }

  // plugin/code.ts
  var properties = [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "visible",
    "locked",
    "opacity",
    "absoluteBoundingBox",
    "absoluteRenderBounds",
    "relativeTransform",
    "fills",
    "strokes",
    "strokeWeight",
    "cornerRadius",
    "effects",
    "characters",
    "fontName",
    "fontSize",
    "textAlignHorizontal",
    "textAlignVertical",
    "lineHeight",
    "letterSpacing",
    "textAutoResize",
    "layoutMode",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "layoutGrow",
    "layoutAlign",
    "itemSpacing",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "clipsContent",
    "constraints",
    "boundVariables",
    "componentProperties",
    "componentPropertyDefinitions",
    "variantProperties",
    "reactions",
    "flowStartingPoints",
    "textStyleId"
  ];
  function clean(value) {
    if (value === figma.mixed) return { mixed: true };
    if (value === void 0) return void 0;
    return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "symbol" ? { mixed: true } : v));
  }
  function summarize(node, depth, budget) {
    var _a, _b;
    budget.left--;
    const result2 = { id: node.id, type: node.type, name: node.name, parentId: (_a = node.parent) == null ? void 0 : _a.id };
    const source = node;
    for (const key of properties) {
      if (key === "componentPropertyDefinitions" && node.type === "COMPONENT" && ((_b = node.parent) == null ? void 0 : _b.type) === "COMPONENT_SET") continue;
      if (key in node) {
        const value = source[key];
        if (key === "characters" && typeof value === "string" && value.length > 1e4) {
          result2[key] = value.slice(0, 1e4);
          result2.charactersTruncated = true;
          result2.characterCount = value.length;
        } else result2[key] = clean(value);
      }
    }
    if ("children" in node) {
      const children = node.children;
      result2.childCount = children.length;
      result2.children = [];
      if (depth > 0) {
        for (const child of children) {
          if (budget.left <= 0) break;
          result2.children.push(summarize(child, depth - 1, budget));
        }
      }
      result2.childrenTruncated = result2.children.length < children.length;
    }
    return result2;
  }
  async function getNode(id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed) throw new Error(`Node not found: ${id}`);
    if (node.type === "PAGE") await node.loadAsync();
    if (node.type === "DOCUMENT") throw new Error("Use get_document for document metadata; get_node accepts a page or scene node.");
    return node;
  }
  function requireScene(node) {
    if (node.type === "DOCUMENT" || node.type === "PAGE") throw new Error("This operation requires a scene node.");
    return node;
  }
  function requireContainer(node) {
    if (!["PAGE", "FRAME", "COMPONENT", "SECTION"].includes(node.type)) {
      throw new Error("Parent must be PAGE, FRAME, COMPONENT or SECTION");
    }
    return node;
  }
  function pageOf2(node) {
    let parent = node;
    while (parent && parent.type !== "PAGE") parent = parent.parent;
    if (!parent) throw new Error("Node is not attached to a page");
    return parent;
  }
  var textProperties = ["characters", "fontName", "fontSize", "textAlignHorizontal", "textAutoResize", "lineHeight"];
  var writable = /* @__PURE__ */ new Set([
    "name",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "opacity",
    "visible",
    "locked",
    "fill",
    "stroke",
    "strokeWeight",
    "cornerRadius",
    ...textProperties,
    "layoutMode",
    "itemSpacing",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "clipsContent",
    "textStyleId",
    "fillVariableId",
    "strokeVariableId",
    "variableBindings"
  ]);
  function paint(hex) {
    if (hex === null) return [];
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error("Color must be #RRGGBB");
    return [{ type: "SOLID", color: {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255
    } }];
  }
  var imageDecodeRequests = /* @__PURE__ */ new Map();
  function decodeImageToPng(base64, mimeType) {
    const id = `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        imageDecodeRequests.delete(id);
        reject(new Error("Image normalization timed out in the Figma plugin UI"));
      }, 3e4);
      imageDecodeRequests.set(id, { resolve, reject, timer });
      figma.ui.postMessage({ type: "decode-image", id, base64, mimeType: mimeType != null ? mimeType : "application/octet-stream" });
    });
  }
  async function createFigmaImage(base64, mimeType) {
    if (mimeType !== "image/webp") {
      try {
        return { image: figma.createImage(figma.base64Decode(base64)), normalized: false };
      } catch (e) {
      }
    }
    const png = await decodeImageToPng(base64, mimeType);
    try {
      return { image: figma.createImage(figma.base64Decode(png)), normalized: true };
    } catch (error) {
      throw new Error(`Figma could not create the normalized image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function applyProps(node, props, beforeMutation = () => {
  }) {
    var _a, _b, _c;
    const target = node;
    const resolveVariable = variableResolver();
    const special = ["textStyleId", "fillVariableId", "strokeVariableId", "variableBindings"];
    let textStyle;
    if (props.textStyleId) {
      if (node.type !== "TEXT") throw new Error("textStyleId requires TEXT");
      const style = await figma.getStyleByIdAsync(props.textStyleId);
      if (!style || style.type !== "TEXT") throw new Error("Text style not found");
      textStyle = style;
      if (["fontName", "fontSize", "lineHeight"].some((k) => props[k] !== void 0)) throw new Error("Use textStyleId or explicit typography properties in one call");
    }
    const bindings = [];
    for (const [field, variableId] of Object.entries((_a = props.variableBindings) != null ? _a : {})) {
      if (!(field in node)) throw new Error(`Variable binding ${field} is not supported on ${node.type}`);
      const variable = variableId === null ? null : await resolveVariable(variableId);
      if (variableId !== null && (!variable || variable.resolvedType !== "FLOAT")) throw new Error(`FLOAT variable not found for ${field}`);
      bindings.push({ field, variable });
    }
    const paints = {};
    if (props.fill !== void 0) paint(props.fill);
    if (props.stroke !== void 0) paint(props.stroke);
    if ((props.width !== void 0 || props.height !== void 0) && !("resize" in node)) throw new Error(`Resize is not supported on ${node.type}`);
    for (const [key, field, raw] of [["fillVariableId", "fills", "fill"], ["strokeVariableId", "strokes", "stroke"]]) {
      if (!props[key]) continue;
      if (!(field in node)) throw new Error(`${field} is not supported on ${node.type}`);
      if (props[raw] !== void 0) throw new Error(`Use ${key} or ${raw} in one call`);
      const variable = await resolveVariable(props[key]);
      if (!variable || variable.resolvedType !== "COLOR") throw new Error(`COLOR variable not found: ${props[key]}`);
      paints[field] = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", variable)];
    }
    for (const key of Object.keys(props)) {
      if (!writable.has(key)) throw new Error(`Unsupported property: ${key}`);
      if (special.includes(key)) continue;
      const actual = key === "fill" ? "fills" : key === "stroke" ? "strokes" : key;
      if (!(actual in node)) throw new Error(`${key} is not supported on ${node.type}`);
      if (textProperties.includes(key) && node.type !== "TEXT") throw new Error(`${key} requires TEXT`);
    }
    if (node.type === "TEXT" && Object.keys(props).some((k) => textProperties.includes(k) || k === "width" || k === "height" || k === "textStyleId" || k === "variableBindings")) {
      const fonts = node.characters.length ? [...node.getRangeAllFontNames(0, node.characters.length)] : [];
      if (node.fontName !== figma.mixed) fonts.push(node.fontName);
      if (props.fontName) fonts.push(props.fontName);
      if (textStyle) fonts.push(textStyle.fontName);
      const unique = new Map(fonts.map((font) => [JSON.stringify(font), font]));
      for (const font of unique.values()) await figma.loadFontAsync(font);
    }
    beforeMutation();
    if (textStyle && node.type === "TEXT") await node.setTextStyleIdAsync(textStyle.id);
    if (props.fontName) target.fontName = props.fontName;
    if (props.layoutMode !== void 0) target.layoutMode = props.layoutMode;
    for (const [key, value] of Object.entries(props)) {
      if (["width", "height", "fontName", "layoutMode", "x", "y", "locked", ...special].includes(key)) continue;
      if (key === "fill") target.fills = paint(value);
      else if (key === "stroke") target.strokes = paint(value);
      else target[key] = value;
    }
    if (props.width !== void 0 || props.height !== void 0) {
      if (!("resize" in node)) throw new Error(`Resize is not supported on ${node.type}`);
      node.resize((_b = props.width) != null ? _b : node.width, (_c = props.height) != null ? _c : node.height);
    }
    if (props.x !== void 0) node.x = props.x;
    if (props.y !== void 0) node.y = props.y;
    if (props.locked !== void 0) node.locked = props.locked;
    for (const [field, value] of Object.entries(paints)) target[field] = value;
    for (const binding of bindings) node.setBoundVariable(binding.field, binding.variable);
  }
  async function createNode(args) {
    var _a, _b;
    const parent = args.parentId ? await getNode(args.parentId) : figma.currentPage;
    if (!["PAGE", "FRAME", "COMPONENT", "SECTION"].includes(parent.type)) throw new Error("Parent must be PAGE, FRAME, COMPONENT or SECTION");
    if (args.type === "TEXT") await figma.loadFontAsync((_a = args.props.fontName) != null ? _a : { family: "Inter", style: "Regular" });
    const creators = {
      FRAME: () => figma.createFrame(),
      RECTANGLE: () => figma.createRectangle(),
      ELLIPSE: () => figma.createEllipse(),
      TEXT: () => figma.createText(),
      COMPONENT: () => figma.createComponent()
    };
    if (!creators[args.type]) throw new Error("Unsupported node type");
    const node = creators[args.type]();
    try {
      parent.appendChild(node);
      if (node.type === "TEXT") node.fontName = (_b = args.props.fontName) != null ? _b : { family: "Inter", style: "Regular" };
      await applyProps(node, args.props);
      return node;
    } catch (error) {
      node.remove();
      throw error;
    }
  }
  async function execute(command, args) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    if (extendedCommands.has(command)) return executeExtended(command, args, { getNode });
    if (designCommands.has(command)) return executeDesignCommand(command, args, { getNode, applyProps, createNode });
    const budget = { left: (_a = args.maxNodes) != null ? _a : 200 };
    switch (command) {
      case "audit_design":
        return auditDesign(await getNode(args.nodeId), args);
      case "get_document":
        return {
          name: figma.root.name,
          currentPageId: figma.currentPage.id,
          pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
          capabilities: getCapabilities()
        };
      case "get_selection": {
        const nodes = [];
        for (const node of figma.currentPage.selection) {
          if (budget.left <= 0) break;
          nodes.push(summarize(node, args.depth, budget));
        }
        return {
          nodes,
          selectionCount: figma.currentPage.selection.length,
          selectionTruncated: nodes.length < figma.currentPage.selection.length
        };
      }
      case "get_node":
        return summarize(await getNode(args.nodeId), args.depth, budget);
      case "find_nodes": {
        const page = args.pageId ? await getNode(args.pageId) : figma.currentPage;
        if (page.type !== "PAGE") throw new Error("pageId must identify a page");
        const stack = [page.children[Symbol.iterator]()];
        const nodes = [];
        let index = 0;
        let visited = 0;
        const query = args.query.toLocaleLowerCase();
        while (stack.length) {
          const next = stack[stack.length - 1].next();
          if (next.done) {
            stack.pop();
            continue;
          }
          const node = next.value;
          if ("children" in node) stack.push(node.children[Symbol.iterator]());
          if (index++ < args.offset) continue;
          visited++;
          const matches = !args.type || node.type === args.type;
          if (matches && (node.name.toLocaleLowerCase().includes(query) || node.type === "TEXT" && node.characters.toLocaleLowerCase().includes(query))) {
            nodes.push({ id: node.id, name: node.name, type: node.type });
          }
          if (nodes.length >= args.limit || visited >= args.maxVisited) {
            return { nodes, visited, nextOffset: index, complete: false };
          }
        }
        return { nodes, visited, nextOffset: null, complete: true };
      }
      case "create_node": {
        const node = await createNode(args);
        figma.commitUndo();
        return summarize(node, 0, { left: 1 });
      }
      case "update_node": {
        const node = requireScene(await getNode(args.nodeId));
        const target = node;
        const rollbackFields = ["name", "x", "y", "width", "height", "rotation", "opacity", "visible", "locked", "fill", "stroke", "strokeWeight", "cornerRadius"];
        const canRestore = ["RECTANGLE", "ELLIPSE"].includes(node.type) && Object.keys(args.props).every((k) => rollbackFields.includes(k)) && !Object.keys((_b = target.boundVariables) != null ? _b : {}).length && !target.fillStyleId && !target.strokeStyleId && !(((_c = node.parent) == null ? void 0 : _c.layoutMode) && node.parent.layoutMode !== "NONE");
        const snapshot = canRestore ? {
          name: node.name,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: target.rotation,
          opacity: target.opacity,
          visible: node.visible,
          locked: node.locked,
          fills: target.fills,
          strokes: target.strokes,
          strokeWeight: target.strokeWeight,
          cornerRadius: target.cornerRadius
        } : null;
        let mutationStarted = false;
        try {
          await applyProps(node, args.props, () => {
            mutationStarted = true;
          });
        } catch (error) {
          if (!mutationStarted) throw new Error(`${error instanceof Error ? error.message : String(error)}. No properties changed.`);
          if (snapshot) {
            try {
              target.resize(snapshot.width, snapshot.height);
              for (const [key, value] of Object.entries(snapshot)) if (!["width", "height"].includes(key) && value !== void 0) target[key] = value;
            } catch (e) {
              figma.commitUndo();
              throw new Error("Update failed and rollback was incomplete. Inspect the node or use Figma Undo.");
            }
            throw new Error(`${error instanceof Error ? error.message : String(error)}. Original shape properties restored.`);
          }
          figma.commitUndo();
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Some properties may have changed; inspect the node or use Figma Undo.`);
        }
        figma.commitUndo();
        return summarize(node, 0, { left: 1 });
      }
      case "update_page": {
        const page = await getNode(args.pageId);
        if (page.type !== "PAGE") throw new Error("pageId must identify a page");
        if (args.name !== void 0) page.name = args.name;
        if (args.background !== void 0) page.backgrounds = paint(args.background);
        figma.commitUndo();
        return { id: page.id, name: page.name, backgrounds: clean(page.backgrounds) };
      }
      case "reparent_nodes": {
        const parent = requireContainer(await getNode(args.parentId));
        const nodes = [];
        const seen = /* @__PURE__ */ new Set();
        for (const id of args.nodeIds) {
          if (seen.has(id)) throw new Error(`Duplicate node id: ${id}`);
          const node = requireScene(await getNode(id));
          if (node.id === parent.id) throw new Error("A node cannot be its own parent");
          seen.add(id);
          nodes.push(node);
        }
        const page = pageOf2(parent);
        if (nodes.some((node) => pageOf2(node).id !== page.id)) throw new Error("All nodes and the parent must belong to the same page");
        let ancestor = parent;
        while (ancestor) {
          if (seen.has(ancestor.id)) throw new Error("Cannot move a node into its own descendant");
          ancestor = ancestor.parent;
        }
        if (parent.type !== "PAGE" && parent.layoutMode && parent.layoutMode !== "NONE") {
          throw new Error("Destination uses auto layout; move into a non-auto-layout frame to preserve positioning");
        }
        const parentBox = parent.type === "PAGE" ? { x: 0, y: 0 } : (_d = parent.absoluteBoundingBox) != null ? _d : { x: 0, y: 0 };
        const positions = nodes.map((node) => {
          var _a2;
          const box = (_a2 = node.absoluteBoundingBox) != null ? _a2 : { x: node.x, y: node.y };
          return { node, x: box.x, y: box.y };
        });
        const selected = new Set(nodes.map((node) => node.id));
        const remaining = parent.children.filter((node) => !selected.has(node.id));
        const insertIndex = Math.min((_e = args.insertIndex) != null ? _e : remaining.length, remaining.length);
        for (let i = 0; i < positions.length; i++) {
          const item = positions[i];
          const maxIndex = parent.children.length - (((_f = item.node.parent) == null ? void 0 : _f.id) === parent.id ? 1 : 0);
          parent.insertChild(Math.min(insertIndex + i, maxIndex), item.node);
          if (args.preserveAbsolutePosition !== false) {
            item.node.x = item.x - parentBox.x;
            item.node.y = item.y - parentBox.y;
          }
        }
        figma.commitUndo();
        return { parentId: parent.id, moved: nodes.map((node) => node.id), insertIndex, preservedAbsolutePosition: args.preserveAbsolutePosition !== false };
      }
      case "reorder_nodes": {
        const parent = requireContainer(await getNode(args.parentId));
        const selected = /* @__PURE__ */ new Set();
        const nodes = [];
        for (const id of args.nodeIds) {
          if (selected.has(id)) throw new Error(`Duplicate node id: ${id}`);
          const node = requireScene(await getNode(id));
          if (((_g = node.parent) == null ? void 0 : _g.id) !== parent.id) throw new Error("Every node must be a direct child of parentId");
          selected.add(id);
          nodes.push(node);
        }
        const remaining = parent.children.filter((node) => !selected.has(node.id));
        const index = Math.min(args.index, remaining.length);
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          parent.insertChild(Math.min(index + i, parent.children.length - 1), node);
        }
        figma.commitUndo();
        return { parentId: parent.id, nodeIds: nodes.map((node) => node.id), index };
      }
      case "set_image_fill": {
        const node = requireScene(await getNode(args.nodeId));
        if (!("fills" in node)) throw new Error(`fills is not supported on ${node.type}`);
        const { image, normalized } = await createFigmaImage(args.base64, args.sourceMimeType);
        node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: (_h = args.scaleMode) != null ? _h : "FILL" }];
        figma.commitUndo();
        return { nodeId: node.id, imageHash: image.hash, normalized, scaleMode: (_i = args.scaleMode) != null ? _i : "FILL" };
      }
      case "delete_node": {
        const node = requireScene(await getNode(args.nodeId));
        const deleted = { id: node.id, name: node.name };
        node.remove();
        figma.commitUndo();
        return { deleted };
      }
      case "set_selection": {
        const nodes = [];
        for (const id of args.nodeIds) nodes.push(requireScene(await getNode(id)));
        const page = nodes.length ? pageOf2(nodes[0]) : figma.currentPage;
        if (nodes.some((node) => pageOf2(node).id !== page.id)) throw new Error("All selected nodes must belong to the same page");
        await figma.setCurrentPageAsync(page);
        page.selection = nodes;
        if (args.focus && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
        return { selected: nodes.map((n) => n.id) };
      }
      case "export_node": {
        const node = requireScene(await getNode(args.nodeId));
        if (!("exportAsync" in node)) throw new Error("Node does not support export");
        if (args.format === "SVG") {
          const svg = await node.exportAsync({ format: "SVG_STRING" });
          if (svg.length > 4 * 1024 * 1024) throw new Error("SVG exceeds 4 MiB; export a smaller node");
          return { svg };
        }
        const bounds = (_j = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null) != null ? _j : node.absoluteBoundingBox;
        if (!bounds) throw new Error("Node has no visible bounds");
        const actualScale = Math.min(args.scale, 4096 / Math.max(bounds.width, bounds.height, 1));
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: actualScale } });
        if (bytes.length > 8 * 1024 * 1024) throw new Error("PNG exceeds 8 MiB; lower scale or export a smaller node");
        return { data: figma.base64Encode(bytes), mimeType: "image/png", scale: actualScale };
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
  figma.showUI(__html__, { width: 380, height: 480, themeColors: true });
  var busy = false;
  function publishDocument() {
    figma.ui.postMessage({ type: "document", document: {
      name: figma.root.name,
      page: figma.currentPage.name,
      pluginVersion: "0.7.17",
      capabilities: getCapabilities()
    } });
  }
  figma.on("currentpagechange", publishDocument);
  figma.ui.onmessage = async (message) => {
    var _a;
    if ((message == null ? void 0 : message.type) === "decode-image-result" && typeof message.id === "string") {
      const pending = imageDecodeRequests.get(message.id);
      if (!pending) return;
      imageDecodeRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new Error(message.error));
      else if (typeof message.base64 === "string") pending.resolve(message.base64);
      else pending.reject(new Error("Image normalization returned no data"));
      return;
    }
    if ((message == null ? void 0 : message.type) === "init") {
      publishDocument();
      return;
    }
    if ((message == null ? void 0 : message.type) === "set-plan") {
      if (busy) {
        figma.ui.postMessage({ type: "policy-error", error: "\u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438." });
        return;
      }
      try {
        setDeclaredPlan(message.plan);
        publishDocument();
      } catch (error) {
        figma.ui.postMessage({ type: "policy-error", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if ((message == null ? void 0 : message.type) !== "command" || typeof message.id !== "string") return;
    if (busy) {
      figma.ui.postMessage({ type: "result", id: message.id, error: "Plugin busy; wait for the running operation." });
      return;
    }
    busy = true;
    try {
      const result2 = await execute(message.command, (_a = message.args) != null ? _a : {});
      figma.ui.postMessage({ type: "result", id: message.id, result: result2 });
    } catch (error) {
      figma.ui.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
      publishDocument();
    }
  };
})();
