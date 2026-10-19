/**
 * Pack a shareable Chrome extension folder under build/
 * Minifies every package file (JS + CSS + HTML + manifest). Local builds also
 * obfuscate JS; live builds do not, because the Chrome Web Store rejects
 * obfuscated code.
 *
 * Usage:
 *   npm run build:local   → build/...-v{version}-local/
 *   npm run build:live    → build/...-v{version}-live/
 *   npm run build         → same as build:live
 *
 * Every build bumps the manifest version (1.86 → 1.87) before packing.
 * Pass --no-bump to reuse the current version (build:all uses it for its
 * second env so both packages share one version).
 *
 * Each build is also copied to build/store-sync-whatsapp-sender-{env}/
 * (no version in the name). Load that folder unpacked once; Chrome's reload
 * button then always picks up the latest build.
 *
 * Environments:
 *   local → http://localhost:8000/
 *   live  → https://testv3.websitedemolynk.com/pos/
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { minify } = require("terser");
const JavaScriptObfuscator = require("javascript-obfuscator");
const { loadEnvConfig } = require("./env-source");

const ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(ROOT, "build");

/** Minified with terser; also obfuscated in local builds only. */
const JS_FILES = ["content.js", "background.js", "posAuth.js", "popup.js"];

/** Dev-only scripts: packed in local builds, left out of live/store builds. */
const LOCAL_ONLY_JS = ["localSocket.js"];

/** Left out of the Chrome Web Store zip (developer install notes). */
const STORE_ZIP_EXCLUDE = ["INSTALL.txt"];

/** Minify only (no obfuscator) — POS auth bridge/inject must stay reliable. */
const MINIFY_ONLY_JS = ["posBridge.js", "posInject.js", "env.js"];
const CSS_FILES = ["sidebar.css"];
const HTML_FILES = ["popup.html"];
/** Copied as-is (manifest "icons" / action "default_icon"). */
const ICON_DIR = "icons";

function parseEnvArg() {
  const arg = process.argv.find((a) => a.startsWith("--env="));
  const name = (arg ? arg.slice("--env=".length) : process.env.WA_BUILD_ENV || "live")
    .trim()
    .toLowerCase();
  if (name !== "local" && name !== "live") {
    throw new Error(`Invalid env "${name}". Use --env=local or --env=live`);
  }
  return name;
}

function readVersion() {
  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = String(manifest.version || "").trim();
  if (!/^\d+(\.\d+)*$/.test(version)) {
    throw new Error(`Invalid or missing version in manifest.json: ${version}`);
  }
  return version;
}

/** Increment the last numeric segment of manifest.json "version" in place. */
function bumpVersion() {
  const manifestPath = path.join(ROOT, "manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  const current = readVersion();
  const parts = current.split(".").map(Number);
  parts[parts.length - 1] += 1;
  const next = parts.join(".");
  // Regex replace keeps the file's formatting and line endings intact
  const updated = raw.replace(
    /("version"\s*:\s*")[^"]*(")/,
    `$1${next}$2`,
  );
  fs.writeFileSync(manifestPath, updated, "utf8");
  console.log(`Version bumped: v${current} → v${next}`);
  return next;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate, no extra dependency) for the store upload. */
function writeZip(srcDir, zipPath, exclude = []) {
  const entries = [];
  (function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (exclude.includes(rel)) continue;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else entries.push({ rel, data: fs.readFileSync(full) });
    }
  })(srcDir, "");

  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { rel, data } of entries) {
    const name = Buffer.from(rel, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));
  return entries.map((e) => e.rel);
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
        "WA_ENV",
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
      "^WA_ENV$",
    ],
    reservedStrings: [
      "posAuth.js",
      "env.js",
      "localSocket.js",
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

async function buildJs(srcRel, destDir, { obfuscate }) {
  const original = readRequired(srcRel);
  const minified = await minifyJs(original, srcRel);
  const out = obfuscate ? obfuscateJs(minified, srcRel) : minified;
  writeBuilt(destDir, path.basename(srcRel), out, original);
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

function buildCss(srcRel, destDir) {
  const original = readRequired(srcRel);
  writeBuilt(destDir, path.basename(srcRel), minifyCss(original), original);
}

function buildHtml(srcRel, destDir) {
  const original = readRequired(srcRel);
  writeBuilt(destDir, path.basename(srcRel), minifyHtml(original), original);
}

async function buildMinifiedOnlyJs(code, filename, destDir) {
  const minified = await minifyJs(code, filename);
  writeBuilt(destDir, filename, minified, code);
}

function buildManifest(destDir, version, env) {
  const base = JSON.parse(readRequired("manifest.json"));
  base.version = version;
  if (env.name !== "live") {
    base.name = `${base.name} (Local)`;
    base.description = `Local development build. POS: ${env.posUrl}`;
  }

  // POS bridge and host access only on this environment's hosts (local builds
  // also need the hosts their sidebar API toggle can switch to)
  const posMatches = [env, ...Object.values(env.alternates || {})].flatMap((e) =>
    Array.isArray(e.posTabMatch) ? e.posTabMatch : [],
  );
  base.host_permissions = ["https://web.whatsapp.com/*", ...posMatches];
  base.content_scripts = [
    {
      matches: ["https://web.whatsapp.com/*"],
      js: ["env.js", "content.js"],
      css: ["sidebar.css"],
    },
    {
      matches: posMatches,
      js: ["posBridge.js"],
      run_at: "document_idle",
    },
  ];

  const original = JSON.stringify(base, null, 2);
  const minified = JSON.stringify(base);
  writeBuilt(destDir, "manifest.json", minified, original);
}

function writeInstallReadme(destDir, version, env) {
  const text = `Store Sync POS Messenger — v${version} (${env.label})

Environment
- Name: ${env.name}
- POS URL: ${env.posUrl}
- Chat API: ${env.posOrigin}${env.chatApiPath}/...

Install (Chrome / Edge)
1. Unzip this folder if you received a zip.
2. Open chrome://extensions (or edge://extensions).
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked".
5. Select this folder (the one that contains manifest.json).
6. Open ${env.posUrl} and log in (keep this tab open).
7. Refresh the POS tab once so auth syncs to the extension.
8. Open https://web.whatsapp.com and refresh the page.
9. Open the extension sidebar — version should show v${version}.

Notes
- POS auth uses localStorage authToken (or cookies). Keep the POS tab open.
- This package is ${env.name === "live" ? "minified only (no obfuscation, as the Chrome Web Store requires)" : "minified/obfuscated (harder to read, not impossible to copy)"}.
- Local and Live builds are separate — do not mix them.${env.alternates ? `
- The sidebar header has a Local/Live toggle to point this build at the live POS APIs.` : ""}

Built from manifest version ${version}, env=${env.name}.
`;
  fs.writeFileSync(path.join(destDir, "INSTALL.txt"), text, "utf8");
}

async function main() {
  const envName = parseEnvArg();
  const { env, sourceCode } = loadEnvConfig(envName);
  const version = process.argv.includes("--no-bump")
    ? readVersion()
    : bumpVersion();
  const folderName = `store-sync-whatsapp-sender-v${version}-${envName}`;
  const destDir = path.join(BUILD_ROOT, folderName);

  ensureDir(BUILD_ROOT);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  ensureDir(destDir);

  // Keep repo env.js in sync with this build target for local unpacked use
  fs.writeFileSync(path.join(ROOT, "env.js"), sourceCode, "utf8");

  console.log(`Building ${env.label} package (env=${envName})...`);
  console.log(`POS: ${env.posUrl}`);
  console.log(`API: ${env.posOrigin}${env.chatApiPath}`);
  console.log("");
  const obfuscate = envName !== "live";
  console.log(
    obfuscate ?
      "JS (terser + javascript-obfuscator):"
    : "JS (terser minify only — no obfuscation for live/store builds):",
  );
  const jsFiles = envName === "live" ? JS_FILES : [...JS_FILES, ...LOCAL_ONLY_JS];
  for (const file of jsFiles) {
    await buildJs(file, destDir, { obfuscate });
  }

  console.log("JS (minify only — env / POS bridge/inject):");
  await buildMinifiedOnlyJs(sourceCode, "env.js", destDir);
  for (const file of ["posBridge.js", "posInject.js"]) {
    const original = readRequired(file);
    await buildMinifiedOnlyJs(original, file, destDir);
  }

  console.log("CSS (minified):");
  for (const file of CSS_FILES) {
    buildCss(file, destDir);
  }

  console.log("HTML (minified):");
  for (const file of HTML_FILES) {
    buildHtml(file, destDir);
  }

  console.log("Icons (copied):");
  fs.cpSync(path.join(ROOT, ICON_DIR), path.join(destDir, ICON_DIR), {
    recursive: true,
  });
  fs.readdirSync(path.join(destDir, ICON_DIR)).forEach((f) =>
    console.log(`  ${ICON_DIR}/${f}`),
  );

  console.log("JSON (minified + env matches):");
  buildManifest(destDir, version, env);

  writeInstallReadme(destDir, version, env);

  const latestName = `store-sync-whatsapp-sender-${envName}`;
  const latestDir = path.join(BUILD_ROOT, latestName);
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.cpSync(destDir, latestDir, { recursive: true });

  // Store upload: manifest.json at the zip root, without developer notes
  let storeZipName = "";
  if (envName === "live") {
    storeZipName = `${folderName}-store.zip`;
    const zipped = writeZip(
      destDir,
      path.join(BUILD_ROOT, storeZipName),
      STORE_ZIP_EXCLUDE,
    );
    console.log("");
    console.log(`Store zip (${zipped.length} files, no ${STORE_ZIP_EXCLUDE.join(", ")}):`);
    console.log(`  build/${storeZipName}`);
  }

  const listed = fs.readdirSync(destDir).sort();
  console.log("");
  console.log(`Build ready: build/${folderName}/`);
  console.log(`Latest (load this unpacked, then just reload): build/${latestName}/`);
  console.log(`Version: v${version}`);
  console.log(`Environment: ${envName}`);
  console.log(`Files (${listed.length}):`);
  listed.forEach((f) => console.log(`  - ${f}`));
  console.log("");
  console.log("Share that folder (or zip it) with your friend.");
  if (storeZipName) {
    console.log(`Chrome Web Store upload: build/${storeZipName}`);
  }
  console.log(`Example zip name: ${folderName}.zip`);
  if (obfuscate) {
    console.log(
      "Note: obfuscation makes reading harder; it does not make code uncopyable.",
    );
  }
}

main().catch((err) => {
  console.error("Build failed:", err.message || err);
  process.exit(1);
});
