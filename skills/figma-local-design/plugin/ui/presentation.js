export function createPresentationPanel(state) {
    const versions = document.getElementById('versions');
    const recovery = document.getElementById('recovery');
    const indicator = document.getElementById('indicator');
    function renderIndicator(pulse = false) {
        if (!indicator)
            return;
        const busy = Boolean(state.activeRequest);
        const mismatch = state.connectionState === 'ready' && state.serverVersion && state.documentInfo?.pluginVersion && state.serverVersion !== state.documentInfo.pluginVersion;
        const kind = state.notice?.unread ? state.notice.level : mismatch ? 'warning' : busy ? 'running' : state.connectionState;
        const label = state.notice?.unread ? state.notice.short : mismatch ? 'Версии отличаются' : busy ? 'Выполняется операция' : {
            ready: 'Подключено', waiting: 'Ожидание MCP', connecting: 'Подключение…', offline: 'Отключено',
        }[state.connectionState];
        const continuingPulse = indicator.className === kind + ' pulse';
        indicator.className = kind;
        document.getElementById('signal').textContent = { ready: '✓', running: '↻', warning: '!', error: '!' }[kind] || '·';
        document.getElementById('indicator-label').textContent = label;
        indicator.title = state.notice?.unread ? state.notice.text : 'Открыть подробности';
        indicator.setAttribute('aria-label', label + '. Открыть подробности');
        if (pulse)
            void indicator.offsetWidth;
        if (pulse || continuingPulse)
            indicator.className += ' pulse';
    }
    function important(code, level, short, text) {
        if (state.notice?.unread && state.notice.level === 'error' && level !== 'error')
            return;
        const fresh = !state.notice?.unread || state.notice.code !== code;
        state.notice = { code, level, short, text, unread: true };
        const box = document.getElementById('notice');
        if (box) {
            box.hidden = false;
            box.className = level;
            document.getElementById('notice-text').textContent = text;
            document.getElementById('acknowledge').hidden = false;
        }
        renderIndicator(fresh);
    }
    function acknowledge() {
        if (state.notice)
            state.notice.unread = false;
        const button = document.getElementById('acknowledge');
        if (button)
            button.hidden = true;
        if (indicator)
            indicator.className = ''; // A persistent warning can remain, but its pulse is acknowledged.
        renderIndicator();
    }
    function displayMode(value) {
        state.compact = value;
        const content = document.getElementById('panel-content'), toggle = document.getElementById('toggle-panel');
        if (content)
            content.hidden = state.compact;
        if (toggle) {
            toggle.textContent = state.compact ? 'Развернуть' : 'Свернуть';
            toggle.setAttribute('aria-expanded', String(!state.compact));
        }
    }
    function requestMode(value) {
        state.requestedMode = value;
        parent.postMessage({ pluginMessage: { type: 'presentation-mode', compact: value } }, '*');
    }
    if (indicator)
        indicator.onclick = () => requestMode(false);
    const togglePanel = document.getElementById('toggle-panel');
    if (togglePanel)
        togglePanel.onclick = () => requestMode(!(state.requestedMode ?? state.compact));
    const acknowledgeButton = document.getElementById('acknowledge');
    if (acknowledgeButton)
        acknowledgeButton.onclick = acknowledge;
    for (const edge of ['left', 'right']) {
        const button = document.getElementById('move-' + edge);
        if (button)
            button.onclick = () => parent.postMessage({ pluginMessage: { type: 'presentation-move', edge } }, '*');
    }
    function showVersions() {
        if (versions)
            versions.textContent = 'Плагин: ' + (state.documentInfo?.pluginVersion ?? 'неизвестно') + '; MCP: ' + (state.serverVersion ?? 'не подключён');
        if (recovery && state.serverVersion && state.documentInfo?.pluginVersion !== state.serverVersion)
            recovery.textContent = 'Версии отличаются. Обновите MCP и плагин из одного пакета и перезапустите их.';
        const mismatch = state.serverVersion && state.documentInfo?.pluginVersion && state.documentInfo.pluginVersion !== state.serverVersion ? state.serverVersion + '/' + state.documentInfo.pluginVersion : undefined;
        if (mismatch && mismatch !== state.warnedVersion)
            important('version', 'warning', 'Обновите плагин', 'Версии MCP и плагина отличаются. Обновите и перезапустите их.');
        state.warnedVersion = mismatch;
        renderIndicator();
    }
    return { renderIndicator, important, acknowledge, displayMode, showVersions };
}
