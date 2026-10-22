import { defineModule } from "../../core/module.js";
import { render } from "./view.js";

export default defineModule({
  id: "settings",
  route: { label: "Настройки", order: 90, render },
});
