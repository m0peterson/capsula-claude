// Cloudflare Pages Function: тот же прокси, что и на Netlify.
import { handleLlm } from "../../lib/proxy-core.mjs";

export const onRequest = ({ request, env }) => handleLlm(request, (name) => env[name]);
