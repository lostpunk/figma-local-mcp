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
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // plugin/resource-revision.ts
  function resourceRevision(value) {
    const text = JSON.stringify(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  }

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
    return async (id2, localOnly = false) => {
      local != null ? local : local = figma.variables.getLocalVariablesAsync().then((variables2) => new Map(variables2.map((variable2) => [variable2.id, variable2])));
      let variables;
      try {
        variables = await local;
      } catch (e) {
        throw new Error("LOCAL_VARIABLES_UNAVAILABLE: Could not read variables in this file. Check Figma connectivity and read get_design_system before retrying.");
      }
      const variable = variables.get(id2);
      if (variable) return variable;
      if (localOnly) return null;
      try {
        return await figma.variables.getVariableByIdAsync(id2);
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
      for (const font2 of [plan.spec.fontName, (_f = plan.existing) == null ? void 0 : _f.fontName]) if (font2) fonts.set(JSON.stringify(font2), font2);
    }
    for (const font2 of fonts.values()) await figma.loadFontAsync(font2);
    const created = [];
    const restore2 = [];
    let mutated = false;
    try {
      for (const plan of variablePlan.filter((p) => p.changed)) {
        let variable = plan.existing;
        if (variable) {
          const previous = variable.valuesByMode[modeId];
          if (previous === void 0) throw new Error(`Default mode has no value for ${plan.name}`);
          const target = variable;
          restore2.push(() => target.setValueForMode(modeId, previous));
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
          restore2.push(() => {
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
      for (const undo of restore2.reverse()) {
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

  // plugin/node-placement.ts
  var identity = [[1, 0, 0], [0, 1, 0]];
  function worldTransform(node) {
    const matrix = node.type === "PAGE" ? identity : node.absoluteTransform;
    if (!matrix || matrix.some((row) => row.some((value) => !Number.isFinite(value)))) throw new Error("Invalid node transform");
    return matrix.map((row) => [...row]);
  }
  function localTransform(parent, world) {
    const [[a, c, x], [b, d, y]] = worldTransform(parent);
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-10) throw new Error("Destination transform is not invertible");
    const [[e, g, u], [f, h, v]] = world;
    return [
      [(d * e - c * f) / determinant, (d * g - c * h) / determinant, (d * (u - x) - c * (v - y)) / determinant],
      [(a * f - b * e) / determinant, (a * h - b * g) / determinant, (a * (v - y) - b * (u - x)) / determinant]
    ];
  }
  function verifyWorldTransform(node, expected) {
    const actual = worldTransform(node);
    if (actual.some((row, r) => row.some((value, c) => Math.abs(value - expected[r][c]) > (c === 2 ? 0.01 : 1e-5)))) {
      throw new Error("Destination geometry changed; absolute transform could not be preserved");
    }
  }
  function placeNodes(parent, nodes, requestedIndex) {
    const selected = new Set(nodes.map((node) => node.id));
    const remaining = parent.children.filter((node) => !selected.has(node.id));
    const index = Math.min(requestedIndex != null ? requestedIndex : remaining.length, remaining.length);
    const desired = [...remaining.slice(0, index), ...nodes, ...remaining.slice(index)];
    const current = parent.children;
    if (current.length === desired.length && current.every((node, i) => node.id === desired[i].id)) return index;
    for (const node of nodes) parent.appendChild(node);
    if (index < remaining.length) {
      for (let i = 0; i < nodes.length; i++) parent.insertChild(index + i, nodes[i]);
    }
    const actual = parent.children;
    if (actual.length !== desired.length || actual.some((node, i) => node.id !== desired[i].id)) {
      throw new Error("Layer order verification failed");
    }
    return index;
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
    const { name, colors, typography, spacing, radii: radii2 } = args;
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
    const fonts = new Map(fontNames.map((font2) => [JSON.stringify(font2), font2]));
    for (const font2 of fonts.values()) await figma.loadFontAsync(font2);
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
      const radiusTokens = radii2.map((s) => __spreadProps(__spreadValues({}, s), { variable: createVariable(`radius/${s.name}`, s.value, "FLOAT") }));
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
      const label2 = (text, x, y2, size2 = 14, bold = false) => create("TEXT", {
        name: text,
        characters: text,
        x,
        y: y2,
        fontSize: size2,
        fontName: { family: "Inter", style: bold ? "Bold" : "Regular" },
        fill: "#0F172A",
        textAutoResize: "HEIGHT",
        width: 980
      }, board.id);
      const title = await label2(name, 48, 40, 40, true);
      const subtitleY = 40 + title.height + 16;
      const subtitle = await label2("Style guide \xB7 Colors / Typography / Spacing / Radius", 48, subtitleY);
      let y = subtitleY + subtitle.height + 40;
      async function heading(title2) {
        const node = await label2(title2, 48, y, 24, true);
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
        const caption = await label2(`${token.name}   ${token.value}`, 136, y + 10);
        await helpers.applyProps(caption, { width: 880 });
        y += Math.max(48, caption.height + 10) + 16;
      }
      y += 24;
      await heading("02 / Typography");
      for (let i = 0; i < styles.length; i++) {
        const spec = typography[i];
        const title2 = await label2(`${spec.name} \xB7 ${spec.fontFamily} ${spec.fontStyle} \xB7 ${spec.fontSize}px`, 48, y);
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
        const title2 = await label2(`${token.name} \xB7 ${token.value}px`, 48, y);
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
        const caption = await label2(`${token.name} \xB7 ${token.value}px`, 152, y + 16);
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    switch (command) {
      case "create_style_guide":
        return createGuide(args, helpers);
      case "sync_style_guide":
        return syncGuide(args);
      case "get_design_system": {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const selected = collections.filter((c) => {
          var _a2;
          return c.name.startsWith((_a2 = args.prefix) != null ? _a2 : "") && (!args.collectionId || c.id === args.collectionId);
        });
        const ids = new Set(selected.map((c) => c.id));
        const variables = (await figma.variables.getLocalVariablesAsync()).filter((v) => {
          var _a2;
          return ids.has(v.variableCollectionId) && v.name.startsWith((_a2 = args.variableNamePrefix) != null ? _a2 : "");
        });
        const styles = (await figma.getLocalTextStylesAsync()).filter((s) => {
          var _a2;
          return s.name.startsWith((_a2 = args.prefix) != null ? _a2 : "");
        });
        const resources = {
          collections: selected.map((c) => ({ id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId })),
          variables: variables.map((v) => ({ id: v.id, name: v.name, type: v.resolvedType, collectionId: v.variableCollectionId, valuesByMode: v.valuesByMode })),
          textStyles: styles.map((s) => ({ id: s.id, name: s.name, fontName: s.fontName, fontSize: s.fontSize, lineHeight: s.lineHeight }))
        };
        for (const list of Object.values(resources)) list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const revision = resourceRevision([(_a = args.prefix) != null ? _a : "", (_b = args.collectionId) != null ? _b : "", (_c = args.variableNamePrefix) != null ? _c : "", resources]);
        const offsets = (_d = args.offsets) != null ? _d : {};
        if (Object.values(offsets).some((value) => Number(value) > 0) && !args.revision) throw new Error("PAGINATION_REVISION_REQUIRED: Supply revision from the first get_design_system response.");
        if (args.revision && args.revision !== revision) throw new Error("DESIGN_SYSTEM_CHANGED: Resources or filters changed. Restart pagination without offsets/revision.");
        const result2 = { revision, pagination: {}, truncated: false };
        for (const key of ["collections", "variables", "textStyles"]) {
          const list = resources[key];
          const offset = Math.min((_e = offsets[key]) != null ? _e : 0, list.length);
          result2[key] = list.slice(offset, offset + ((_f = args.limit) != null ? _f : 200));
          const next = offset + result2[key].length;
          result2.pagination[key] = { offset, total: list.length, nextOffset: next < list.length ? next : null };
          result2.truncated || (result2.truncated = next < list.length);
        }
        return result2;
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
        const rootParentId = (_g = args.parentId) != null ? _g : figma.currentPage.id;
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
            if (((_h = node.parent) == null ? void 0 : _h.id) === expectedId) continue;
            const expected = await helpers.getNode(expectedId);
            if (!["PAGE", "FRAME", "COMPONENT", "SECTION"].includes(expected.type)) throw new Error(`Invalid expected parent for ${spec.ref}`);
            if (expected.type !== "PAGE" && expected.layoutMode !== "NONE") {
              throw new Error(`Hierarchy verification failed for ${spec.ref}: destination uses auto layout`);
            }
            const world = worldTransform(node);
            localTransform(expected, world);
            expected.appendChild(node);
            node.relativeTransform = localTransform(expected, world);
            verifyWorldTransform(node, world);
            if (((_i = node.parent) == null ? void 0 : _i.id) !== expectedId) throw new Error(`Hierarchy recovery failed for ${spec.ref}`);
            repaired.push(spec.ref);
          }
          figma.commitUndo();
          return { nodes: Array.from(refs, ([ref2, node]) => ({ ref: ref2, id: node.id, type: node.type, name: node.name })), hierarchyVerified: true, repaired };
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
        if (component.type !== "COMPONENT") throw new Error("componentId must refer to an accessible COMPONENT");
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
        const modeId = (_j = args.modeId) != null ? _j : collection.defaultModeId;
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
            for (const font2 of fonts) await figma.loadFontAsync(font2);
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

  // plugin/design-review.ts
  async function resolveDesignRules(rules) {
    var _a, _b, _c;
    const variables = [], styles = [], components = [];
    for (const id2 of (_a = rules.colorVariableIds) != null ? _a : []) {
      const v = await figma.variables.getVariableByIdAsync(id2);
      if (!v || v.resolvedType !== "COLOR") throw new Error(`Expected a COLOR variable: ${id2}`);
      variables.push(v);
    }
    for (const id2 of (_b = rules.textStyleIds) != null ? _b : []) {
      const style = await figma.getStyleByIdAsync(id2);
      if (!style || style.type !== "TEXT") throw new Error(`Expected a text style: ${id2}`);
      styles.push(style);
    }
    for (const id2 of (_c = rules.componentIds) != null ? _c : []) {
      const node = await figma.getNodeByIdAsync(id2);
      if (!node || !["COMPONENT", "COMPONENT_SET"].includes(node.type)) throw new Error(`Expected a component or set: ${id2}`);
      components.push(node);
    }
    return { variables, styles, components };
  }
  function variableColor(variable, node) {
    const resolved = variable.resolveForConsumer(node);
    if (resolved.resolvedType !== "COLOR" || !resolved.value || typeof resolved.value !== "object" || !("r" in resolved.value))
      throw new Error("Color variable could not be resolved for this layer.");
    return resolved.value;
  }
  function paintMatches(paint4, color2) {
    var _a;
    return (paint4 == null ? void 0 : paint4.type) === "SOLID" && Math.abs(((_a = paint4.opacity) != null ? _a : 1) - color2.a) < 1e-6 && ["r", "g", "b"].every((k) => Math.abs(paint4.color[k] - color2[k]) < 1e-6);
  }
  var typographyKeys = [
    "fontName",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "paragraphSpacing",
    "paragraphIndent",
    "textCase",
    "textDecoration",
    "listSpacing",
    "hangingPunctuation",
    "hangingList",
    "leadingTrim",
    "textWrapStyle"
  ];
  function styleMatches(node, style) {
    return typographyKeys.every((key) => JSON.stringify(node[key]) === JSON.stringify(style[key]));
  }
  async function inspectDesignNode(node, rules, resources) {
    var _a, _b, _c, _d, _e, _f;
    if ((_a = rules.ignoreNodeIds) == null ? void 0 : _a.includes(node.id)) return [];
    const findings = [];
    if (rules.colorVariableIds) for (const field of ["fills", "strokes"]) {
      const paints = node[field];
      if (paints === figma.mixed) {
        findings.push({ code: "MIXED_COLOR_BINDINGS", message: "Mixed text paints require range-level review.", evidence: { field } });
        continue;
      }
      if (!Array.isArray(paints)) continue;
      for (const [index, paint4] of paints.entries()) {
        if (paint4.visible === false || paint4.type !== "SOLID") continue;
        const id2 = (_c = (_b = paint4.boundVariables) == null ? void 0 : _b.color) == null ? void 0 : _c.id;
        if (id2 && rules.colorVariableIds.includes(id2)) continue;
        findings.push({
          code: id2 ? "COLOR_VARIABLE_OUTSIDE_SYSTEM" : "UNBOUND_COLOR",
          message: id2 ? "Color is bound to a variable outside the supplied project system." : "Solid color has no project variable binding.",
          evidence: {
            field,
            paintIndex: index,
            variableId: id2 != null ? id2 : null,
            candidateVariableIds: resources.variables.filter((v) => paintMatches(paint4, variableColor(v, node))).map((v) => v.id)
          }
        });
      }
    }
    if (node.type === "TEXT" && rules.textStyleIds && !rules.textStyleIds.includes(node.textStyleId)) findings.push({
      code: "TEXT_STYLE_OUTSIDE_SYSTEM",
      message: "Text has no approved project style. Candidates match current uniform typography exactly.",
      evidence: {
        textStyleId: typeof node.textStyleId === "string" ? node.textStyleId : null,
        candidateStyleIds: resources.styles.filter((s) => styleMatches(node, s)).map((s) => s.id)
      }
    });
    if (node.type === "INSTANCE" && rules.componentIds) {
      const main = await node.getMainComponentAsync();
      if (!main || !rules.componentIds.includes(main.id) && !rules.componentIds.includes((_d = main.parent) == null ? void 0 : _d.id)) findings.push({
        code: "COMPONENT_OUTSIDE_SYSTEM",
        message: "Instance source is outside the supplied project component list; inspect its role before replacement.",
        evidence: { componentId: (_e = main == null ? void 0 : main.id) != null ? _e : null, componentSetId: ((_f = main == null ? void 0 : main.parent) == null ? void 0 : _f.type) === "COMPONENT_SET" ? main.parent.id : null }
      });
    }
    return findings;
  }
  async function resolveDesignEdit(node, edit) {
    if (edit.property === "textStyleId") {
      const style = await figma.getStyleByIdAsync(edit.resourceId);
      if (!style || style.type !== "TEXT" || !styleMatches(node, style)) throw new Error("Text style or typography changed. Preview again.");
      validateStyleEdit(node, edit, style);
      return style;
    }
    const variable = await figma.variables.getVariableByIdAsync(edit.resourceId);
    if (!variable || variable.resolvedType !== "COLOR") throw new Error("Color variable is unavailable. Preview again.");
    validateColorEdit(node, edit, variable);
    return variable;
  }
  function validateStyleEdit(node, edit, style) {
    if (JSON.stringify(typographyKeys.map((key) => style[key])) !== edit.signature || !styleMatches(node, style))
      throw new Error("Text style or typography changed. Preview again.");
  }
  function validateColorEdit(node, edit, variable) {
    const color2 = variableColor(variable, node), paints = node[edit.property === "fillVariableId" ? "fills" : "strokes"];
    if (JSON.stringify(color2) !== edit.signature || !Array.isArray(paints) || paints.length !== 1 || !paintMatches(paints[0], color2))
      throw new Error("Color or variable mode changed. Preview again.");
  }
  function validateDesignTarget(node, edits) {
    if (!["RECTANGLE", "ELLIPSE", "FRAME", "TEXT"].includes(node.type)) throw new Error("Binding preview does not support this node type.");
    for (let current = node; current && current.type !== "DOCUMENT"; current = current.parent)
      if (current.locked || current.isMask || current.visible === false || current.opacity === 0 || ["COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(current.type)) throw new Error("Hidden, locked, masked or component hierarchies require manual binding review.");
    if (edits.some((e) => e.property === "textStyleId") && (typeof node.textStyleId !== "string" || typeof node.fontName !== "object"))
      throw new Error("Mixed typography requires manual review.");
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
    let designResources;
    let designChecked = 0, designIgnored = 0;
    if (rules.designSystem) {
      try {
        designResources = await resolveDesignRules(rules.designSystem);
      } catch (error) {
        failedChecks++;
        add({ code: "DESIGN_RULES_INVALID", severity: "warning", message: error instanceof Error ? error.message : String(error) });
      }
    }
    const check = async (node) => {
      var _a2, _b2, _c2, _d2, _e2;
      if (designResources && rules.designSystem && node.type !== "PAGE") {
        if ((_a2 = rules.designSystem.ignoreNodeIds) == null ? void 0 : _a2.includes(node.id)) designIgnored++;
        else {
          for (const finding of await inspectDesignNode(node, rules.designSystem, designResources))
            note(node, finding.code, finding.message, finding.evidence);
          designChecked++;
        }
      }
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
      if ("layoutMode" in node && ["HORIZONTAL", "VERTICAL"].includes(node.layoutMode) && ((_b2 = rules.spacing) == null ? void 0 : _b2.length)) {
        const properties = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
        if (node.primaryAxisAlignItems !== "SPACE_BETWEEN") properties.push("itemSpacing");
        if (node.layoutWrap === "WRAP" && node.counterAxisAlignContent !== "SPACE_BETWEEN") properties.push("counterAxisSpacing");
        const values = node;
        const offScale = properties.filter((key) => finite(values[key]) && ![0, ...rules.spacing].some((value) => Math.abs(values[key] - value) <= tolerance));
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
            { maxLines: (_c2 = node.maxLines) != null ? _c2 : null },
            "info"
          );
        } else if (node.textAutoResize === "NONE") {
          const rendered = node.absoluteRenderBounds, box = node.absoluteBoundingBox;
          if (!node.effects.some((effect) => effect.visible !== false) && !node.strokes.some((paint4) => paint4.visible !== false) && rendered && box && (rendered.x < box.x - tolerance || rendered.y < box.y - tolerance || rendered.x + rendered.width > box.x + box.width + tolerance || rendered.y + rendered.height > box.y + box.height + tolerance)) {
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
      for (const rule of (_d2 = rules.componentStates) != null ? _d2 : []) {
        if (rule.nodeId !== node.id) continue;
        seenStateRules.add(rule);
        if (node.type !== "COMPONENT_SET") {
          failedChecks++;
          note(node, "STATE_RULE_TARGET_INVALID", "State rules must target a verified component set.");
          continue;
        }
        const property = node.componentPropertyDefinitions[rule.property];
        const actual = (property == null ? void 0 : property.type) === "VARIANT" ? (_e2 = property.variantOptions) != null ? _e2 : [] : [];
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
        await check(node);
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
        designSystem: { enabled: Boolean(rules.designSystem), checked: designChecked, ignored: designIgnored },
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

  // plugin/layout-preview.ts
  function layoutDescendants(node) {
    const descendants = [];
    function visit(current) {
      var _a;
      for (const child of (_a = current.children) != null ? _a : []) {
        if (descendants.length >= 100) throw new Error("Layout preview supports at most 100 descendants.");
        descendants.push(child);
        visit(child);
      }
    }
    visit(node);
    return descendants;
  }
  var layoutProperties = /* @__PURE__ */ new Set(["width", "height", "itemSpacing", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight"]);
  var isLayoutEdit = (node, props) => node.type === "FRAME" && Object.keys(props).some((key) => layoutProperties.has(key));
  function predictLayout(node, props) {
    var _a, _b, _c, _d, _e;
    if (!["HORIZONTAL", "VERTICAL"].includes(node.layoutMode)) throw new Error("Layout preview requires an existing horizontal or vertical Auto Layout frame.");
    if (node.primaryAxisSizingMode !== "FIXED" || node.counterAxisSizingMode !== "FIXED" || node.layoutWrap === "WRAP" || node.counterAxisAlignItems === "BASELINE" || ((_a = node.strokes) == null ? void 0 : _a.some((p) => p.visible !== false)) && node.strokesIncludedInLayout)
      throw new Error("Layout preview requires fixed axes without wrapping, baseline alignment or included strokes.");
    for (let current = node; current && current.type !== "PAGE"; current = current.parent) {
      if (current !== node && (current.type === "GROUP" || ["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(current.type) || current.layoutMode && current.layoutMode !== "NONE"))
        throw new Error("Layout preview requires a regular ancestor hierarchy.");
      if (current.locked || current.visible === false || current.opacity === 0 || current.isMask || ((_c = (_b = current.parent) == null ? void 0 : _b.children) == null ? void 0 : _c.some((child) => child.isMask)))
        throw new Error("Hidden, locked or masked layout requires manual review.");
      const m = current.relativeTransform;
      if (!m || m[0][0] !== 1 || m[0][1] !== 0 || m[1][0] !== 0 || m[1][1] !== 1)
        throw new Error("Transformed layout requires manual review.");
    }
    if (["minWidth", "maxWidth", "minHeight", "maxHeight"].some((key) => node[key] != null))
      throw new Error("Layout min/max constraints require manual review.");
    const descendants = layoutDescendants(node);
    const children = node.children.filter((c) => c.visible !== false);
    for (const child of children) {
      const m = child.relativeTransform;
      if (child.layoutPositioning === "ABSOLUTE" || child.layoutGrow || child.layoutAlign === "STRETCH" || child.layoutSizingHorizontal === "FILL" || child.layoutSizingVertical === "FILL" || child.isMask || !m || m[0][0] !== 1 || m[0][1] !== 0 || m[1][0] !== 0 || m[1][1] !== 1)
        throw new Error("Layout children must have fixed measured sizes, without fill, stretch, absolute placement or transforms.");
    }
    const value = (key) => {
      var _a2;
      return (_a2 = props[key]) != null ? _a2 : node[key];
    };
    const horizontal = node.layoutMode === "HORIZONTAL";
    const width = value("width"), height = value("height");
    const main = horizontal ? width : height, cross = horizontal ? height : width;
    const start = value(horizontal ? "paddingLeft" : "paddingTop"), end = value(horizontal ? "paddingRight" : "paddingBottom");
    const crossStart = value(horizontal ? "paddingTop" : "paddingLeft"), crossEnd = value(horizontal ? "paddingBottom" : "paddingRight");
    const sizes2 = children.map((c) => horizontal ? c.width : c.height);
    const used = sizes2.reduce((sum, n) => sum + n, 0);
    const align = (_d = node.primaryAxisAlignItems) != null ? _d : "MIN", crossAlign = (_e = node.counterAxisAlignItems) != null ? _e : "MIN";
    if (!["MIN", "CENTER", "MAX", "SPACE_BETWEEN"].includes(align) || !["MIN", "CENTER", "MAX"].includes(crossAlign))
      throw new Error("Unsupported layout alignment.");
    const remaining = main - start - end - used;
    const gap = align === "SPACE_BETWEEN" && children.length > 1 ? Math.max(0, remaining / (children.length - 1)) : value("itemSpacing");
    const free = remaining - Math.max(0, children.length - 1) * gap;
    if (free < -0.01) throw new Error("Proposed layout does not fit its main axis.");
    let cursor = start + (align === "CENTER" ? free / 2 : align === "MAX" ? free : 0);
    const effects = children.map((child, index) => {
      const crossSize = horizontal ? child.height : child.width, crossFree = cross - crossStart - crossEnd - crossSize;
      if (crossFree < -0.01) throw new Error("Proposed layout does not fit its cross axis.");
      const other = crossStart + (crossAlign === "CENTER" ? crossFree / 2 : crossAlign === "MAX" ? crossFree : 0);
      const after = { x: horizontal ? cursor : other, y: horizontal ? other : cursor, width: child.width, height: child.height };
      cursor += sizes2[index] + gap;
      return { nodeId: child.id, before: { x: child.x, y: child.y, width: child.width, height: child.height }, after };
    });
    if (!Object.values({ width, height, start, end, crossStart, crossEnd, gap }).every(Number.isFinite))
      throw new Error("Layout geometry is unavailable.");
    return { nodeId: node.id, frame: { width, height }, children: effects, descendants };
  }

  // plugin/text-fit.ts
  function textHeightProposal(node, requested, tolerance = 0.5) {
    var _a, _b, _c;
    if (node.type !== "TEXT" || node.textAutoResize !== "NONE" || node.textTruncation === "ENDING")
      throw new Error("Text fix requires fixed-size text without ellipsis.");
    if (node.hasMissingFont || typeof node.fontName !== "object" || typeof node.fontSize !== "number" || node.textAlignVertical && node.textAlignVertical !== "TOP")
      throw new Error("Missing/mixed fonts or vertical text alignment require manual review.");
    if (node.effects.some((v) => v.visible !== false) || node.strokes.some((v) => v.visible !== false))
      throw new Error("Text effects or strokes make render bounds ambiguous.");
    const parent = node.parent;
    if ((parent == null ? void 0 : parent.type) !== "FRAME" || parent.layoutMode !== "NONE" || parent.overflowDirection && parent.overflowDirection !== "NONE")
      throw new Error("Text fix requires a regular non-scrolling frame.");
    for (let current = node; current && current.type !== "PAGE"; current = current.parent) {
      if (current.visible === false || current.opacity === 0 || current.locked || current.isMask || ["INSTANCE", "COMPONENT", "COMPONENT_SET", "GROUP"].includes(current.type) || current.layoutMode && current.layoutMode !== "NONE" || ((_b = (_a = current.parent) == null ? void 0 : _a.children) == null ? void 0 : _b.some((child) => child.isMask)))
        throw new Error("Hidden, locked, masked, component or Auto Layout hierarchies require manual review.");
      const m = current.relativeTransform;
      if (!m || m[0][0] !== 1 || m[0][1] !== 0 || m[1][0] !== 0 || m[1][1] !== 1)
        throw new Error("Transformed text or ancestors require manual review.");
    }
    if (parent.children.length > 200) throw new Error("Too many siblings for a bounded text fix.");
    const box = node.absoluteBoundingBox, ink = node.absoluteRenderBounds;
    if (!box || !ink || ![box.x, box.y, box.width, box.height, ink.x, ink.y, ink.width, ink.height].every(Number.isFinite))
      throw new Error("Text render bounds are unavailable.");
    if (ink.x < box.x - tolerance || ink.x + ink.width > box.x + box.width + tolerance || ink.y < box.y - tolerance)
      throw new Error("Horizontal or top glyph overflow requires manual review.");
    const minimum = Math.ceil(ink.y + ink.height - box.y);
    const height = requested != null ? requested : minimum;
    if (!Number.isFinite(height) || height <= node.height || height < minimum || height > 1e5)
      throw new Error("Text height must grow to contain the current rendered text.");
    if (node.x < 0 || node.y < 0 || node.x + node.width > parent.width || node.y + height > parent.height)
      throw new Error("Text cannot grow within its parent.");
    const strip = { x: box.x, right: box.x + box.width, y: box.y + node.height, bottom: box.y + height };
    for (const sibling of parent.children) {
      if (sibling === node || sibling.visible === false || sibling.opacity === 0) continue;
      const b = sibling.absoluteBoundingBox;
      if (!b) throw new Error("A sibling has no bounds; inspect text growth manually.");
      const r = (_c = sibling.absoluteRenderBounds) != null ? _c : b;
      const left = Math.min(b.x, r.x), right = Math.max(b.x + b.width, r.x + r.width);
      const top = Math.min(b.y, r.y), bottom = Math.max(b.y + b.height, r.y + r.height);
      if (left < strip.right && right > strip.x && top < strip.bottom && bottom > strip.y)
        throw new Error(`Text growth intersects sibling ${sibling.id}; review spacing manually.`);
    }
    return { height };
  }
  function textSiblingState(node) {
    return node.parent.children.map((s) => ({
      id: s.id,
      visible: s.visible,
      opacity: s.opacity,
      isMask: s.isMask,
      bounds: s.absoluteBoundingBox,
      rendered: s.absoluteRenderBounds
    }));
  }

  // plugin/changes.ts
  var TTL = 5 * 60 * 1e3;
  var plans2 = /* @__PURE__ */ new Map();
  var session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  var sequence = 0;
  var metadata = /* @__PURE__ */ new Set(["name", "opacity", "visible", "locked"]);
  var shapeProps = /* @__PURE__ */ new Set([...metadata, "x", "y", "width", "height", "fill", "stroke", "strokeWeight", "cornerRadius"]);
  var geometry = /* @__PURE__ */ new Set(["x", "y", "width", "height"]);
  var radii = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
  var stateKeys = [
    "name",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "relativeTransform",
    "opacity",
    "visible",
    "locked",
    "isMask",
    "resolvedVariableModes",
    "fills",
    "strokes",
    "strokeWeight",
    "strokeTopWeight",
    "strokeBottomWeight",
    "strokeLeftWeight",
    "strokeRightWeight",
    "cornerRadius",
    ...radii,
    "cornerSmoothing",
    "effects",
    "constraints",
    "boundVariables",
    "explicitVariableModes",
    "fillStyleId",
    "strokeStyleId",
    "effectStyleId",
    ...typographyKeys,
    "characters",
    "fontName",
    "fontSize",
    "textStyleId",
    "textAutoResize",
    "textAlignVertical",
    "textAlignHorizontal",
    "lineHeight",
    "letterSpacing",
    "paragraphSpacing",
    "paragraphIndent",
    "listSpacing",
    "textCase",
    "textDecoration",
    "textTruncation",
    "maxLines",
    "hasMissingFont",
    "absoluteRenderBounds",
    "layoutMode",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "layoutWrap",
    "layoutPositioning",
    "layoutGrow",
    "layoutAlign",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "strokesIncludedInLayout",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "itemSpacing",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight"
  ];
  var stateFieldIndexes = new Map([.../* @__PURE__ */ new Set(["id", "type", "parentId", ...stateKeys, "childIds"])].map((key, index) => [key, index]));
  function copy(value) {
    if (value === void 0) return null;
    return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "symbol" ? { mixed: true } : v));
  }
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  function state(node) {
    var _a, _b;
    const result2 = { id: node.id, type: node.type, parentId: (_b = (_a = node.parent) == null ? void 0 : _a.id) != null ? _b : null };
    for (const key of stateKeys) if (key in node) result2[key] = copy(node[key]);
    if ("children" in node) result2.childIds = node.children.map((child) => child.id);
    return result2;
  }
  function compactState(node) {
    return Object.entries(state(node)).map(([key, value]) => {
      const index = stateFieldIndexes.get(key);
      if (index === void 0) throw new Error(`Missing snapshot field: ${key}`);
      return [index, value];
    });
  }
  function snapshot(node, props = {}, nodeState) {
    var _a, _b;
    if (node.removed) throw new Error(`Node removed: ${node.id}. Preview again.`);
    const ancestors = [];
    let parent = node.parent;
    while (parent) {
      if (ancestors.length >= 64) throw new Error("Layer hierarchy is too deep for a change preview.");
      const context = { id: parent.id, type: parent.type, parentId: (_b = (_a = parent.parent) == null ? void 0 : _a.id) != null ? _b : null };
      for (const key of ["x", "y", "width", "height", "relativeTransform", "layoutMode", "visible", "locked", "opacity", "isMask", "overflowDirection", "clipsContent"])
        if (key in parent) context[key] = copy(parent[key]);
      if ("children" in parent) context.maskIds = parent.children.filter((child) => child.isMask).map((child) => child.id);
      ancestors.push(context);
      parent = parent.parent;
    }
    if (!ancestors.some((p) => p.type === "PAGE")) throw new Error("Layer must be attached to a page.");
    const value = stable({
      node: nodeState != null ? nodeState : state(node),
      ancestors,
      descendants: isLayoutEdit(node, props) ? layoutDescendants(node).map(compactState) : void 0,
      siblings: node.type === "TEXT" && "height" in props ? textSiblingState(node) : void 0
    });
    if (value.length > 32e3) throw new Error("Layer state is too large for a change preview.");
    return value;
  }
  function validatePreviewProperties(node, props) {
    var _a, _b;
    if (!["RECTANGLE", "ELLIPSE", "FRAME", "TEXT"].includes(node.type)) throw new Error(`Change previews do not support ${node.type}.`);
    const shape = node.type === "RECTANGLE" || node.type === "ELLIPSE";
    if ("strokeWeight" in props && typeof node.strokeWeight !== "number")
      throw new Error("Preview does not support replacing mixed individual stroke weights.");
    for (const [key, value] of Object.entries(props)) {
      if (!(shape ? shapeProps : node.type === "TEXT" ? /* @__PURE__ */ new Set([...metadata, "height"]) : /* @__PURE__ */ new Set([...metadata, ...layoutProperties])).has(key) || key === "cornerRadius" && node.type !== "RECTANGLE")
        throw new Error(`Preview does not support ${key} on ${node.type}.`);
      if (key === "name" ? typeof value !== "string" || value.length > 500 : key === "visible" || key === "locked" ? typeof value !== "boolean" : key === "fill" || key === "stroke" ? value !== null && (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) : typeof value !== "number" || !Number.isFinite(value) || key === "opacity" && (value < 0 || value > 1) || ["width", "height"].includes(key) && (value <= 0 || value > 1e5) || key === "strokeWeight" && (value < 0 || value > 1e3) || key === "cornerRadius" && (value < 0 || value > 1e5) || (key === "itemSpacing" || key.startsWith("padding")) && (value < 0 || value > 1e3) || ["x", "y"].includes(key) && Math.abs(value) > 1e6) throw new Error(`Invalid preview value for ${key}.`);
    }
    const layout2 = isLayoutEdit(node, props);
    if (layout2) predictLayout(node, props);
    if (node.type === "TEXT" && "height" in props) textHeightProposal(node, props.height);
    const impactful = Object.keys(props).some((key) => key !== "name" && key !== "locked");
    const sizingOnly = layout2 && Object.keys(props).every((k) => layoutProperties.has(k) || ["name", "locked"].includes(k)) || node.type === "TEXT" && "height" in props && Object.keys(props).every((k) => ["height", "name", "locked"].includes(k));
    if (sizingOnly && Object.keys(props).some((key) => {
      var _a2;
      return (_a2 = node.boundVariables) == null ? void 0 : _a2[key];
    }))
      throw new Error("Preview cannot replace a bound sizing property. Keep its variable.");
    if (impactful && !sizingOnly && (Object.keys((_a = node.boundVariables) != null ? _a : {}).length || node.fillStyleId || node.strokeStyleId || node.effectStyleId || [...Array.isArray(node.fills) ? node.fills : [], ...(_b = node.strokes) != null ? _b : []].some((p) => {
      var _a2;
      return Object.keys((_a2 = p.boundVariables) != null ? _a2 : {}).length;
    })))
      throw new Error("Preview cannot change appearance or geometry of bound/styled layers. Keep their variables and styles.");
    for (let current = node; current && current.type !== "DOCUMENT"; current = current.parent) {
      if (["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(current.type)) throw new Error("Preview does not support component or instance hierarchies.");
      if (impactful && (current.type === "GROUP" || current.layoutMode && current.layoutMode !== "NONE" && !(layout2 && current === node)))
        throw new Error("Preview supports only name/locked inside groups or Auto Layout.");
    }
  }
  function paint(hex) {
    return hex === null ? [] : [{ type: "SOLID", color: {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255
    }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  }
  function read(node, key) {
    var _a, _b, _c, _d;
    if (key === "fillVariableId" || key === "strokeVariableId") return (_d = (_c = (_b = (_a = node[key === "fillVariableId" ? "fills" : "strokes"][0]) == null ? void 0 : _a.boundVariables) == null ? void 0 : _b.color) == null ? void 0 : _c.id) != null ? _d : null;
    return copy(node[key === "fill" ? "fills" : key === "stroke" ? "strokes" : key]);
  }
  function equivalent(a, b) {
    if (typeof a === "number" && typeof b === "number") return a === b || Math.fround(a) === Math.fround(b);
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equivalent(v, b[i]));
    if (a && b && typeof a === "object" && typeof b === "object") {
      const normalize2 = (value) => value.type === "SOLID" ? __spreadValues({ opacity: 1, visible: true, blendMode: "NORMAL", boundVariables: {} }, value) : value;
      a = normalize2(a);
      b = normalize2(b);
      return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && equivalent(a[k], b[k]));
    }
    return a === b;
  }
  function write(node, props) {
    var _a, _b;
    if ("width" in props || "height" in props) node.resize((_a = props.width) != null ? _a : node.width, (_b = props.height) != null ? _b : node.height);
    for (const [key, value] of Object.entries(props)) {
      if (key === "width" || key === "height" || key === "locked") continue;
      node[key === "fill" ? "fills" : key === "stroke" ? "strokes" : key] = value;
    }
    if ("locked" in props) node.locked = props.locked;
  }
  function restore(node, props, before) {
    if (Object.keys(props).some((key) => geometry.has(key))) {
      node.resize(before.width, before.height);
      node.relativeTransform = before.relativeTransform;
      node.x = before.x;
      node.y = before.y;
    }
    for (const key of Object.keys(props).reverse()) {
      if (geometry.has(key)) continue;
      if (key === "cornerRadius" && typeof before.cornerRadius !== "number") {
        for (const radius of radii) node[radius] = before[radius];
      } else node[key === "fill" ? "fills" : key === "stroke" ? "strokes" : key] = before[key === "fill" ? "fills" : key === "stroke" ? "strokes" : key];
    }
  }
  function prune() {
    for (const [id2, plan] of plans2) if (plan.expiresAt <= Date.now()) plans2.delete(id2);
  }
  async function previewChanges(args, getNode2) {
    if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 50) throw new Error("Provide 1\u201350 layers.");
    const ids = /* @__PURE__ */ new Set();
    let count = 0;
    for (const entry of args.changes) {
      if (!entry || typeof entry.nodeId !== "string" || ids.has(entry.nodeId) || !entry.props || Array.isArray(entry.props) || typeof entry.props !== "object" || !Object.keys(entry.props).length) throw new Error("Provide unique layers with nonempty properties.");
      ids.add(entry.nodeId);
      count += Object.keys(entry.props).length;
    }
    if (count > 200) throw new Error("At most 200 properties per preview.");
    const nodes = [];
    for (const entry of args.changes) nodes.push(await getNode2(entry.nodeId));
    return createChangePreview(nodes.map((node, index) => ({ node, props: args.changes[index].props })));
  }
  function createChangePreview(entries) {
    const ids = new Set(entries.map((entry) => entry.node.id));
    if (!entries.length || entries.length > 50 || ids.size !== entries.length || entries.reduce((count, entry) => count + Object.keys(entry.props).length, 0) > 200)
      throw new Error("Preview requires 1\u201350 unique layers and at most 200 properties.");
    const targets = [];
    let changeNumber = 0;
    for (const { node, props, design } of entries) {
      if (design) validateDesignTarget(node, design);
      else validatePreviewProperties(node, props);
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ids.has(parent.id)) throw new Error("Preview parent and descendant layers in separate plans.");
      const changes = [];
      for (const [property, value] of Object.entries(props)) {
        const before = read(node, property);
        const after = property === "fill" || property === "stroke" ? paint(value) : value;
        if (!equivalent(before, after)) changes.push({ id: `c${++changeNumber}`, nodeId: node.id, property, before, after });
      }
      const effectiveProps = Object.fromEntries(changes.map((change) => [change.property, change.after]));
      const prediction = isLayoutEdit(node, effectiveProps) ? predictLayout(node, effectiveProps) : null;
      const layout2 = prediction ? { nodeId: node.id, frame: prediction.frame, children: prediction.children } : void 0;
      targets.push({ nodeId: node.id, snapshot: snapshot(node, effectiveProps), changes, layout: layout2, design });
    }
    if (stable(targets).length > 256e3) throw new Error("Preview state is too large; use fewer layers.");
    prune();
    while (plans2.size >= 10) plans2.delete(plans2.keys().next().value);
    const planId = `${session}-${++sequence}`;
    const expiresAt = Date.now() + TTL;
    plans2.set(planId, { expiresAt, targets });
    return {
      planId,
      expiresAt,
      singleUse: true,
      previewType: "properties",
      changes: targets.flatMap((target) => target.changes),
      layoutEffects: targets.filter((t) => t.layout).map((t) => t.layout),
      atomicNodeIds: targets.filter((t) => t.layout).map((t) => t.nodeId)
    };
  }
  async function applyChanges(args, getNode2) {
    var _a;
    prune();
    const plan = plans2.get(args.planId);
    if (!plan) throw new Error("Unknown, expired or consumed plan. Preview again in this plugin session.");
    if (!Array.isArray(args.changeIds) || !args.changeIds.length || args.changeIds.length > 200 || new Set(args.changeIds).size !== args.changeIds.length) throw new Error("Select 1\u2013200 unique change IDs.");
    const selection = new Set(args.changeIds);
    const allChanges = plan.targets.flatMap((target) => target.changes);
    if (args.changeIds.some((id2) => !allChanges.some((change) => change.id === id2))) throw new Error("Unknown change ID. Use IDs from this plan.");
    const pending = [];
    for (const target of plan.targets) {
      const chosen = target.changes.filter((change) => selection.has(change.id));
      if (chosen.length && target.layout && chosen.length !== target.changes.length)
        throw new Error("Select all changes for a layout frame, or preview the smaller property set again.");
      if (chosen.length) pending.push({
        node: await getNode2(target.nodeId),
        target,
        props: Object.fromEntries(chosen.map((change) => [change.property, change.after])),
        before: {}
      });
    }
    for (const item of pending) if (item.target.design) {
      item.resources = [];
      for (const edit of item.target.design) {
        const resource = await resolveDesignEdit(item.node, edit);
        item.resources.push(resource);
        if (edit.property === "textStyleId") await figma.loadFontAsync(resource.fontName);
      }
    }
    for (const item of pending) if (item.node.type === "TEXT" && "height" in item.props) {
      const fonts = item.node.characters.length ? item.node.getRangeAllFontNames(0, item.node.characters.length) : [item.node.fontName];
      for (const font2 of fonts) await figma.loadFontAsync(font2);
    }
    if (plan.expiresAt <= Date.now()) {
      plans2.delete(args.planId);
      throw new Error("Plan expired during lookup. Preview again.");
    }
    for (const item of pending) {
      if (snapshot(item.node, Object.fromEntries(item.target.changes.map((c) => [c.property, c.after]))) !== item.target.snapshot) throw new Error(`Layer ${item.target.nodeId} or its context changed. Preview again; no changes applied.`);
      if (item.target.design) for (const [index, edit] of item.target.design.entries())
        if (edit.property !== "textStyleId") validateColorEdit(item.node, edit, item.resources[index]);
        else validateStyleEdit(item.node, edit, item.resources[index]);
      item.before = state(item.node);
    }
    plans2.delete(args.planId);
    figma.commitUndo();
    const touched = [];
    try {
      for (const item of pending) {
        const contextProps = Object.fromEntries(item.target.changes.map((c) => [c.property, c.after]));
        if (item.target.design && snapshot(item.node, contextProps) !== item.target.snapshot) throw new Error("Layer changed during application; remaining layers were not written.");
        touched.push(item);
        if (item.target.design) {
          for (const [index, edit] of item.target.design.entries()) {
            if (!(edit.property in item.props)) continue;
            if (edit.property === "textStyleId") validateStyleEdit(item.node, edit, item.resources[index]);
            else validateColorEdit(item.node, edit, item.resources[index]);
            const before = state(item.node), beforeSnapshot = snapshot(item.node, contextProps);
            const field = edit.property === "textStyleId" ? "textStyleId" : edit.property === "fillVariableId" ? "fills" : "strokes";
            const expected = edit.property === "textStyleId" ? edit.resourceId : [figma.variables.setBoundVariableForPaint(item.node[field][0], "color", item.resources[index])];
            item.designStable = false;
            item.afterSnapshot = void 0;
            if (edit.property === "textStyleId") await item.node.setTextStyleIdAsync(edit.resourceId);
            else item.node[field] = expected;
            const changedKeys = /* @__PURE__ */ new Set(["boundVariables", "resolvedVariableModes", field]);
            const after = state(item.node);
            if (!Object.keys(before).every((key) => changedKeys.has(key) || stable(before[key]) === stable(after[key])) || snapshot(item.node, contextProps, before) !== beforeSnapshot)
              throw new Error("Binding changed other layer properties or context. Inspect the layer before continuing.");
            if (!equivalent(after[field], expected)) throw new Error(`Figma did not retain planned ${edit.property} on ${item.node.id}.`);
            item.afterSnapshot = snapshot(item.node, contextProps);
            item.designStable = true;
          }
        } else write(item.node, item.props);
      }
      for (const item of pending) if (item.target.design) {
        if (snapshot(item.node, item.props) !== item.afterSnapshot) throw new Error("Layer changed while applying another binding. Inspect affected layers.");
        for (const [index, edit] of item.target.design.entries()) if (edit.property in item.props) {
          if (edit.property === "textStyleId") validateStyleEdit(item.node, edit, item.resources[index]);
          else validateColorEdit(item.node, edit, item.resources[index]);
        }
      }
      for (const item of pending) for (const [key, expected] of Object.entries(item.props))
        if (!equivalent(read(item.node, key), expected)) throw new Error(`Figma did not retain planned ${key} on ${item.node.id}.`);
      for (const item of pending) if (item.target.layout) {
        const children = new Map(item.node.children.map((n) => [n.id, n]));
        for (const effect of item.target.layout.children) for (const [key, expected] of Object.entries(effect.after))
          if (!equivalent((_a = children.get(effect.nodeId)) == null ? void 0 : _a[key], expected))
            throw new Error(`Figma layout differs from the preview on ${effect.nodeId}.`);
      }
      for (const item of pending) for (const key of ["x", "y", "width", "height", "rotation"])
        if (!(key in item.props) && !equivalent(item.node[key], item.before[key]))
          throw new Error(`Figma changed unselected ${key} on ${item.node.id}.`);
    } catch (error) {
      let restored = true;
      for (const item of touched.reverse()) {
        try {
          if (item.target.design) {
            const contextProps = Object.fromEntries(item.target.changes.map((c) => [c.property, c.after]));
            if (!item.designStable || !item.afterSnapshot || snapshot(item.node, contextProps) !== item.afterSnapshot) {
              restored = false;
              continue;
            }
            for (const edit of item.target.design) if (edit.property in item.props) {
              if (edit.property === "textStyleId") await item.node.setTextStyleIdAsync(item.before.textStyleId);
              else {
                const field = edit.property === "fillVariableId" ? "fills" : "strokes";
                item.node[field] = item.before[field];
              }
            }
          } else restore(item.node, item.props, item.before);
        } catch (e) {
          restored = false;
        }
      }
      for (const item of touched) {
        try {
          if (snapshot(item.node, Object.fromEntries(item.target.changes.map((c) => [c.property, c.after]))) !== item.target.snapshot) restored = false;
        } catch (e) {
          restored = false;
        }
      }
      figma.commitUndo();
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${restored ? "Original layer states restored." : "Rollback incomplete. Inspect affected layers and use Figma Undo if needed."} Plan consumed; preview again.`);
    }
    figma.commitUndo();
    return { planId: args.planId, appliedChangeIds: args.changeIds, nodeIds: pending.map((item) => item.node.id), layoutEffects: pending.filter((item) => item.target.layout).map((item) => item.target.layout), consumed: true };
  }

  // plugin/design-fixes.ts
  async function previewDesignFixes(args, getNode2) {
    var _a, _b, _c, _d;
    if (!Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length > 50 || new Set(args.nodeIds).size !== args.nodeIds.length)
      throw new Error("Select 1\u201350 unique layers.");
    const root = await getNode2(args.nodeId), resources = await resolveDesignRules(args.rules);
    const resolved = [], skipped = [];
    for (const id2 of args.nodeIds) {
      try {
        resolved.push(await getNode2(id2));
      } catch (e) {
        skipped.push({ nodeId: id2, reason: "Layer is unavailable." });
      }
    }
    const entries = [];
    for (const node of resolved) {
      try {
        let inScope = node === root;
        for (let parent = node.parent; parent; parent = parent.parent) if (parent === root) inScope = true;
        if (!inScope || ((_a = args.rules.ignoreNodeIds) == null ? void 0 : _a.includes(node.id))) throw new Error("Layer is outside scope or explicitly exempt.");
        const props = {}, design = [];
        for (const [field, property] of [["fills", "fillVariableId"], ["strokes", "strokeVariableId"]]) {
          const paints = node[field];
          if (!args.rules.colorVariableIds || !Array.isArray(paints) || paints.length !== 1 || paints[0].type !== "SOLID" || paints[0].visible === false || args.rules.colorVariableIds.includes((_c = (_b = paints[0].boundVariables) == null ? void 0 : _b.color) == null ? void 0 : _c.id) || node[field === "fills" ? "fillStyleId" : "strokeStyleId"]) continue;
          const candidates = resources.variables.filter((v2) => paintMatches(paints[0], variableColor(v2, node)));
          if (candidates.length !== 1) continue;
          const v = candidates[0];
          props[property] = v.id;
          design.push({ property, resourceId: v.id, signature: JSON.stringify(variableColor(v, node)) });
        }
        if (node.type === "TEXT" && args.rules.textStyleIds && !args.rules.textStyleIds.includes(node.textStyleId)) {
          const candidates = resources.styles.filter((s) => styleMatches(node, s));
          if (candidates.length === 1 && !node.hasMissingFont && !Object.keys((_d = node.boundVariables) != null ? _d : {}).length) {
            const style = candidates[0];
            props.textStyleId = style.id;
            design.push({ property: "textStyleId", resourceId: style.id, signature: JSON.stringify(typographyKeys.map((k) => style[k])) });
          }
        }
        if (!design.length) throw new Error("No unique exact match. Select the semantic token/style explicitly; component swaps and mixed paints require manual review.");
        entries.push({ node, props, design });
      } catch (error) {
        skipped.push({ nodeId: node.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const accepted = [];
    for (const entry of entries) {
      try {
        validateDesignTarget(entry.node, entry.design);
        accepted.push(entry);
      } catch (error) {
        skipped.push({ nodeId: entry.node.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const plan = accepted.length ? createChangePreview(accepted) : null;
    return {
      rootId: root.id,
      readOnly: true,
      plan,
      skipped,
      nextStep: "Choose semantic bindings, apply selected changes, rerun the audit with the same rules and inspect an export."
    };
  }

  // plugin/audit-fixes.ts
  async function previewAuditFixes(args, getNode2) {
    var _a, _b, _c;
    if (!Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length > 50 || new Set(args.nodeIds).size !== args.nodeIds.length) throw new Error("Select 1\u201350 unique finding node IDs.");
    const tolerance = (_a = args.tolerance) != null ? _a : 0.5;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) throw new Error("Invalid audit tolerance.");
    const root = await getNode2(args.nodeId);
    const candidates = [];
    const skipped = [];
    const resolved = [];
    for (const id2 of args.nodeIds) {
      try {
        resolved.push(await getNode2(id2));
      } catch (e) {
        skipped.push({ nodeId: id2, reason: "Layer is unavailable; rerun the audit." });
      }
    }
    if (root.removed) throw new Error("Audit root was removed.");
    for (const node of resolved) {
      try {
        if (node.removed || node === root) throw new Error("Select a descendant from the audited subtree.");
        let inScope = false;
        for (let current = node.parent; current; current = current.parent) if (current === root) inScope = true;
        if (!inScope) throw new Error("Layer is outside the audited subtree.");
        for (let current = node; current; current = current.parent) {
          if (current.visible === false || current.opacity === 0 || current.locked || current.isMask)
            throw new Error("Hidden, locked or masked hierarchies require manual review.");
          if ((_c = (_b = current.parent) == null ? void 0 : _b.children) == null ? void 0 : _c.some((child) => child.isMask))
            throw new Error("A mask in the ancestor hierarchy makes the visible result ambiguous.");
        }
        if (node.type === "TEXT") {
          const props2 = textHeightProposal(node, void 0, tolerance);
          validatePreviewProperties(node, props2);
          candidates.push({ node, props: props2 });
          continue;
        }
        if (!["RECTANGLE", "ELLIPSE"].includes(node.type)) throw new Error("Only simple rectangles and ellipses have a bounds fix.");
        const parent = node.parent;
        if ((parent == null ? void 0 : parent.type) !== "FRAME" || parent.layoutMode !== "NONE") throw new Error("Fix requires a regular frame without Auto Layout.");
        if (parent.overflowDirection && parent.overflowDirection !== "NONE") throw new Error("Scrolling frames require manual review.");
        const matrix = node.relativeTransform;
        if (matrix[0][0] !== 1 || matrix[0][1] !== 0 || matrix[1][0] !== 0 || matrix[1][1] !== 1)
          throw new Error("Rotated, flipped or transformed layers require manual review.");
        const { x, y, width, height } = node;
        if (![x, y, width, height, parent.width, parent.height].every(Number.isFinite) || width <= 0 || height <= 0 || width > parent.width || height > parent.height)
          throw new Error("Layer cannot fit without resizing; no automatic fix proposed.");
        const props = {};
        if (x < -tolerance || x + width > parent.width + tolerance) props.x = Math.min(Math.max(x, 0), parent.width - width);
        if (y < -tolerance || y + height > parent.height + tolerance) props.y = Math.min(Math.max(y, 0), parent.height - height);
        if (!Object.keys(props).length) throw new Error("No current OUTSIDE_PARENT finding on this layer.");
        validatePreviewProperties(node, props);
        candidates.push({ node, props });
      } catch (error) {
        skipped.push({ nodeId: node.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const plan = candidates.length ? createChangePreview(candidates) : null;
    return {
      readOnly: true,
      rootId: root.id,
      rules: ["OUTSIDE_PARENT", "TEXT_RENDER_OUTSIDE_BOX"],
      plan,
      skipped,
      recommendations: candidates.map(({ node }) => ({ nodeId: node.id, reason: node.type === "TEXT" ? "Grow the fixed text box to contain its existing ink without changing width or typography. Inspect the export." : "Move the entire shape inside its parent without resizing. Check that the overflow is not intentional decoration." })),
      nextStep: "Review differences and select change IDs for apply_changes. Then rerun audit_design on the same root and visually inspect it."
    };
  }

  // plugin/presentation.ts
  var preferenceKey = "figma-local-presentation-v1";
  var sizes = { compact: { width: 300, height: 64 }, expanded: { width: 380, height: 640 } };
  var initialWindowSize = sizes.compact;
  function createPresentation() {
    let compact = true, revision = 0, initialized = false;
    let saves = Promise.resolve();
    const report = (error) => figma.ui.postMessage({ type: "presentation-error", error });
    function apply(value) {
      const size2 = value ? sizes.compact : sizes.expanded;
      try {
        figma.ui.resize(size2.width, size2.height);
      } catch (e) {
        figma.ui.postMessage({ type: "presentation-state", compact });
        report("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0440\u0430\u0437\u043C\u0435\u0440 \u043E\u043A\u043D\u0430. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437; \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C.");
        return false;
      }
      compact = value;
      figma.ui.postMessage({ type: "presentation-state", compact });
      return true;
    }
    async function initialize() {
      if (initialized) return;
      initialized = true;
      const started = revision;
      try {
        const saved = await figma.clientStorage.getAsync(preferenceKey);
        if (revision !== started) return;
        apply((saved == null ? void 0 : saved.version) === 1 && typeof saved.compact === "boolean" ? saved.compact : compact);
      } catch (e) {
        report("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043E\u043A\u043D\u0430. \u0412\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0432 \u044D\u0442\u043E\u043C \u0437\u0430\u043F\u0443\u0441\u043A\u0435.");
      }
    }
    function setMode(value) {
      if (typeof value !== "boolean") return;
      revision++;
      if (!apply(value)) return;
      const preference = { version: 1, compact };
      saves = saves.then(() => figma.clientStorage.setAsync(preferenceKey, preference)).catch(() => report("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u043E\u043C\u043D\u0438\u0442\u044C \u0440\u0435\u0436\u0438\u043C \u043E\u043A\u043D\u0430. \u0421\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C."));
    }
    function move(edge) {
      if (edge !== "left" && edge !== "right") return;
      try {
        const { bounds, zoom } = figma.viewport;
        if (![bounds.x, bounds.y, bounds.width, bounds.height, zoom].every(Number.isFinite) || zoom <= 0)
          throw new Error("Unavailable viewport");
        const size2 = compact ? sizes.compact : sizes.expanded;
        const inset = 12 / zoom;
        const x = edge === "left" ? bounds.x + inset : Math.max(bounds.x + inset, bounds.x + bounds.width - size2.width / zoom - inset);
        figma.ui.reposition(x, bounds.y + inset);
      } catch (e) {
        report("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0435\u0440\u0435\u043C\u0435\u0441\u0442\u0438\u0442\u044C \u043E\u043A\u043D\u043E. \u041F\u0435\u0440\u0435\u0442\u0430\u0449\u0438\u0442\u0435 \u0435\u0433\u043E \u0437\u0430 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A.");
      }
    }
    return { initialize, setMode, move };
  }

  // src/node-properties.json
  var node_properties_default = [
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

  // src/response-limits.json
  var response_limits_default = {
    defaultReadBytes: 1048576,
    minReadBytes: 4096,
    maxReadBytes: 4194304,
    maxResultBytes: 12582912,
    transportBytes: 16777216
  };

  // plugin/response-size.ts
  var MAX_RESULT_BYTES = response_limits_default.maxResultBytes;
  var DEFAULT_READ_BYTES = response_limits_default.defaultReadBytes;
  function jsonBytes(value) {
    return utf8Bytes(JSON.stringify(value));
  }
  function utf8Bytes(text) {
    let bytes = 0;
    for (const character of text) {
      const point = character.codePointAt(0);
      bytes += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
    }
    return bytes;
  }

  // plugin/node-reader.ts
  var readCommands = /* @__PURE__ */ new Set(["get_document", "get_selection", "get_node", "find_nodes", "export_node"]);
  function clean(value) {
    if (value === figma.mixed) return { mixed: true };
    if (value === void 0) return void 0;
    return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "symbol" ? { mixed: true } : v));
  }
  function summarize(node, depth, budget2, childOffset = 0) {
    var _a, _b, _c, _d;
    budget2.left--;
    (_a = budget2.bytes) != null ? _a : budget2.bytes = DEFAULT_READ_BYTES;
    const result2 = { id: node.id, type: node.type, name: node.name.slice(0, 500), parentId: (_b = node.parent) == null ? void 0 : _b.id };
    if (node.name.length > 500) result2.nameTruncated = true;
    budget2.bytes -= jsonBytes(result2) + 1024;
    const source = node;
    const omitted = [];
    for (const key of (_c = budget2.fields) != null ? _c : node_properties_default) {
      if (key === "componentPropertyDefinitions" && node.type === "COMPONENT" && ((_d = node.parent) == null ? void 0 : _d.type) === "COMPONENT_SET") continue;
      if (!(key in node)) continue;
      let value = source[key];
      if (key === "characters" && typeof value === "string" && value.length > 1e4) {
        result2.characterCount = value.length;
        result2.charactersTruncated = true;
        value = value.slice(0, 1e4);
      }
      value = clean(value);
      const size2 = jsonBytes({ [key]: value });
      if (size2 > budget2.bytes) {
        omitted.push(key);
        continue;
      }
      result2[key] = value;
      budget2.bytes -= size2;
    }
    if (omitted.length) {
      result2.omittedProperties = omitted;
      result2.responseTruncated = true;
    }
    if ("children" in node) {
      const children = node.children;
      result2.childCount = children.length;
      result2.childOffset = Math.min(childOffset, children.length);
      result2.children = [];
      let next = result2.childOffset;
      if (depth > 0) {
        while (next < children.length && budget2.left > 0 && budget2.bytes >= 2048) {
          result2.children.push(summarize(children[next++], depth - 1, budget2));
        }
      }
      result2.childrenTruncated = next < children.length;
      result2.nextChildOffset = next < children.length ? next : null;
    }
    return result2;
  }
  async function executeNodeRead(command, args, { getNode: getNode2, requireScene: requireScene2 }) {
    var _a, _b, _c, _d, _e, _f;
    if ((_a = args.fields) == null ? void 0 : _a.some((field) => !node_properties_default.includes(field))) throw new Error("Unknown node field");
    const budget2 = { left: (_b = args.maxNodes) != null ? _b : 200, bytes: ((_c = args.maxResponseBytes) != null ? _c : DEFAULT_READ_BYTES) - 256, fields: args.fields };
    switch (command) {
      case "get_document":
        return {
          name: figma.root.name,
          currentPageId: figma.currentPage.id,
          pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
          capabilities: getCapabilities()
        };
      case "get_selection": {
        const nodes = [];
        const offset = Math.min((_d = args.selectionOffset) != null ? _d : 0, figma.currentPage.selection.length);
        for (const node of figma.currentPage.selection.slice(offset)) {
          if (budget2.left <= 0 || budget2.bytes < 2048) break;
          nodes.push(summarize(node, args.depth, budget2));
        }
        return {
          nodes,
          selectionCount: figma.currentPage.selection.length,
          selectionOffset: offset,
          nextSelectionOffset: offset + nodes.length < figma.currentPage.selection.length ? offset + nodes.length : null,
          selectionTruncated: offset + nodes.length < figma.currentPage.selection.length
        };
      }
      case "get_node":
        return summarize(await getNode2(args.nodeId), args.depth, budget2, (_e = args.childOffset) != null ? _e : 0);
      case "find_nodes": {
        const page = args.pageId ? await getNode2(args.pageId) : figma.currentPage;
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
      case "export_node": {
        const node = requireScene2(await getNode2(args.nodeId));
        if (!("exportAsync" in node)) throw new Error("Node does not support export");
        if (args.format === "SVG") {
          const svg = await node.exportAsync({ format: "SVG_STRING" });
          if (svg.length > 4 * 1024 * 1024) throw new Error("SVG exceeds 4 MiB; export a smaller node");
          return { svg };
        }
        const bounds = (_f = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null) != null ? _f : node.absoluteBoundingBox;
        if (!bounds) throw new Error("Node has no visible bounds");
        const actualScale = Math.min(args.scale, 4096 / Math.max(bounds.width, bounds.height, 1));
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: actualScale } });
        if (bytes.length > 8 * 1024 * 1024) throw new Error("PNG exceeds 8 MiB; lower scale or export a smaller node");
        return { data: figma.base64Encode(bytes), mimeType: "image/png", scale: actualScale };
      }
      default:
        throw new Error(`Unknown read operation: ${command}`);
    }
  }

  // src/text-properties.json
  var text_properties_default = [
    "fontName",
    "fontSize",
    "fontWeight",
    "textCase",
    "textDecoration",
    "lineHeight",
    "letterSpacing",
    "fills",
    "textStyleId",
    "fillStyleId",
    "listOptions",
    "indentation",
    "paragraphIndent",
    "paragraphSpacing",
    "listSpacing",
    "hyperlink",
    "boundVariables"
  ];

  // plugin/design-reader.ts
  var designReadCommands = /* @__PURE__ */ new Set(["get_text_runs", "get_component_details", "get_bound_variables"]);
  function budget(args) {
    var _a;
    const limit = (_a = args.maxResponseBytes) != null ? _a : response_limits_default.defaultReadBytes;
    if (!Number.isInteger(limit) || limit < response_limits_default.minReadBytes || limit > response_limits_default.maxReadBytes)
      throw new Error("Invalid maxResponseBytes");
    let remaining = limit - 2048;
    return (value) => {
      const size2 = jsonBytes(value) + 32;
      if (size2 > remaining) return false;
      remaining -= size2;
      return true;
    };
  }
  function integer(value, fallback, min, max, name) {
    const result2 = value != null ? value : fallback;
    if (!Number.isInteger(result2) || result2 < min || result2 > max) throw new Error(`Invalid ${name}`);
    return result2;
  }
  function splitsSurrogate(text, index) {
    return index > 0 && index < text.length && text.charCodeAt(index - 1) >= 55296 && text.charCodeAt(index - 1) <= 56319 && text.charCodeAt(index) >= 56320 && text.charCodeAt(index) <= 57343;
  }
  function identity2(node) {
    return {
      id: node.id,
      key: node.key,
      name: node.name.slice(0, 500),
      nameTruncated: node.name.length > 500,
      remote: node.remote
    };
  }
  async function readDesignDetails(command, args, node, dependencies = {}) {
    var _a, _b, _c, _d;
    const admit = budget(args);
    if (command === "get_text_runs") {
      if (node.type !== "TEXT") throw new Error("get_text_runs requires a TEXT node");
      const start = integer(args.start, 0, 0, Number.MAX_SAFE_INTEGER, "start");
      const count = integer(args.maxCharacters, 4e3, 2, 1e4, "maxCharacters");
      const maxRuns = integer(args.maxRuns, 100, 1, 500, "maxRuns");
      const fields = (_a = args.fields) != null ? _a : text_properties_default;
      if (!Array.isArray(fields) || fields.length > text_properties_default.length || fields.some((field) => !text_properties_default.includes(field)))
        throw new Error("Unknown text field");
      const characters = node.characters;
      if (start > characters.length) throw new Error("Text start exceeds current length; restart the read after text edits");
      if (splitsSurrogate(characters, start)) throw new Error("Text start splits a UTF-16 surrogate pair; use nextStart");
      let end = Math.min(start + count, characters.length);
      if (splitsSurrogate(characters, end)) end--;
      const runs = [];
      let next = start;
      let reason;
      const segments = end > start ? node.getStyledTextSegments(fields, start, end) : [];
      for (const segment of segments) {
        if (runs.length >= maxRuns) {
          reason = "run_limit";
          break;
        }
        if (!admit(segment)) {
          reason = "byte_limit";
          break;
        }
        runs.push(segment);
        next = segment.end;
      }
      return __spreadValues({
        nodeId: node.id,
        indexUnit: "UTF-16",
        characterCount: characters.length,
        start,
        fields,
        runs,
        nextStart: next < characters.length ? next : null,
        complete: next === characters.length,
        reason: reason != null ? reason : next < characters.length ? "character_limit" : void 0
      }, reason === "byte_limit" && next === start ? {
        blocked: true,
        recovery: "Reduce maxCharacters or fields, or increase maxResponseBytes; do not repeat the same request."
      } : {});
    }
    if (command === "get_component_details") {
      const result2 = { nodeId: node.id, nodeType: node.type, omittedProperties: [] };
      const add = (key, value) => {
        if (value === void 0) return;
        if (admit({ [key]: value })) result2[key] = value;
        else result2.omittedProperties.push(key);
      };
      let component;
      if (node.type === "INSTANCE") {
        add("componentProperties", node.componentProperties);
        add("variantProperties", node.variantProperties);
        try {
          component = await node.getMainComponentAsync();
        } catch (e) {
          return __spreadProps(__spreadValues({}, result2), { status: "unavailable", complete: false });
        }
        if (!component) return __spreadProps(__spreadValues({}, result2), { status: "main_component_missing", complete: false });
      } else if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") component = node;
      else return __spreadProps(__spreadValues({}, result2), { status: "not_component", complete: true });
      add("component", identity2(component));
      const owner = ((_b = component.parent) == null ? void 0 : _b.type) === "COMPONENT_SET" ? component.parent : component;
      if (owner !== component) add("componentSet", identity2(owner));
      add("definitionOwnerId", owner.id);
      add("componentPropertyDefinitions", owner.componentPropertyDefinitions);
      if (node.type !== "INSTANCE") add("variantProperties", component.type === "COMPONENT" ? component.variantProperties : void 0);
      return __spreadProps(__spreadValues({}, result2), { status: "available", complete: result2.omittedProperties.length === 0 });
    }
    if (command === "get_bound_variables") {
      const offset = integer(args.offset, 0, 0, 1e6, "offset");
      const limit = integer(args.limit, 50, 1, 100, "limit");
      let ids;
      let scanTruncated = false;
      if (args.variableIds !== void 0) {
        if (!Array.isArray(args.variableIds) || args.variableIds.length > 100 || args.variableIds.some((id2) => typeof id2 !== "string" || !id2.length || id2.length > 200))
          throw new Error("Invalid variableIds");
        ids = [...new Set(args.variableIds)];
      } else {
        const found = /* @__PURE__ */ new Set();
        const stack = [node.boundVariables];
        for (const field of ["fills", "strokes", "effects", "layoutGrids"]) {
          if (field in node) stack.push(node[field]);
        }
        let visited = 0;
        while (stack.length && visited++ < 2e4 && found.size < 1e3) {
          const value = stack.pop();
          if (!value || typeof value !== "object") continue;
          if ("type" in value && value.type === "VARIABLE_ALIAS" && "id" in value && typeof value.id === "string") found.add(value.id);
          else {
            const values = Object.values(value);
            if (values.length + stack.length > 2e4) {
              scanTruncated = true;
              break;
            }
            stack.push(...values);
          }
        }
        scanTruncated || (scanTruncated = stack.length > 0);
        ids = [...found].sort();
      }
      const variables = [];
      const resolveVariable = (_c = dependencies.resolveVariable) != null ? _c : variableResolver();
      let next = Math.min(offset, ids.length);
      let byteLimited = false;
      for (; next < ids.length && variables.length < limit; next++) {
        const id2 = ids[next];
        let entry;
        try {
          const variable = await resolveVariable(id2);
          if (!variable) entry = { id: id2, status: "not_found" };
          else {
            const modeId = (_d = node.resolvedVariableModes[variable.variableCollectionId]) != null ? _d : null;
            entry = {
              id: id2,
              name: variable.name,
              key: variable.key,
              remote: variable.remote,
              collectionId: variable.variableCollectionId,
              resolvedType: variable.resolvedType,
              modeId,
              modeValue: modeId ? variable.valuesByMode[modeId] : void 0,
              codeSyntax: variable.codeSyntax
            };
            try {
              entry.resolved = variable.resolveForConsumer(node);
              entry.status = "resolved";
            } catch (e) {
              entry.status = "unresolved";
            }
          }
        } catch (e) {
          entry = { id: id2, status: "unavailable" };
        }
        if (!admit(entry)) {
          byteLimited = true;
          break;
        }
        variables.push(entry);
      }
      return __spreadValues({
        nodeId: node.id,
        scope: args.variableIds ? "requested_ids_for_consumer" : "node_properties_only",
        variables,
        total: ids.length,
        offset: Math.min(offset, ids.length),
        nextOffset: next < ids.length ? next : null,
        scanTruncated,
        complete: !scanTruncated && next === ids.length && variables.every((item) => item.status === "resolved")
      }, byteLimited ? {
        reason: "byte_limit",
        blocked: variables.length === 0,
        recovery: "Increase maxResponseBytes; read a specific variable using variableIds."
      } : {});
    }
    throw new Error("Unknown design read operation");
  }

  // plugin/asset-export.ts
  var MAX_ASSET_BYTES = 8 * 1024 * 1024;
  var sourceSession = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  async function exportAsset(args, getNode2) {
    var _a, _b;
    if (args.sourceSession !== void 0 && args.sourceSession !== sourceSession)
      throw new Error("EXPORT_SOURCE_CHANGED: The plugin session changed; start a fresh export for the intended file");
    const source = args.source;
    if (!source || !["node", "image"].includes(source.kind)) throw new Error("Invalid export source");
    let bytes;
    let scale;
    if (source.kind === "image") {
      if (typeof source.imageHash !== "string" || !source.imageHash.length || source.imageHash.length > 200)
        throw new Error("Invalid imageHash");
      try {
        const image = figma.getImageByHash(source.imageHash);
        if (!image) return { sourceSession, error: "IMAGE_NOT_FOUND" };
        bytes = await image.getBytesAsync();
      } catch (e) {
        return { sourceSession, error: "IMAGE_BYTES_UNAVAILABLE" };
      }
    } else {
      if (typeof source.nodeId !== "string" || !source.nodeId.length || source.nodeId.length > 200 || !["PNG", "JPG", "SVG", "PDF"].includes(source.format)) throw new Error("Invalid node export source");
      const requestedScale = (_a = source.scale) != null ? _a : 1;
      if (!Number.isFinite(requestedScale) || requestedScale <= 0 || requestedScale > 4) throw new Error("Invalid export scale");
      let node;
      try {
        node = await getNode2(source.nodeId);
      } catch (e) {
        return { sourceSession, error: "NODE_NOT_FOUND" };
      }
      if (node.type === "PAGE" || node.type === "DOCUMENT" || !("exportAsync" in node))
        return { sourceSession, error: "SCENE_EXPORT_REQUIRED" };
      try {
        if (source.format === "PNG" || source.format === "JPG") {
          const bounds = (_b = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null) != null ? _b : node.absoluteBoundingBox;
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { sourceSession, error: "NO_VISIBLE_BOUNDS" };
          scale = Math.min(requestedScale, 4096 / Math.max(bounds.width, bounds.height));
          bytes = await node.exportAsync({ format: source.format, contentsOnly: true, constraint: { type: "SCALE", value: scale } });
        } else if (source.format === "SVG") {
          bytes = await node.exportAsync({ format: "SVG", contentsOnly: true, svgOutlineText: true, svgIdAttribute: false });
        } else bytes = await node.exportAsync({ format: "PDF", contentsOnly: true });
      } catch (e) {
        return { sourceSession, error: "NODE_EXPORT_FAILED" };
      }
    }
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) return { sourceSession, error: "ASSET_SIZE_LIMIT" };
    return __spreadValues({ sourceSession, dataBase64: figma.base64Encode(bytes), byteLength: bytes.length }, scale === void 0 ? {} : { scale });
  }

  // node_modules/zod/v3/external.js
  var external_exports = {};
  __export(external_exports, {
    BRAND: () => BRAND,
    DIRTY: () => DIRTY,
    EMPTY_PATH: () => EMPTY_PATH,
    INVALID: () => INVALID,
    NEVER: () => NEVER,
    OK: () => OK,
    ParseStatus: () => ParseStatus,
    Schema: () => ZodType,
    ZodAny: () => ZodAny,
    ZodArray: () => ZodArray,
    ZodBigInt: () => ZodBigInt,
    ZodBoolean: () => ZodBoolean,
    ZodBranded: () => ZodBranded,
    ZodCatch: () => ZodCatch,
    ZodDate: () => ZodDate,
    ZodDefault: () => ZodDefault,
    ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
    ZodEffects: () => ZodEffects,
    ZodEnum: () => ZodEnum,
    ZodError: () => ZodError,
    ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
    ZodFunction: () => ZodFunction,
    ZodIntersection: () => ZodIntersection,
    ZodIssueCode: () => ZodIssueCode,
    ZodLazy: () => ZodLazy,
    ZodLiteral: () => ZodLiteral,
    ZodMap: () => ZodMap,
    ZodNaN: () => ZodNaN,
    ZodNativeEnum: () => ZodNativeEnum,
    ZodNever: () => ZodNever,
    ZodNull: () => ZodNull,
    ZodNullable: () => ZodNullable,
    ZodNumber: () => ZodNumber,
    ZodObject: () => ZodObject,
    ZodOptional: () => ZodOptional,
    ZodParsedType: () => ZodParsedType,
    ZodPipeline: () => ZodPipeline,
    ZodPromise: () => ZodPromise,
    ZodReadonly: () => ZodReadonly,
    ZodRecord: () => ZodRecord,
    ZodSchema: () => ZodType,
    ZodSet: () => ZodSet,
    ZodString: () => ZodString,
    ZodSymbol: () => ZodSymbol,
    ZodTransformer: () => ZodEffects,
    ZodTuple: () => ZodTuple,
    ZodType: () => ZodType,
    ZodUndefined: () => ZodUndefined,
    ZodUnion: () => ZodUnion,
    ZodUnknown: () => ZodUnknown,
    ZodVoid: () => ZodVoid,
    addIssueToContext: () => addIssueToContext,
    any: () => anyType,
    array: () => arrayType,
    bigint: () => bigIntType,
    boolean: () => booleanType,
    coerce: () => coerce,
    custom: () => custom,
    date: () => dateType,
    datetimeRegex: () => datetimeRegex,
    defaultErrorMap: () => en_default,
    discriminatedUnion: () => discriminatedUnionType,
    effect: () => effectsType,
    enum: () => enumType,
    function: () => functionType,
    getErrorMap: () => getErrorMap,
    getParsedType: () => getParsedType,
    instanceof: () => instanceOfType,
    intersection: () => intersectionType,
    isAborted: () => isAborted,
    isAsync: () => isAsync,
    isDirty: () => isDirty,
    isValid: () => isValid,
    late: () => late,
    lazy: () => lazyType,
    literal: () => literalType,
    makeIssue: () => makeIssue,
    map: () => mapType,
    nan: () => nanType,
    nativeEnum: () => nativeEnumType,
    never: () => neverType,
    null: () => nullType,
    nullable: () => nullableType,
    number: () => numberType,
    object: () => objectType,
    objectUtil: () => objectUtil,
    oboolean: () => oboolean,
    onumber: () => onumber,
    optional: () => optionalType,
    ostring: () => ostring,
    pipeline: () => pipelineType,
    preprocess: () => preprocessType,
    promise: () => promiseType,
    quotelessJson: () => quotelessJson,
    record: () => recordType,
    set: () => setType,
    setErrorMap: () => setErrorMap,
    strictObject: () => strictObjectType,
    string: () => stringType,
    symbol: () => symbolType,
    transformer: () => effectsType,
    tuple: () => tupleType,
    undefined: () => undefinedType,
    union: () => unionType,
    unknown: () => unknownType,
    util: () => util,
    void: () => voidType
  });

  // node_modules/zod/v3/helpers/util.js
  var util;
  (function(util2) {
    util2.assertEqual = (_) => {
    };
    function assertIs(_arg) {
    }
    util2.assertIs = assertIs;
    function assertNever(_x) {
      throw new Error();
    }
    util2.assertNever = assertNever;
    util2.arrayToEnum = (items) => {
      const obj = {};
      for (const item of items) {
        obj[item] = item;
      }
      return obj;
    };
    util2.getValidEnumValues = (obj) => {
      const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
      const filtered = {};
      for (const k of validKeys) {
        filtered[k] = obj[k];
      }
      return util2.objectValues(filtered);
    };
    util2.objectValues = (obj) => {
      return util2.objectKeys(obj).map(function(e) {
        return obj[e];
      });
    };
    util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
      const keys = [];
      for (const key in object) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
          keys.push(key);
        }
      }
      return keys;
    };
    util2.find = (arr, checker) => {
      for (const item of arr) {
        if (checker(item))
          return item;
      }
      return void 0;
    };
    util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
    function joinValues(array, separator = " | ") {
      return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
    }
    util2.joinValues = joinValues;
    util2.jsonStringifyReplacer = (_, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    };
  })(util || (util = {}));
  var objectUtil;
  (function(objectUtil2) {
    objectUtil2.mergeShapes = (first, second) => {
      return __spreadValues(__spreadValues({}, first), second);
    };
  })(objectUtil || (objectUtil = {}));
  var ZodParsedType = util.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set"
  ]);
  var getParsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "undefined":
        return ZodParsedType.undefined;
      case "string":
        return ZodParsedType.string;
      case "number":
        return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
      case "boolean":
        return ZodParsedType.boolean;
      case "function":
        return ZodParsedType.function;
      case "bigint":
        return ZodParsedType.bigint;
      case "symbol":
        return ZodParsedType.symbol;
      case "object":
        if (Array.isArray(data)) {
          return ZodParsedType.array;
        }
        if (data === null) {
          return ZodParsedType.null;
        }
        if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
          return ZodParsedType.promise;
        }
        if (typeof Map !== "undefined" && data instanceof Map) {
          return ZodParsedType.map;
        }
        if (typeof Set !== "undefined" && data instanceof Set) {
          return ZodParsedType.set;
        }
        if (typeof Date !== "undefined" && data instanceof Date) {
          return ZodParsedType.date;
        }
        return ZodParsedType.object;
      default:
        return ZodParsedType.unknown;
    }
  };

  // node_modules/zod/v3/ZodError.js
  var ZodIssueCode = util.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite"
  ]);
  var quotelessJson = (obj) => {
    const json = JSON.stringify(obj, null, 2);
    return json.replace(/"([^"]+)":/g, "$1:");
  };
  var ZodError = class _ZodError extends Error {
    get errors() {
      return this.issues;
    }
    constructor(issues) {
      super();
      this.issues = [];
      this.addIssue = (sub) => {
        this.issues = [...this.issues, sub];
      };
      this.addIssues = (subs = []) => {
        this.issues = [...this.issues, ...subs];
      };
      const actualProto = new.target.prototype;
      if (Object.setPrototypeOf) {
        Object.setPrototypeOf(this, actualProto);
      } else {
        this.__proto__ = actualProto;
      }
      this.name = "ZodError";
      this.issues = issues;
    }
    format(_mapper) {
      const mapper = _mapper || function(issue) {
        return issue.message;
      };
      const fieldErrors = { _errors: [] };
      const processError = (error) => {
        for (const issue of error.issues) {
          if (issue.code === "invalid_union") {
            issue.unionErrors.map(processError);
          } else if (issue.code === "invalid_return_type") {
            processError(issue.returnTypeError);
          } else if (issue.code === "invalid_arguments") {
            processError(issue.argumentsError);
          } else if (issue.path.length === 0) {
            fieldErrors._errors.push(mapper(issue));
          } else {
            let curr = fieldErrors;
            let i = 0;
            while (i < issue.path.length) {
              const el = issue.path[i];
              const terminal = i === issue.path.length - 1;
              if (!terminal) {
                curr[el] = curr[el] || { _errors: [] };
              } else {
                curr[el] = curr[el] || { _errors: [] };
                curr[el]._errors.push(mapper(issue));
              }
              curr = curr[el];
              i++;
            }
          }
        }
      };
      processError(this);
      return fieldErrors;
    }
    static assert(value) {
      if (!(value instanceof _ZodError)) {
        throw new Error(`Not a ZodError: ${value}`);
      }
    }
    toString() {
      return this.message;
    }
    get message() {
      return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
      return this.issues.length === 0;
    }
    flatten(mapper = (issue) => issue.message) {
      const fieldErrors = {};
      const formErrors = [];
      for (const sub of this.issues) {
        if (sub.path.length > 0) {
          const firstEl = sub.path[0];
          fieldErrors[firstEl] = fieldErrors[firstEl] || [];
          fieldErrors[firstEl].push(mapper(sub));
        } else {
          formErrors.push(mapper(sub));
        }
      }
      return { formErrors, fieldErrors };
    }
    get formErrors() {
      return this.flatten();
    }
  };
  ZodError.create = (issues) => {
    const error = new ZodError(issues);
    return error;
  };

  // node_modules/zod/v3/locales/en.js
  var errorMap = (issue, _ctx) => {
    let message;
    switch (issue.code) {
      case ZodIssueCode.invalid_type:
        if (issue.received === ZodParsedType.undefined) {
          message = "Required";
        } else {
          message = `Expected ${issue.expected}, received ${issue.received}`;
        }
        break;
      case ZodIssueCode.invalid_literal:
        message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
        break;
      case ZodIssueCode.unrecognized_keys:
        message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
        break;
      case ZodIssueCode.invalid_union:
        message = `Invalid input`;
        break;
      case ZodIssueCode.invalid_union_discriminator:
        message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
        break;
      case ZodIssueCode.invalid_enum_value:
        message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
        break;
      case ZodIssueCode.invalid_arguments:
        message = `Invalid function arguments`;
        break;
      case ZodIssueCode.invalid_return_type:
        message = `Invalid function return type`;
        break;
      case ZodIssueCode.invalid_date:
        message = `Invalid date`;
        break;
      case ZodIssueCode.invalid_string:
        if (typeof issue.validation === "object") {
          if ("includes" in issue.validation) {
            message = `Invalid input: must include "${issue.validation.includes}"`;
            if (typeof issue.validation.position === "number") {
              message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
            }
          } else if ("startsWith" in issue.validation) {
            message = `Invalid input: must start with "${issue.validation.startsWith}"`;
          } else if ("endsWith" in issue.validation) {
            message = `Invalid input: must end with "${issue.validation.endsWith}"`;
          } else {
            util.assertNever(issue.validation);
          }
        } else if (issue.validation !== "regex") {
          message = `Invalid ${issue.validation}`;
        } else {
          message = "Invalid";
        }
        break;
      case ZodIssueCode.too_small:
        if (issue.type === "array")
          message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
        else if (issue.type === "string")
          message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
        else if (issue.type === "number")
          message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
        else if (issue.type === "bigint")
          message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
        else if (issue.type === "date")
          message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
        else
          message = "Invalid input";
        break;
      case ZodIssueCode.too_big:
        if (issue.type === "array")
          message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
        else if (issue.type === "string")
          message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
        else if (issue.type === "number")
          message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
        else if (issue.type === "bigint")
          message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
        else if (issue.type === "date")
          message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
        else
          message = "Invalid input";
        break;
      case ZodIssueCode.custom:
        message = `Invalid input`;
        break;
      case ZodIssueCode.invalid_intersection_types:
        message = `Intersection results could not be merged`;
        break;
      case ZodIssueCode.not_multiple_of:
        message = `Number must be a multiple of ${issue.multipleOf}`;
        break;
      case ZodIssueCode.not_finite:
        message = "Number must be finite";
        break;
      default:
        message = _ctx.defaultError;
        util.assertNever(issue);
    }
    return { message };
  };
  var en_default = errorMap;

  // node_modules/zod/v3/errors.js
  var overrideErrorMap = en_default;
  function setErrorMap(map) {
    overrideErrorMap = map;
  }
  function getErrorMap() {
    return overrideErrorMap;
  }

  // node_modules/zod/v3/helpers/parseUtil.js
  var makeIssue = (params) => {
    const { data, path, errorMaps, issueData } = params;
    const fullPath = [...path, ...issueData.path || []];
    const fullIssue = __spreadProps(__spreadValues({}, issueData), {
      path: fullPath
    });
    if (issueData.message !== void 0) {
      return __spreadProps(__spreadValues({}, issueData), {
        path: fullPath,
        message: issueData.message
      });
    }
    let errorMessage = "";
    const maps = errorMaps.filter((m) => !!m).slice().reverse();
    for (const map of maps) {
      errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
    }
    return __spreadProps(__spreadValues({}, issueData), {
      path: fullPath,
      message: errorMessage
    });
  };
  var EMPTY_PATH = [];
  function addIssueToContext(ctx, issueData) {
    const overrideMap = getErrorMap();
    const issue = makeIssue({
      issueData,
      data: ctx.data,
      path: ctx.path,
      errorMaps: [
        ctx.common.contextualErrorMap,
        // contextual error map is first priority
        ctx.schemaErrorMap,
        // then schema-bound map if available
        overrideMap,
        // then global override map
        overrideMap === en_default ? void 0 : en_default
        // then global default map
      ].filter((x) => !!x)
    });
    ctx.common.issues.push(issue);
  }
  var ParseStatus = class _ParseStatus {
    constructor() {
      this.value = "valid";
    }
    dirty() {
      if (this.value === "valid")
        this.value = "dirty";
    }
    abort() {
      if (this.value !== "aborted")
        this.value = "aborted";
    }
    static mergeArray(status, results) {
      const arrayValue = [];
      for (const s of results) {
        if (s.status === "aborted")
          return INVALID;
        if (s.status === "dirty")
          status.dirty();
        arrayValue.push(s.value);
      }
      return { status: status.value, value: arrayValue };
    }
    static async mergeObjectAsync(status, pairs) {
      const syncPairs = [];
      for (const pair of pairs) {
        const key = await pair.key;
        const value = await pair.value;
        syncPairs.push({
          key,
          value
        });
      }
      return _ParseStatus.mergeObjectSync(status, syncPairs);
    }
    static mergeObjectSync(status, pairs) {
      const finalObject = {};
      for (const pair of pairs) {
        const { key, value } = pair;
        if (key.status === "aborted")
          return INVALID;
        if (value.status === "aborted")
          return INVALID;
        if (key.status === "dirty")
          status.dirty();
        if (value.status === "dirty")
          status.dirty();
        if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
          finalObject[key.value] = value.value;
        }
      }
      return { status: status.value, value: finalObject };
    }
  };
  var INVALID = Object.freeze({
    status: "aborted"
  });
  var DIRTY = (value) => ({ status: "dirty", value });
  var OK = (value) => ({ status: "valid", value });
  var isAborted = (x) => x.status === "aborted";
  var isDirty = (x) => x.status === "dirty";
  var isValid = (x) => x.status === "valid";
  var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

  // node_modules/zod/v3/helpers/errorUtil.js
  var errorUtil;
  (function(errorUtil2) {
    errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
    errorUtil2.toString = (message) => typeof message === "string" ? message : message == null ? void 0 : message.message;
  })(errorUtil || (errorUtil = {}));

  // node_modules/zod/v3/types.js
  var ParseInputLazyPath = class {
    constructor(parent, value, path, key) {
      this._cachedPath = [];
      this.parent = parent;
      this.data = value;
      this._path = path;
      this._key = key;
    }
    get path() {
      if (!this._cachedPath.length) {
        if (Array.isArray(this._key)) {
          this._cachedPath.push(...this._path, ...this._key);
        } else {
          this._cachedPath.push(...this._path, this._key);
        }
      }
      return this._cachedPath;
    }
  };
  var handleResult = (ctx, result2) => {
    if (isValid(result2)) {
      return { success: true, data: result2.value };
    } else {
      if (!ctx.common.issues.length) {
        throw new Error("Validation failed but no issues detected.");
      }
      return {
        success: false,
        get error() {
          if (this._error)
            return this._error;
          const error = new ZodError(ctx.common.issues);
          this._error = error;
          return this._error;
        }
      };
    }
  };
  function processCreateParams(params) {
    if (!params)
      return {};
    const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
    if (errorMap2 && (invalid_type_error || required_error)) {
      throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap2)
      return { errorMap: errorMap2, description };
    const customMap = (iss, ctx) => {
      var _a, _b;
      const { message } = params;
      if (iss.code === "invalid_enum_value") {
        return { message: message != null ? message : ctx.defaultError };
      }
      if (typeof ctx.data === "undefined") {
        return { message: (_a = message != null ? message : required_error) != null ? _a : ctx.defaultError };
      }
      if (iss.code !== "invalid_type")
        return { message: ctx.defaultError };
      return { message: (_b = message != null ? message : invalid_type_error) != null ? _b : ctx.defaultError };
    };
    return { errorMap: customMap, description };
  }
  var ZodType = class {
    get description() {
      return this._def.description;
    }
    _getType(input) {
      return getParsedType(input.data);
    }
    _getOrReturnCtx(input, ctx) {
      return ctx || {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      };
    }
    _processInputParams(input) {
      return {
        status: new ParseStatus(),
        ctx: {
          common: input.parent.common,
          data: input.data,
          parsedType: getParsedType(input.data),
          schemaErrorMap: this._def.errorMap,
          path: input.path,
          parent: input.parent
        }
      };
    }
    _parseSync(input) {
      const result2 = this._parse(input);
      if (isAsync(result2)) {
        throw new Error("Synchronous parse encountered promise.");
      }
      return result2;
    }
    _parseAsync(input) {
      const result2 = this._parse(input);
      return Promise.resolve(result2);
    }
    parse(data, params) {
      const result2 = this.safeParse(data, params);
      if (result2.success)
        return result2.data;
      throw result2.error;
    }
    safeParse(data, params) {
      var _a;
      const ctx = {
        common: {
          issues: [],
          async: (_a = params == null ? void 0 : params.async) != null ? _a : false,
          contextualErrorMap: params == null ? void 0 : params.errorMap
        },
        path: (params == null ? void 0 : params.path) || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data,
        parsedType: getParsedType(data)
      };
      const result2 = this._parseSync({ data, path: ctx.path, parent: ctx });
      return handleResult(ctx, result2);
    }
    "~validate"(data) {
      var _a, _b;
      const ctx = {
        common: {
          issues: [],
          async: !!this["~standard"].async
        },
        path: [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data,
        parsedType: getParsedType(data)
      };
      if (!this["~standard"].async) {
        try {
          const result2 = this._parseSync({ data, path: [], parent: ctx });
          return isValid(result2) ? {
            value: result2.value
          } : {
            issues: ctx.common.issues
          };
        } catch (err) {
          if ((_b = (_a = err == null ? void 0 : err.message) == null ? void 0 : _a.toLowerCase()) == null ? void 0 : _b.includes("encountered")) {
            this["~standard"].async = true;
          }
          ctx.common = {
            issues: [],
            async: true
          };
        }
      }
      return this._parseAsync({ data, path: [], parent: ctx }).then((result2) => isValid(result2) ? {
        value: result2.value
      } : {
        issues: ctx.common.issues
      });
    }
    async parseAsync(data, params) {
      const result2 = await this.safeParseAsync(data, params);
      if (result2.success)
        return result2.data;
      throw result2.error;
    }
    async safeParseAsync(data, params) {
      const ctx = {
        common: {
          issues: [],
          contextualErrorMap: params == null ? void 0 : params.errorMap,
          async: true
        },
        path: (params == null ? void 0 : params.path) || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data,
        parsedType: getParsedType(data)
      };
      const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
      const result2 = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
      return handleResult(ctx, result2);
    }
    refine(check, message) {
      const getIssueProperties = (val) => {
        if (typeof message === "string" || typeof message === "undefined") {
          return { message };
        } else if (typeof message === "function") {
          return message(val);
        } else {
          return message;
        }
      };
      return this._refinement((val, ctx) => {
        const result2 = check(val);
        const setError = () => ctx.addIssue(__spreadValues({
          code: ZodIssueCode.custom
        }, getIssueProperties(val)));
        if (typeof Promise !== "undefined" && result2 instanceof Promise) {
          return result2.then((data) => {
            if (!data) {
              setError();
              return false;
            } else {
              return true;
            }
          });
        }
        if (!result2) {
          setError();
          return false;
        } else {
          return true;
        }
      });
    }
    refinement(check, refinementData) {
      return this._refinement((val, ctx) => {
        if (!check(val)) {
          ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
          return false;
        } else {
          return true;
        }
      });
    }
    _refinement(refinement) {
      return new ZodEffects({
        schema: this,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect: { type: "refinement", refinement }
      });
    }
    superRefine(refinement) {
      return this._refinement(refinement);
    }
    constructor(def) {
      this.spa = this.safeParseAsync;
      this._def = def;
      this.parse = this.parse.bind(this);
      this.safeParse = this.safeParse.bind(this);
      this.parseAsync = this.parseAsync.bind(this);
      this.safeParseAsync = this.safeParseAsync.bind(this);
      this.spa = this.spa.bind(this);
      this.refine = this.refine.bind(this);
      this.refinement = this.refinement.bind(this);
      this.superRefine = this.superRefine.bind(this);
      this.optional = this.optional.bind(this);
      this.nullable = this.nullable.bind(this);
      this.nullish = this.nullish.bind(this);
      this.array = this.array.bind(this);
      this.promise = this.promise.bind(this);
      this.or = this.or.bind(this);
      this.and = this.and.bind(this);
      this.transform = this.transform.bind(this);
      this.brand = this.brand.bind(this);
      this.default = this.default.bind(this);
      this.catch = this.catch.bind(this);
      this.describe = this.describe.bind(this);
      this.pipe = this.pipe.bind(this);
      this.readonly = this.readonly.bind(this);
      this.isNullable = this.isNullable.bind(this);
      this.isOptional = this.isOptional.bind(this);
      this["~standard"] = {
        version: 1,
        vendor: "zod",
        validate: (data) => this["~validate"](data)
      };
    }
    optional() {
      return ZodOptional.create(this, this._def);
    }
    nullable() {
      return ZodNullable.create(this, this._def);
    }
    nullish() {
      return this.nullable().optional();
    }
    array() {
      return ZodArray.create(this);
    }
    promise() {
      return ZodPromise.create(this, this._def);
    }
    or(option) {
      return ZodUnion.create([this, option], this._def);
    }
    and(incoming) {
      return ZodIntersection.create(this, incoming, this._def);
    }
    transform(transform) {
      return new ZodEffects(__spreadProps(__spreadValues({}, processCreateParams(this._def)), {
        schema: this,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect: { type: "transform", transform }
      }));
    }
    default(def) {
      const defaultValueFunc = typeof def === "function" ? def : () => def;
      return new ZodDefault(__spreadProps(__spreadValues({}, processCreateParams(this._def)), {
        innerType: this,
        defaultValue: defaultValueFunc,
        typeName: ZodFirstPartyTypeKind.ZodDefault
      }));
    }
    brand() {
      return new ZodBranded(__spreadValues({
        typeName: ZodFirstPartyTypeKind.ZodBranded,
        type: this
      }, processCreateParams(this._def)));
    }
    catch(def) {
      const catchValueFunc = typeof def === "function" ? def : () => def;
      return new ZodCatch(__spreadProps(__spreadValues({}, processCreateParams(this._def)), {
        innerType: this,
        catchValue: catchValueFunc,
        typeName: ZodFirstPartyTypeKind.ZodCatch
      }));
    }
    describe(description) {
      const This = this.constructor;
      return new This(__spreadProps(__spreadValues({}, this._def), {
        description
      }));
    }
    pipe(target) {
      return ZodPipeline.create(this, target);
    }
    readonly() {
      return ZodReadonly.create(this);
    }
    isOptional() {
      return this.safeParse(void 0).success;
    }
    isNullable() {
      return this.safeParse(null).success;
    }
  };
  var cuidRegex = /^c[^\s-]{8,}$/i;
  var cuid2Regex = /^[0-9a-z]+$/;
  var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
  var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
  var nanoidRegex = /^[a-z0-9_-]{21}$/i;
  var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
  var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
  var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
  var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
  var emojiRegex;
  var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
  var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
  var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
  var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
  var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
  var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
  var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
  var dateRegex = new RegExp(`^${dateRegexSource}$`);
  function timeRegexSource(args) {
    let secondsRegexSource = `[0-5]\\d`;
    if (args.precision) {
      secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
    } else if (args.precision == null) {
      secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
    }
    const secondsQuantifier = args.precision ? "+" : "?";
    return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
  }
  function timeRegex(args) {
    return new RegExp(`^${timeRegexSource(args)}$`);
  }
  function datetimeRegex(args) {
    let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
    const opts = [];
    opts.push(args.local ? `Z?` : `Z`);
    if (args.offset)
      opts.push(`([+-]\\d{2}:?\\d{2})`);
    regex = `${regex}(${opts.join("|")})`;
    return new RegExp(`^${regex}$`);
  }
  function isValidIP(ip, version) {
    if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
      return true;
    }
    if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
      return true;
    }
    return false;
  }
  function isValidJWT(jwt, alg) {
    if (!jwtRegex.test(jwt))
      return false;
    try {
      const [header] = jwt.split(".");
      if (!header)
        return false;
      const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
      const decoded = JSON.parse(atob(base64));
      if (typeof decoded !== "object" || decoded === null)
        return false;
      if ("typ" in decoded && (decoded == null ? void 0 : decoded.typ) !== "JWT")
        return false;
      if (!decoded.alg)
        return false;
      if (alg && decoded.alg !== alg)
        return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  function isValidCidr(ip, version) {
    if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
      return true;
    }
    if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
      return true;
    }
    return false;
  }
  var ZodString = class _ZodString extends ZodType {
    _parse(input) {
      if (this._def.coerce) {
        input.data = String(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.string) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.string,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      const status = new ParseStatus();
      let ctx = void 0;
      for (const check of this._def.checks) {
        if (check.kind === "min") {
          if (input.data.length < check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          if (input.data.length > check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "length") {
          const tooBig = input.data.length > check.value;
          const tooSmall = input.data.length < check.value;
          if (tooBig || tooSmall) {
            ctx = this._getOrReturnCtx(input, ctx);
            if (tooBig) {
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: check.value,
                type: "string",
                inclusive: true,
                exact: true,
                message: check.message
              });
            } else if (tooSmall) {
              addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: check.value,
                type: "string",
                inclusive: true,
                exact: true,
                message: check.message
              });
            }
            status.dirty();
          }
        } else if (check.kind === "email") {
          if (!emailRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "email",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "emoji") {
          if (!emojiRegex) {
            emojiRegex = new RegExp(_emojiRegex, "u");
          }
          if (!emojiRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "emoji",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "uuid") {
          if (!uuidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "uuid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "nanoid") {
          if (!nanoidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "nanoid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "cuid") {
          if (!cuidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "cuid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "cuid2") {
          if (!cuid2Regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "cuid2",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "ulid") {
          if (!ulidRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "ulid",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "url") {
          try {
            new URL(input.data);
          } catch (e) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "url",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "regex") {
          check.regex.lastIndex = 0;
          const testResult = check.regex.test(input.data);
          if (!testResult) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "regex",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "trim") {
          input.data = input.data.trim();
        } else if (check.kind === "includes") {
          if (!input.data.includes(check.value, check.position)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: { includes: check.value, position: check.position },
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "toLowerCase") {
          input.data = input.data.toLowerCase();
        } else if (check.kind === "toUpperCase") {
          input.data = input.data.toUpperCase();
        } else if (check.kind === "startsWith") {
          if (!input.data.startsWith(check.value)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: { startsWith: check.value },
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "endsWith") {
          if (!input.data.endsWith(check.value)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: { endsWith: check.value },
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "datetime") {
          const regex = datetimeRegex(check);
          if (!regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: "datetime",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "date") {
          const regex = dateRegex;
          if (!regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: "date",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "time") {
          const regex = timeRegex(check);
          if (!regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_string,
              validation: "time",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "duration") {
          if (!durationRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "duration",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "ip") {
          if (!isValidIP(input.data, check.version)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "ip",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "jwt") {
          if (!isValidJWT(input.data, check.alg)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "jwt",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "cidr") {
          if (!isValidCidr(input.data, check.version)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "cidr",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "base64") {
          if (!base64Regex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "base64",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "base64url") {
          if (!base64urlRegex.test(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              validation: "base64url",
              code: ZodIssueCode.invalid_string,
              message: check.message
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return { status: status.value, value: input.data };
    }
    _regex(regex, validation, message) {
      return this.refinement((data) => regex.test(data), __spreadValues({
        validation,
        code: ZodIssueCode.invalid_string
      }, errorUtil.errToObj(message)));
    }
    _addCheck(check) {
      return new _ZodString(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, check]
      }));
    }
    email(message) {
      return this._addCheck(__spreadValues({ kind: "email" }, errorUtil.errToObj(message)));
    }
    url(message) {
      return this._addCheck(__spreadValues({ kind: "url" }, errorUtil.errToObj(message)));
    }
    emoji(message) {
      return this._addCheck(__spreadValues({ kind: "emoji" }, errorUtil.errToObj(message)));
    }
    uuid(message) {
      return this._addCheck(__spreadValues({ kind: "uuid" }, errorUtil.errToObj(message)));
    }
    nanoid(message) {
      return this._addCheck(__spreadValues({ kind: "nanoid" }, errorUtil.errToObj(message)));
    }
    cuid(message) {
      return this._addCheck(__spreadValues({ kind: "cuid" }, errorUtil.errToObj(message)));
    }
    cuid2(message) {
      return this._addCheck(__spreadValues({ kind: "cuid2" }, errorUtil.errToObj(message)));
    }
    ulid(message) {
      return this._addCheck(__spreadValues({ kind: "ulid" }, errorUtil.errToObj(message)));
    }
    base64(message) {
      return this._addCheck(__spreadValues({ kind: "base64" }, errorUtil.errToObj(message)));
    }
    base64url(message) {
      return this._addCheck(__spreadValues({
        kind: "base64url"
      }, errorUtil.errToObj(message)));
    }
    jwt(options) {
      return this._addCheck(__spreadValues({ kind: "jwt" }, errorUtil.errToObj(options)));
    }
    ip(options) {
      return this._addCheck(__spreadValues({ kind: "ip" }, errorUtil.errToObj(options)));
    }
    cidr(options) {
      return this._addCheck(__spreadValues({ kind: "cidr" }, errorUtil.errToObj(options)));
    }
    datetime(options) {
      var _a, _b;
      if (typeof options === "string") {
        return this._addCheck({
          kind: "datetime",
          precision: null,
          offset: false,
          local: false,
          message: options
        });
      }
      return this._addCheck(__spreadValues({
        kind: "datetime",
        precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
        offset: (_a = options == null ? void 0 : options.offset) != null ? _a : false,
        local: (_b = options == null ? void 0 : options.local) != null ? _b : false
      }, errorUtil.errToObj(options == null ? void 0 : options.message)));
    }
    date(message) {
      return this._addCheck({ kind: "date", message });
    }
    time(options) {
      if (typeof options === "string") {
        return this._addCheck({
          kind: "time",
          precision: null,
          message: options
        });
      }
      return this._addCheck(__spreadValues({
        kind: "time",
        precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision
      }, errorUtil.errToObj(options == null ? void 0 : options.message)));
    }
    duration(message) {
      return this._addCheck(__spreadValues({ kind: "duration" }, errorUtil.errToObj(message)));
    }
    regex(regex, message) {
      return this._addCheck(__spreadValues({
        kind: "regex",
        regex
      }, errorUtil.errToObj(message)));
    }
    includes(value, options) {
      return this._addCheck(__spreadValues({
        kind: "includes",
        value,
        position: options == null ? void 0 : options.position
      }, errorUtil.errToObj(options == null ? void 0 : options.message)));
    }
    startsWith(value, message) {
      return this._addCheck(__spreadValues({
        kind: "startsWith",
        value
      }, errorUtil.errToObj(message)));
    }
    endsWith(value, message) {
      return this._addCheck(__spreadValues({
        kind: "endsWith",
        value
      }, errorUtil.errToObj(message)));
    }
    min(minLength, message) {
      return this._addCheck(__spreadValues({
        kind: "min",
        value: minLength
      }, errorUtil.errToObj(message)));
    }
    max(maxLength, message) {
      return this._addCheck(__spreadValues({
        kind: "max",
        value: maxLength
      }, errorUtil.errToObj(message)));
    }
    length(len, message) {
      return this._addCheck(__spreadValues({
        kind: "length",
        value: len
      }, errorUtil.errToObj(message)));
    }
    /**
     * Equivalent to `.min(1)`
     */
    nonempty(message) {
      return this.min(1, errorUtil.errToObj(message));
    }
    trim() {
      return new _ZodString(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, { kind: "trim" }]
      }));
    }
    toLowerCase() {
      return new _ZodString(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, { kind: "toLowerCase" }]
      }));
    }
    toUpperCase() {
      return new _ZodString(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, { kind: "toUpperCase" }]
      }));
    }
    get isDatetime() {
      return !!this._def.checks.find((ch) => ch.kind === "datetime");
    }
    get isDate() {
      return !!this._def.checks.find((ch) => ch.kind === "date");
    }
    get isTime() {
      return !!this._def.checks.find((ch) => ch.kind === "time");
    }
    get isDuration() {
      return !!this._def.checks.find((ch) => ch.kind === "duration");
    }
    get isEmail() {
      return !!this._def.checks.find((ch) => ch.kind === "email");
    }
    get isURL() {
      return !!this._def.checks.find((ch) => ch.kind === "url");
    }
    get isEmoji() {
      return !!this._def.checks.find((ch) => ch.kind === "emoji");
    }
    get isUUID() {
      return !!this._def.checks.find((ch) => ch.kind === "uuid");
    }
    get isNANOID() {
      return !!this._def.checks.find((ch) => ch.kind === "nanoid");
    }
    get isCUID() {
      return !!this._def.checks.find((ch) => ch.kind === "cuid");
    }
    get isCUID2() {
      return !!this._def.checks.find((ch) => ch.kind === "cuid2");
    }
    get isULID() {
      return !!this._def.checks.find((ch) => ch.kind === "ulid");
    }
    get isIP() {
      return !!this._def.checks.find((ch) => ch.kind === "ip");
    }
    get isCIDR() {
      return !!this._def.checks.find((ch) => ch.kind === "cidr");
    }
    get isBase64() {
      return !!this._def.checks.find((ch) => ch.kind === "base64");
    }
    get isBase64url() {
      return !!this._def.checks.find((ch) => ch.kind === "base64url");
    }
    get minLength() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min;
    }
    get maxLength() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max;
    }
  };
  ZodString.create = (params) => {
    var _a;
    return new ZodString(__spreadValues({
      checks: [],
      typeName: ZodFirstPartyTypeKind.ZodString,
      coerce: (_a = params == null ? void 0 : params.coerce) != null ? _a : false
    }, processCreateParams(params)));
  };
  function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split(".")[1] || "").length;
    const stepDecCount = (step.toString().split(".")[1] || "").length;
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
    const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
    return valInt % stepInt / 10 ** decCount;
  }
  var ZodNumber = class _ZodNumber extends ZodType {
    constructor() {
      super(...arguments);
      this.min = this.gte;
      this.max = this.lte;
      this.step = this.multipleOf;
    }
    _parse(input) {
      if (this._def.coerce) {
        input.data = Number(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.number) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.number,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      let ctx = void 0;
      const status = new ParseStatus();
      for (const check of this._def.checks) {
        if (check.kind === "int") {
          if (!util.isInteger(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.invalid_type,
              expected: "integer",
              received: "float",
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "min") {
          const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
          if (tooSmall) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "number",
              inclusive: check.inclusive,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
          if (tooBig) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "number",
              inclusive: check.inclusive,
              exact: false,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "multipleOf") {
          if (floatSafeRemainder(input.data, check.value) !== 0) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.not_multiple_of,
              multipleOf: check.value,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "finite") {
          if (!Number.isFinite(input.data)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.not_finite,
              message: check.message
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return { status: status.value, value: input.data };
    }
    gte(value, message) {
      return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
      return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
      return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
      return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
      return new _ZodNumber(__spreadProps(__spreadValues({}, this._def), {
        checks: [
          ...this._def.checks,
          {
            kind,
            value,
            inclusive,
            message: errorUtil.toString(message)
          }
        ]
      }));
    }
    _addCheck(check) {
      return new _ZodNumber(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, check]
      }));
    }
    int(message) {
      return this._addCheck({
        kind: "int",
        message: errorUtil.toString(message)
      });
    }
    positive(message) {
      return this._addCheck({
        kind: "min",
        value: 0,
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    negative(message) {
      return this._addCheck({
        kind: "max",
        value: 0,
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    nonpositive(message) {
      return this._addCheck({
        kind: "max",
        value: 0,
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    nonnegative(message) {
      return this._addCheck({
        kind: "min",
        value: 0,
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    multipleOf(value, message) {
      return this._addCheck({
        kind: "multipleOf",
        value,
        message: errorUtil.toString(message)
      });
    }
    finite(message) {
      return this._addCheck({
        kind: "finite",
        message: errorUtil.toString(message)
      });
    }
    safe(message) {
      return this._addCheck({
        kind: "min",
        inclusive: true,
        value: Number.MIN_SAFE_INTEGER,
        message: errorUtil.toString(message)
      })._addCheck({
        kind: "max",
        inclusive: true,
        value: Number.MAX_SAFE_INTEGER,
        message: errorUtil.toString(message)
      });
    }
    get minValue() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min;
    }
    get maxValue() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max;
    }
    get isInt() {
      return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
    }
    get isFinite() {
      let max = null;
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
          return true;
        } else if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        } else if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return Number.isFinite(min) && Number.isFinite(max);
    }
  };
  ZodNumber.create = (params) => {
    return new ZodNumber(__spreadValues({
      checks: [],
      typeName: ZodFirstPartyTypeKind.ZodNumber,
      coerce: (params == null ? void 0 : params.coerce) || false
    }, processCreateParams(params)));
  };
  var ZodBigInt = class _ZodBigInt extends ZodType {
    constructor() {
      super(...arguments);
      this.min = this.gte;
      this.max = this.lte;
    }
    _parse(input) {
      if (this._def.coerce) {
        try {
          input.data = BigInt(input.data);
        } catch (e) {
          return this._getInvalidInput(input);
        }
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.bigint) {
        return this._getInvalidInput(input);
      }
      let ctx = void 0;
      const status = new ParseStatus();
      for (const check of this._def.checks) {
        if (check.kind === "min") {
          const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
          if (tooSmall) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              type: "bigint",
              minimum: check.value,
              inclusive: check.inclusive,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
          if (tooBig) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              type: "bigint",
              maximum: check.value,
              inclusive: check.inclusive,
              message: check.message
            });
            status.dirty();
          }
        } else if (check.kind === "multipleOf") {
          if (input.data % check.value !== BigInt(0)) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.not_multiple_of,
              multipleOf: check.value,
              message: check.message
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return { status: status.value, value: input.data };
    }
    _getInvalidInput(input) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.bigint,
        received: ctx.parsedType
      });
      return INVALID;
    }
    gte(value, message) {
      return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
      return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
      return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
      return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
      return new _ZodBigInt(__spreadProps(__spreadValues({}, this._def), {
        checks: [
          ...this._def.checks,
          {
            kind,
            value,
            inclusive,
            message: errorUtil.toString(message)
          }
        ]
      }));
    }
    _addCheck(check) {
      return new _ZodBigInt(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, check]
      }));
    }
    positive(message) {
      return this._addCheck({
        kind: "min",
        value: BigInt(0),
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    negative(message) {
      return this._addCheck({
        kind: "max",
        value: BigInt(0),
        inclusive: false,
        message: errorUtil.toString(message)
      });
    }
    nonpositive(message) {
      return this._addCheck({
        kind: "max",
        value: BigInt(0),
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    nonnegative(message) {
      return this._addCheck({
        kind: "min",
        value: BigInt(0),
        inclusive: true,
        message: errorUtil.toString(message)
      });
    }
    multipleOf(value, message) {
      return this._addCheck({
        kind: "multipleOf",
        value,
        message: errorUtil.toString(message)
      });
    }
    get minValue() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min;
    }
    get maxValue() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max;
    }
  };
  ZodBigInt.create = (params) => {
    var _a;
    return new ZodBigInt(__spreadValues({
      checks: [],
      typeName: ZodFirstPartyTypeKind.ZodBigInt,
      coerce: (_a = params == null ? void 0 : params.coerce) != null ? _a : false
    }, processCreateParams(params)));
  };
  var ZodBoolean = class extends ZodType {
    _parse(input) {
      if (this._def.coerce) {
        input.data = Boolean(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.boolean) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.boolean,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  };
  ZodBoolean.create = (params) => {
    return new ZodBoolean(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodBoolean,
      coerce: (params == null ? void 0 : params.coerce) || false
    }, processCreateParams(params)));
  };
  var ZodDate = class _ZodDate extends ZodType {
    _parse(input) {
      if (this._def.coerce) {
        input.data = new Date(input.data);
      }
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.date) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.date,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      if (Number.isNaN(input.data.getTime())) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_date
        });
        return INVALID;
      }
      const status = new ParseStatus();
      let ctx = void 0;
      for (const check of this._def.checks) {
        if (check.kind === "min") {
          if (input.data.getTime() < check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              message: check.message,
              inclusive: true,
              exact: false,
              minimum: check.value,
              type: "date"
            });
            status.dirty();
          }
        } else if (check.kind === "max") {
          if (input.data.getTime() > check.value) {
            ctx = this._getOrReturnCtx(input, ctx);
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              message: check.message,
              inclusive: true,
              exact: false,
              maximum: check.value,
              type: "date"
            });
            status.dirty();
          }
        } else {
          util.assertNever(check);
        }
      }
      return {
        status: status.value,
        value: new Date(input.data.getTime())
      };
    }
    _addCheck(check) {
      return new _ZodDate(__spreadProps(__spreadValues({}, this._def), {
        checks: [...this._def.checks, check]
      }));
    }
    min(minDate, message) {
      return this._addCheck({
        kind: "min",
        value: minDate.getTime(),
        message: errorUtil.toString(message)
      });
    }
    max(maxDate, message) {
      return this._addCheck({
        kind: "max",
        value: maxDate.getTime(),
        message: errorUtil.toString(message)
      });
    }
    get minDate() {
      let min = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "min") {
          if (min === null || ch.value > min)
            min = ch.value;
        }
      }
      return min != null ? new Date(min) : null;
    }
    get maxDate() {
      let max = null;
      for (const ch of this._def.checks) {
        if (ch.kind === "max") {
          if (max === null || ch.value < max)
            max = ch.value;
        }
      }
      return max != null ? new Date(max) : null;
    }
  };
  ZodDate.create = (params) => {
    return new ZodDate(__spreadValues({
      checks: [],
      coerce: (params == null ? void 0 : params.coerce) || false,
      typeName: ZodFirstPartyTypeKind.ZodDate
    }, processCreateParams(params)));
  };
  var ZodSymbol = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.symbol) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.symbol,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  };
  ZodSymbol.create = (params) => {
    return new ZodSymbol(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodSymbol
    }, processCreateParams(params)));
  };
  var ZodUndefined = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.undefined) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.undefined,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  };
  ZodUndefined.create = (params) => {
    return new ZodUndefined(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodUndefined
    }, processCreateParams(params)));
  };
  var ZodNull = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.null) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.null,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  };
  ZodNull.create = (params) => {
    return new ZodNull(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodNull
    }, processCreateParams(params)));
  };
  var ZodAny = class extends ZodType {
    constructor() {
      super(...arguments);
      this._any = true;
    }
    _parse(input) {
      return OK(input.data);
    }
  };
  ZodAny.create = (params) => {
    return new ZodAny(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodAny
    }, processCreateParams(params)));
  };
  var ZodUnknown = class extends ZodType {
    constructor() {
      super(...arguments);
      this._unknown = true;
    }
    _parse(input) {
      return OK(input.data);
    }
  };
  ZodUnknown.create = (params) => {
    return new ZodUnknown(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodUnknown
    }, processCreateParams(params)));
  };
  var ZodNever = class extends ZodType {
    _parse(input) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.never,
        received: ctx.parsedType
      });
      return INVALID;
    }
  };
  ZodNever.create = (params) => {
    return new ZodNever(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodNever
    }, processCreateParams(params)));
  };
  var ZodVoid = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.undefined) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.void,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return OK(input.data);
    }
  };
  ZodVoid.create = (params) => {
    return new ZodVoid(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodVoid
    }, processCreateParams(params)));
  };
  var ZodArray = class _ZodArray extends ZodType {
    _parse(input) {
      const { ctx, status } = this._processInputParams(input);
      const def = this._def;
      if (ctx.parsedType !== ZodParsedType.array) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.array,
          received: ctx.parsedType
        });
        return INVALID;
      }
      if (def.exactLength !== null) {
        const tooBig = ctx.data.length > def.exactLength.value;
        const tooSmall = ctx.data.length < def.exactLength.value;
        if (tooBig || tooSmall) {
          addIssueToContext(ctx, {
            code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
            minimum: tooSmall ? def.exactLength.value : void 0,
            maximum: tooBig ? def.exactLength.value : void 0,
            type: "array",
            inclusive: true,
            exact: true,
            message: def.exactLength.message
          });
          status.dirty();
        }
      }
      if (def.minLength !== null) {
        if (ctx.data.length < def.minLength.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: def.minLength.value,
            type: "array",
            inclusive: true,
            exact: false,
            message: def.minLength.message
          });
          status.dirty();
        }
      }
      if (def.maxLength !== null) {
        if (ctx.data.length > def.maxLength.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: def.maxLength.value,
            type: "array",
            inclusive: true,
            exact: false,
            message: def.maxLength.message
          });
          status.dirty();
        }
      }
      if (ctx.common.async) {
        return Promise.all([...ctx.data].map((item, i) => {
          return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        })).then((result3) => {
          return ParseStatus.mergeArray(status, result3);
        });
      }
      const result2 = [...ctx.data].map((item, i) => {
        return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      });
      return ParseStatus.mergeArray(status, result2);
    }
    get element() {
      return this._def.type;
    }
    min(minLength, message) {
      return new _ZodArray(__spreadProps(__spreadValues({}, this._def), {
        minLength: { value: minLength, message: errorUtil.toString(message) }
      }));
    }
    max(maxLength, message) {
      return new _ZodArray(__spreadProps(__spreadValues({}, this._def), {
        maxLength: { value: maxLength, message: errorUtil.toString(message) }
      }));
    }
    length(len, message) {
      return new _ZodArray(__spreadProps(__spreadValues({}, this._def), {
        exactLength: { value: len, message: errorUtil.toString(message) }
      }));
    }
    nonempty(message) {
      return this.min(1, message);
    }
  };
  ZodArray.create = (schema, params) => {
    return new ZodArray(__spreadValues({
      type: schema,
      minLength: null,
      maxLength: null,
      exactLength: null,
      typeName: ZodFirstPartyTypeKind.ZodArray
    }, processCreateParams(params)));
  };
  function deepPartialify(schema) {
    if (schema instanceof ZodObject) {
      const newShape = {};
      for (const key in schema.shape) {
        const fieldSchema = schema.shape[key];
        newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
      }
      return new ZodObject(__spreadProps(__spreadValues({}, schema._def), {
        shape: () => newShape
      }));
    } else if (schema instanceof ZodArray) {
      return new ZodArray(__spreadProps(__spreadValues({}, schema._def), {
        type: deepPartialify(schema.element)
      }));
    } else if (schema instanceof ZodOptional) {
      return ZodOptional.create(deepPartialify(schema.unwrap()));
    } else if (schema instanceof ZodNullable) {
      return ZodNullable.create(deepPartialify(schema.unwrap()));
    } else if (schema instanceof ZodTuple) {
      return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
    } else {
      return schema;
    }
  }
  var ZodObject = class _ZodObject extends ZodType {
    constructor() {
      super(...arguments);
      this._cached = null;
      this.nonstrict = this.passthrough;
      this.augment = this.extend;
    }
    _getCached() {
      if (this._cached !== null)
        return this._cached;
      const shape = this._def.shape();
      const keys = util.objectKeys(shape);
      this._cached = { shape, keys };
      return this._cached;
    }
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.object) {
        const ctx2 = this._getOrReturnCtx(input);
        addIssueToContext(ctx2, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.object,
          received: ctx2.parsedType
        });
        return INVALID;
      }
      const { status, ctx } = this._processInputParams(input);
      const { shape, keys: shapeKeys } = this._getCached();
      const extraKeys = [];
      if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
        for (const key in ctx.data) {
          if (!shapeKeys.includes(key)) {
            extraKeys.push(key);
          }
        }
      }
      const pairs = [];
      for (const key of shapeKeys) {
        const keyValidator = shape[key];
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
      if (this._def.catchall instanceof ZodNever) {
        const unknownKeys = this._def.unknownKeys;
        if (unknownKeys === "passthrough") {
          for (const key of extraKeys) {
            pairs.push({
              key: { status: "valid", value: key },
              value: { status: "valid", value: ctx.data[key] }
            });
          }
        } else if (unknownKeys === "strict") {
          if (extraKeys.length > 0) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.unrecognized_keys,
              keys: extraKeys
            });
            status.dirty();
          }
        } else if (unknownKeys === "strip") {
        } else {
          throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
        }
      } else {
        const catchall = this._def.catchall;
        for (const key of extraKeys) {
          const value = ctx.data[key];
          pairs.push({
            key: { status: "valid", value: key },
            value: catchall._parse(
              new ParseInputLazyPath(ctx, value, ctx.path, key)
              //, ctx.child(key), value, getParsedType(value)
            ),
            alwaysSet: key in ctx.data
          });
        }
      }
      if (ctx.common.async) {
        return Promise.resolve().then(async () => {
          const syncPairs = [];
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
              key,
              value,
              alwaysSet: pair.alwaysSet
            });
          }
          return syncPairs;
        }).then((syncPairs) => {
          return ParseStatus.mergeObjectSync(status, syncPairs);
        });
      } else {
        return ParseStatus.mergeObjectSync(status, pairs);
      }
    }
    get shape() {
      return this._def.shape();
    }
    strict(message) {
      errorUtil.errToObj;
      return new _ZodObject(__spreadValues(__spreadProps(__spreadValues({}, this._def), {
        unknownKeys: "strict"
      }), message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a, _b, _c, _d;
          const defaultError = (_c = (_b = (_a = this._def).errorMap) == null ? void 0 : _b.call(_a, issue, ctx).message) != null ? _c : ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: (_d = errorUtil.errToObj(message).message) != null ? _d : defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}));
    }
    strip() {
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        unknownKeys: "strip"
      }));
    }
    passthrough() {
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        unknownKeys: "passthrough"
      }));
    }
    // const AugmentFactory =
    //   <Def extends ZodObjectDef>(def: Def) =>
    //   <Augmentation extends ZodRawShape>(
    //     augmentation: Augmentation
    //   ): ZodObject<
    //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
    //     Def["unknownKeys"],
    //     Def["catchall"]
    //   > => {
    //     return new ZodObject({
    //       ...def,
    //       shape: () => ({
    //         ...def.shape(),
    //         ...augmentation,
    //       }),
    //     }) as any;
    //   };
    extend(augmentation) {
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        shape: () => __spreadValues(__spreadValues({}, this._def.shape()), augmentation)
      }));
    }
    /**
     * Prior to zod@1.0.12 there was a bug in the
     * inferred type of merged objects. Please
     * upgrade if you are experiencing issues.
     */
    merge(merging) {
      const merged = new _ZodObject({
        unknownKeys: merging._def.unknownKeys,
        catchall: merging._def.catchall,
        shape: () => __spreadValues(__spreadValues({}, this._def.shape()), merging._def.shape()),
        typeName: ZodFirstPartyTypeKind.ZodObject
      });
      return merged;
    }
    // merge<
    //   Incoming extends AnyZodObject,
    //   Augmentation extends Incoming["shape"],
    //   NewOutput extends {
    //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
    //       ? Augmentation[k]["_output"]
    //       : k extends keyof Output
    //       ? Output[k]
    //       : never;
    //   },
    //   NewInput extends {
    //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
    //       ? Augmentation[k]["_input"]
    //       : k extends keyof Input
    //       ? Input[k]
    //       : never;
    //   }
    // >(
    //   merging: Incoming
    // ): ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"],
    //   NewOutput,
    //   NewInput
    // > {
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    setKey(key, schema) {
      return this.augment({ [key]: schema });
    }
    // merge<Incoming extends AnyZodObject>(
    //   merging: Incoming
    // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
    // ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"]
    // > {
    //   // const mergedShape = objectUtil.mergeShapes(
    //   //   this._def.shape(),
    //   //   merging._def.shape()
    //   // );
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    catchall(index) {
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        catchall: index
      }));
    }
    pick(mask) {
      const shape = {};
      for (const key of util.objectKeys(mask)) {
        if (mask[key] && this.shape[key]) {
          shape[key] = this.shape[key];
        }
      }
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        shape: () => shape
      }));
    }
    omit(mask) {
      const shape = {};
      for (const key of util.objectKeys(this.shape)) {
        if (!mask[key]) {
          shape[key] = this.shape[key];
        }
      }
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        shape: () => shape
      }));
    }
    /**
     * @deprecated
     */
    deepPartial() {
      return deepPartialify(this);
    }
    partial(mask) {
      const newShape = {};
      for (const key of util.objectKeys(this.shape)) {
        const fieldSchema = this.shape[key];
        if (mask && !mask[key]) {
          newShape[key] = fieldSchema;
        } else {
          newShape[key] = fieldSchema.optional();
        }
      }
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        shape: () => newShape
      }));
    }
    required(mask) {
      const newShape = {};
      for (const key of util.objectKeys(this.shape)) {
        if (mask && !mask[key]) {
          newShape[key] = this.shape[key];
        } else {
          const fieldSchema = this.shape[key];
          let newField = fieldSchema;
          while (newField instanceof ZodOptional) {
            newField = newField._def.innerType;
          }
          newShape[key] = newField;
        }
      }
      return new _ZodObject(__spreadProps(__spreadValues({}, this._def), {
        shape: () => newShape
      }));
    }
    keyof() {
      return createZodEnum(util.objectKeys(this.shape));
    }
  };
  ZodObject.create = (shape, params) => {
    return new ZodObject(__spreadValues({
      shape: () => shape,
      unknownKeys: "strip",
      catchall: ZodNever.create(),
      typeName: ZodFirstPartyTypeKind.ZodObject
    }, processCreateParams(params)));
  };
  ZodObject.strictCreate = (shape, params) => {
    return new ZodObject(__spreadValues({
      shape: () => shape,
      unknownKeys: "strict",
      catchall: ZodNever.create(),
      typeName: ZodFirstPartyTypeKind.ZodObject
    }, processCreateParams(params)));
  };
  ZodObject.lazycreate = (shape, params) => {
    return new ZodObject(__spreadValues({
      shape,
      unknownKeys: "strip",
      catchall: ZodNever.create(),
      typeName: ZodFirstPartyTypeKind.ZodObject
    }, processCreateParams(params)));
  };
  var ZodUnion = class extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const options = this._def.options;
      function handleResults(results) {
        for (const result2 of results) {
          if (result2.result.status === "valid") {
            return result2.result;
          }
        }
        for (const result2 of results) {
          if (result2.result.status === "dirty") {
            ctx.common.issues.push(...result2.ctx.common.issues);
            return result2.result;
          }
        }
        const unionErrors = results.map((result2) => new ZodError(result2.ctx.common.issues));
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_union,
          unionErrors
        });
        return INVALID;
      }
      if (ctx.common.async) {
        return Promise.all(options.map(async (option) => {
          const childCtx = __spreadProps(__spreadValues({}, ctx), {
            common: __spreadProps(__spreadValues({}, ctx.common), {
              issues: []
            }),
            parent: null
          });
          return {
            result: await option._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx
            }),
            ctx: childCtx
          };
        })).then(handleResults);
      } else {
        let dirty = void 0;
        const issues = [];
        for (const option of options) {
          const childCtx = __spreadProps(__spreadValues({}, ctx), {
            common: __spreadProps(__spreadValues({}, ctx.common), {
              issues: []
            }),
            parent: null
          });
          const result2 = option._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          });
          if (result2.status === "valid") {
            return result2;
          } else if (result2.status === "dirty" && !dirty) {
            dirty = { result: result2, ctx: childCtx };
          }
          if (childCtx.common.issues.length) {
            issues.push(childCtx.common.issues);
          }
        }
        if (dirty) {
          ctx.common.issues.push(...dirty.ctx.common.issues);
          return dirty.result;
        }
        const unionErrors = issues.map((issues2) => new ZodError(issues2));
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_union,
          unionErrors
        });
        return INVALID;
      }
    }
    get options() {
      return this._def.options;
    }
  };
  ZodUnion.create = (types, params) => {
    return new ZodUnion(__spreadValues({
      options: types,
      typeName: ZodFirstPartyTypeKind.ZodUnion
    }, processCreateParams(params)));
  };
  var getDiscriminator = (type) => {
    if (type instanceof ZodLazy) {
      return getDiscriminator(type.schema);
    } else if (type instanceof ZodEffects) {
      return getDiscriminator(type.innerType());
    } else if (type instanceof ZodLiteral) {
      return [type.value];
    } else if (type instanceof ZodEnum) {
      return type.options;
    } else if (type instanceof ZodNativeEnum) {
      return util.objectValues(type.enum);
    } else if (type instanceof ZodDefault) {
      return getDiscriminator(type._def.innerType);
    } else if (type instanceof ZodUndefined) {
      return [void 0];
    } else if (type instanceof ZodNull) {
      return [null];
    } else if (type instanceof ZodOptional) {
      return [void 0, ...getDiscriminator(type.unwrap())];
    } else if (type instanceof ZodNullable) {
      return [null, ...getDiscriminator(type.unwrap())];
    } else if (type instanceof ZodBranded) {
      return getDiscriminator(type.unwrap());
    } else if (type instanceof ZodReadonly) {
      return getDiscriminator(type.unwrap());
    } else if (type instanceof ZodCatch) {
      return getDiscriminator(type._def.innerType);
    } else {
      return [];
    }
  };
  var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.object) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.object,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const discriminator = this.discriminator;
      const discriminatorValue = ctx.data[discriminator];
      const option = this.optionsMap.get(discriminatorValue);
      if (!option) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_union_discriminator,
          options: Array.from(this.optionsMap.keys()),
          path: [discriminator]
        });
        return INVALID;
      }
      if (ctx.common.async) {
        return option._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
      } else {
        return option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
      }
    }
    get discriminator() {
      return this._def.discriminator;
    }
    get options() {
      return this._def.options;
    }
    get optionsMap() {
      return this._def.optionsMap;
    }
    /**
     * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
     * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
     * have a different value for each object in the union.
     * @param discriminator the name of the discriminator property
     * @param types an array of object schemas
     * @param params
     */
    static create(discriminator, options, params) {
      const optionsMap = /* @__PURE__ */ new Map();
      for (const type of options) {
        const discriminatorValues = getDiscriminator(type.shape[discriminator]);
        if (!discriminatorValues.length) {
          throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
        }
        for (const value of discriminatorValues) {
          if (optionsMap.has(value)) {
            throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
          }
          optionsMap.set(value, type);
        }
      }
      return new _ZodDiscriminatedUnion(__spreadValues({
        typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
        discriminator,
        options,
        optionsMap
      }, processCreateParams(params)));
    }
  };
  function mergeValues(a, b) {
    const aType = getParsedType(a);
    const bType = getParsedType(b);
    if (a === b) {
      return { valid: true, data: a };
    } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
      const bKeys = util.objectKeys(b);
      const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
      const newObj = __spreadValues(__spreadValues({}, a), b);
      for (const key of sharedKeys) {
        const sharedValue = mergeValues(a[key], b[key]);
        if (!sharedValue.valid) {
          return { valid: false };
        }
        newObj[key] = sharedValue.data;
      }
      return { valid: true, data: newObj };
    } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
      if (a.length !== b.length) {
        return { valid: false };
      }
      const newArray = [];
      for (let index = 0; index < a.length; index++) {
        const itemA = a[index];
        const itemB = b[index];
        const sharedValue = mergeValues(itemA, itemB);
        if (!sharedValue.valid) {
          return { valid: false };
        }
        newArray.push(sharedValue.data);
      }
      return { valid: true, data: newArray };
    } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
      return { valid: true, data: a };
    } else {
      return { valid: false };
    }
  }
  var ZodIntersection = class extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      const handleParsed = (parsedLeft, parsedRight) => {
        if (isAborted(parsedLeft) || isAborted(parsedRight)) {
          return INVALID;
        }
        const merged = mergeValues(parsedLeft.value, parsedRight.value);
        if (!merged.valid) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_intersection_types
          });
          return INVALID;
        }
        if (isDirty(parsedLeft) || isDirty(parsedRight)) {
          status.dirty();
        }
        return { status: status.value, value: merged.data };
      };
      if (ctx.common.async) {
        return Promise.all([
          this._def.left._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          }),
          this._def.right._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          })
        ]).then(([left, right]) => handleParsed(left, right));
      } else {
        return handleParsed(this._def.left._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }), this._def.right._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }));
      }
    }
  };
  ZodIntersection.create = (left, right, params) => {
    return new ZodIntersection(__spreadValues({
      left,
      right,
      typeName: ZodFirstPartyTypeKind.ZodIntersection
    }, processCreateParams(params)));
  };
  var ZodTuple = class _ZodTuple extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.array) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.array,
          received: ctx.parsedType
        });
        return INVALID;
      }
      if (ctx.data.length < this._def.items.length) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: this._def.items.length,
          inclusive: true,
          exact: false,
          type: "array"
        });
        return INVALID;
      }
      const rest = this._def.rest;
      if (!rest && ctx.data.length > this._def.items.length) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: this._def.items.length,
          inclusive: true,
          exact: false,
          type: "array"
        });
        status.dirty();
      }
      const items = [...ctx.data].map((item, itemIndex) => {
        const schema = this._def.items[itemIndex] || this._def.rest;
        if (!schema)
          return null;
        return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
      }).filter((x) => !!x);
      if (ctx.common.async) {
        return Promise.all(items).then((results) => {
          return ParseStatus.mergeArray(status, results);
        });
      } else {
        return ParseStatus.mergeArray(status, items);
      }
    }
    get items() {
      return this._def.items;
    }
    rest(rest) {
      return new _ZodTuple(__spreadProps(__spreadValues({}, this._def), {
        rest
      }));
    }
  };
  ZodTuple.create = (schemas, params) => {
    if (!Array.isArray(schemas)) {
      throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    }
    return new ZodTuple(__spreadValues({
      items: schemas,
      typeName: ZodFirstPartyTypeKind.ZodTuple,
      rest: null
    }, processCreateParams(params)));
  };
  var ZodRecord = class _ZodRecord extends ZodType {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.object) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.object,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const pairs = [];
      const keyType = this._def.keyType;
      const valueType = this._def.valueType;
      for (const key in ctx.data) {
        pairs.push({
          key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
          value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
      if (ctx.common.async) {
        return ParseStatus.mergeObjectAsync(status, pairs);
      } else {
        return ParseStatus.mergeObjectSync(status, pairs);
      }
    }
    get element() {
      return this._def.valueType;
    }
    static create(first, second, third) {
      if (second instanceof ZodType) {
        return new _ZodRecord(__spreadValues({
          keyType: first,
          valueType: second,
          typeName: ZodFirstPartyTypeKind.ZodRecord
        }, processCreateParams(third)));
      }
      return new _ZodRecord(__spreadValues({
        keyType: ZodString.create(),
        valueType: first,
        typeName: ZodFirstPartyTypeKind.ZodRecord
      }, processCreateParams(second)));
    }
  };
  var ZodMap = class extends ZodType {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.map) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.map,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const keyType = this._def.keyType;
      const valueType = this._def.valueType;
      const pairs = [...ctx.data.entries()].map(([key, value], index) => {
        return {
          key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
          value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
        };
      });
      if (ctx.common.async) {
        const finalMap = /* @__PURE__ */ new Map();
        return Promise.resolve().then(async () => {
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            if (key.status === "aborted" || value.status === "aborted") {
              return INVALID;
            }
            if (key.status === "dirty" || value.status === "dirty") {
              status.dirty();
            }
            finalMap.set(key.value, value.value);
          }
          return { status: status.value, value: finalMap };
        });
      } else {
        const finalMap = /* @__PURE__ */ new Map();
        for (const pair of pairs) {
          const key = pair.key;
          const value = pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      }
    }
  };
  ZodMap.create = (keyType, valueType, params) => {
    return new ZodMap(__spreadValues({
      valueType,
      keyType,
      typeName: ZodFirstPartyTypeKind.ZodMap
    }, processCreateParams(params)));
  };
  var ZodSet = class _ZodSet extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.set) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.set,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const def = this._def;
      if (def.minSize !== null) {
        if (ctx.data.size < def.minSize.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: def.minSize.value,
            type: "set",
            inclusive: true,
            exact: false,
            message: def.minSize.message
          });
          status.dirty();
        }
      }
      if (def.maxSize !== null) {
        if (ctx.data.size > def.maxSize.value) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: def.maxSize.value,
            type: "set",
            inclusive: true,
            exact: false,
            message: def.maxSize.message
          });
          status.dirty();
        }
      }
      const valueType = this._def.valueType;
      function finalizeSet(elements2) {
        const parsedSet = /* @__PURE__ */ new Set();
        for (const element of elements2) {
          if (element.status === "aborted")
            return INVALID;
          if (element.status === "dirty")
            status.dirty();
          parsedSet.add(element.value);
        }
        return { status: status.value, value: parsedSet };
      }
      const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
      if (ctx.common.async) {
        return Promise.all(elements).then((elements2) => finalizeSet(elements2));
      } else {
        return finalizeSet(elements);
      }
    }
    min(minSize, message) {
      return new _ZodSet(__spreadProps(__spreadValues({}, this._def), {
        minSize: { value: minSize, message: errorUtil.toString(message) }
      }));
    }
    max(maxSize, message) {
      return new _ZodSet(__spreadProps(__spreadValues({}, this._def), {
        maxSize: { value: maxSize, message: errorUtil.toString(message) }
      }));
    }
    size(size2, message) {
      return this.min(size2, message).max(size2, message);
    }
    nonempty(message) {
      return this.min(1, message);
    }
  };
  ZodSet.create = (valueType, params) => {
    return new ZodSet(__spreadValues({
      valueType,
      minSize: null,
      maxSize: null,
      typeName: ZodFirstPartyTypeKind.ZodSet
    }, processCreateParams(params)));
  };
  var ZodFunction = class _ZodFunction extends ZodType {
    constructor() {
      super(...arguments);
      this.validate = this.implement;
    }
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.function) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.function,
          received: ctx.parsedType
        });
        return INVALID;
      }
      function makeArgsIssue(args, error) {
        return makeIssue({
          data: args,
          path: ctx.path,
          errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
          issueData: {
            code: ZodIssueCode.invalid_arguments,
            argumentsError: error
          }
        });
      }
      function makeReturnsIssue(returns, error) {
        return makeIssue({
          data: returns,
          path: ctx.path,
          errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
          issueData: {
            code: ZodIssueCode.invalid_return_type,
            returnTypeError: error
          }
        });
      }
      const params = { errorMap: ctx.common.contextualErrorMap };
      const fn = ctx.data;
      if (this._def.returns instanceof ZodPromise) {
        const me = this;
        return OK(async function(...args) {
          const error = new ZodError([]);
          const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
            error.addIssue(makeArgsIssue(args, e));
            throw error;
          });
          const result2 = await Reflect.apply(fn, this, parsedArgs);
          const parsedReturns = await me._def.returns._def.type.parseAsync(result2, params).catch((e) => {
            error.addIssue(makeReturnsIssue(result2, e));
            throw error;
          });
          return parsedReturns;
        });
      } else {
        const me = this;
        return OK(function(...args) {
          const parsedArgs = me._def.args.safeParse(args, params);
          if (!parsedArgs.success) {
            throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
          }
          const result2 = Reflect.apply(fn, this, parsedArgs.data);
          const parsedReturns = me._def.returns.safeParse(result2, params);
          if (!parsedReturns.success) {
            throw new ZodError([makeReturnsIssue(result2, parsedReturns.error)]);
          }
          return parsedReturns.data;
        });
      }
    }
    parameters() {
      return this._def.args;
    }
    returnType() {
      return this._def.returns;
    }
    args(...items) {
      return new _ZodFunction(__spreadProps(__spreadValues({}, this._def), {
        args: ZodTuple.create(items).rest(ZodUnknown.create())
      }));
    }
    returns(returnType) {
      return new _ZodFunction(__spreadProps(__spreadValues({}, this._def), {
        returns: returnType
      }));
    }
    implement(func) {
      const validatedFunc = this.parse(func);
      return validatedFunc;
    }
    strictImplement(func) {
      const validatedFunc = this.parse(func);
      return validatedFunc;
    }
    static create(args, returns, params) {
      return new _ZodFunction(__spreadValues({
        args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
        returns: returns || ZodUnknown.create(),
        typeName: ZodFirstPartyTypeKind.ZodFunction
      }, processCreateParams(params)));
    }
  };
  var ZodLazy = class extends ZodType {
    get schema() {
      return this._def.getter();
    }
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const lazySchema = this._def.getter();
      return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
    }
  };
  ZodLazy.create = (getter, params) => {
    return new ZodLazy(__spreadValues({
      getter,
      typeName: ZodFirstPartyTypeKind.ZodLazy
    }, processCreateParams(params)));
  };
  var ZodLiteral = class extends ZodType {
    _parse(input) {
      if (input.data !== this._def.value) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          received: ctx.data,
          code: ZodIssueCode.invalid_literal,
          expected: this._def.value
        });
        return INVALID;
      }
      return { status: "valid", value: input.data };
    }
    get value() {
      return this._def.value;
    }
  };
  ZodLiteral.create = (value, params) => {
    return new ZodLiteral(__spreadValues({
      value,
      typeName: ZodFirstPartyTypeKind.ZodLiteral
    }, processCreateParams(params)));
  };
  function createZodEnum(values, params) {
    return new ZodEnum(__spreadValues({
      values,
      typeName: ZodFirstPartyTypeKind.ZodEnum
    }, processCreateParams(params)));
  }
  var ZodEnum = class _ZodEnum extends ZodType {
    _parse(input) {
      if (typeof input.data !== "string") {
        const ctx = this._getOrReturnCtx(input);
        const expectedValues = this._def.values;
        addIssueToContext(ctx, {
          expected: util.joinValues(expectedValues),
          received: ctx.parsedType,
          code: ZodIssueCode.invalid_type
        });
        return INVALID;
      }
      if (!this._cache) {
        this._cache = new Set(this._def.values);
      }
      if (!this._cache.has(input.data)) {
        const ctx = this._getOrReturnCtx(input);
        const expectedValues = this._def.values;
        addIssueToContext(ctx, {
          received: ctx.data,
          code: ZodIssueCode.invalid_enum_value,
          options: expectedValues
        });
        return INVALID;
      }
      return OK(input.data);
    }
    get options() {
      return this._def.values;
    }
    get enum() {
      const enumValues = {};
      for (const val of this._def.values) {
        enumValues[val] = val;
      }
      return enumValues;
    }
    get Values() {
      const enumValues = {};
      for (const val of this._def.values) {
        enumValues[val] = val;
      }
      return enumValues;
    }
    get Enum() {
      const enumValues = {};
      for (const val of this._def.values) {
        enumValues[val] = val;
      }
      return enumValues;
    }
    extract(values, newDef = this._def) {
      return _ZodEnum.create(values, __spreadValues(__spreadValues({}, this._def), newDef));
    }
    exclude(values, newDef = this._def) {
      return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), __spreadValues(__spreadValues({}, this._def), newDef));
    }
  };
  ZodEnum.create = createZodEnum;
  var ZodNativeEnum = class extends ZodType {
    _parse(input) {
      const nativeEnumValues = util.getValidEnumValues(this._def.values);
      const ctx = this._getOrReturnCtx(input);
      if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
        const expectedValues = util.objectValues(nativeEnumValues);
        addIssueToContext(ctx, {
          expected: util.joinValues(expectedValues),
          received: ctx.parsedType,
          code: ZodIssueCode.invalid_type
        });
        return INVALID;
      }
      if (!this._cache) {
        this._cache = new Set(util.getValidEnumValues(this._def.values));
      }
      if (!this._cache.has(input.data)) {
        const expectedValues = util.objectValues(nativeEnumValues);
        addIssueToContext(ctx, {
          received: ctx.data,
          code: ZodIssueCode.invalid_enum_value,
          options: expectedValues
        });
        return INVALID;
      }
      return OK(input.data);
    }
    get enum() {
      return this._def.values;
    }
  };
  ZodNativeEnum.create = (values, params) => {
    return new ZodNativeEnum(__spreadValues({
      values,
      typeName: ZodFirstPartyTypeKind.ZodNativeEnum
    }, processCreateParams(params)));
  };
  var ZodPromise = class extends ZodType {
    unwrap() {
      return this._def.type;
    }
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.promise,
          received: ctx.parsedType
        });
        return INVALID;
      }
      const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
      return OK(promisified.then((data) => {
        return this._def.type.parseAsync(data, {
          path: ctx.path,
          errorMap: ctx.common.contextualErrorMap
        });
      }));
    }
  };
  ZodPromise.create = (schema, params) => {
    return new ZodPromise(__spreadValues({
      type: schema,
      typeName: ZodFirstPartyTypeKind.ZodPromise
    }, processCreateParams(params)));
  };
  var ZodEffects = class extends ZodType {
    innerType() {
      return this._def.schema;
    }
    sourceType() {
      return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
    }
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      const effect = this._def.effect || null;
      const checkCtx = {
        addIssue: (arg) => {
          addIssueToContext(ctx, arg);
          if (arg.fatal) {
            status.abort();
          } else {
            status.dirty();
          }
        },
        get path() {
          return ctx.path;
        }
      };
      checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
      if (effect.type === "preprocess") {
        const processed = effect.transform(ctx.data, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(processed).then(async (processed2) => {
            if (status.value === "aborted")
              return INVALID;
            const result2 = await this._def.schema._parseAsync({
              data: processed2,
              path: ctx.path,
              parent: ctx
            });
            if (result2.status === "aborted")
              return INVALID;
            if (result2.status === "dirty")
              return DIRTY(result2.value);
            if (status.value === "dirty")
              return DIRTY(result2.value);
            return result2;
          });
        } else {
          if (status.value === "aborted")
            return INVALID;
          const result2 = this._def.schema._parseSync({
            data: processed,
            path: ctx.path,
            parent: ctx
          });
          if (result2.status === "aborted")
            return INVALID;
          if (result2.status === "dirty")
            return DIRTY(result2.value);
          if (status.value === "dirty")
            return DIRTY(result2.value);
          return result2;
        }
      }
      if (effect.type === "refinement") {
        const executeRefinement = (acc) => {
          const result2 = effect.refinement(acc, checkCtx);
          if (ctx.common.async) {
            return Promise.resolve(result2);
          }
          if (result2 instanceof Promise) {
            throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
          }
          return acc;
        };
        if (ctx.common.async === false) {
          const inner = this._def.schema._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          executeRefinement(inner.value);
          return { status: status.value, value: inner.value };
        } else {
          return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
            if (inner.status === "aborted")
              return INVALID;
            if (inner.status === "dirty")
              status.dirty();
            return executeRefinement(inner.value).then(() => {
              return { status: status.value, value: inner.value };
            });
          });
        }
      }
      if (effect.type === "transform") {
        if (ctx.common.async === false) {
          const base = this._def.schema._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (!isValid(base))
            return INVALID;
          const result2 = effect.transform(base.value, checkCtx);
          if (result2 instanceof Promise) {
            throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
          }
          return { status: status.value, value: result2 };
        } else {
          return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
            if (!isValid(base))
              return INVALID;
            return Promise.resolve(effect.transform(base.value, checkCtx)).then((result2) => ({
              status: status.value,
              value: result2
            }));
          });
        }
      }
      util.assertNever(effect);
    }
  };
  ZodEffects.create = (schema, effect, params) => {
    return new ZodEffects(__spreadValues({
      schema,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect
    }, processCreateParams(params)));
  };
  ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
    return new ZodEffects(__spreadValues({
      schema,
      effect: { type: "preprocess", transform: preprocess },
      typeName: ZodFirstPartyTypeKind.ZodEffects
    }, processCreateParams(params)));
  };
  var ZodOptional = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType === ZodParsedType.undefined) {
        return OK(void 0);
      }
      return this._def.innerType._parse(input);
    }
    unwrap() {
      return this._def.innerType;
    }
  };
  ZodOptional.create = (type, params) => {
    return new ZodOptional(__spreadValues({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodOptional
    }, processCreateParams(params)));
  };
  var ZodNullable = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType === ZodParsedType.null) {
        return OK(null);
      }
      return this._def.innerType._parse(input);
    }
    unwrap() {
      return this._def.innerType;
    }
  };
  ZodNullable.create = (type, params) => {
    return new ZodNullable(__spreadValues({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodNullable
    }, processCreateParams(params)));
  };
  var ZodDefault = class extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      let data = ctx.data;
      if (ctx.parsedType === ZodParsedType.undefined) {
        data = this._def.defaultValue();
      }
      return this._def.innerType._parse({
        data,
        path: ctx.path,
        parent: ctx
      });
    }
    removeDefault() {
      return this._def.innerType;
    }
  };
  ZodDefault.create = (type, params) => {
    return new ZodDefault(__spreadValues({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodDefault,
      defaultValue: typeof params.default === "function" ? params.default : () => params.default
    }, processCreateParams(params)));
  };
  var ZodCatch = class extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const newCtx = __spreadProps(__spreadValues({}, ctx), {
        common: __spreadProps(__spreadValues({}, ctx.common), {
          issues: []
        })
      });
      const result2 = this._def.innerType._parse({
        data: newCtx.data,
        path: newCtx.path,
        parent: __spreadValues({}, newCtx)
      });
      if (isAsync(result2)) {
        return result2.then((result3) => {
          return {
            status: "valid",
            value: result3.status === "valid" ? result3.value : this._def.catchValue({
              get error() {
                return new ZodError(newCtx.common.issues);
              },
              input: newCtx.data
            })
          };
        });
      } else {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      }
    }
    removeCatch() {
      return this._def.innerType;
    }
  };
  ZodCatch.create = (type, params) => {
    return new ZodCatch(__spreadValues({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodCatch,
      catchValue: typeof params.catch === "function" ? params.catch : () => params.catch
    }, processCreateParams(params)));
  };
  var ZodNaN = class extends ZodType {
    _parse(input) {
      const parsedType = this._getType(input);
      if (parsedType !== ZodParsedType.nan) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_type,
          expected: ZodParsedType.nan,
          received: ctx.parsedType
        });
        return INVALID;
      }
      return { status: "valid", value: input.data };
    }
  };
  ZodNaN.create = (params) => {
    return new ZodNaN(__spreadValues({
      typeName: ZodFirstPartyTypeKind.ZodNaN
    }, processCreateParams(params)));
  };
  var BRAND = Symbol("zod_brand");
  var ZodBranded = class extends ZodType {
    _parse(input) {
      const { ctx } = this._processInputParams(input);
      const data = ctx.data;
      return this._def.type._parse({
        data,
        path: ctx.path,
        parent: ctx
      });
    }
    unwrap() {
      return this._def.type;
    }
  };
  var ZodPipeline = class _ZodPipeline extends ZodType {
    _parse(input) {
      const { status, ctx } = this._processInputParams(input);
      if (ctx.common.async) {
        const handleAsync = async () => {
          const inResult = await this._def.in._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (inResult.status === "aborted")
            return INVALID;
          if (inResult.status === "dirty") {
            status.dirty();
            return DIRTY(inResult.value);
          } else {
            return this._def.out._parseAsync({
              data: inResult.value,
              path: ctx.path,
              parent: ctx
            });
          }
        };
        return handleAsync();
      } else {
        const inResult = this._def.in._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return {
            status: "dirty",
            value: inResult.value
          };
        } else {
          return this._def.out._parseSync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      }
    }
    static create(a, b) {
      return new _ZodPipeline({
        in: a,
        out: b,
        typeName: ZodFirstPartyTypeKind.ZodPipeline
      });
    }
  };
  var ZodReadonly = class extends ZodType {
    _parse(input) {
      const result2 = this._def.innerType._parse(input);
      const freeze = (data) => {
        if (isValid(data)) {
          data.value = Object.freeze(data.value);
        }
        return data;
      };
      return isAsync(result2) ? result2.then((data) => freeze(data)) : freeze(result2);
    }
    unwrap() {
      return this._def.innerType;
    }
  };
  ZodReadonly.create = (type, params) => {
    return new ZodReadonly(__spreadValues({
      innerType: type,
      typeName: ZodFirstPartyTypeKind.ZodReadonly
    }, processCreateParams(params)));
  };
  function cleanParams(params, data) {
    const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
    const p2 = typeof p === "string" ? { message: p } : p;
    return p2;
  }
  function custom(check, _params = {}, fatal) {
    if (check)
      return ZodAny.create().superRefine((data, ctx) => {
        var _a, _b;
        const r = check(data);
        if (r instanceof Promise) {
          return r.then((r2) => {
            var _a2, _b2;
            if (!r2) {
              const params = cleanParams(_params, data);
              const _fatal = (_b2 = (_a2 = params.fatal) != null ? _a2 : fatal) != null ? _b2 : true;
              ctx.addIssue(__spreadProps(__spreadValues({ code: "custom" }, params), { fatal: _fatal }));
            }
          });
        }
        if (!r) {
          const params = cleanParams(_params, data);
          const _fatal = (_b = (_a = params.fatal) != null ? _a : fatal) != null ? _b : true;
          ctx.addIssue(__spreadProps(__spreadValues({ code: "custom" }, params), { fatal: _fatal }));
        }
        return;
      });
    return ZodAny.create();
  }
  var late = {
    object: ZodObject.lazycreate
  };
  var ZodFirstPartyTypeKind;
  (function(ZodFirstPartyTypeKind2) {
    ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
    ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
    ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
    ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
    ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
    ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
    ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
    ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
    ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
    ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
    ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
    ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
    ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
    ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
    ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
    ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
    ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
    ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
    ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
    ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
    ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
    ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
    ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
    ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
    ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
    ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
    ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
    ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
    ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
    ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
    ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
    ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
    ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
    ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
    ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
    ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
  })(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
  var instanceOfType = (cls, params = {
    message: `Input not instance of ${cls.name}`
  }) => custom((data) => data instanceof cls, params);
  var stringType = ZodString.create;
  var numberType = ZodNumber.create;
  var nanType = ZodNaN.create;
  var bigIntType = ZodBigInt.create;
  var booleanType = ZodBoolean.create;
  var dateType = ZodDate.create;
  var symbolType = ZodSymbol.create;
  var undefinedType = ZodUndefined.create;
  var nullType = ZodNull.create;
  var anyType = ZodAny.create;
  var unknownType = ZodUnknown.create;
  var neverType = ZodNever.create;
  var voidType = ZodVoid.create;
  var arrayType = ZodArray.create;
  var objectType = ZodObject.create;
  var strictObjectType = ZodObject.strictCreate;
  var unionType = ZodUnion.create;
  var discriminatedUnionType = ZodDiscriminatedUnion.create;
  var intersectionType = ZodIntersection.create;
  var tupleType = ZodTuple.create;
  var recordType = ZodRecord.create;
  var mapType = ZodMap.create;
  var setType = ZodSet.create;
  var functionType = ZodFunction.create;
  var lazyType = ZodLazy.create;
  var literalType = ZodLiteral.create;
  var enumType = ZodEnum.create;
  var nativeEnumType = ZodNativeEnum.create;
  var promiseType = ZodPromise.create;
  var effectsType = ZodEffects.create;
  var optionalType = ZodOptional.create;
  var nullableType = ZodNullable.create;
  var preprocessType = ZodEffects.createWithPreprocess;
  var pipelineType = ZodPipeline.create;
  var ostring = () => stringType().optional();
  var onumber = () => numberType().optional();
  var oboolean = () => booleanType().optional();
  var coerce = {
    string: ((arg) => ZodString.create(__spreadProps(__spreadValues({}, arg), { coerce: true }))),
    number: ((arg) => ZodNumber.create(__spreadProps(__spreadValues({}, arg), { coerce: true }))),
    boolean: ((arg) => ZodBoolean.create(__spreadProps(__spreadValues({}, arg), {
      coerce: true
    }))),
    bigint: ((arg) => ZodBigInt.create(__spreadProps(__spreadValues({}, arg), { coerce: true }))),
    date: ((arg) => ZodDate.create(__spreadProps(__spreadValues({}, arg), { coerce: true })))
  };
  var NEVER = INVALID;

  // src/web-snapshot-schema.mjs
  var finite2 = external_exports.number().finite();
  var coord = finite2.min(-1e5).max(1e5);
  var size = finite2.positive().max(2e4);
  var ref = external_exports.string().regex(/^n\d{1,6}$/);
  var color = external_exports.object({ r: finite2.min(0).max(1), g: finite2.min(0).max(1), b: finite2.min(0).max(1), a: finite2.min(0).max(1) }).strict();
  var label = external_exports.string().max(200);
  var font = external_exports.object({
    family: label,
    weight: external_exports.number().int().min(100).max(900),
    italic: external_exports.boolean(),
    size: finite2.positive().max(1e3),
    lineHeight: finite2.positive().max(2e3).nullable(),
    letterSpacing: finite2.min(-100).max(100),
    align: external_exports.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]),
    color
  }).strict();
  var layout = external_exports.object({
    direction: external_exports.enum(["HORIZONTAL", "VERTICAL"]),
    gap: finite2.min(0).max(1e4),
    padding: external_exports.array(finite2.min(0).max(1e4)).length(4),
    justify: external_exports.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]),
    align: external_exports.enum(["MIN", "CENTER", "MAX"])
  }).strict();
  var webSnapshotSchema = external_exports.object({
    format: external_exports.literal("figma-local-web-v1"),
    viewport: external_exports.object({ width: size, height: size, scrollX: coord, scrollY: coord }).strict(),
    coverage: external_exports.object({ complete: external_exports.boolean(), visited: external_exports.number().int().min(0).max(1e4), reason: label.optional() }).strict(),
    warnings: external_exports.array(external_exports.object({ ref: ref.optional(), code: label }).strict()).max(500),
    nodes: external_exports.array(external_exports.object({
      ref,
      parentRef: ref.optional(),
      kind: external_exports.enum(["FRAME", "TEXT", "IMAGE"]),
      name: label,
      x: coord,
      y: coord,
      width: size,
      height: size,
      opacity: finite2.min(0).max(1),
      fill: color.nullable(),
      border: external_exports.object({ color, width: finite2.min(0).max(1e3) }).strict().nullable(),
      radii: external_exports.array(finite2.min(0).max(1e4)).length(4),
      clipsContent: external_exports.boolean(),
      text: external_exports.string().max(2e3).optional(),
      font: font.optional(),
      textLayout: external_exports.enum(["SINGLE_LINE", "WRAPPED"]).optional(),
      imageRef: ref.optional(),
      imageFit: external_exports.enum(["FILL", "FIT"]).optional(),
      layout: layout.optional()
    }).strict()).min(1).max(200),
    images: external_exports.array(external_exports.object({ ref, png: external_exports.string().min(1).max(2 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()).max(40)
  }).strict().superRefine((s, ctx) => {
    const issue = (message) => ctx.addIssue({ code: "custom", message });
    const nodes = /* @__PURE__ */ new Map(), images = /* @__PURE__ */ new Set();
    for (const image of s.images) {
      if (images.has(image.ref)) issue("Duplicate image ref");
      images.add(image.ref);
    }
    s.nodes.forEach((n, i) => {
      var _a, _b;
      if (nodes.has(n.ref)) issue("Duplicate node ref");
      if (i === 0 ? n.parentRef || n.kind !== "FRAME" || n.x !== 0 || n.y !== 0 : !n.parentRef || ((_a = nodes.get(n.parentRef)) == null ? void 0 : _a.kind) !== "FRAME") issue("Expected one root frame and parents before children");
      if (n.kind === "TEXT" ? n.text === void 0 || !n.font : n.text !== void 0 || n.font !== void 0) issue("Text content and font belong to TEXT nodes only");
      if (n.textLayout && n.kind !== "TEXT") issue("Text layout belongs to TEXT nodes only");
      if (n.textLayout === "SINGLE_LINE" && /[\r\n]/.test((_b = n.text) != null ? _b : "")) issue("Single-line text cannot contain line breaks");
      if (n.layout && n.kind !== "FRAME") issue("Auto Layout requires FRAME");
      if ((n.imageRef || n.imageFit) && n.kind !== "IMAGE") issue("Image fields require IMAGE");
      if (n.imageRef && !images.has(n.imageRef)) issue("Missing image data");
      nodes.set(n.ref, n);
    });
    const raw = JSON.stringify(s);
    let bytes = 0;
    for (const ch of raw) {
      const cp = ch.codePointAt(0);
      bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    }
    if (bytes > 4 * 1024 * 1024) issue("Snapshot exceeds 4 MiB; capture a smaller section");
  });
  var importWebSnapshotSchema = {
    snapshot: webSnapshotSchema.optional(),
    filePath: external_exports.string().min(1).max(4096).optional(),
    parentId: external_exports.string().min(1).max(200).optional(),
    x: coord.default(0),
    y: coord.default(0),
    dryRun: external_exports.boolean().default(true),
    revision: external_exports.string().max(100).optional()
  };

  // plugin/web-import.ts
  var session2 = `${Date.now()}-${Math.random()}`;
  var normalize = (s) => s.toLowerCase().replace(/[\s_-]/g, "");
  function selectFont(row, available) {
    const font2 = row.font;
    const weight = font2.weight >= 850 ? "black" : font2.weight >= 750 ? "extrabold" : font2.weight >= 650 ? "bold" : font2.weight >= 550 ? "semibold" : font2.weight >= 450 ? "medium" : font2.weight >= 350 ? "regular" : font2.weight >= 250 ? "light" : "thin";
    const style = (weight === "regular" && font2.italic ? "" : weight) + (font2.italic ? "italic" : "");
    const exact = available.find((f) => normalize(f.family) === normalize(font2.family) && normalize(f.style) === style);
    const chosen = exact != null ? exact : available.find((f) => f.family === "Inter" && f.style === "Regular");
    if (!chosen) throw new Error("WEB_FONT_UNAVAILABLE: Requested font and Inter Regular fallback are unavailable; no layers created");
    return { font: chosen, substituted: !exact };
  }
  var paint2 = (color2) => ({ type: "SOLID", color: { r: color2.r, g: color2.g, b: color2.b }, opacity: color2.a });
  async function importWebSnapshot(args, getNode2) {
    var _a, _b, _c;
    const snapshot2 = webSnapshotSchema.parse(args.snapshot);
    const x = (_a = args.x) != null ? _a : 0, y = (_b = args.y) != null ? _b : 0;
    if (![x, y].every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e5) || args.dryRun !== void 0 && typeof args.dryRun !== "boolean") throw new Error("Invalid web import options");
    const parent = args.parentId ? await getNode2(args.parentId) : figma.currentPage;
    if (!["PAGE", "FRAME", "SECTION"].includes(parent.type) || "layoutMode" in parent && parent.layoutMode !== "NONE")
      throw new Error("Choose a PAGE, SECTION or frame without Auto Layout as the import destination");
    const bytes = /* @__PURE__ */ new Map();
    let totalPixels = 0;
    for (const image of snapshot2.images) {
      const data = figma.base64Decode(image.png);
      if (figma.base64Encode(data) !== image.png || data.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
        throw new Error("Expected canonical PNG image data");
      const uint = (i) => data[i] * 16777216 + data[i + 1] * 65536 + data[i + 2] * 256 + data[i + 3];
      if (String.fromCharCode(...data.slice(12, 16)) !== "IHDR" || uint(8) !== 13 || !uint(16) || !uint(20) || uint(16) > 4096 || uint(20) > 4096)
        throw new Error("PNG exceeds 4096px per side or has an invalid header");
      totalPixels += uint(16) * uint(20);
      if (totalPixels > 16777216) throw new Error("Snapshot images exceed the 16 megapixel total budget");
      bytes.set(image.ref, data);
    }
    const fonts = /* @__PURE__ */ new Map();
    const warnings = [...snapshot2.warnings];
    const textRows = snapshot2.nodes.filter((row) => row.kind === "TEXT");
    const available = textRows.length ? (await figma.listAvailableFontsAsync()).map((entry) => entry.fontName) : [];
    for (const row of textRows) {
      const selection = selectFont(row, available);
      fonts.set(row.ref, selection);
      if (selection.substituted) warnings.push({ ref: row.ref, code: "font_substituted_with_inter_regular" });
    }
    for (const row of snapshot2.nodes) if (row.kind === "IMAGE" && !row.imageRef) warnings.push({ ref: row.ref, code: "image_placeholder" });
    const revision = resourceRevision([session2, parent.id, x, y, snapshot2, [...fonts]]);
    const summary = {
      parentId: parent.id,
      nodeCount: snapshot2.nodes.length,
      textCount: textRows.length,
      imageCount: bytes.size,
      autoLayoutCandidates: snapshot2.nodes.filter((row) => row.layout).length,
      coverage: snapshot2.coverage,
      warnings,
      revision,
      fidelity: "approximate",
      visualVerification: "pending",
      note: "One editable frame at the captured size. No scripts, links, responsive rules or interactions are imported. Compare a browser screenshot with a Figma export."
    };
    if (args.dryRun !== false) return __spreadProps(__spreadValues({}, summary), { dryRun: true });
    if (!args.revision || args.revision !== revision) throw new Error("WEB_PREVIEW_CHANGED: Preview again with the same snapshot/destination before applying");
    const unique = new Map([...fonts.values()].map((item) => [JSON.stringify(item.font), item.font]));
    for (const font2 of unique.values()) await figma.loadFontAsync(font2);
    if (parent.removed || "layoutMode" in parent && parent.layoutMode !== "NONE") throw new Error("Import destination changed while fonts loaded; preview again");
    const images = /* @__PURE__ */ new Map();
    for (const [ref2, data] of bytes) images.set(ref2, figma.createImage(data));
    const created = [], nodes = /* @__PURE__ */ new Map(), rows = new Map(snapshot2.nodes.map((row) => [row.ref, row]));
    let autoLayoutCount = 0;
    try {
      for (const row of snapshot2.nodes) {
        const node = row.kind === "TEXT" ? figma.createText() : row.kind === "FRAME" ? figma.createFrame() : figma.createRectangle();
        created.push(node);
        nodes.set(row.ref, node);
        const owner = row.parentRef ? nodes.get(row.parentRef) : parent;
        owner.appendChild(node);
        node.name = row.kind === "TEXT" ? "Web text" : `Web ${row.name || row.kind}`;
        node.opacity = row.opacity;
        if (node.type === "TEXT") {
          const font2 = row.font;
          node.fontName = fonts.get(row.ref).font;
          node.fontSize = font2.size;
          node.lineHeight = font2.lineHeight === null ? { unit: "AUTO" } : { unit: "PIXELS", value: font2.lineHeight };
          node.letterSpacing = { unit: "PIXELS", value: font2.letterSpacing };
          node.textAlignHorizontal = font2.align;
          node.textAutoResize = "NONE";
          node.characters = row.text;
          node.fills = [paint2(font2.color)];
        } else {
          node.fills = row.imageRef ? [{ type: "IMAGE", imageHash: images.get(row.imageRef).hash, scaleMode: (_c = row.imageFit) != null ? _c : "FILL" }] : row.fill ? [paint2(row.fill)] : row.kind === "IMAGE" ? [paint2({ r: 0.9, g: 0.9, b: 0.9, a: 1 })] : [];
          if (row.border) {
            node.strokes = [paint2(row.border.color)];
            node.strokeWeight = row.border.width;
            node.strokeAlign = "INSIDE";
          } else node.strokes = [];
          [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = row.radii;
          if (node.type === "FRAME") {
            node.layoutMode = "NONE";
            node.clipsContent = row.clipsContent;
          }
        }
        node.resize(row.width, row.height);
        if (node.type === "TEXT" && row.textLayout === "SINGLE_LINE") {
          node.textAutoResize = "WIDTH_AND_HEIGHT";
          if (Math.abs(node.width - row.width) > 1 || Math.abs(node.height - row.height) > 1)
            warnings.push({ ref: row.ref, code: "text_metrics_adjusted" });
        }
        const origin = row.parentRef ? rows.get(row.parentRef) : null;
        node.x = origin ? row.x - origin.x : x;
        node.y = origin ? row.y - origin.y : y;
        if (node.type === "TEXT" && row.textLayout === "SINGLE_LINE") node.y -= (node.height - row.height) / 2;
      }
      for (const row of [...snapshot2.nodes].reverse()) {
        if (!row.layout) continue;
        const frame = nodes.get(row.ref), layout2 = row.layout;
        const children = snapshot2.nodes.filter((child) => child.parentRef === row.ref);
        const geometry2 = new Map(children.map((child) => {
          const n = nodes.get(child.ref);
          return [child.ref, { x: n.x, y: n.y, width: n.width, height: n.height }];
        }));
        frame.layoutMode = layout2.direction;
        frame.primaryAxisSizingMode = "FIXED";
        frame.counterAxisSizingMode = "FIXED";
        [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = layout2.padding;
        frame.itemSpacing = layout2.gap;
        frame.primaryAxisAlignItems = layout2.justify;
        frame.counterAxisAlignItems = layout2.align;
        frame.resize(row.width, row.height);
        const matches = children.every((child) => {
          const n = nodes.get(child.ref);
          return Math.abs(n.x - (child.x - row.x)) <= 1 && Math.abs(n.y - (child.y - row.y)) <= 1 && Math.abs(n.width - child.width) <= 1 && Math.abs(n.height - child.height) <= 1;
        });
        if (matches) autoLayoutCount++;
        else {
          frame.layoutMode = "NONE";
          frame.resize(row.width, row.height);
          for (const child of children) {
            const n = nodes.get(child.ref), original = geometry2.get(child.ref);
            if (n.type !== "TEXT" || child.textLayout !== "SINGLE_LINE") n.resize(original.width, original.height);
            n.x = original.x;
            n.y = original.y;
          }
          warnings.push({ ref: row.ref, code: "auto_layout_fallback_to_coordinates" });
        }
      }
      figma.commitUndo();
      return __spreadProps(__spreadValues({}, summary), {
        dryRun: false,
        rootId: created[0].id,
        autoLayoutCount,
        nodes: snapshot2.nodes.map((row) => ({ ref: row.ref, id: nodes.get(row.ref).id, kind: row.kind })),
        warnings
      });
    } catch (error) {
      const failed = [];
      for (const node of [...created].reverse()) try {
        if (!node.removed) node.remove();
      } catch (e) {
        failed.push(node.id);
      }
      throw new Error(`WEB_IMPORT_FAILED: ${error instanceof Error ? error.message : String(error)}. ${failed.length ? `Cleanup incomplete: ${failed.join(", ")}` : "New layers removed; existing layers preserved."} Imported image bytes may remain unreferenced in Figma.`);
    }
  }

  // plugin/design-context.ts
  var contextProperties = [
    ...node_properties_default.filter((key) => !["characters", "componentProperties", "componentPropertyDefinitions", "variantProperties"].includes(key)),
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "layoutPositioning",
    "layoutWrap",
    "counterAxisSpacing",
    "strokeAlign",
    "topLeftRadius",
    "topRightRadius",
    "bottomLeftRadius",
    "bottomRightRadius",
    "fillStyleId",
    "strokeStyleId",
    "effectStyleId",
    "isMask"
  ];
  function integer2(value, fallback, min, max) {
    const result2 = value != null ? value : fallback;
    if (!Number.isInteger(result2) || result2 < min || result2 > max) throw new Error("Invalid design context bounds");
    return result2;
  }
  function* walk(root, maxDepth) {
    yield { node: root, depth: 0 };
    const stack = [];
    if (maxDepth > 0 && "children" in root) stack.push({ iterator: root.children[Symbol.iterator](), depth: 1 });
    while (stack.length) {
      const frame = stack[stack.length - 1], next = frame.iterator.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      const node = next.value;
      yield { node, depth: frame.depth };
      if (frame.depth < maxDepth && "children" in node) stack.push({ iterator: node.children[Symbol.iterator](), depth: frame.depth + 1 });
    }
  }
  function references(value) {
    const stack = [value], images = /* @__PURE__ */ new Set(), variables = /* @__PURE__ */ new Set();
    let visited = 0;
    while (stack.length && visited++ < 1e4 && images.size < 100 && variables.size < 100) {
      const item = stack.pop();
      if (!item || typeof item !== "object") continue;
      if ("type" in item && item.type === "IMAGE" && "imageHash" in item && typeof item.imageHash === "string") images.add(item.imageHash);
      if ("type" in item && item.type === "VARIABLE_ALIAS" && "id" in item && typeof item.id === "string") variables.add(item.id);
      const values = Object.values(item);
      if (stack.length + values.length > 1e4) return { imageHashes: [...images], variableIds: [...variables], complete: false };
      stack.push(...values);
    }
    return { imageHashes: [...images], variableIds: [...variables], complete: stack.length === 0 };
  }
  async function getDesignContext(root, args) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    const depth = integer2(args.depth, 2, 0, 6), maxNodes = integer2(args.maxNodes, 50, 1, 200);
    const offset = integer2(args.offset, 0, 0, 9999);
    const maxBytes = integer2(args.maxResponseBytes, response_limits_default.defaultReadBytes, response_limits_default.minReadBytes, response_limits_default.maxReadBytes);
    for (const key of ["includeText", "includeComponents", "includeVariables", "includeCSS", "includePreview"])
      if (args[key] !== void 0 && typeof args[key] !== "boolean") throw new Error(`Invalid ${key}`);
    const options = {
      text: (_a = args.includeText) != null ? _a : true,
      components: (_b = args.includeComponents) != null ? _b : true,
      variables: (_c = args.includeVariables) != null ? _c : true,
      css: (_d = args.includeCSS) != null ? _d : false,
      preview: (_e = args.includePreview) != null ? _e : true
    };
    const result2 = {
      rootId: root.id,
      consistency: "live_non_atomic",
      options,
      nodes: [],
      coverage: { offset, returned: 0, nextOffset: null, treeComplete: true, detailsComplete: true },
      preview: { status: options.preview ? offset ? "not_requested_on_continuation" : "pending" : "not_requested" }
    };
    const previewBudget = options.preview && offset === 0 ? Math.min(1024 * 1024, Math.floor(maxBytes / 4)) : 0;
    let remaining = maxBytes - jsonBytes(result2) - 512 - previewBudget;
    const lookupVariable = variableResolver();
    const variableCache = /* @__PURE__ */ new Map();
    const resolveVariable = (id2, localOnly = false) => {
      const key = `${localOnly ? "local" : "any"}:${id2}`;
      let pending = variableCache.get(key);
      if (!pending) {
        pending = lookupVariable(id2, localOnly);
        variableCache.set(key, pending);
      }
      return pending;
    };
    let index = 0;
    for (const { node, depth: level } of walk(root, depth)) {
      if (index >= 1e4) {
        result2.coverage.treeComplete = false;
        result2.coverage.reason = "traversal_limit";
        break;
      }
      const childCount = "children" in node ? node.children.length : 0;
      if (childCount && level === depth) result2.coverage.treeComplete = false;
      if (index++ < offset) continue;
      if (result2.nodes.length >= maxNodes || remaining < 2048) {
        result2.coverage.nextOffset = index - 1;
        result2.coverage.treeComplete = false;
        result2.coverage.reason = remaining < 2048 ? "byte_limit" : "node_limit";
        break;
      }
      const row = {
        id: node.id,
        type: node.type,
        name: node.name.slice(0, 120),
        parentId: (_f = node.parent) == null ? void 0 : _f.id,
        index: index - 1,
        depth: level,
        childCount,
        properties: {},
        omittedProperties: [],
        unavailableProperties: [],
        details: {}
      };
      if (node.name.length > 120) row.nameTruncated = true;
      if (childCount && level === depth) row.childrenOutsideDepth = true;
      const rowLimit = Math.min(65536, remaining);
      let available = rowLimit - jsonBytes(row) - 1536;
      let propertyBytes = 0;
      for (const key of contextProperties) {
        if (!(key in node)) continue;
        try {
          const value = clean(node[key]);
          const size3 = jsonBytes({ [key]: value }) + 4;
          if (size3 > available || propertyBytes + size3 > rowLimit / 3) row.omittedProperties.push(key);
          else {
            row.properties[key] = value;
            available -= size3;
            propertyBytes += size3;
          }
        } catch (e) {
          row.unavailableProperties.push(key);
        }
      }
      async function detail(key, enabled, applicable, read2) {
        let entry;
        if (!enabled) entry = { status: "not_requested" };
        else if (!applicable) entry = { status: "not_applicable" };
        else if (available < response_limits_default.minReadBytes) entry = { status: "byte_limit" };
        else {
          try {
            const value = await read2(Math.min(16384, available));
            if (jsonBytes(value) + 64 > available) entry = { status: "byte_limit" };
            else entry = { status: value.complete === false ? "partial" : "available", data: value };
          } catch (e) {
            entry = { status: "unavailable" };
          }
        }
        available -= jsonBytes(entry) + key.length + 8;
        row.details[key] = entry;
        if (["partial", "unavailable", "byte_limit"].includes(entry.status)) result2.coverage.detailsComplete = false;
      }
      await detail("text", options.text, node.type === "TEXT", (bytes) => readDesignDetails(
        "get_text_runs",
        { maxCharacters: 2e3, maxRuns: 50, maxResponseBytes: bytes },
        node
      ));
      await detail("component", options.components, ["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(node.type), (bytes) => readDesignDetails("get_component_details", { maxResponseBytes: bytes }, node));
      await detail("variables", options.variables, true, (bytes) => readDesignDetails(
        "get_bound_variables",
        { maxResponseBytes: bytes, limit: 50 },
        node,
        { resolveVariable }
      ));
      const textRefs = references((_g = row.details.text.data) == null ? void 0 : _g.runs);
      await detail("textVariables", options.variables && options.text, textRefs.variableIds.length > 0, (bytes) => readDesignDetails("get_bound_variables", { maxResponseBytes: bytes, variableIds: textRefs.variableIds, limit: 100 }, node, { resolveVariable }));
      if (!textRefs.complete) {
        row.textReferencesTruncated = true;
        result2.coverage.detailsComplete = false;
      }
      await detail("css", options.css, true, async () => ({ properties: clean(await node.getCSSAsync()) }));
      const assets = references([row.properties.fills, row.properties.strokes, (_h = row.details.text.data) == null ? void 0 : _h.runs]);
      const missingPaints = [...row.omittedProperties, ...row.unavailableProperties].some((key) => ["fills", "strokes"].includes(key));
      const missingTextPaints = node.type === "TEXT" && ((_i = row.properties.fills) == null ? void 0 : _i.mixed) && !((_j = row.details.text.data) == null ? void 0 : _j.complete);
      const assetInfo = {
        imageHashes: assets.imageHashes,
        complete: assets.complete && !missingPaints && !missingTextPaints,
        scope: "returned_properties_and_text_runs",
        exportNodeId: node.id
      };
      if (jsonBytes(assetInfo) + 32 <= available) row.assets = assetInfo;
      else row.assets = { complete: false, reason: "byte_limit" };
      if (!row.assets.complete || row.omittedProperties.length || row.unavailableProperties.length) result2.coverage.detailsComplete = false;
      let size2 = jsonBytes(row) + 1;
      if (size2 > remaining) {
        result2.coverage.nextOffset = index - 1;
        result2.coverage.treeComplete = false;
        result2.coverage.reason = "byte_limit";
        break;
      }
      result2.nodes.push(row);
      remaining -= size2;
    }
    result2.coverage.returned = result2.nodes.length;
    if (!result2.coverage.treeComplete && result2.coverage.reason === void 0) result2.coverage.reason = "depth_limit";
    if (offset > 0 && !result2.nodes.length && result2.coverage.reason === void 0) {
      result2.coverage.treeComplete = false;
      result2.coverage.reason = "offset_past_end";
    }
    if (result2.coverage.nextOffset === offset) result2.coverage.blocked = true;
    if (options.preview && offset === 0) {
      try {
        const bounds = (_k = "absoluteRenderBounds" in root ? root.absoluteRenderBounds : null) != null ? _k : root.absoluteBoundingBox;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !("exportAsync" in root)) result2.preview = { status: "unavailable" };
        else {
          const scale = Math.min(1, 1600 / Math.max(bounds.width, bounds.height));
          const bytes = await root.exportAsync({ format: "PNG", contentsOnly: true, constraint: { type: "SCALE", value: scale } });
          if (!bytes.length || Math.ceil(bytes.length / 3) * 4 + 256 > previewBudget) result2.preview = { status: "byte_limit", recovery: "Use export_node for a separate preview" };
          else result2.preview = { status: "available", data: figma.base64Encode(bytes), mimeType: "image/png", scale, byteLength: bytes.length };
        }
      } catch (e) {
        result2.preview = { status: "unavailable", recovery: "Use export_node for a separate preview" };
      }
    }
    result2.coverage.complete = result2.coverage.treeComplete && result2.coverage.detailsComplete && (!options.preview || offset > 0 || result2.preview.status === "available");
    return result2;
  }

  // plugin/libraries-themes.ts
  var themeSession = `${Date.now()}-${Math.random()}`;
  function failureMessage(error, fallback) {
    return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message.slice(0, 500) : fallback;
  }
  var libraryThemeCommands = /* @__PURE__ */ new Set(["get_library_variables", "import_library_asset", "get_variable_modes", "set_variable_mode", "create_variable_mode"]);
  function id(value) {
    if (typeof value !== "string" || !value.length || value.length > 200) throw new Error("Expected an ID or key of 1\u2013200 characters");
  }
  function modeSummary(collection) {
    return {
      id: collection.id,
      key: collection.key,
      name: collection.name.slice(0, 500),
      remote: collection.remote,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name.slice(0, 500) }))
    };
  }
  async function getCollection(collectionId) {
    var _a;
    id(collectionId);
    const local = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = (_a = local.find((item) => item.id === collectionId)) != null ? _a : await figma.variables.getVariableCollectionByIdAsync(collectionId);
    if (!collection) throw new Error("Variable collection not found; read local design system or import a library variable first");
    return collection;
  }
  function preview(args, revision) {
    if (args.dryRun !== void 0 && typeof args.dryRun !== "boolean") throw new Error("Invalid dryRun");
    if (args.dryRun !== false) return true;
    if (!args.revision || args.revision !== revision) throw new Error("THEME_CHANGED: Preview again and pass its revision before applying");
    return false;
  }
  async function libraries(args) {
    var _a, _b, _c, _d;
    const offset = (_a = args.offset) != null ? _a : 0, limit = (_b = args.limit) != null ? _b : 100, maxBytes = (_c = args.maxResponseBytes) != null ? _c : response_limits_default.defaultReadBytes;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1e6 || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(maxBytes) || maxBytes < response_limits_default.minReadBytes || maxBytes > response_limits_default.maxReadBytes) throw new Error("Invalid library read bounds");
    if (args.collectionKey !== void 0) id(args.collectionKey);
    let entries;
    try {
      entries = args.collectionKey === void 0 ? (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName })) : (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(args.collectionKey)).map((v) => ({ key: v.key, name: v.name, resolvedType: v.resolvedType }));
    } catch (error) {
      const cause = failureMessage(error, "Figma library API failed").replace(/(?:https?|wss?):\/\/[^\s]+/gi, "[url]").replace(/\b(?:token|authorization|password)\s*[:=]\s*\S+/gi, "[secret]").replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ");
      throw new Error(`LIBRARY_ACCESS_FAILED: ${cause}. Check Figma access, connectivity, enabled libraries and the plugin manifest teamlibrary permission. If the permission was added recently, re-import the generated manifest. No assets were imported.`);
    }
    entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const revision = resourceRevision([(_d = args.collectionKey) != null ? _d : null, entries]);
    if (offset > 0 && !args.revision || args.revision && args.revision !== revision)
      throw new Error("LIBRARIES_CHANGED: Restart at offset 0 without revision; continue with the returned revision");
    if (offset > entries.length) throw new Error("Library offset exceeds current list");
    const items = [];
    let bytes = 0, next = offset;
    for (; next < entries.length && items.length < limit; next++) {
      const size2 = jsonBytes(entries[next]) + 1;
      if (bytes + size2 > maxBytes - 2048) break;
      items.push(entries[next]);
      bytes += size2;
    }
    return __spreadValues({
      kind: args.collectionKey === void 0 ? "collections" : "variables",
      collectionKey: args.collectionKey,
      revision,
      items,
      offset,
      total: entries.length,
      nextOffset: next < entries.length ? next : null,
      complete: next === entries.length
    }, next === offset && next < entries.length ? {
      blocked: true,
      reason: "byte_limit",
      recovery: "Increase maxResponseBytes; do not repeat identical bounds."
    } : {});
  }
  async function executeLibraryTheme(command, args, getNode2) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (command === "get_library_variables") return libraries(args);
    if (command === "import_library_asset") {
      id(args.key);
      let asset;
      try {
        if (args.kind === "component") asset = await figma.importComponentByKeyAsync(args.key);
        else if (args.kind === "componentSet") asset = await figma.importComponentSetByKeyAsync(args.key);
        else if (args.kind === "variable") asset = await figma.variables.importVariableByKeyAsync(args.key);
        else throw new Error("Unsupported library asset kind");
      } catch (error) {
        throw new Error(`LIBRARY_IMPORT_FAILED: ${failureMessage(error, "Figma import failed")}. Inspect the file before retrying an uncertain import; no local imitation was created.`);
      }
      figma.commitUndo();
      return __spreadProps(__spreadValues({
        kind: args.kind,
        id: asset.id,
        key: asset.key,
        name: asset.name.slice(0, 500),
        remote: asset.remote
      }, "variableCollectionId" in asset ? { collectionId: asset.variableCollectionId, resolvedType: asset.resolvedType } : { type: asset.type }), {
        note: "Imported reference only; no instance created and no layer bound. Inspect returned IDs before using them."
      });
    }
    const collection = await getCollection(args.collectionId);
    if (command === "create_variable_mode") {
      if (collection.remote || collection.isExtension) throw new Error("Modes can only be created on a local, non-extended collection");
      if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 100) throw new Error("Mode name must be 1\u2013100 characters");
      const name = args.name.trim();
      if (collection.modes.some((mode) => mode.name === name)) throw new Error("A mode with this name already exists; reuse its modeId");
      const sourceModeId = (_a = args.sourceModeId) != null ? _a : collection.defaultModeId;
      if (!collection.modes.some((mode) => mode.modeId === sourceModeId)) throw new Error("Source mode does not belong to this collection");
      if (collection.variableIds.length > 1e3) throw new Error("Mode copy supports at most 1000 variables; use Figma for this collection");
      const variables = (await figma.variables.getLocalVariablesAsync()).filter((v) => v.variableCollectionId === collection.id).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const variableIds = new Set(variables.map((v) => v.id));
      if (variables.length !== collection.variableIds.length || collection.variableIds.some((id2) => !variableIds.has(id2)))
        throw new Error("Collection variables changed or are unavailable; preview again");
      const values = variables.map((variable) => {
        const value = variable.valuesByMode[sourceModeId];
        if (value === void 0) throw new Error("Source mode contains an unavailable value; no mode created");
        return { id: variable.id, value };
      });
      if (jsonBytes(values) > 1024 * 1024) throw new Error("Source mode exceeds the 1 MiB copy budget");
      const revision2 = resourceRevision([themeSession, collection.id, collection.modes, name, sourceModeId, values]);
      const info2 = {
        collectionId: collection.id,
        name,
        sourceModeId,
        variableCount: values.length,
        revision: revision2,
        note: "Copies source values and aliases; does not change the default mode or switch layers. Figma enforces plan limits on apply."
      };
      if (preview(args, revision2)) return __spreadProps(__spreadValues({}, info2), { dryRun: true });
      let modeId;
      try {
        modeId = collection.addMode(name);
        for (let i = 0; i < variables.length; i++) variables[i].setValueForMode(modeId, values[i].value);
        figma.commitUndo();
        return __spreadProps(__spreadValues({}, info2), { dryRun: false, modeId });
      } catch (error) {
        let cleanup = "No new mode created.";
        if (modeId) {
          try {
            collection.removeMode(modeId);
            cleanup = "New mode removed; original modes preserved.";
          } catch (e) {
            cleanup = `Cleanup incomplete for mode ${modeId}; inspect the collection before further edits.`;
          }
        }
        throw new Error(`MODE_CREATE_FAILED: ${failureMessage(error, "Figma rejected the mode")}. ${cleanup}`);
      }
    }
    if (!["get_variable_modes", "set_variable_mode"].includes(command)) throw new Error("Unknown library/theme command");
    const node = args.nodeId ? await getNode2(args.nodeId) : void 0;
    if (node && !("explicitVariableModes" in node)) throw new Error("Node does not support variable modes");
    const target = node;
    const state2 = target ? {
      nodeId: target.id,
      explicitModeId: (_b = target.explicitVariableModes[collection.id]) != null ? _b : null,
      resolvedModeId: (_d = (_c = target.resolvedVariableModes) == null ? void 0 : _c[collection.id]) != null ? _d : null
    } : void 0;
    if (command === "get_variable_modes") return { collection: modeSummary(collection), node: state2 };
    if (!target || !state2) throw new Error("set_variable_mode requires nodeId");
    if (args.modeId !== null && !collection.modes.some((mode) => mode.modeId === args.modeId)) throw new Error("Mode does not belong to this collection; use null to clear the override");
    const revision = resourceRevision([themeSession, collection.id, collection.modes, state2, args.modeId]);
    const info = __spreadProps(__spreadValues({
      collectionId: collection.id
    }, state2), {
      targetModeId: args.modeId,
      revision,
      note: "Changes only this node override; descendants without their own override inherit it. Token definitions stay unchanged."
    });
    if (preview(args, revision)) return __spreadProps(__spreadValues({}, info), { dryRun: true });
    if (state2.explicitModeId === args.modeId) return __spreadProps(__spreadValues({}, info), { dryRun: false, changed: false });
    try {
      if (args.modeId === null) target.clearExplicitVariableModeForCollection(collection);
      else target.setExplicitVariableModeForCollection(collection, args.modeId);
      if (((_e = target.explicitVariableModes[collection.id]) != null ? _e : null) !== args.modeId) throw new Error("Figma did not retain the requested override");
      figma.commitUndo();
    } catch (error) {
      let restored = true;
      try {
        if (state2.explicitModeId === null) target.clearExplicitVariableModeForCollection(collection);
        else target.setExplicitVariableModeForCollection(collection, state2.explicitModeId);
      } catch (e) {
        restored = false;
      }
      throw new Error(`MODE_SET_FAILED: ${failureMessage(error, "Figma rejected the mode")}. ${restored ? "Original override restored." : "Restore failed; inspect the node."}`);
    }
    return __spreadProps(__spreadValues({}, info), {
      dryRun: false,
      changed: true,
      explicitModeId: (_f = target.explicitVariableModes[collection.id]) != null ? _f : null,
      resolvedModeId: (_h = (_g = target.resolvedVariableModes) == null ? void 0 : _g[collection.id]) != null ? _h : null
    });
  }

  // plugin/code.ts
  async function getNode(id2) {
    const node = await figma.getNodeByIdAsync(id2);
    if (!node || node.removed) throw new Error(`Node not found: ${id2}`);
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
  function paint3(hex) {
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
    const id2 = `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        imageDecodeRequests.delete(id2);
        reject(new Error("Image normalization timed out in the Figma plugin UI"));
      }, 3e4);
      imageDecodeRequests.set(id2, { resolve, reject, timer });
      figma.ui.postMessage({ type: "decode-image", id: id2, base64, mimeType: mimeType != null ? mimeType : "application/octet-stream" });
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
    if (props.fill !== void 0) paint3(props.fill);
    if (props.stroke !== void 0) paint3(props.stroke);
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
      const unique = new Map(fonts.map((font2) => [JSON.stringify(font2), font2]));
      for (const font2 of unique.values()) await figma.loadFontAsync(font2);
    }
    beforeMutation();
    if (textStyle && node.type === "TEXT") await node.setTextStyleIdAsync(textStyle.id);
    if (props.fontName) target.fontName = props.fontName;
    if (props.layoutMode !== void 0) target.layoutMode = props.layoutMode;
    for (const [key, value] of Object.entries(props)) {
      if (["width", "height", "fontName", "textAutoResize", "layoutMode", "x", "y", "locked", ...special].includes(key)) continue;
      if (key === "fill") target.fills = paint3(value);
      else if (key === "stroke") target.strokes = paint3(value);
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
    if (props.textAutoResize !== void 0) target.textAutoResize = props.textAutoResize;
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
    var _a, _b, _c, _d, _e;
    if (command === "import_web_snapshot") return importWebSnapshot(args, getNode);
    if (libraryThemeCommands.has(command)) return executeLibraryTheme(command, args, getNode);
    if (command === "get_design_context") return getDesignContext(requireScene(await getNode(args.nodeId)), args);
    if (command === "export_asset") return exportAsset(args, getNode);
    if (readCommands.has(command)) return executeNodeRead(command, args, { getNode, requireScene });
    if (designReadCommands.has(command)) return readDesignDetails(command, args, requireScene(await getNode(args.nodeId)));
    if (extendedCommands.has(command)) return executeExtended(command, args, { getNode });
    if (designCommands.has(command)) return executeDesignCommand(command, args, { getNode, applyProps, createNode });
    switch (command) {
      case "preview_design_fixes":
        return previewDesignFixes(args, getNode);
      case "preview_changes":
        return previewChanges(args, getNode);
      case "preview_audit_fixes":
        return previewAuditFixes(args, getNode);
      case "apply_changes":
        return applyChanges(args, getNode);
      case "audit_design":
        return auditDesign(await getNode(args.nodeId), args);
      case "create_node": {
        const node = await createNode(args);
        figma.commitUndo();
        return summarize(node, 0, { left: 1 });
      }
      case "update_node": {
        const node = requireScene(await getNode(args.nodeId));
        const target = node;
        const rollbackFields = ["name", "x", "y", "width", "height", "rotation", "opacity", "visible", "locked", "fill", "stroke", "strokeWeight", "cornerRadius"];
        const canRestore = ["RECTANGLE", "ELLIPSE"].includes(node.type) && Object.keys(args.props).every((k) => rollbackFields.includes(k)) && !Object.keys((_a = target.boundVariables) != null ? _a : {}).length && !target.fillStyleId && !target.strokeStyleId && !(((_b = node.parent) == null ? void 0 : _b.layoutMode) && node.parent.layoutMode !== "NONE");
        const snapshot2 = canRestore ? {
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
          if (snapshot2) {
            try {
              target.resize(snapshot2.width, snapshot2.height);
              for (const [key, value] of Object.entries(snapshot2)) if (!["width", "height"].includes(key) && value !== void 0) target[key] = value;
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
        if (args.background !== void 0) page.backgrounds = paint3(args.background);
        figma.commitUndo();
        return { id: page.id, name: page.name, backgrounds: clean(page.backgrounds) };
      }
      case "reparent_nodes": {
        const parent = requireContainer(await getNode(args.parentId));
        const nodes = [];
        const seen = /* @__PURE__ */ new Set();
        for (const id2 of args.nodeIds) {
          if (seen.has(id2)) throw new Error(`Duplicate node id: ${id2}`);
          const node = requireScene(await getNode(id2));
          if (node.id === parent.id) throw new Error("A node cannot be its own parent");
          seen.add(id2);
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
        for (const node of nodes) {
          let ancestor2 = node.parent;
          while (ancestor2) {
            if (seen.has(ancestor2.id)) throw new Error("Cannot move a node and its ancestor in the same operation");
            ancestor2 = ancestor2.parent;
          }
        }
        const positions = args.preserveAbsolutePosition === false ? [] : nodes.map((node) => ({ node, world: worldTransform(node) }));
        for (const item of positions) localTransform(parent, item.world);
        let insertIndex;
        try {
          insertIndex = placeNodes(parent, nodes, args.insertIndex);
          for (const item of positions) item.node.relativeTransform = localTransform(parent, item.world);
          for (const item of positions) verifyWorldTransform(item.node, item.world);
        } catch (error) {
          figma.commitUndo();
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Some layers may have moved; inspect or use Figma Undo.`);
        }
        figma.commitUndo();
        return { parentId: parent.id, moved: nodes.map((node) => node.id), insertIndex, preservedAbsolutePosition: args.preserveAbsolutePosition !== false };
      }
      case "reorder_nodes": {
        const parent = requireContainer(await getNode(args.parentId));
        const selected = /* @__PURE__ */ new Set();
        const nodes = [];
        for (const id2 of args.nodeIds) {
          if (selected.has(id2)) throw new Error(`Duplicate node id: ${id2}`);
          const node = requireScene(await getNode(id2));
          if (((_c = node.parent) == null ? void 0 : _c.id) !== parent.id) throw new Error("Every node must be a direct child of parentId");
          selected.add(id2);
          nodes.push(node);
        }
        let index;
        try {
          index = placeNodes(parent, nodes, args.index);
        } catch (error) {
          figma.commitUndo();
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Some layers may have moved; inspect or use Figma Undo.`);
        }
        figma.commitUndo();
        return { parentId: parent.id, nodeIds: nodes.map((node) => node.id), index };
      }
      case "set_image_fill": {
        const node = requireScene(await getNode(args.nodeId));
        if (!("fills" in node)) throw new Error(`fills is not supported on ${node.type}`);
        const { image, normalized } = await createFigmaImage(args.base64, args.sourceMimeType);
        node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: (_d = args.scaleMode) != null ? _d : "FILL" }];
        figma.commitUndo();
        return { nodeId: node.id, imageHash: image.hash, normalized, scaleMode: (_e = args.scaleMode) != null ? _e : "FILL" };
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
        for (const id2 of args.nodeIds) nodes.push(requireScene(await getNode(id2)));
        const page = nodes.length ? pageOf2(nodes[0]) : figma.currentPage;
        if (nodes.some((node) => pageOf2(node).id !== page.id)) throw new Error("All selected nodes must belong to the same page");
        await figma.setCurrentPageAsync(page);
        page.selection = nodes;
        if (args.focus && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
        return { selected: nodes.map((n) => n.id) };
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
  figma.showUI(__html__, __spreadProps(__spreadValues({}, initialWindowSize), { themeColors: true }));
  var presentation = createPresentation();
  var busy = false;
  function publishDocument() {
    figma.ui.postMessage({ type: "document", document: {
      name: figma.root.name,
      page: figma.currentPage.name,
      pluginVersion: "0.7.38",
      capabilities: getCapabilities()
    } });
  }
  figma.on("currentpagechange", publishDocument);
  var findingTargets = /* @__PURE__ */ new Set();
  figma.ui.onmessage = async (message) => {
    var _a, _b, _c, _d, _e;
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
      await presentation.initialize();
      return;
    }
    if ((message == null ? void 0 : message.type) === "presentation-mode") {
      presentation.setMode(message.compact);
      return;
    }
    if ((message == null ? void 0 : message.type) === "presentation-move") {
      presentation.move(message.edge);
      return;
    }
    if ((message == null ? void 0 : message.type) === "focus-finding") {
      if (busy) {
        figma.ui.postMessage({ type: "focus-result", error: "\u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438." });
        return;
      }
      if (!findingTargets.has(message.nodeId)) {
        figma.ui.postMessage({ type: "focus-result", error: "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0430\u0443\u0434\u0438\u0442: \u0441\u043B\u043E\u044F \u043D\u0435\u0442 \u0432 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u043C \u043E\u0442\u0447\u0451\u0442\u0435." });
        return;
      }
      busy = true;
      try {
        const node = await getNode(message.nodeId);
        const page = pageOf2(node);
        await figma.setCurrentPageAsync(page);
        if (node.type !== "PAGE") page.selection = [requireScene(node)];
        figma.viewport.scrollAndZoomIntoView([node]);
        figma.ui.postMessage({ type: "focus-result" });
      } catch (e) {
        figma.ui.postMessage({ type: "focus-result", error: "\u0421\u043B\u043E\u0439 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0430\u0443\u0434\u0438\u0442." });
      } finally {
        busy = false;
      }
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
      if (["audit_design", "preview_audit_fixes", "preview_design_fixes"].includes(message.command)) {
        findingTargets.clear();
        for (const finding of ((_c = (_b = result2.findings) != null ? _b : result2.skipped) != null ? _c : []).slice(0, 500))
          if (typeof finding.nodeId === "string") findingTargets.add(finding.nodeId);
      }
      const response = { type: "result", id: message.id, result: result2 };
      const responseLimit = ["get_node", "get_selection", "get_design_context"].includes(message.command) || designReadCommands.has(message.command) ? Math.min((_e = (_d = message.args) == null ? void 0 : _d.maxResponseBytes) != null ? _e : DEFAULT_READ_BYTES, MAX_RESULT_BYTES) : MAX_RESULT_BYTES;
      if (jsonBytes(response) > responseLimit) throw new Error("RESPONSE_TOO_LARGE: Read a smaller range or fewer fields. A write may already have completed; inspect the file before retrying.");
      figma.ui.postMessage(response);
    } catch (error) {
      figma.ui.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
      publishDocument();
    }
  };
})();
