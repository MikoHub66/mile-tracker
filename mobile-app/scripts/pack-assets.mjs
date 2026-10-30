// Minify + bundle the first-party JS that ships inside the APK, so the packaged
// app is not readable source. Runs on the copied Android assets AFTER `cap sync`,
// never on www/ itself, so developing and browser-previewing www/ still use the
// plain source files.
//
// What it does in android/app/src/main/assets/public:
//   - bundles app.js (and everything it imports) into app.min.js, minified
//   - points index.html at app.min.js
//   - deletes the now-inlined first-party source files
// It keeps vendor/ (Firebase/Leaflet, loaded by a runtime dynamic import) and the
// Leaflet assets untouched.
//
// NOTE: this is obfuscation, not security. Minified JS can still be unpacked and
// read with effort, and the Firebase web key it contains is public by design.
// Data is protected by the server-side Firestore rules, not by hiding the code.

import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "android", "app", "src", "main", "assets", "public");
if (!existsSync(join(assets, "app.js"))) {
  console.error("assets/public/app.js not found - run `npx cap sync android` first.");
  process.exit(1);
}

// Keep the dynamic `import("./vendor/firebase.js")` as a runtime import.
const keepVendorExternal = {
  name: "keep-vendor-external",
  setup(b) {
    b.onResolve({ filter: /vendor\// }, (a) => ({ path: "./" + a.path.replace(/^.*?(vendor\/)/, "$1"), external: true }));
  },
};

await build({
  entryPoints: [join(assets, "app.js")],
  outfile: join(assets, "app.min.js"),
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "none",
  plugins: [keepVendorExternal],
  logLevel: "warning",
});

let html = readFileSync(join(assets, "index.html"), "utf8");
html = html.replace('src="app.js"', 'src="app.min.js"');
writeFileSync(join(assets, "index.html"), html);

// Remove the first-party sources now inlined into app.min.js (vendor/ and leaflet stay).
for (const f of ["app.js", "native.js", "firebase.js", "store.js"]) rmSync(join(assets, f), { force: true });
const shared = join(assets, "shared");
if (existsSync(shared)) for (const f of readdirSync(shared)) if (f.endsWith(".js")) rmSync(join(shared, f));

console.log("Packed APK web assets: app.min.js only (sources removed).");
