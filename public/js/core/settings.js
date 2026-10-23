// Настройки браузера в localStorage: Pro-токен и код разработчика. Ключи провайдеров и модели живут на сервере.
import { isRecord } from "../lib/coerce.js";

const SETTINGS_KEY = "capsula.settings.v1";

// Слоты моделей на сервере. Разработчик может подменить модель и effort каждого из них из настроек.
export const DEV_SLOTS = ["vision", "detect", "text"];

export const defaultSettings = () => ({
  proToken: "",
  proUntil: 0,
  // Код разработчика (ADMIN_CODE на сервере): открывает всё и позволяет подменять модели для сравнения.
  devCode: "",
  dev: { provider: "", ...Object.fromEntries(DEV_SLOTS.map((s) => [s, { model: "", effort: "" }])) },
});

// Один и тот же объект на всё время работы: модули читают его напрямую.
export const settings = defaultSettings();

export function loadSettings() {
  try {
    // Настройки прошлой версии (ключи API и модели в браузере) больше не нужны: всё это теперь на сервере.
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!isRecord(raw)) return;
    const d = defaultSettings();
    const dev = isRecord(raw.dev) ? raw.dev : {};
    Object.assign(settings, {
      proToken: typeof raw.proToken === "string" ? raw.proToken : "",
      proUntil: Number.isFinite(raw.proUntil) ? raw.proUntil : 0,
      devCode: typeof raw.devCode === "string" ? raw.devCode : "",
      dev: {
        provider: typeof dev.provider === "string" ? dev.provider : "",
        ...Object.fromEntries(DEV_SLOTS.map((s) => [s, { ...d.dev[s], ...(isRecord(dev[s]) ? dev[s] : {}) }])),
      },
    });
  } catch {
    /* повреждённые настройки или нет localStorage: остаются по умолчанию */
  }
}

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("Не удалось сохранить настройки", e);
  }
}
