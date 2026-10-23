// Список модулей в порядке загрузки. Единственный файл, который знает их все.
// Модуль из requires другого модуля должен стоять раньше. Чтобы убрать модуль, который никто не требует
// (looks, search, settings), удалите его строку здесь и его папку.
import settings from "./modules/settings/index.js";
import profile from "./modules/profile/index.js";
import wardrobe from "./modules/wardrobe/index.js";
import looks from "./modules/looks/index.js";
import capsule from "./modules/capsule/index.js";
import search from "./modules/search/index.js";

export default [settings, profile, wardrobe, looks, capsule, search];
