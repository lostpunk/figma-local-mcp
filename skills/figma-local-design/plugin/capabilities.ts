const policyKey = 'document-plan-v1';
const plans = ['unknown', 'starter', 'professional', 'education', 'organization', 'enterprise'] as const;
type Plan = typeof plans[number];
type Policy = { plan: Plan; source: 'user_declared' | 'figma_error'; observedPageLimit?: number };

function readPolicy(): Policy | undefined {
  try {
    const value = JSON.parse(figma.root.getPluginData(policyKey) || 'null');
    if (value && plans.includes(value.plan) && ['user_declared', 'figma_error'].includes(value.source)) return value;
  } catch {}
  return undefined;
}

export function getCapabilities() {
  const policy = readPolicy();
  const plan = policy?.plan ?? 'unknown';
  const pageCount = figma.root.children.length;
  const supportedEditor = figma.editorType === 'figma';
  const observedLimit = policy?.source === 'figma_error' && policy.observedPageLimit === 3 ? 3 : null;
  const effectivePageLimit = observedLimit ?? (plan === 'unknown' || plan === 'starter' ? 3 : null);
  return {
    editorType: figma.editorType, plan, planSource: policy?.source ?? 'not_exposed_by_plugin_api',
    planAutomaticallyDetected: policy?.source === 'figma_error', pageCount,
    effectivePageLimit, limitSource: observedLimit ? 'figma_error' : plan === 'unknown' ? 'conservative_default' : 'declared_plan',
    canCreatePage: supportedEditor && (effectivePageLimit === null || pageCount < effectivePageLimit),
    remainingPages: effectivePageLimit === null ? null : Math.max(0, effectivePageLimit - pageCount),
    recommendation: 'Reuse existing pages and place screens, components and style guides in separate frames. Do not probe the plan by creating a page.',
  };
}

export function setDeclaredPlan(plan: unknown) {
  if (!plans.includes(plan as Plan)) throw new Error('Unsupported file plan');
  figma.root.setPluginData(policyKey, JSON.stringify({ plan, source: 'user_declared' }));
  return getCapabilities();
}

export function createPageChecked(name: string): PageNode {
  const capability = getCapabilities();
  if (!capability.canCreatePage) {
    throw new Error(`PAGE_LIMIT: ${capability.pageCount} pages; effective limit ${capability.effectivePageLimit}. Reuse an existing page. Plan: ${capability.plan} (${capability.planSource}). Confirm this file's team plan in the plugin if the conservative limit is not applicable.`);
  }
  let page: PageNode;
  try { page = figma.createPage(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Starter plan only comes with 3 pages/i.test(message)) {
      figma.root.setPluginData(policyKey, JSON.stringify({ plan: 'starter', source: 'figma_error', observedPageLimit: 3 }));
      throw new Error('PAGE_LIMIT: Figma reported the Starter three-page limit. Reuse an existing page; the limit has been recorded for this file.');
    }
    throw error;
  }
  try { page.name = name; return page; }
  catch (error) { page.remove(); throw error; }
}
