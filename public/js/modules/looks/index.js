import { defineModule } from "../../core/module.js";
import { on } from "../../core/events.js";
import { ids } from "../wardrobe/api.js";
import { slice, commitLooks, pruneItem } from "./model.js";
import { normalizeLooks } from "./schema.js";
import { render } from "./view.js";

export default defineModule({
  id: "looks",
  requires: ["profile", "wardrobe"],
  slice,
  route: { label: "Образы", order: 30, render },
  init() {
    on("wardrobe:item-removed", ({ id }) => pruneItem(id));
  },
  locked: { task: "looks", sealed: () => slice.data.lock?.sealed, unlock: (full) => commitLooks(normalizeLooks(full, ids())) },
});
