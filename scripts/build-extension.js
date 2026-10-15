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
const { minify } = require("terser");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.resolve(__dirname, "..");
const BUILD_ROOT = path.join(ROOT, "build");

/** Minified with terser; also obfuscated in local builds only. */
const JS_FILES = ["content.js", "background.js", "posAuth.js", "popup.js"];

/** Minify only (no obfuscator) — POS auth bridge/inject must stay reliable. */
const MINIFY_ONLY_JS = ["posBridge.js", "posInject.js", "env.js"];
const CSS_FILES = ["sidebar.css"];
const HTML_FILES = ["popup.html"];

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

function loadEnvConfig(envName) {
  const src = path.join(ROOT, "env", `${envName}.js`);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing env file: env/${envName}.js`);
  }
  // Evaluate in a sandbox-ish scope
  const code = fs.readFileSync(src, "utf8");
  const sandbox = { self: {}, window: undefined };
  // eslint-disable-next-line no-new-func
  const fn = new Function("self", "window", `${code}\n; return typeof WA_ENV !== "undefined" ? WA_ENV : self.WA_ENV;`);
  const env = fn(sandbox.self, undefined);
  if (!env?.name || !env?.posOrigin) {
    throw new Error(`Invalid WA_ENV in env/${envName}.js`);
  }
  return { env, sourcePath: src, sourceCode: code };
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

  // POS bridge and host access only on this environment's hosts
  const posMatches = Array.isArray(env.posTabMatch) ? env.posTabMatch : [];
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
- Local and Live builds are separate — do not mix them.

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
  for (const file of JS_FILES) {
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

  console.log("JSON (minified + env matches):");
  buildManifest(destDir, version, env);

  writeInstallReadme(destDir, version, env);

  const latestName = `store-sync-whatsapp-sender-${envName}`;
  const latestDir = path.join(BUILD_ROOT, latestName);
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.cpSync(destDir, latestDir, { recursive: true });

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
