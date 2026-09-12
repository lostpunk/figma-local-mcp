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

  // plugin/design-system.ts
  var designCommands = /* @__PURE__ */ new Set(["create_style_guide", "get_design_system", "create_page", "create_scene", "create_instance", "set_variable"]);
  var rgb = (hex) => ({
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
      const colorTokens = colors.map((c) => __spreadProps(__spreadValues({}, c), { variable: createVariable(`color/${c.name}`, rgb(c.value), "COLOR") }));
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
        const variable = await figma.variables.getVariableByIdAsync(args.variableId);
        if (!variable || variable.remote) throw new Error("Local variable not found");
        const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
        if (!collection) throw new Error("Variable collection not found");
        const modeId = (_f = args.modeId) != null ? _f : collection.defaultModeId;
        if (!collection.modes.some((m) => m.modeId === modeId)) throw new Error("Mode does not belong to this collection");
        let value;
        if (variable.resolvedType === "COLOR" && typeof args.value === "string" && /^#[0-9a-fA-F]{6}$/.test(args.value)) value = rgb(args.value);
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
    "textStyleId"
  ];
  function clean(value) {
    if (value === figma.mixed) return { mixed: true };
    if (value === void 0) return void 0;
    return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "symbol" ? { mixed: true } : v));
  }
  function summarize(node, depth, budget) {
    var _a;
    budget.left--;
    const result = { id: node.id, type: node.type, name: node.name, parentId: (_a = node.parent) == null ? void 0 : _a.id };
    const source = node;
    for (const key of properties) {
      if (key in node) {
        const value = source[key];
        if (key === "characters" && typeof value === "string" && value.length > 1e4) {
          result[key] = value.slice(0, 1e4);
          result.charactersTruncated = true;
          result.characterCount = value.length;
        } else result[key] = clean(value);
      }
    }
    if ("children" in node) {
      const children = node.children;
      result.childCount = children.length;
      result.children = [];
      if (depth > 0) {
        for (const child of children) {
          if (budget.left <= 0) break;
          result.children.push(summarize(child, depth - 1, budget));
        }
      }
      result.childrenTruncated = result.children.length < children.length;
    }
    return result;
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
  function pageOf(node) {
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
  async function applyProps(node, props) {
    var _a, _b, _c;
    const target = node;
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
      const variable = variableId === null ? null : await figma.variables.getVariableByIdAsync(variableId);
      if (variableId !== null && (!variable || variable.resolvedType !== "FLOAT")) throw new Error(`FLOAT variable not found for ${field}`);
      bindings.push({ field, variable });
    }
    const paints = {};
    for (const [key, field, raw] of [["fillVariableId", "fills", "fill"], ["strokeVariableId", "strokes", "stroke"]]) {
      if (!props[key]) continue;
      if (!(field in node)) throw new Error(`${field} is not supported on ${node.type}`);
      if (props[raw] !== void 0) throw new Error(`Use ${key} or ${raw} in one call`);
      const variable = await figma.variables.getVariableByIdAsync(props[key]);
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
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (designCommands.has(command)) return executeDesignCommand(command, args, { getNode, applyProps, createNode });
    const budget = { left: (_a = args.maxNodes) != null ? _a : 200 };
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
        try {
          await applyProps(node, args.props);
        } catch (error) {
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
        const page = pageOf(parent);
        if (nodes.some((node) => pageOf(node).id !== page.id)) throw new Error("All nodes and the parent must belong to the same page");
        let ancestor = parent;
        while (ancestor) {
          if (seen.has(ancestor.id)) throw new Error("Cannot move a node into its own descendant");
          ancestor = ancestor.parent;
        }
        if (parent.type !== "PAGE" && parent.layoutMode && parent.layoutMode !== "NONE") {
          throw new Error("Destination uses auto layout; move into a non-auto-layout frame to preserve positioning");
        }
        const parentBox = parent.type === "PAGE" ? { x: 0, y: 0 } : (_b = parent.absoluteBoundingBox) != null ? _b : { x: 0, y: 0 };
        const positions = nodes.map((node) => {
          var _a2;
          const box = (_a2 = node.absoluteBoundingBox) != null ? _a2 : { x: node.x, y: node.y };
          return { node, x: box.x, y: box.y };
        });
        const selected = new Set(nodes.map((node) => node.id));
        const remaining = parent.children.filter((node) => !selected.has(node.id));
        const insertIndex = Math.min((_c = args.insertIndex) != null ? _c : remaining.length, remaining.length);
        for (let i = 0; i < positions.length; i++) {
          const item = positions[i];
          const maxIndex = parent.children.length - (((_d = item.node.parent) == null ? void 0 : _d.id) === parent.id ? 1 : 0);
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
          if (((_e = node.parent) == null ? void 0 : _e.id) !== parent.id) throw new Error("Every node must be a direct child of parentId");
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
        node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: (_f = args.scaleMode) != null ? _f : "FILL" }];
        figma.commitUndo();
        return { nodeId: node.id, imageHash: image.hash, normalized, scaleMode: (_g = args.scaleMode) != null ? _g : "FILL" };
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
        const page = nodes.length ? pageOf(nodes[0]) : figma.currentPage;
        if (nodes.some((node) => pageOf(node).id !== page.id)) throw new Error("All selected nodes must belong to the same page");
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
        const bounds = (_h = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null) != null ? _h : node.absoluteBoundingBox;
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
      pluginVersion: "0.6.2",
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
      const result = await execute(message.command, (_a = message.args) != null ? _a : {});
      figma.ui.postMessage({ type: "result", id: message.id, result });
    } catch (error) {
      figma.ui.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
      publishDocument();
    }
  };
})();
