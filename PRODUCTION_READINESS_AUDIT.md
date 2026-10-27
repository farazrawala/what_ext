# Production readiness audit — Store Sync POS Messenger

Audit date: 26 October 2026  
Code audited: repository at version **1.117** (before the fixes in this change)  
Live listing checked: https://chromewebstore.google.com/detail/store-sync-pos-messenger/kgcdeemjfndahhdkdldpfjfamblhclih  
This pass did not upload a package or edit the live listing.

Line numbers below refer to the code **as audited**, before the remediation patch.

## 1. Executive summary

**Overall risk before fixes: High.**  
**Release recommendation before fixes: NOT READY.**

The queued-send and reply-save path is wired to the live POS and that API is up. The extension is Manifest V3, it does not download remote scripts, and the live build already strips localhost hosts, `localSocket.js`, and obfuscation.

It was not safe to publish the next build as-is:

- A script running on WhatsApp Web could start the sender and point the background request at any URL. The service worker then attached the Store Sync POS bearer token to that request.
- The privacy policy and the store summary say message data goes only to the POS. The code also sends call audio to xAI or Google when the user turns on the AI call agent, and the default provider (Gemini) is missing its host permission, so that path fails.
- Logs and some error text include message bodies and the POS token (the token is placed in the chat-create URL).

**After the fixes in this change:** see the remediation section at the end. Remaining release blockers are manual (republish the privacy policy, update the store dashboard text, and run the WhatsApp/POS checks). Those cannot be completed from this repository.

### What was verified from outside the editor

| Check | Result |
| --- | --- |
| Store page HTTP | 200. Title: "Store Sync POS Messenger for WhatsApp Web". Meta description matches `manifest.json`. |
| Privacy policy link on the store page | `https://testv3.websitedemolynk.com/pos/privacy-policy.html` (present in the page HTML) |
| Full overview text on the store page | Not in the static HTML (the overview tab is filled in by the store's client script). Compared against `store-listing/STORE_LISTING.md` instead. |
| Live POS `https://testv3.websitedemolynk.com/pos/` | HTTP 200 |
| Live chat API `.../pos_admin/api/chat/fetch-random?company_id=test` | HTTP 400 with JSON `company_id must be a valid 24-character MongoDB ObjectId` — the route is the API |
| Hosted privacy policy | HTTP 200, HTML, same title as `privacy-policy.html` |
| `npm audit` (26 Oct 2026) | 1 critical, 5 high, 1 moderate. All are in `express` / `ws`, used only by the local dev server `server.js`. They are not copied into the extension zip. |
| Automated extension tests | None existed at audit time. |
| WhatsApp Web UI automation | Not run. Selectors and send/receive behavior need the manual script in `RELEASE_CHECKLIST.md`. |

## 2. Architecture (inspected)

| Piece | Role |
| --- | --- |
| `manifest.json` | MV3. Service worker `background.js`. Content scripts on WhatsApp Web and POS origins. Popup `popup.html`. No options page. No `externally_connectable`. No remote script URL. |
| `env.js` / `env/live.js` / `env/local.js` | Active POS origin. Unpacked repo is **local** (`http://localhost:8000`) with a Live alternate. Store packages must be `npm run build:live`. |
| `background.js` | POS API proxy, auth header, incoming-chat POST, Gemini/Grok voice sockets. |
| `content.js` | Sidebar, send queue, reply reader, call buttons. Isolated world. |
| `callTap.js` | MAIN world from `document_start`. Hooks `getUserMedia`, Web Audio, and `RTCPeerConnection` so calls can be recorded or driven by the agent. |
| `posBridge.js` / `posInject.js` | Read POS `localStorage` `authToken` and cache it in `chrome.storage.local`. |
| `posAuth.js` | Cache, cookie fallback, API URL builders. |
| `popup.js` | Shows POS login name and opens WhatsApp Web. |
| `localSocket.js` | Dev only (`ws://localhost:3000`). Omitted from live builds. |
| `scripts/build-extension.js` | Minifies, writes the store zip, **replaces** `host_permissions`. Live builds are not obfuscated. |
| Not in the store zip | `server.js`, `content_old.js`, `features.html`, `qrcode.min.js`, `qrcode_genrator.html`, `node_modules/`, store-listing HTML, `API.md`. |

Default extension CSP for MV3 extension pages applies (`script-src 'self'`). No `eval` or remote `<script>` in the extension package. `new Function` exists only in `scripts/env-source.js`, which runs at build time in Node, not in Chrome.

## 3. Findings

Severity is the impact if the next build is published without a fix.

### Critical

None that are exploitable with no script on the page. The token-forwarding bug below is rated High because it needs script already running on `web.whatsapp.com` (or a user click after that script rewrites the hidden URL fields).

### High

#### H1. POS bearer token can be sent to a URL chosen from the WhatsApp page

**Verified in code.**

- `content.js` listens for `window` `message` events and clicks Start when `data.type === "wa-start-sending-from-socket"`. It does not check `event.source`. Any page script on WhatsApp Web can post that message. Lines 5569–5576.
- The fetch / mark-sent / mark-not-available URLs are ordinary DOM inputs (`wa-fetch-url` and the two mark inputs), including when they are visually hidden. Page script can change them before Start. Lines 2228–2234 and 4708–4746.
- `background.js` `wa-api-request` fetches `message.url` and `attachPosAuthHeaders` adds `Authorization: Bearer <POS token>` with no host check. Lines 9–15 and 161–182.
- `wa-post-incoming-chat` substitutes the token into `message.receiveUrlTemplate` and POSTs there. Lines 51–86. `buildReceivePostUrl` in `posAuth.js` lines 567–579.

**Reproduction**

1. Load the extension, sign in to the POS, open WhatsApp Web, open the sidebar.
2. From the WhatsApp page console (page world, not the extension world): set `#wa-fetch-url` to `https://example.invalid/api/chat/fetch-random` and `postMessage({ type: "wa-start-sending-from-socket" }, "*")`.
3. The service worker fetches that host with the POS bearer token.

**Impact:** theft of the POS session token. The attacker can then call the POS as that user.

**Fix:** accept API calls only for the configured POS chat API; never put the token into a URL whose host is not that POS; ignore the page `postMessage` start signal. Dev socket start already uses `chrome.tabs.sendMessage`.

#### H2. Chat name is written with `innerHTML`

**Verified in code.** `content.js` `prependReceivedItem` puts `fromLabel` (WhatsApp chat name) inside `innerHTML`. Only `"` is escaped. Lines 2866–2873. Message text itself uses `textContent` (line 2883) and is safe.

**Reproduction:** a contact display name of `<img src=x onerror=alert(1)>` is rendered as HTML in the sidebar's isolated world. That world can call `chrome.runtime.sendMessage`.

**Impact:** with H1, this is a second way to reach the API proxy. On its own it runs script in the content-script world when a hostile display name is shown.

**Fix:** set the name with `textContent`.

#### H3. Privacy policy and store text do not match the extension

**Verified** by reading `privacy-policy.html`, `store-listing/STORE_LISTING.md`, `features.html` lines 527–528, and the code.

The policy says:

- data goes to the POS "and nowhere else" (lines 131–142 and 177–178)
- the extension does not read or upload WhatsApp call data (lines 131–134)

The code:

- `callTap.js` records call audio and can replace the mic while the agent is armed
- `background.js` lines 291–321 and 481–691 open sockets to `wss://api.x.ai` and `wss://generativelanguage.googleapis.com` using keys the user saved
- the default agent provider is Gemini (`content.js` line 5007)

The store meta description (verified on the live page) only describes queued send and reply save. `STORE_LISTING.md` permission text does not mention `https://api.x.ai/*`. The hosted policy URL returns the same "nowhere else" text.

**Impact:** Chrome Web Store User Data Policy. A review can reject the update, or the current listing can be taken down, because disclosure does not match behavior. This is a policy defect, not a guess.

**Fix:** correct `privacy-policy.html`, `features.html`, and `STORE_LISTING.md`. Republish the policy on the POS host and paste the new disclosure into the developer dashboard. This repository cannot publish either of those.

#### H4. Gemini calls have no host permission

**Verified in code.** `background.js` lines 315–321 and 596–691 call `generativelanguage.googleapis.com`. `manifest.json` `host_permissions` and `scripts/build-extension.js` line 328 allow `https://api.x.ai/*` only. The live build **replaces** the manifest host list, so editing the manifest alone is not enough.

**Impact:** the default AI call agent cannot open its socket or rewrite Urdu script. Grok can, because `api.x.ai` is allowed. Chrome extension host permissions are required for those requests from the service worker.

**Fix:** add `https://generativelanguage.googleapis.com/*` in both the manifest and the build script, and disclose it.

### Medium

#### M1. Message text and the POS token are logged and sometimes shown

**Verified.** Examples:

- `background.js` line 76 logs the create URL (token is in the path) and the message body
- `background.js` lines 222–228 and 240–251 log the full API JSON
- `content.js` lines 2946, 2970–2999, 4548, 4571–4589, 4603–4606 log message text
- `formatApiErrorInfo` keeps the raw URL, and `renderReceivedPostState` writes `info.url` into the sidebar DOM (`content.js` lines 2153–2156). Page script can read that DOM. A failed create can reveal the token.

`scripts/build-extension.js` minifies with `drop_console: false` (line 200), so the store package keeps these logs.

**Fix:** redact tokens in URLs before they are logged or returned to the page; stop logging message bodies; drop `console.log` / `console.debug` / `console.info` from the packaged build. Keep `console.warn` and `console.error` for failures, without the body.

#### M2. Refresh during send can send the same chat again

**Verified.** The queue is `sessionStorage` (`content.js` lines 881–883). `processApiQueue` saves `currentId` **before** `sendOneMessage` (lines 4608–4613). On the next load, lines 5578–5604 send that chat again, then mark it sent.

**Reproduction:** press Start, refresh WhatsApp Web while a chat is being sent, let the sidebar come back.

**Impact:** the customer can receive the same WhatsApp message twice. Mark-sent does not run until after the second send.

**Fix:** remember a `phase` of `sent` after WhatsApp accepts the message and, on resume, only call mark-sent for that phase.

#### M3. MAIN-world call hooks can be poked by page script

**Verified.** `callTap.js` lines 830–849 accept `CustomEvent` commands (`start` recording, `arm` agent) with no check. Isolated world and the page share DOM events. A secret on `window` would be readable by the page, so this cannot be closed while the tap stays in the page world.

**Impact:** a script already running inside WhatsApp Web can start a local mp3 recording or arm the mic swap. It cannot, by itself, open `chrome.runtime` and spend the user's AI key. That port is opened only from the sidebar's isolated world (`content.js` lines 5164–5179). This is the same trust boundary as any page-world hook.

**Not changed in this pass.** Removing the hooks would remove call recording and the agent. Treat it as a known limit of the feature.

#### M4. Listening turns back on when the sidebar version changes

**Verified.** `content.js` lines 2187–2189 delete `wa_listening_stopped` when `dataset.version` differs, so an extension update resumes reply reading even if the user had stopped it.

**Impact:** after an update, incoming messages are saved to the POS again until the user presses Stop. The comment shows this is intentional. Left unchanged so existing update behavior stays.

#### M5. `cookies` and broad POS host match

**Verified.** `cookies` is used as a fallback in `readPosAuth` (`posAuth.js` lines 407–445). Live AI POS primarily uses `localStorage` `authToken`. The permission is still exercised. `isPosTabUrl` also matches localhost regexes even in a live build (lines 119–124). Live `host_permissions` do not include localhost, so `executeScript` there fails closed.

**Not removed.** Dropping `cookies` would change the auth fallback. Left as-is on purpose.

### Low

#### L1. Dev-server dependency CVEs are not in the extension

`npm audit` on 26 Oct 2026: critical `proxy-addr`, high `body-parser`, `brace-expansion`, `fast-uri`, `path-to-regexp`, `ws`, moderate `qs`. They come from `express` and `ws` in `package.json`. `scripts/build-extension.js` never copies `node_modules`. Confirmed by the build file list. Do not treat `npm audit` as a store-package vulnerability. Patch the dev server on its own schedule.

#### L2. Dead files in the repo

`content_old.js`, `qrcode.min.js`, `qrcode_genrator.html`, `server.js` are not extension entry points. They are not in the store zip. Left in the repo so nothing working is deleted.

#### L3. No `minimum_chrome_version`

MV3 and the call hooks need a current Chrome. No version pin. Add one later if support wants a floor.

#### L4. Popup is a fixed 260px column

`popup.html` lines 6–8. Usable. Not a responsive settings page. Settings live in the WhatsApp sidebar.

#### L5. `console` noise in `callTap.js`

Mic-path logs run in the page console. They do not include message text. Packaging strips `console.log` after this change.

### Potential risks that need a person at the keyboard

These were **not** executed against WhatsApp Web or a logged-in POS.

- WhatsApp DOM for the send button, invalid-number dialog, and unread badges changes without notice. `content.js` is full of selectors that only fail in a real session.
- Reply dedup uses in-memory `seenIds` plus stored ids (`content.js` around 3015). Confirm a reload does not re-post the same WhatsApp message id.
- Stop sets `stopSending` and clears the queue (`content.js` lines 4795–4804). Confirm a click during the pre-send countdown does not let one more message go out.
- Service worker restart drops the voice socket. The send loop lives in the tab, not the worker, so a worker restart should not by itself continue sending. Confirm after a forced worker stop.
- Closing the WhatsApp tab drops `sessionStorage`, so the queue should not resume in a new tab. Confirm.
- AI agent: Gemini key in the WebSocket query string is how that API authenticates. It will show in the extension's network panel. Keys are stored in `chrome.storage.local`, not in the repo. No key was found in the source.
- Trademark: the name includes "WhatsApp". The description says it is not affiliated with WhatsApp or Meta. The current listing is published with that name. Residual policy risk, not a new defect.
- Single purpose: voice agent is extra surface area. Disclosure is required. Whether review calls it a second purpose is their decision; do not assume the current listing covers it.

## 4. Chrome Web Store policy risks

| Topic | Evidence | Risk |
| --- | --- | --- |
| User data disclosure | Policy and listing omit xAI, Google, and call audio | High until the policy URL and dashboard text match the code |
| Host permissions | `scripting`, `cookies`, `storage`, WhatsApp, POS, `api.x.ai`. No `<all_urls>`, no `webRequest`, no `tabs` permission (`tabs` is used only where host access already exists) | `cookies` is justified by the cookie fallback. `api.x.ai` and Gemini must be in the permission justification |
| Remote code | No fetched scripts. Libraries `vendor/lame.min.js` and the build are packed locally. LAME license file is copied | Meets the "no remote code" answer, as long as the dashboard still says No |
| Obfuscation | Live build does not obfuscate (`scripts/build-extension.js` line 413) | Meets the store rule |
| Deceptive behavior | Summary matches send + save replies. Voice tools are undisclosed | Fix the listing before the next submission |
| Data sale / ads / credit | No analytics or ad SDK found | Consistent with the three certifications, for POS data. AI providers are processors the user opts into, and must be named |

## 5. Security and privacy

- No API keys, passwords, or POS tokens are committed in the extension source. Agent keys are typed by the user into `chrome.storage.local`.
- POS token storage: `chrome.storage.local` key `wa_pos_auth_cache:<origin>` from `posBridge.js`. Logout on the POS page removes that key (`posBridge.js` lines 75–82). Cache entries older than 24 hours are ignored (`posAuth.js` lines 303–305).
- HTTPS is used for the live POS and both AI providers. Local env is `http://localhost` on purpose and is not in the store zip.
- Message channel: no `externally_connectable`. Web pages cannot call `chrome.runtime.sendMessage` directly. The holes are the shared DOM (H1, H2) and the page `postMessage` listener (H1).
- `wa-call-agent` port carries microphone audio to the provider the user selected. Keys are read only in the service worker (`background.js` lines 789–798).

## 6. Reliability notes (from code, not from a live WhatsApp session)

- Send loop is one chat at a time with a random delay (min 2s, max 12s in the hidden fields; the visible Settings tab controls reply reading, not this delay).
- Empty `fetch-random` waits and retries until Stop.
- Mark-sent failure stops the run instead of sending the next chat (`content.js` lines 4624–4629).
- Incoming posts retry on the Settings interval (default 60s).
- Duplicate incoming posts are skipped when `messageId` is already in `seenIds`.
- POS auth on the POS tab is re-read every 3 seconds (`posBridge.js` line 99). That is one timer per POS tab, not per WhatsApp chat.
- Extension reload shows a stale banner and stops the run (`content.js` `onExtensionStale`).

## 7. Tests

| Test | At audit time |
| --- | --- |
| Unit tests | None in the repo |
| Lint script | None |
| `npm audit` | Executed. Results in L1. Not a store-package failure |
| Live POS / API / policy URL | Executed. Results in section 1 |
| Store listing HTML | Executed for title, summary, privacy link. Full overview not in the static HTML |
| WhatsApp send, receive, stop, refresh, logout | **Not run** |

## 8. Prioritized remediation

1. Block non-POS API URLs and stop putting the token on other hosts (H1).
2. Remove the page `postMessage` start hook (H1).
3. Escape chat names (H2).
4. Redact tokens and message bodies in logs and error UI (M1). Drop packaged `console.log`.
5. Allow Gemini's host (H4) and disclose it (H3).
6. Avoid a second WhatsApp send after refresh once the send has already succeeded (M2).
7. Republish the privacy policy and update the store dashboard (manual).
8. Run the manual WhatsApp/POS script.
9. Leave M3, M4, M5, and the dev-server CVEs unless you want those behavior changes.

## 9. Release recommendation

**NOT READY** at the start of this audit.

Do not upload `build/*-store.zip` until H1–H4 and M1 are fixed, the hosted privacy policy matches, the dashboard text names the AI hosts, and the manual script in `RELEASE_CHECKLIST.md` has been run on a real WhatsApp Web session.

## 10. Fixes applied in this change

Applied in the working tree after the audit, without changing POS URL paths, the `create/:token` contract, or auth storage keys.

| ID | What changed |
| --- | --- |
| H1 | `isAllowedPosApiUrl` allows only the active env's POS origins (plus a local build's Live alternate) and only `/api/chat` paths. The token is inserted and the `Authorization` header is set only when that check passes and the token's origin matches the URL. The WhatsApp page `postMessage` start listener is removed. Dev socket start still uses `chrome.tabs.sendMessage` only. Service worker messages must come from this extension's id. |
| H2 | Received-row chat names use `textContent`. |
| H3 | `privacy-policy.html`, `features.html`, and `store-listing/STORE_LISTING.md` now describe local call recording and the optional Gemini/xAI agent. **The hosted policy and the live listing are not updated by this commit.** |
| H4 | `https://generativelanguage.googleapis.com/*` added in `manifest.json` and in the live/local host list inside `scripts/build-extension.js`. |
| M1 | Token redaction on URLs returned to the page and on logs. Message bodies removed from those logs. Packaged builds drop `console.log`, `console.debug`, and `console.info`. |
| M2 | Queue `phase: "sent"` after a successful WhatsApp send. A refresh then mark-sents that id instead of sending it again. A refresh **before** WhatsApp accepts the send still retries once (the message may or may not have left). |

Left unchanged on purpose: call-tap CustomEvents (M3), resume-listening-on-update (M4), `cookies` permission (M5), production API host `testv3.websitedemolynk.com`, auth token storage, and the chat API paths.

Checks run after the patch:

- `npm test`: 4 passed, 0 failed.
- `node --check` succeeded for `background.js`, `content.js`, `posAuth.js`, `localSocket.js`, and `popup.js`.
- Live zip `build/store-sync-whatsapp-sender-v1.118-live-store.zip` was built and inspected: version 1.118, no localhost host, Gemini and xAI hosts present, no `console.log`, no `localSocket.js`, no `node_modules`, manifest at the zip root.
- WhatsApp Web itself was not driven. That remains a manual step.

**Recommendation after this patch: READY AFTER FIXES.**  
Code blockers H1, H2, H4, M1, and M2 are addressed in the repo. The update is still not ready to upload until:

1. `privacy-policy.html` is deployed to `https://testv3.websitedemolynk.com/pos/privacy-policy.html`
2. The Chrome Web Store dashboard text and permission justifications are updated from `store-listing/STORE_LISTING.md` (not done here)
3. The manual tests in `RELEASE_CHECKLIST.md` pass on WhatsApp Web

M3 remains a documented limit of the page-world call tap.
