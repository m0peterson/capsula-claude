// Cloudflare Pages Function: тот же API, что и на Netlify.
import { handleApi } from "../../server/api.mjs";

export const onRequest = ({ request, env }) => handleApi(request, (name) => env[name]);
