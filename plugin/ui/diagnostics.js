export function createDiagnosticsPanel(state, { important, renderIndicator }) {
    const diagnosticLog = document.getElementById('diagnostic-log');
    const history = [], supportEvents = [];
    function safeLogText(value) {
        if (value != null && !['string', 'number', 'boolean'].includes(typeof value))
            return '[unsupported metadata]';
        return String(value ?? '').slice(0, 8000)
            .replace(/(?:https?|wss?):\/\/[^\s]+/gi, '[url]')
            .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var)\/)[^\s]+/g, '[path]')
            .replace(/\b(?:token|pairingCode|authorization|password)\s*[:=]\s*\S+/gi, '[secret]')
            .replace(/[A-Za-z0-9+/=_-]{48,}/g, '[redacted]')
            .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
    }
    function journal(event, detail = '') {
        supportEvents.push({ time: new Date().toISOString(), event: /^[A-Z_]+$/.test(event) ? event : 'UNKNOWN' });
        if (supportEvents.length > 50)
            supportEvents.shift();
        history.push(new Date().toISOString() + ' ' + event + ' ' + safeLogText(detail));
        if (history.length > 50)
            history.shift();
        if (diagnosticLog)
            diagnosticLog.textContent = history.join('\n');
        if (['ERROR', 'UI_ERROR', 'UI_REJECTION'].includes(event))
            important('operation-error', 'error', 'Ошибка · подробности', 'Произошла ошибка. Проверьте журнал и результат операции перед повтором.');
        renderIndicator();
    }
    function supportReport() {
        // Deliberately excludes document names, IDs, text, paths, keys and free-form errors.
        return JSON.stringify({ format: 'figma-local-support-v1', versions: {
                plugin: /^\d+\.\d+\.\d+$/.test(state.documentInfo?.pluginVersion ?? '') ? state.documentInfo.pluginVersion : null,
                server: /^\d+\.\d+\.\d+$/.test(state.serverVersion ?? '') ? state.serverVersion : null
            },
            connected: state.socket === state.authenticatedSocket && state.socket?.readyState === WebSocket.OPEN,
            operation: state.activeRequest ? 'running' : 'idle', elapsedMs: state.activeRequest ? Date.now() - state.activeStartedAt : null,
            lastErrorCode: state.lastErrorCode ?? null, events: supportEvents }, null, 2);
    }
    const copyReport = document.getElementById('copy-report');
    if (copyReport)
        copyReport.onclick = async () => {
            const report = supportReport();
            const field = document.getElementById('support-report');
            const feedback = document.getElementById('copy-status');
            field.value = report;
            try {
                if (!navigator.clipboard?.writeText)
                    throw new Error('Clipboard unavailable');
                await navigator.clipboard.writeText(report);
                feedback.textContent = 'Отчёт скопирован. Данные макета и ключ подключения исключены.';
            }
            catch {
                field.hidden = false;
                field.focus();
                field.select();
                feedback.textContent = 'Выделен готовый отчёт. Нажмите ⌘C или Ctrl+C.';
            }
        };
    return { journal, safeLogText };
}
