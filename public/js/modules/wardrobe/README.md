# Модуль wardrobe: гардероб

Вещи клиента с фото и атрибутами. Два способа наполнить:

1. **Из фото образов** (основной): до 10 фото в полный рост. Одна задача `outfits` видит все фото сразу, находит уникальные вещи, рамку каждой на лучшем фото и сверяет их с уже имеющимися по таблице миниатюр. Браузер вырезает вещи из копий 1600 px и добавляет новые в начало списка. Последний импорт можно отменить.
2. **По одной вещи на фото**: задача `wardrobe`, пачки по 6, три пачки параллельно.

| Файл                          | Что внутри                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `index.js`                    | манифест: вкладка «Гардероб», слайс                                                                                        |
| `model.js`                    | слайс `wardrobe`, команды `addItems`, `removeItem` (шлёт `wardrobe:item-removed`), `setLastImport`, `undoLastImport`       |
| `schema.js`                   | `normalizeItem`, `recognizedItems`, `normalizeOutfits`, `normalizeBox`, `outfitsToWire`, `itemForServer`; общие с сервером |
| `api.js`                      | `items`, `count`, `byId`, `ids`, `forServer` (без фото)                                                                    |
| `outfits.js`                  | импорт из фото образов: сжатие, таблицы миниатюр, запрос, вырезка, сверка, отчёт                                           |
| `recognize.js`                | распознавание вещей по одной                                                                                               |
| `view.js`                     | экран                                                                                                                      |
| `server/modules/wardrobe.mjs` | задачи `wardrobe` и `outfits`, промпты, `wardrobeItems` и `wardrobeBrief` для других модулей                               |

**Данные** (`mod:wardrobe`, версия 1): `{ items: [{ id, image, name, category, color, color_hex, material, style, seasons, formality, notes, recognized, source? }], lastImport: { added, photos, found, repeats, known, at } | null }`. `source: "outfit"` у вещей из фото образов: их миниатюры показываются целиком (`object-fit: contain`).

**Модель:** `outfits` идёт в слот `detect` (по умолчанию `google/gemini-3.8-flash`, запасная `qwen/qwen3.8-flash`, effort `minimal`). deepseek-v4.1-flash для рамок не годится: ставит их мимо вещей.

**Зависит от:** ничего. **От него зависят:** looks, capsule (через `api.js` и событие `wardrobe:item-removed`).

**Тесты:** `test/outfits.test.mjs` (разбор ответа, рамки, вырезка, задача `outfits`), `test/normalize.test.mjs` (распознавание по одной), `test/store.test.mjs` (отмена импорта, удаление вещи).

**Проверить руками:** «Выбрать фото образов», 3-6 фото одного человека в разных образах с повторяющимися вещами. Затем ещё 2-3 фото: уже имеющиеся вещи не должны добавиться второй раз.

**Правила:** вещь удаляется только через `removeItem`, иначе образы останутся с битыми ссылками. Фото образов не сохраняются, только вырезки.
