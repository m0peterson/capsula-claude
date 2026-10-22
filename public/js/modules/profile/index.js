import { defineModule } from "../../core/module.js";
import { slice, unlock } from "./model.js";
import { render } from "./view.js";

export default defineModule({
  id: "profile",
  slice,
  route: { label: "Профиль", order: 10, render },
  locked: { task: "analysis", sealed: () => slice.data.lock?.sealed, unlock },
});
