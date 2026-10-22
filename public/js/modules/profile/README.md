# Модуль profile: анализ внешности

Фото и анкета клиента, анализ (цветотип из 12 сезонов, фигура, стили, силуэты), пожелания по стилю. Пожелания общие для образов и капсулы, владелец здесь.

| Файл                         | Что внутри                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `index.js`                   | манифест: вкладка «Профиль», слайс, `locked` для бесплатного плана                                            |
| `model.js`                   | слайс `profile` и команды `setWishes`, `commitAnalysis`, `unlock`                                             |
| `schema.js`                  | `normalizeAnalysis`: форма анализа, общая с сервером                                                          |
| `api.js`                     | что читают другие модули: `wishes`, `setWishes`, `inputs`, `palette`, `forServer`, `sealed`, `hasAnalysis`    |
| `view.js`                    | экран: фото, анкета, результат с заглушками Pro                                                               |
| `server/modules/profile.mjs` | задача `analysis`, промпт `ANALYSIS_SYSTEM`, 12 сезонов, бесплатная часть, `profileBrief` для других промптов |

**Данные** (`mod:profile`, версия 1): `{ photos: dataURL[], inputs: {gender, age, height, size, city, budget}, analysis, wishes, lock: {locked, sealed} | null }`.

**Зависит от:** ничего. **От него зависят:** looks, capsule, search (только через `api.js`), серверные looks и capsule (через `profileBrief`, `profileInputs`, `clientAnalysis`).

**Тесты:** `test/normalize.test.mjs` (нормализация анализа, `profileBrief`), `test/api.test.mjs` (задача `analysis`, бесплатная часть, конверты).

**Проверить руками:** вкладка «Профиль», 1-3 фото, «Проанализировать». С `PRO_SECRET` без кода видна урезанная версия.

**Правила:** граница бесплатного плана (`teaser`) только на сервере. Если меняете форму анализа, поменяйте `schema.js` и миграцию в `model.js`: старые сохранённые анализы должны открываться.
