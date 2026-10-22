// Форма анализа клиента: общий контракт сервера (server/modules/profile.mjs) и браузера.
// Ответ модели приводится к этой форме до сохранения и до показа.
import { arr, isRecord, text, list, colors } from "../../lib/coerce.js";
import { incomplete } from "../../shared/catalog.js";

export function normalizeAnalysis(data) {
  if (!isRecord(data)) throw incomplete("нет анализа");
  const c = typeof data.color_type === "string" ? { season: data.color_type } : data.color_type;
  const b = typeof data.body === "string" ? { figure_type: data.body } : data.body;
  if (!isRecord(c) || !isRecord(b)) throw incomplete("нет цветотипа или фигуры");

  const color_type = {
    season: text(c.season),
    neighbor_season: text(c.neighbor_season),
    undertone: text(c.undertone),
    contrast: text(c.contrast),
    confidence: text(c.confidence).toLowerCase(),
    reasoning: text(c.reasoning),
    best_colors: colors(c.best_colors),
    neutrals: colors(c.neutrals),
    avoid_colors: colors(c.avoid_colors),
    metals: text(c.metals),
  };
  const h = Number(b.height_cm);
  const result = {
    color_type,
    body: {
      height_cm: Number.isFinite(h) && h > 80 && h < 250 ? Math.round(h) : null,
      height_category: text(b.height_category),
      figure_type: text(b.figure_type),
      proportions: text(b.proportions),
      goals: list(b.goals),
      confidence: text(b.confidence).toLowerCase(),
      notes: text(b.notes),
    },
    styles: arr(data.styles)
      .map((s) => (isRecord(s) ? s : typeof s === "string" ? { name: s } : null))
      .filter(Boolean)
      .map((s) => ({ name: text(s.name), description: text(s.description), why: text(s.why) }))
      .filter((s) => s.name || s.description),
    silhouettes: arr(data.silhouettes)
      .map((s) => (isRecord(s) ? s : typeof s === "string" ? { recommend: s } : null))
      .filter(Boolean)
      .map((s) => ({ zone: text(s.zone), recommend: text(s.recommend), avoid: text(s.avoid) }))
      .filter((s) => s.zone || s.recommend),
    fabrics_prints: text(data.fabrics_prints),
    summary: text(data.summary),
  };
  // Отклоняем, только если в ответе нет вообще ничего полезного. Пустой цветотип при остальном содержимом это не повод всё выбросить.
  const useful =
    result.color_type.season ||
    result.color_type.best_colors.length ||
    result.body.figure_type ||
    result.body.proportions ||
    result.styles.length ||
    result.silhouettes.length;
  if (!useful) throw incomplete("в анализе нет ни цветотипа, ни фигуры, ни стилей, ни силуэтов");
  return result;
}
