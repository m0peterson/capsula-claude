import { defineModule } from "../../core/module.js";
import { on } from "../../core/events.js";
import { slice, clearCache } from "./model.js";
import { render } from "./view.js";

export default defineModule({
  id: "search",
  requires: ["profile", "capsule"],
  slice,
  route: { label: "Поиск", order: 50, render },
  init() {
    on("capsule:rebuilt", clearCache);
  },
});
