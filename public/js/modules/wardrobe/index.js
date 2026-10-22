import { defineModule } from "../../core/module.js";
import { slice } from "./model.js";
import { render } from "./view.js";

export default defineModule({
  id: "wardrobe",
  slice,
  route: { label: "Гардероб", order: 20, render },
});
