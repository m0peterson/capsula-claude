// Точка входа: запускает ядро со списком модулей и оболочку. Единственный файл, который трогает DOM при импорте.
import { start } from "./core/registry.js";
import { startShell } from "./core/shell.js";
import { fetchConfig } from "./core/api.js";
import modules from "./modules.js";

const { routes } = await start(modules);
await fetchConfig();
startShell({ routes });
