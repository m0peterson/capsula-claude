// Публичный API профиля для других модулей. Без DOM.
import { arr, isRecord } from "../../lib/coerce.js";
import { data, setWishes as set } from "./model.js";

/** Пожелания по стилю: общий текст для профиля, образов и капсулы. */
export const wishes = () => data().wishes;

/** @param {string} text */
export const setWishes = (text) => set(text);

/** Анкета: { gender, age, height, size, city, budget }, поля необязательные. */
export const inputs = () => data().inputs;

export const hasAnalysis = () => Boolean(data().analysis);

/** Названия лучших цветов клиента из анализа. */
export const palette = () =>
  arr(data().analysis?.color_type?.best_colors)
    .filter(isRecord)
    .map((c) => c.name);

/** Профиль для запроса к серверу: анкета и анализ (полный или урезанный), без фото. */
export const forServer = () => ({ inputs: data().inputs, analysis: data().analysis });

/** Конверт с полным анализом бесплатного пользователя: сервер подставит его в промпт образов и капсулы. */
export const sealed = () => (data().lock ? { analysis: data().lock.sealed } : undefined);
