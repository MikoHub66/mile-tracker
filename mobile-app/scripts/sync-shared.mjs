// web/public/shared/ is the source of truth for code shared with the app.
// Copies it into mobile-app/www/shared/ (tests/shared-copies.test.mjs checks they match).
import { cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "..", "web", "public", "shared");
const dst = join(root, "www", "shared");
for (const f of readdirSync(src)) if (f.endsWith(".js")) cpSync(join(src, f), join(dst, f));
console.log("web/public/shared -> mobile-app/www/shared");
