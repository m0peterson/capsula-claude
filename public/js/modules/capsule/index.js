import { defineModule } from "../../core/module.js";
import { ids } from "../wardrobe/api.js";
import { slice, commitCapsule } from "./model.js";
import { normalizeCapsule } from "./schema.js";
import { render } from "./view.js";

export default defineModule({
  id: "capsule",
  requires: ["profile", "wardrobe"],
  slice,
  route: { label: "Капсула", order: 40, render },
  locked: { task: "capsule", sealed: () => slice.data.lock?.sealed, unlock: (full) => commitCapsule(normalizeCapsule(full, ids())) },
});
