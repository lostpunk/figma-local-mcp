export function createQualityPanel(state, { important }) {
    const audits = new Map();
    function showQuality(command, result) {
        const panel = document.getElementById('quality');
        if (!panel || !result)
            return;
        const summary = document.getElementById('quality-summary');
        const action = document.getElementById('quality-action');
        const list = document.getElementById('quality-findings');
        let items;
        if (command === 'audit_design') {
            panel.hidden = false;
            const key = result.rootId + JSON.stringify(state.activeArgs?.rules ?? {});
            const previous = audits.get(key);
            summary.textContent = 'Проверено элементов: ' + result.coverage.checked + ' · Замечаний: ' + result.findingCount +
                (previous === undefined ? '' : ' · В прошлой проверке: ' + previous);
            if (result.complete)
                audits.set(key, result.findingCount);
            if (audits.size > 10)
                audits.delete(audits.keys().next().value);
            action.textContent = result.complete ? 'Структурная проверка завершена. Внешний вид проверяется отдельно.' : 'Проверка неполная: смотрите ограничения охвата в результате MCP.';
            items = result.findings;
            if (result.findingCount || !result.complete)
                important('audit', 'warning', 'Проверьте макет', 'Аудит обнаружил замечания или завершился не полностью. Подробности ниже.');
        }
        else if (['preview_audit_fixes', 'preview_design_fixes'].includes(command)) {
            panel.hidden = false;
            summary.textContent = 'Предпросмотр выбранных слоёв';
            action.textContent = 'Предложено изменений: ' + (result.plan?.changes.length ?? 0) + ' · Пропущено: ' + result.skipped.length + ' — правки ещё не применены.';
            items = result.skipped.map(item => ({ ...item, message: item.reason }));
        }
        else if (command === 'apply_changes') {
            panel.hidden = false;
            action.textContent = 'Изменено слоёв: ' + result.nodeIds.length + ' · Требуется повторный аудит, чтобы подтвердить исправления.';
            return;
        }
        else
            return;
        list.replaceChildren();
        for (const item of items.slice(0, 50)) {
            const row = document.createElement('p');
            const label = document.createElement('span');
            const titles = { TEXT_RENDER_OUTSIDE_BOX: 'Текст выходит за рамку', OUTSIDE_PARENT: 'Элемент выходит за контейнер',
                MISSING_FONT: 'Недоступен шрифт', TEXT_TRUNCATION_ENABLED: 'Включено сокращение текста',
                SPACING_OFF_SCALE: 'Отступ вне шкалы проекта', UNBOUND_COLOR: 'Цвет без переменной',
                COLOR_VARIABLE_OUTSIDE_SYSTEM: 'Переменная цвета вне дизайн-системы', MIXED_COLOR_BINDINGS: 'Разные цвета внутри текста',
                TEXT_STYLE_OUTSIDE_SYSTEM: 'Текстовый стиль вне дизайн-системы', COMPONENT_OUTSIDE_SYSTEM: 'Компонент вне дизайн-системы',
                DESIGN_RULES_INVALID: 'Проверьте правила дизайн-системы', COMPONENT_STATES_MISSING: 'Не хватает состояний компонента' };
            label.textContent = [item.name, titles[item.code] || item.code, item.message].filter(Boolean).join(' · ');
            row.appendChild(label);
            if (item.nodeId) {
                const button = document.createElement('button');
                button.textContent = 'Показать слой';
                button.onclick = () => {
                    if (state.activeRequest) {
                        document.getElementById('quality-focus-status').textContent = 'Дождитесь завершения операции.';
                        return;
                    }
                    parent.postMessage({ pluginMessage: { type: 'focus-finding', nodeId: item.nodeId } }, '*');
                };
                row.appendChild(button);
            }
            list.appendChild(row);
        }
        if (items.length > 50) {
            const note = document.createElement('p');
            note.textContent = 'Показаны первые 50 замечаний. Полный результат — в MCP.';
            list.appendChild(note);
        }
    }
    return { showQuality };
}
