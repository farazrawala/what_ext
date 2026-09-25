# Extension environments & build

Two environments control which POS/API the extension talks to:

| Env | POS URL | Chat API |
| --- | ------- | -------- |
| **local** | `http://localhost:8000/` | `http://localhost:8000/api/chat/...` |
| **live** | [https://testv3.websitedemolynk.com/pos/](https://testv3.websitedemolynk.com/pos/) | `https://testv3.websitedemolynk.com/pos_admin/api/chat/...` |

Config files:

- `env/local.js` — local definitions
- `env/live.js` — live definitions
- `env.js` — **active** env for unpacked development (copied by switch/build)

## Switch env (unpacked / Load unpacked from repo)

```bash
npm run env:local
npm run env:live
```

Then reload the extension in `chrome://extensions`.

## Create builds

```bash
npm install
npm run build:local   # → build/store-sync-whatsapp-sender-v{version}-local/
npm run build:live    # → build/store-sync-whatsapp-sender-v{version}-live/
npm run build:all     # both
npm run build         # alias for live
```

Every package file is processed:

| File | Treatment |
|------|-----------|
| `env.js` | Minified only (chosen env) |
| `content.js` | Minified + obfuscated |
| `background.js` | Minified + obfuscated |
| `posAuth.js` | Minified + obfuscated |
| `popup.js` | Minified + obfuscated |
| `posBridge.js` | Minified only |
| `posInject.js` | Minified only |
| `sidebar.css` | Minified |
| `popup.html` | Minified |
| `manifest.json` | Minified JSON (POS `content_scripts` matches for that env) |
| `INSTALL.txt` | Env-specific install steps |

## Friend install (live example)

1. Load unpacked `build/store-sync-whatsapp-sender-v*-live/`.
2. Open/login [https://testv3.websitedemolynk.com/pos](https://testv3.websitedemolynk.com/pos/) and **refresh that tab**.
3. Open the extension popup — should show **Welcome …**.
4. Open WhatsApp Web and use the sidebar.

## Friend install (local example)

1. Load unpacked `build/store-sync-whatsapp-sender-v*-local/`.
2. Open/login `http://localhost:8000/` and refresh that tab.
3. Open WhatsApp Web and use the sidebar.

## Limits

Obfuscation makes reading harder; it does not make code uncopyable.
