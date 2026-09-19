import { jsonBytes, MAX_RESULT_BYTES } from '../response-size.ts';
export function createConnection(state, installationToken, { journal, safeLogText, renderIndicator, important, showVersions, showQuality }) {
    const status = document.getElementById('status');
    const activity = document.getElementById('activity');
    const connect = document.getElementById('connect');
    const disconnect = document.getElementById('disconnect');
    const filePlan = document.getElementById('file-plan');
    const recovery = document.getElementById('recovery');
    const recoveredResults = [], lateResults = [];
    let recoveredBytes = 0;
    let retryTimer;
    let retryDelay = 1000;
    const pluginSessionId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    if (typeof setInterval === 'function')
        setInterval(() => {
            if (state.activeRequest) {
                const seconds = Math.floor((Date.now() - state.activeStartedAt) / 1000);
                activity.textContent = 'Выполняется: ' + state.activeCommand + ' · ' + seconds + ' с';
                if (seconds >= 120 && recovery)
                    recovery.textContent = 'Операция ещё выполняется. Не повторяйте её; оставьте плагин открытым и проверьте get_operation.';
                if (seconds >= 120 && state.warnedOperation !== state.activeRequest) {
                    state.warnedOperation = state.activeRequest;
                    important('long-operation', 'warning', 'Операция ещё идёт', 'Операция выполняется больше двух минут. Не повторяйте её; проверьте её статус в MCP.');
                }
            }
        }, 1000);
    if (installationToken) {
        document.getElementById('pairing').hidden = true;
        document.getElementById('intro').textContent = 'Автоматическое подключение к MCP на этом компьютере.';
    }
    function scheduleReconnect() {
        if (!installationToken || state.stopped || state.activeRequest || retryTimer)
            return;
        retryTimer = setTimeout(() => { retryTimer = undefined; connectToBridge(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
    }
    function connectToBridge() {
        const token = installationToken || document.getElementById('token').value.trim();
        if (!/^[a-f0-9]{64}$/.test(token)) {
            status.textContent = 'Вставьте полный pairingCode из get_connection';
            return;
        }
        if (state.activeRequest) {
            status.textContent = 'Дождитесь завершения текущей операции';
            return;
        }
        clearTimeout(retryTimer);
        retryTimer = undefined;
        if (state.socket) {
            const previous = state.socket;
            state.socket = undefined;
            previous.close();
        }
        const current = new WebSocket('ws://localhost:3055');
        state.socket = current;
        state.connectionState = 'connecting';
        renderIndicator();
        status.textContent = 'Подключение…';
        connect.disabled = true;
        disconnect.hidden = false;
        current.onopen = () => current.send(JSON.stringify({ type: 'hello', token, pluginSessionId, document: state.documentInfo }));
        current.onmessage = event => {
            if (state.socket !== current)
                return;
            let message;
            try {
                message = JSON.parse(event.data);
            }
            catch {
                current.close();
                return;
            }
            if (!message || typeof message !== 'object') {
                current.close();
                return;
            }
            if (message.type === 'ready') {
                state.authenticatedSocket = current;
                state.connectionState = 'ready';
                state.serverVersion = message.serverVersion;
                if (recovery)
                    recovery.textContent = '';
                showVersions();
                retryDelay = 1000;
                status.textContent = 'Соединение с локальным MCP установлено.';
                disconnect.hidden = false;
                document.getElementById('token').value = '';
                journal('CONNECTED');
                while (lateResults.length)
                    current.send(JSON.stringify(lateResults.shift()));
                for (const result of recoveredResults)
                    current.send(JSON.stringify({ ...result, type: 'recovered_result' }));
            }
            else if (message.type === 'result_ack') {
                const index = recoveredResults.findIndex(result => result.id === message.id);
                if (index >= 0)
                    recoveredBytes -= JSON.stringify(recoveredResults.splice(index, 1)[0]).length * 2;
            }
            else if (message.type === 'command') {
                if (state.activeRequest === message.id)
                    return;
                if (state.activeRequest) {
                    current.send(JSON.stringify({ type: 'result', id: message.id, error: 'Plugin busy' }));
                    return;
                }
                state.activeRequest = message.id;
                state.activeCommand = message.command;
                state.activeArgs = message.args;
                state.activeStartedAt = Date.now();
                if (recovery)
                    recovery.textContent = '';
                journal('START', state.activeCommand + ' id=' + state.activeRequest);
                filePlan.disabled = true;
                state.responseSocket = current;
                activity.textContent = 'Выполняется: ' + message.command;
                parent.postMessage({ pluginMessage: message }, '*');
            }
        };
        current.onclose = event => {
            if (state.socket !== current)
                return;
            const wasReady = state.connectionState === 'ready';
            state.connectionState = state.stopped ? 'offline' : 'waiting';
            if (!state.stopped && (wasReady || state.activeRequest))
                important('connection', 'warning', 'Связь потеряна', state.activeRequest ? 'Связь потеряна во время операции. Дождитесь результата; не повторяйте её.' : 'Соединение с MCP потеряно. Плагин попробует подключиться снова.');
            journal('DISCONNECTED', 'code=' + event.code + (state.activeRequest ? ' id=' + state.activeRequest + ' outcome=unknown' : ''));
            status.textContent = 'Отключено' + (event.reason ? ': ' + event.reason : '. Вызовите get_connection и подключитесь снова.');
            connect.disabled = false;
            disconnect.hidden = true;
            if (event.code === 1008) {
                state.stopped = true;
                state.lastErrorCode = 'CONNECTION_REJECTED';
                important('rejected', 'error', 'Подключение отклонено', 'Подключение отклонено. Проверьте, не открыта ли вторая копия плагина.');
                if (recovery)
                    recovery.textContent = 'Подключение отклонено. Закройте вторую копию плагина; если не помогло, обновите локальную установку и запустите Auto снова.';
            }
            if (installationToken && !state.stopped) {
                status.textContent = state.activeRequest ? 'Связь потеряна. Ожидаем завершения операции; повторно она не отправляется.' : 'Ожидаем локальный MCP. Подключение восстановится автоматически.';
                disconnect.hidden = false;
                scheduleReconnect();
            }
        };
        current.onerror = () => { if (state.socket === current) {
            status.textContent = 'Нет соединения с локальным MCP на порту 3055';
            journal('SOCKET_ERROR');
            state.lastErrorCode = 'SOCKET_ERROR';
        } };
    }
    connect.onclick = () => { state.stopped = false; connectToBridge(); };
    disconnect.onclick = () => {
        state.stopped = true;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        state.socket?.close();
        disconnect.hidden = true;
        status.textContent = 'Отключено';
        state.connectionState = 'offline';
        renderIndicator();
    };
    function publishDocument() {
        if (state.socket === state.authenticatedSocket && state.socket?.readyState === WebSocket.OPEN)
            state.socket.send(JSON.stringify({ type: 'document', document: state.documentInfo }));
        if (installationToken && !state.socket && !state.stopped)
            connectToBridge();
    }
    function receiveResult(message) {
        if (message.type === 'result' && state.activeRequest && message.id === state.activeRequest) {
            // Also protect transports with an older plugin backend: never send an oversized frame.
            if (jsonBytes(message) > MAX_RESULT_BYTES)
                message = { type: 'result', id: message.id,
                    error: 'RESPONSE_TOO_LARGE: Read a smaller range or fewer fields. A write may already have completed; inspect the file before retrying.' };
            const durationMs = Date.now() - state.activeStartedAt;
            const delivered = state.responseSocket?.readyState === WebSocket.OPEN;
            journal(delivered ? (message.error ? 'ERROR' : 'DONE') : 'LATE_RESULT', state.activeCommand + ' id=' + state.activeRequest + ' ms=' + durationMs + (message.error ? ' ' + safeLogText(message.error) : ' completed'));
            if (/^[0-9a-f-]{36}:\d+$/.test(message.id) || !delivered) {
                const bytes = JSON.stringify(message).length * 2;
                if (bytes <= 16 * 1024 * 1024) {
                    while (recoveredResults.length && (recoveredResults.length >= 32 || recoveredBytes + bytes > 16 * 1024 * 1024))
                        recoveredBytes -= JSON.stringify(recoveredResults.shift()).length * 2;
                    recoveredResults.push(message);
                    recoveredBytes += bytes;
                }
            }
            if (!delivered) {
                lateResults.push({ type: 'diagnostic', event: 'late_result', id: state.activeRequest,
                    command: state.activeCommand, durationMs, failed: typeof message.error === 'string', error: message.error ? safeLogText(message.error) : undefined });
                if (lateResults.length > 32)
                    lateResults.shift();
            }
            if (state.responseSocket?.readyState === WebSocket.OPEN)
                state.responseSocket.send(JSON.stringify(message));
            if (!message.error) {
                try {
                    showQuality(state.activeCommand, message.result);
                }
                catch {
                    journal('QUALITY_UI_ERROR');
                }
            }
            else if (document.getElementById('quality-action') && ['audit_design', 'apply_changes', 'preview_audit_fixes', 'preview_design_fixes'].includes(state.activeCommand))
                document.getElementById('quality-action').textContent = 'Операция не завершилась успешно. Результат исправления не подтверждён; проверьте слои.';
            state.activeRequest = undefined;
            state.activeCommand = undefined;
            state.activeArgs = undefined;
            filePlan.disabled = false;
            state.responseSocket = undefined;
            state.lastErrorCode = message.error ? 'PLUGIN_ERROR' : undefined;
            if (message.error && recovery)
                recovery.textContent = 'Проверьте затронутые слои и get_operation. Не повторяйте создание автоматически; при частичном изменении используйте Undo в Figma.';
            activity.textContent = message.error ? 'Ошибка: ' + message.error : 'Операция завершена';
            if (message.error)
                important('operation-error', 'error', 'Ошибка · подробности', 'Операция завершилась с ошибкой. Проверьте затронутые слои и журнал перед повтором.');
            renderIndicator();
            if (state.socket?.readyState === WebSocket.CLOSED)
                scheduleReconnect();
        }
    }
    return { publishDocument, receiveResult };
}
