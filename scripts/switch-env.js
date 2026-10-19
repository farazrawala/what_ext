/**
 * Write env.js from env/local.js or env/live.js for unpacked local development.
 * Local also gets the live config, which enables the sidebar's Local/Live toggle.
 * Usage: node scripts/switch-env.js local|live
 */
const fs = require("fs");
const path = require("path");
const { loadEnvConfig } = require("./env-source");

const ROOT = path.resolve(__dirname, "..");
const name = String(process.argv[2] || "").trim().toLowerCase();

if (name !== "local" && name !== "live") {
  console.error("Usage: node scripts/switch-env.js local|live");
  process.exit(1);
}

let config;
try {
  config = loadEnvConfig(name);
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}

const dest = path.join(ROOT, "env.js");
fs.writeFileSync(dest, config.sourceCode, "utf8");
console.log(`Active env → ${name} (${path.relative(ROOT, dest)})`);
console.log(`POS: ${config.env.posUrl}`);
if (config.env.alternates) {
  console.log("Sidebar header shows a Local/Live API toggle.");
}
console.log("Reload the extension in chrome://extensions to apply.");
