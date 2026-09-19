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
  function resourceRevision(value) {
    const text = JSON.stringify(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  }
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

  // plugin/design-review.ts
  async function resolveDesignRules(rules) {
    var _a, _b, _c;
    const variables = [], styles = [], components = [];
    for (const id of (_a = rules.colorVariableIds) != null ? _a : []) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v || v.resolvedType !== "COLOR") throw new Error(`Expected a COLOR variable: ${id}`);
      variables.push(v);
    }
    for (const id of (_b = rules.textStyleIds) != null ? _b : []) {
      const style = await figma.getStyleByIdAsync(id);
      if (!style || style.type !== "TEXT") throw new Error(`Expected a text style: ${id}`);
      styles.push(style);
    }
    for (const id of (_c = rules.componentIds) != null ? _c : []) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || !["COMPONENT", "COMPONENT_SET"].includes(node.type)) throw new Error(`Expected a component or set: ${id}`);
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
  function paintMatches(paint3, color) {
    var _a;
    return (paint3 == null ? void 0 : paint3.type) === "SOLID" && Math.abs(((_a = paint3.opacity) != null ? _a : 1) - color.a) < 1e-6 && ["r", "g", "b"].every((k) => Math.abs(paint3.color[k] - color[k]) < 1e-6);
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
      for (const [index, paint3] of paints.entries()) {
        if (paint3.visible === false || paint3.type !== "SOLID") continue;
        const id = (_c = (_b = paint3.boundVariables) == null ? void 0 : _b.color) == null ? void 0 : _c.id;
        if (id && rules.colorVariableIds.includes(id)) continue;
        findings.push({
          code: id ? "COLOR_VARIABLE_OUTSIDE_SYSTEM" : "UNBOUND_COLOR",
          message: id ? "Color is bound to a variable outside the supplied project system." : "Solid color has no project variable binding.",
          evidence: {
            field,
            paintIndex: index,
            variableId: id != null ? id : null,
            candidateVariableIds: resources.variables.filter((v) => paintMatches(paint3, variableColor(v, node))).map((v) => v.id)
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
    const color = variableColor(variable, node), paints = node[edit.property === "fillVariableId" ? "fills" : "strokes"];
    if (JSON.stringify(color) !== edit.signature || !Array.isArray(paints) || paints.length !== 1 || !paintMatches(paints[0], color))
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
          if (!node.effects.some((effect) => effect.visible !== false) && !node.strokes.some((paint3) => paint3.visible !== false) && rendered && box && (rendered.x < box.x - tolerance || rendered.y < box.y - tolerance || rendered.x + rendered.width > box.x + box.width + tolerance || rendered.y + rendered.height > box.y + box.height + tolerance)) {
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
    const layout = isLayoutEdit(node, props);
    if (layout) predictLayout(node, props);
    if (node.type === "TEXT" && "height" in props) textHeightProposal(node, props.height);
    const impactful = Object.keys(props).some((key) => key !== "name" && key !== "locked");
    const sizingOnly = layout && Object.keys(props).every((k) => layoutProperties.has(k) || ["name", "locked"].includes(k)) || node.type === "TEXT" && "height" in props && Object.keys(props).every((k) => ["height", "name", "locked"].includes(k));
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
      if (impactful && (current.type === "GROUP" || current.layoutMode && current.layoutMode !== "NONE" && !(layout && current === node)))
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
      const normalize = (value) => value.type === "SOLID" ? __spreadValues({ opacity: 1, visible: true, blendMode: "NORMAL", boundVariables: {} }, value) : value;
      a = normalize(a);
      b = normalize(b);
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
    for (const [id, plan] of plans2) if (plan.expiresAt <= Date.now()) plans2.delete(id);
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
      const layout = prediction ? { nodeId: node.id, frame: prediction.frame, children: prediction.children } : void 0;
      targets.push({ nodeId: node.id, snapshot: snapshot(node, effectiveProps), changes, layout, design });
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
    if (args.changeIds.some((id) => !allChanges.some((change) => change.id === id))) throw new Error("Unknown change ID. Use IDs from this plan.");
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
      for (const font of fonts) await figma.loadFontAsync(font);
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
    for (const id of args.nodeIds) {
      try {
        resolved.push(await getNode2(id));
      } catch (e) {
        skipped.push({ nodeId: id, reason: "Layer is unavailable." });
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
    for (const id of args.nodeIds) {
      try {
        resolved.push(await getNode2(id));
      } catch (e) {
        skipped.push({ nodeId: id, reason: "Layer is unavailable; rerun the audit." });
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
      const size = value ? sizes.compact : sizes.expanded;
      try {
        figma.ui.resize(size.width, size.height);
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
        const size = compact ? sizes.compact : sizes.expanded;
        const inset = 12 / zoom;
        const x = edge === "left" ? bounds.x + inset : Math.max(bounds.x + inset, bounds.x + bounds.width - size.width / zoom - inset);
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
  function summarize(node, depth, budget, childOffset = 0) {
    var _a, _b, _c, _d;
    budget.left--;
    (_a = budget.bytes) != null ? _a : budget.bytes = DEFAULT_READ_BYTES;
    const result2 = { id: node.id, type: node.type, name: node.name.slice(0, 500), parentId: (_b = node.parent) == null ? void 0 : _b.id };
    if (node.name.length > 500) result2.nameTruncated = true;
    budget.bytes -= jsonBytes(result2) + 1024;
    const source = node;
    const omitted = [];
    for (const key of (_c = budget.fields) != null ? _c : node_properties_default) {
      if (key === "componentPropertyDefinitions" && node.type === "COMPONENT" && ((_d = node.parent) == null ? void 0 : _d.type) === "COMPONENT_SET") continue;
      if (!(key in node)) continue;
      let value = source[key];
      if (key === "characters" && typeof value === "string" && value.length > 1e4) {
        result2.characterCount = value.length;
        result2.charactersTruncated = true;
        value = value.slice(0, 1e4);
      }
      value = clean(value);
      const size = jsonBytes({ [key]: value });
      if (size > budget.bytes) {
        omitted.push(key);
        continue;
      }
      result2[key] = value;
      budget.bytes -= size;
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
        while (next < children.length && budget.left > 0 && budget.bytes >= 2048) {
          result2.children.push(summarize(children[next++], depth - 1, budget));
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
    const budget = { left: (_b = args.maxNodes) != null ? _b : 200, bytes: ((_c = args.maxResponseBytes) != null ? _c : DEFAULT_READ_BYTES) - 256, fields: args.fields };
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
          if (budget.left <= 0 || budget.bytes < 2048) break;
          nodes.push(summarize(node, args.depth, budget));
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
        return summarize(await getNode2(args.nodeId), args.depth, budget, (_e = args.childOffset) != null ? _e : 0);
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

  // plugin/code.ts
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
  function paint2(hex) {
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
    if (props.fill !== void 0) paint2(props.fill);
    if (props.stroke !== void 0) paint2(props.stroke);
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
      if (key === "fill") target.fills = paint2(value);
      else if (key === "stroke") target.strokes = paint2(value);
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
    var _a, _b, _c, _d, _e;
    if (readCommands.has(command)) return executeNodeRead(command, args, { getNode, requireScene });
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
        if (args.background !== void 0) page.backgrounds = paint2(args.background);
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
        for (const id of args.nodeIds) {
          if (selected.has(id)) throw new Error(`Duplicate node id: ${id}`);
          const node = requireScene(await getNode(id));
          if (((_c = node.parent) == null ? void 0 : _c.id) !== parent.id) throw new Error("Every node must be a direct child of parentId");
          selected.add(id);
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
        for (const id of args.nodeIds) nodes.push(requireScene(await getNode(id)));
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
      pluginVersion: "0.7.26",
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
      const responseLimit = ["get_node", "get_selection"].includes(message.command) ? Math.min((_e = (_d = message.args) == null ? void 0 : _d.maxResponseBytes) != null ? _e : DEFAULT_READ_BYTES, MAX_RESULT_BYTES) : MAX_RESULT_BYTES;
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
