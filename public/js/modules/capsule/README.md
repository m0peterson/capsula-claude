# Модуль capsule: капсульный гардероб

Палитра, что оставить из гардероба, что докупить (с приоритетом, ценой, парами и поисковым запросом), образы капсулы. Работает и с гардеробом, и с нуля.

| Файл                         | Что внутри                                                             |
| ---------------------------- | ---------------------------------------------------------------------- |
| `index.js`                   | манифест: вкладка «Капсула», `requires: profile, wardrobe`, `locked`   |
| `model.js`                   | слайс `capsule`, `commitCapsule` (шлёт `capsule:rebuilt`), сезоны      |
| `schema.js`                  | `normalizeCapsule`                                                     |
| `api.js`                     | `buyList`, `buyItem(id)` для поиска                                    |
| `view.js`                    | экран                                                                  |
| `server/modules/capsule.mjs` | задача `capsule`, промпт `CAPSULE_SYSTEM`, бесплатно 3 главные покупки |

**Данные** (`mod:capsule`, версия 1): `{ result: { concept, palette, keep, drop, buy, looks, notes } | null, options: { size, season, budget, useWardrobe }, lock }`.

**Зависит от:** profile, wardrobe. **От него зависит:** search (через `api.js` и событие `capsule:rebuilt`).

**Тесты:** `test/normalize.test.mjs` (капсула), `test/api.test.mjs` (задача `capsule`, бесплатная часть).
