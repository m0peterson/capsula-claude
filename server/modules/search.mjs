// Модуль «Поиск» на сервере: поиск конкретных моделей с веб-поиском (задача search, только Pro).
import { arr, isRecord, list } from "../../public/js/lib/coerce.js";
import { safeUrl } from "../../public/js/lib/html.js";
import { normalizeSearch } from "../../public/js/modules/search/schema.js";
import { BASE, InputError, str } from "../kit.mjs";

export const SEARCH_SYSTEM = `${BASE}
Задача: найти в интернете конкретные модели одежды, подходящие под описание. Используй веб-поиск.
Правила: давай только ссылки на реальные страницы товаров или категорий магазинов, которые ты увидел в результатах поиска. Не придумывай URL. Если подходящего не нашёл, верни меньше результатов.
Схема ответа:
{"results": [{"title": "название модели", "shop": "магазин", "url": "https://...", "price": "цена или null", "why": "чем подходит под запрос"}]}
Нужно 5-8 результатов.`;

export const tasks = {
  search: {
    slot: "text",
    pro: true,
    webSearch: true,
    validate(input) {
      const query = str(input.query, 200);
      if (!query) throw new InputError("Введите запрос.");
      const item = isRecord(input.item) ? input.item : {};
      return {
        query,
        description: str(item.description, 500),
        color: str(item.color, 60),
        price: str(item.price_range, 60),
        palette: list(input.palette)
          .slice(0, 12)
          .map((x) => x.slice(0, 40)),
        budget: str(input.budget, 60),
        city: str(input.city, 80),
      };
    },
    prompt(c) {
      return {
        system: SEARCH_SYSTEM,
        user: `Запрос: ${c.query}\n${c.description ? `Описание вещи: ${c.description}\n` : ""}${c.color ? `Цвет: ${c.color}\n` : ""}Цвета клиента: ${c.palette.join(", ") || "не определены"}\nБюджет: ${c.price || c.budget || "не указан"}\nРегион и магазины: ${c.city || "Россия"}, нужны магазины с доставкой туда.`,
        expect: ["results"],
        // Движок exa явно: без него OpenRouter для моделей со своим поиском (Muse Spark) включает их родной поиск,
        // а тот не отдаёт источники (ссылки нечем проверить) и в октябре 2026 выдумывал URL вида .../12345678/.
        // С exa ссылки из реальной выдачи, с источниками, и запрос в 3 раза дешевле ($0.007 против $0.020).
        extra: { plugins: [{ id: "web", engine: "exa", max_results: 5 }] },
      };
    },
    finish(data, c, { annotations }) {
      let results = normalizeSearch(data);
      const key = (u) => {
        const href = safeUrl(u);
        if (!href) return "";
        const x = new URL(href);
        return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "");
      };
      const cited = new Set(
        arr(annotations)
          .filter(isRecord)
          .map((a) => key(a.url_citation?.url || a.url))
          .filter(Boolean),
      );
      // Если источники известны, оставляем только ссылки из реальной выдачи поиска.
      // Если после фильтра ничего не осталось, показываем всё, но помечаем как непроверенное.
      const confirmed = results.filter((r) => cited.has(key(r.url)));
      const verified = confirmed.length > 0;
      if (verified) results = confirmed;
      return { results, verified };
    },
  },
};
