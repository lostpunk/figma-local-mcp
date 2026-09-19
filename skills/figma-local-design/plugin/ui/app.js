import { createPresentationPanel } from './presentation.js';
import { createDiagnosticsPanel } from './diagnostics.js';
import { createQualityPanel } from './quality.js';
import { createConnection } from './connection.js';
import { normalizeImage } from './images.js';
// Per-window state shared by views and transport; initialize before requesting plugin metadata.
const state = { compact: true, connectionState: 'waiting', stopped: false };
const { renderIndicator, important, acknowledge, displayMode, showVersions } = createPresentationPanel(state);
const { journal, safeLogText } = createDiagnosticsPanel(state, { important, renderIndicator });
const { showQuality } = createQualityPanel(state, { important });
const connection = createConnection(state, installationToken, { journal, safeLogText, renderIndicator, important, showVersions, showQuality });
const filePlan = document.getElementById('file-plan');
const pageBudget = document.getElementById('page-budget');

filePlan.onchange = () => parent.postMessage({ pluginMessage: { type: 'set-plan', plan: filePlan.value } }, '*');
window.onmessage = event => {
    // Figma Desktop can deliver plugin messages with a null event.source.
    // Correlate results with the active request instead of checking Window identity.
    let message = event.data?.pluginMessage;
    if (!message)
        return;
    if (message.type === 'presentation-state' && typeof message.compact === 'boolean') {
        displayMode(message.compact);
        if (state.requestedMode === state.compact) {
            state.requestedMode = undefined;
            if (!state.compact) {
                const content = document.getElementById('panel-content');
                if (content)
                    content.scrollTop = 0;
                acknowledge();
            }
        }
        return;
    }
    if (message.type === 'presentation-error') {
        state.requestedMode = undefined;
        journal('PRESENTATION_ERROR', message.error);
        state.lastErrorCode = 'PRESENTATION_ERROR';
        important('presentation', 'warning', 'Настройки окна', String(message.error));
        return;
    }
    if (message.type === 'decode-image' && typeof message.id === 'string' && typeof message.base64 === 'string') {
        void normalizeImage(message);
        return;
    }
    if (message.type === 'document') {
        state.documentInfo = message.document;
        showVersions();
        const capability = state.documentInfo?.capabilities;
        if (capability) {
            filePlan.value = capability.plan;
            const limit = capability.effectivePageLimit === null ? 'без лимита по указанному тарифу' : 'предел ' + capability.effectivePageLimit;
            pageBudget.textContent = 'Страниц: ' + capability.pageCount + '; ' + limit + '. ' +
                (capability.planSource === 'figma_error' ? 'Ограничение подтверждено Figma.' : capability.plan === 'unknown' ? 'Тариф не определён; используем существующие страницы.' : 'Тариф указан вручную для этого файла.');
        }
        connection.publishDocument();
    }
    if (message.type === 'focus-result') {
        const field = document.getElementById('quality-focus-status');
        if (field)
            field.textContent = message.error || 'Слой выделен в Figma.';
        return;
    }
    if (message.type === 'policy-error') {
        journal('POLICY_ERROR', message.error);
        important('policy', 'warning', 'Проверьте тариф', 'Не удалось изменить настройку тарифа. Подробности ниже.');
        pageBudget.textContent = message.error;
        parent.postMessage({ pluginMessage: { type: 'init' } }, '*');
    }
    connection.receiveResult(message);
};
window.onerror = (_message, _source, _line, _column, error) => journal('UI_ERROR', error?.message ?? _message);
window.onunhandledrejection = event => journal('UI_REJECTION', event.reason?.message ?? event.reason);
parent.postMessage({ pluginMessage: { type: 'init' } }, '*');
