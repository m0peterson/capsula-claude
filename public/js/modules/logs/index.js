import { defineModule } from "../../core/module.js";
import { on } from "../../core/events.js";
import { devlogOn } from "../../core/devlog.js";
import { render, refresh } from "./view.js";

export default defineModule({
  id: "logs",
  // Вкладка видна только в режиме разработчика: журнал пишется только в нём.
  route: { label: "Логи", order: 95, render, visible: devlogOn },
  init() {
    on("app:devlog", refresh);
  },
});
