# Extension build (share with friends)

Create a **version-specific obfuscated package** under `build/` that you can zip and send. Friends install it with **Load unpacked** — they do not need your full repo.

Every package file is processed:

| File | Treatment |
|------|-----------|
| `content.js` | Minified (terser) + obfuscated |
| `background.js` | Minified + obfuscated |
| `posAuth.js` | Minified + obfuscated |
| `popup.js` | Minified + obfuscated |
| `posBridge.js` | Minified only (POS localStorage → extension) |
| `posInject.js` | Minified only (injectable auth reader) |
| `sidebar.css` | Minified |
| `popup.html` | Minified |
| `manifest.json` | Minified JSON |
| `INSTALL.txt` | Plain install steps |

## Live POS auth note

Live AI POS stores the JWT in **localStorage** (`authToken`), not cookies.  
`posBridge.js` runs on the POS tab and syncs auth into the extension. After install/reload, **refresh the POS tab** once, then open the extension popup.

## Create a build

```bash
npm install
npm run build
```

Output:

```text
build/store-sync-whatsapp-sender-v1.73/
build/store-sync-whatsapp-sender-v1.73.zip   # if you zip it
```

## Friend install

1. Load unpacked the build folder.
2. Open/login [https://testv3.websitedemolynk.com/pos](https://testv3.websitedemolynk.com/pos) and **refresh that tab**.
3. Open the extension popup — should show **Welcome …**.
4. Open WhatsApp Web and use the sidebar.

## Limits

Obfuscation makes reading harder; it does not make code uncopyable.
