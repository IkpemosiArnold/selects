// Node module hooks for testing the browser engine outside Vite: `?raw` imports become the
// file's text and `?url` imports become the file's URL, as Vite builds them. Tests only.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, next) {
  const u = new URL(url);
  if (u.protocol === "file:" && (u.search === "?raw" || u.search === "?url")) {
    const file = fileURLToPath(u.href.replace(/\?.*$/, ""));
    const value = u.search === "?raw" ? fs.readFileSync(file, "utf8") : `file://${file}`;
    return { format: "module", source: `export default ${JSON.stringify(value)};`, shortCircuit: true };
  }
  return next(url, context);
}
