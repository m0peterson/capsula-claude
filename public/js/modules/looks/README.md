# Модуль looks: образы из гардероба

Готовые образы строго из вещей клиента с учётом цветотипа, фигуры и пожеланий.

| Файл                       | Что внутри                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `index.js`                 | манифест: вкладка «Образы», `requires: profile, wardrobe`, подписка на `wardrobe:item-removed`, `locked` |
| `model.js`                 | слайс `looks`, команды `commitLooks`, `pruneItem`                                                        |
| `schema.js`                | `normalizeLooks`: отбрасывает чужие id и образы меньше чем из двух вещей                                 |
| `view.js`                  | экран                                                                                                    |
| `server/modules/looks.mjs` | задача `looks`, промпт `LOOKS_SYSTEM`, бесплатно первые 2 образа                                         |

**Данные** (`mod:looks`, версия 1): `{ list: [{ name, occasion, season, item_ids, description, tips, missing }], lock }`.

**Зависит от:** profile (пожелания, профиль для запроса, конверт анализа), wardrobe (вещи). **От него зависят:** никто, модуль можно убрать строкой в `modules.js`.

**Тесты:** `test/normalize.test.mjs` (образы), `test/api.test.mjs` (задача `looks`), `test/store.test.mjs` (чистка после удаления вещи).
