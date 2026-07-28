# Extension build (share with friends)

Create a **version-specific obfuscated package** under `build/` that you can zip and send. Friends install it with **Load unpacked** — they do not need your full repo.

Every package file is processed:

| File | Treatment |
|------|-----------|
| `content.js` | Minified (terser) + obfuscated (javascript-obfuscator) |
| `background.js` | Minified + obfuscated |
| `posAuth.js` | Minified + obfuscated |
| `popup.js` | Minified + obfuscated |
| `sidebar.css` | Minified |
| `popup.html` | Minified |
| `manifest.json` | Minified JSON (keys kept — Chrome requires them) |
| `INSTALL.txt` | Plain install steps for your friend |

This makes reading/editing painful. It does **not** make the extension uncopyable.

## Create a build

1. Bump `version` in `manifest.json` if you made changes (e.g. `1.70` → `1.71`).
2. Install build tools once:

```bash
npm install
```

3. From the project root run:

```bash
npm run build
```

4. Output folder:

```text
build/store-sync-whatsapp-sender-v1.70/
```

The folder name always matches `manifest.json` → `version`.

## What is not included

Keep these private: source repo, readable originals, `server.js`, `API.md`, `.cursor`, `content_old.js`, `node_modules`.

## Zip and share

**Windows (PowerShell)** from project root:

```powershell
npm run build
Compress-Archive -Path "build\store-sync-whatsapp-sender-v1.70\*" -DestinationPath "build\store-sync-whatsapp-sender-v1.70.zip" -Force
```

Replace `1.70` with the version printed by `npm run build`.

Send **only** that zip/folder — not the whole `what_ext` project.

## Friend install steps

1. Unzip.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select the folder that contains `manifest.json`.
5. Open [web.whatsapp.com](https://web.whatsapp.com) → refresh.
6. Confirm sidebar shows the same version (e.g. **v1.70**).
7. Log in to AI POS in the **same browser** (e.g. [https://testv3.websitedemolynk.com/pos/](https://testv3.websitedemolynk.com/pos/)).

## Updating a friend to a new version

1. Bump version + `npm run build` + send new zip.
2. Friend removes the old unpacked extension (or replaces the folder).
3. **Load unpacked** on the new folder.
4. Hard-refresh WhatsApp (`Ctrl+Shift+R`).

## Version checklist

- [ ] `manifest.json` `version` bumped
- [ ] `npm run build` succeeds (shows sizes for JS/CSS/HTML/JSON)
- [ ] Folder name is `store-sync-whatsapp-sender-v{version}`
- [ ] Zip named the same way
- [ ] Friend sees that version in the sidebar after reload
- [ ] Smoke-test: POS connect + API Start + Received listen still work on the obfuscated build

## Limits (honesty)

Obfuscation only raises the bar. Anyone with the installed extension can still extract and attempt to reverse it. Keep important business rules and secrets on your POS/API server.
