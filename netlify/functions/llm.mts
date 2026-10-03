import { handleLlm } from "../../lib/proxy-core.mjs";

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (req: Request) => handleLlm(req, (name: string) => Netlify.env.get(name));

export const config = {
  path: "/api/llm",
};
