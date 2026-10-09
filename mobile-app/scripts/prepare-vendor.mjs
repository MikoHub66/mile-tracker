// Stages third-party code into www/vendor so the app starts with no signal:
//   www/vendor/firebase.js   Firebase app/auth/firestore (esbuild bundle)
//   www/vendor/leaflet/      Leaflet JS/CSS/images
// Run via `npm run prepare:vendor` (also part of `npm run sync`). Outputs are gitignored.

import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www");
mkdirSync(join(www, "vendor"), { recursive: true });
await build({
  entryPoints: [join(root, "scripts", "firebase-entry.js")],
  outfile: join(www, "vendor", "firebase.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  logLevel: "warning",
});
cpSync(join(root, "node_modules", "leaflet", "dist"), join(www, "vendor", "leaflet"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map") && !src.includes("leaflet-src"),
});
console.log("Firebase + Leaflet -> www/vendor/");
