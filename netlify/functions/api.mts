import { handleApi } from "../../lib/api.mjs";

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (req: Request) => handleApi(req, (name: string) => Netlify.env.get(name));

export const config = {
  path: "/api/*",
};
