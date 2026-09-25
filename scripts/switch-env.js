/**
 * Copy env/local.js or env/live.js → env.js for unpacked local development.
 * Usage: node scripts/switch-env.js local|live
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const name = String(process.argv[2] || "").trim().toLowerCase();

if (name !== "local" && name !== "live") {
  console.error("Usage: node scripts/switch-env.js local|live");
  process.exit(1);
}

const src = path.join(ROOT, "env", `${name}.js`);
const dest = path.join(ROOT, "env.js");
if (!fs.existsSync(src)) {
  console.error(`Missing env file: ${src}`);
  process.exit(1);
}

fs.copyFileSync(src, dest);
console.log(`Active env → ${name} (${path.relative(ROOT, dest)})`);
console.log(`POS: ${name === "live" ? "https://testv3.websitedemolynk.com/pos/" : "http://localhost:8000/"}`);
console.log("Reload the extension in chrome://extensions to apply.");
