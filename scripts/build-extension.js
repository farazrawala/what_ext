/**
 * Pack a shareable Chrome extension folder under build/
 * Obfuscates/minifies every package file (JS + CSS + HTML + manifest).
 * Output: build/store-sync-whatsapp-sender-v{version}/
 *
 * Usage: npm run build
 */
const fs = require("fs");
const path = require("path");
const { minify } = require("terser");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(ROOT, "build");

/** Minify + obfuscate with terser + javascript-obfuscator. */
const JS_FILES = ["content.js", "background.js", "posAuth.js", "popup.js"];

/** Minify only (no obfuscator) — POS auth bridge/inject must stay reliable. */
const MINIFY_ONLY_JS = ["posBridge.js", "posInject.js"];
const CSS_FILES = ["sidebar.css"];
const HTML_FILES = ["popup.html"];
const JSON_FILES = ["manifest.json"];

function readVersion() {
  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = String(manifest.version || "").trim();
  if (!/^\d+(\.\d+)*$/.test(version)) {
    throw new Error(`Invalid or missing version in manifest.json: ${version}`);
  }
  return version;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readRequired(srcRel) {
  const src = path.join(ROOT, srcRel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required file: ${srcRel}`);
  }
  return fs.readFileSync(src, "utf8");
}

function writeBuilt(destDir, filename, content, original) {
  const dest = path.join(destDir, filename);
  fs.writeFileSync(dest, content, "utf8");
  const beforeKb = (Buffer.byteLength(original, "utf8") / 1024).toFixed(1);
  const afterKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
  console.log(`  ${filename}: ${beforeKb} KB → ${afterKb} KB`);
}

async function minifyJs(code, filename) {
  const result = await minify(code, {
    compress: {
      drop_console: false,
      passes: 2,
    },
    mangle: {
      toplevel: false,
      reserved: [
        "chrome",
        "browser",
        "importScripts",
        "self",
        "window",
        "document",
      ],
    },
    format: {
      comments: false,
    },
    sourceMap: false,
  });
  if (!result.code) {
    throw new Error(`Terser produced empty output for ${filename}`);
  }
  return result.code;
}

function obfuscateJs(code, filename) {
  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    selfDefending: false,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.75,
    splitStrings: true,
    splitStringsChunkLength: 8,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    reservedNames: [
      "^chrome$",
      "^browser$",
      "^importScripts$",
      "^self$",
      "^window$",
      "^document$",
    ],
    reservedStrings: [
      "posAuth.js",
      "wa-api-request",
      "wa-get-pos-auth",
      "wa-post-incoming-chat",
      "wa-toggle-sidebar",
      "wa-show-sidebar",
      "wa-start-sending",
      "wa-start-sending-from-socket",
      "start-sending",
    ],
  });
  const out = result.getObfuscatedCode();
  if (!out) {
    throw new Error(`Obfuscator produced empty output for ${filename}`);
  }
  return out;
}

async function buildJs(srcRel, destDir) {
  const original = readRequired(srcRel);
  const minified = await minifyJs(original, srcRel);
  const obfuscated = obfuscateJs(minified, srcRel);
  writeBuilt(destDir, path.basename(srcRel), obfuscated, original);
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>~+])\s*/g, "$1")
    .replace(/;}/g, "}")
    .replace(/^\s+|\s+$/g, "")
    .trim();
}

function minifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

function minifyJson(jsonText) {
  return JSON.stringify(JSON.parse(jsonText));
}

function buildCss(srcRel, destDir) {
  const original = readRequired(srcRel);
  writeBuilt(destDir, path.basename(srcRel), minifyCss(original), original);
}

function buildHtml(srcRel, destDir) {
  const original = readRequired(srcRel);
  writeBuilt(destDir, path.basename(srcRel), minifyHtml(original), original);
}

function buildJson(srcRel, destDir) {
  const original = readRequired(srcRel);
  writeBuilt(destDir, path.basename(srcRel), minifyJson(original), original);
}

async function buildMinifiedOnlyJs(srcRel, destDir) {
  const original = readRequired(srcRel);
  const minified = await minifyJs(original, srcRel);
  writeBuilt(destDir, path.basename(srcRel), minified, original);
}

function writeInstallReadme(destDir, version) {
  const text = `Store Sync WhatsApp Sender — v${version}

Install (Chrome / Edge)
1. Unzip this folder if you received a zip.
2. Open chrome://extensions (or edge://extensions).
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked".
5. Select this folder (the one that contains manifest.json).
6. Open https://testv3.websitedemolynk.com/pos and log in (keep this tab open).
7. Refresh the POS tab once so auth syncs to the extension.
8. Open https://web.whatsapp.com and refresh the page.
9. Open the extension sidebar — version should show v${version}.

Notes
- Live POS auth uses localStorage authToken (not cookies). Keep the POS tab open.
- This package is minified/obfuscated (harder to read, not impossible to copy).
- For a newer version, remove the old unpacked extension and load again.

Built from manifest version ${version}.
`;
  fs.writeFileSync(path.join(destDir, "INSTALL.txt"), text, "utf8");
}

async function main() {
  const version = readVersion();
  const folderName = `store-sync-whatsapp-sender-v${version}`;
  const destDir = path.join(BUILD_ROOT, folderName);

  ensureDir(BUILD_ROOT);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  ensureDir(destDir);

  console.log("Building obfuscated/minified package...");
  console.log("JS (terser + javascript-obfuscator):");
  for (const file of JS_FILES) {
    await buildJs(file, destDir);
  }

  console.log("JS (minify only — POS bridge/inject):");
  for (const file of MINIFY_ONLY_JS) {
    await buildMinifiedOnlyJs(file, destDir);
  }

  console.log("CSS (minified):");
  for (const file of CSS_FILES) {
    buildCss(file, destDir);
  }

  console.log("HTML (minified):");
  for (const file of HTML_FILES) {
    buildHtml(file, destDir);
  }

  console.log("JSON (minified):");
  for (const file of JSON_FILES) {
    buildJson(file, destDir);
  }

  writeInstallReadme(destDir, version);

  const listed = fs.readdirSync(destDir).sort();
  console.log("");
  console.log(`Build ready: build/${folderName}/`);
  console.log(`Version: v${version}`);
  console.log(`Files (${listed.length}):`);
  listed.forEach((f) => console.log(`  - ${f}`));
  console.log("");
  console.log("Share that folder (or zip it) with your friend.");
  console.log(`Example zip name: ${folderName}.zip`);
  console.log(
    "Note: obfuscation makes reading harder; it does not make code uncopyable.",
  );
}

main().catch((err) => {
  console.error("Build failed:", err.message || err);
  process.exit(1);
});
