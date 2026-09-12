# С нуля: foundation → компонент → экран

Все вызовы выполняются через **figma_local** в открытом файле с подключённым development plugin. Значения `<...>` ниже — обозначения: замените их реальными ID из ответов инструментов. Они не разрешаются сервером автоматически.

## 1. Создать foundation

`create_style_guide`:

```json
{
  "name": "Acme",
  "colors": [
    { "name": "background", "value": "#F8FAFC" },
    { "name": "surface", "value": "#FFFFFF" },
    { "name": "text", "value": "#0F172A" },
    { "name": "primary", "value": "#2563EB" },
    { "name": "on-primary", "value": "#FFFFFF" }
  ]
}
```

Типографика, отступы и радиусы здесь используются по умолчанию. Сохраните ID цветов primary/on-primary/background/text, `spacing/16`, `spacing/24`, `radius/8` и текстовых стилей `Acme/Heading/H1`, `Acme/Label/Medium`.

## 2. Создать компонент кнопки

Сначала `create_page` с `{"name":"Components"}`. Используйте его `id` в `parentId` следующего `create_scene`:

```json
{
  "parentId": "<components-page-id>",
  "nodes": [
    {
      "ref": "button",
      "type": "COMPONENT",
      "props": {
        "name": "Button/Primary",
        "width": 240,
        "height": 48,
        "layoutMode": "HORIZONTAL",
        "primaryAxisAlignItems": "CENTER",
        "counterAxisAlignItems": "CENTER",
        "fillVariableId": "<primary-color-id>",
        "variableBindings": {
          "paddingLeft": "<spacing-16-id>",
          "paddingRight": "<spacing-16-id>",
          "topLeftRadius": "<radius-8-id>",
          "topRightRadius": "<radius-8-id>",
          "bottomLeftRadius": "<radius-8-id>",
          "bottomRightRadius": "<radius-8-id>"
        }
      }
    },
    {
      "ref": "label",
      "parentRef": "button",
      "type": "TEXT",
      "props": {
        "characters": "Продолжить",
        "textAutoResize": "WIDTH_AND_HEIGHT",
        "textStyleId": "<label-style-id>",
        "fillVariableId": "<on-primary-color-id>"
      }
    }
  ]
}
```

Сохраните ID узла с `ref: "button"`. Это компонент; его экземпляры создаются отдельным инструментом, без копирования макета кнопки вручную.

## 3. Собрать экран

Создайте страницу Screens через `create_page`, затем вызовите `create_scene`:

```json
{
  "parentId": "<screens-page-id>",
  "nodes": [
    {
      "ref": "screen",
      "type": "FRAME",
      "props": {
        "name": "Welcome / Desktop",
        "width": 1280,
        "height": 800,
        "fillVariableId": "<background-color-id>"
      }
    },
    {
      "ref": "content",
      "parentRef": "screen",
      "type": "FRAME",
      "props": {
        "name": "Content",
        "x": 80,
        "y": 160,
        "width": 720,
        "height": 240,
        "fill": null,
        "layoutMode": "VERTICAL",
        "variableBindings": { "itemSpacing": "<spacing-24-id>" }
      }
    },
    {
      "ref": "title",
      "parentRef": "content",
      "type": "TEXT",
      "props": {
        "characters": "Добро пожаловать в Acme",
        "width": 720,
        "textAutoResize": "HEIGHT",
        "textStyleId": "<heading-h1-style-id>",
        "fillVariableId": "<text-color-id>"
      }
    }
  ]
}
```

Вызовите `create_instance`:

```json
{
  "componentId": "<button-component-id>",
  "parentId": "<content-frame-id>",
  "props": { "name": "Continue button" }
}
```

Через `set_selection` передайте `{"nodeIds":["<screen-frame-id>"],"focus":true}`, затем `export_node` с `{"nodeId":"<screen-frame-id>","format":"PNG"}`. Проверьте визуальный результат и при необходимости корректируйте через `update_node`.

## 4. Изменить токен

`set_variable` с `{"variableId":"<primary-color-id>","value":"#7C3AED"}` меняет primary. Цветовой образец и компонент используют эту переменную, экземпляр наследует свойства компонента. Подпись HEX на странице guide остаётся исходной; актуальные значения доступны через `get_design_system` с `{"prefix":"Acme"}`.

Автотесты проверяют MCP, схемы и операции с имитацией Plugin API. Этот пошаговый пример и его внешний вид в настоящем Figma Desktop ещё требуют проверки.
