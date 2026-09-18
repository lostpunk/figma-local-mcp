import packageInfo from '../package.json' with { type: 'json' };

export const VERSION = packageInfo.version;
export function readiness({ connected, document, operation, skillVersion }) {
  const issues = [];
  if (!connected) issues.push({ code: 'PLUGIN_DISCONNECTED', action: 'Запустите Figma Local MCP Auto в нужном файле.' });
  if (connected && !document?.pluginVersion) issues.push({ code: 'PLUGIN_VERSION_UNKNOWN', action: 'Обновите локальный плагин и запустите его снова.' });
  else if (connected && document.pluginVersion !== VERSION) issues.push({ code: 'PLUGIN_VERSION_MISMATCH', action: 'Обновите MCP и плагин из одного пакета, затем перезапустите их.' });
  if (skillVersion && skillVersion !== VERSION) issues.push({ code: 'SKILL_VERSION_MISMATCH', action: 'Обновите установленный скилл и MCP из одного пакета.' });
  if (operation !== 'idle') issues.push({ code: 'OPERATION_PENDING', action: 'Дождитесь результата операции. Тайм-аут не отменяет изменение.' });
  return { ready: issues.length === 0, versions: { server: VERSION, plugin: document?.pluginVersion ?? null, skill: skillVersion ?? null }, skillVersionChecked: Boolean(skillVersion), issues };
}
