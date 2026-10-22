// Cloudflare Worker со статикой: /api/* обрабатывает API, остальное отдаётся из public/ (см. wrangler.jsonc).
import { handleApi } from "../lib/api.mjs";

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) return handleApi(request, (name) => env[name]);
    return env.ASSETS.fetch(request);
  },
};
