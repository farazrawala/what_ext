# Release checklist — Store Sync POS Messenger 1.119

Do not upload until every box you can do yourself is checked. This file does not publish the extension.

Package to upload, when the manual tests pass:

`build/store-sync-whatsapp-sender-v1.119-live-store.zip`

Build it with `node scripts/build-extension.js --env=live --no-bump`. The version is already 1.119. The unpacked source folder stays on the local env (`env.js` still has the Local | Live toggle). Load the **build** folder, not the repo root, when you test the store package. Do not upload the 1.118 zip; that package still includes call recording.

## Already done in this repo

- [x] Version in `manifest.json` is **1.119**
- [x] Call recording (Record button, mp3 save, `lame.min.js`) is removed. Voice call and the AI call agent remain.
- [x] `npm test` — 4 passed, 0 failed (`tests/api-allowlist.test.js`)
- [x] `node --check` on `background.js`, `content.js`, `posAuth.js`, `localSocket.js`, `popup.js`
- [x] Live package manifest host permissions are only:
  - `https://web.whatsapp.com/*`
  - `https://api.x.ai/*`
  - `https://generativelanguage.googleapis.com/*`
  - `https://testv3.websitedemolynk.com/*`
- [ ] Rebuild the live zip and confirm it has no `vendor/lame.min.js` and no Record button
- [x] Privacy policy, `features.html`, and `store-listing/STORE_LISTING.md` describe the optional Gemini/xAI agent and do not describe call recording

`npm audit` was run. The critical and high results are in `express` and `ws` for the local dev server only. They are not in the zip.

## You still have to do these

- [x] Privacy policy is live at https://testv3.websitedemolynk.com/pos/privacy-policy.html and matches this repo (no call-recording section). The same file is in `brands/ai-pos/public/privacy-policy.html`, but that copy is not committed. Commit it before the next POS deploy, or that deploy will put the recording text back.
- [ ] In the Chrome Web Store dashboard, paste the updated description and the `api.x.ai` / Gemini permission justifications from `store-listing/STORE_LISTING.md`. Do this in the same submission as the zip. The live listing was not changed from here.
- [ ] Confirm the privacy-policy field in the dashboard is still that URL, after the new file is deployed.
- [ ] Upload `build/store-sync-whatsapp-sender-v1.119-live-store.zip` only after the tests below pass. Unlisted, same as the current listing, unless you intend to change visibility.

## Manual test — store package

Load unpacked `build/store-sync-whatsapp-sender-v1.119-live/` (or the folder `build/store-sync-whatsapp-sender-live/`). Chrome version: current stable. Use a demo POS user and a WhatsApp account you can message from a second phone.

1. Fresh profile or remove the old unpacked extension first. Confirm the popup shows **v1.119** and there is **no** Local | Live toggle.
2. With no POS tab open, the popup should say to keep the POS open and logged in. It must not show a company name.
3. Open https://testv3.websitedemolynk.com/pos/ , sign in, refresh that tab. Popup should greet the company. The sidebar on WhatsApp Web should say POS connected.
4. Sign out of the POS and refresh. Popup should drop the greeting. Sending should stop with a not-logged-in error, not send another chat.
5. Sign in again. Queue one test message to a number you control. Press Start. Exactly one WhatsApp message arrives. The POS row becomes sent.
6. Press Stop during the "next message" countdown. No further message is sent. Refresh WhatsApp Web. Sending does not continue on its own.
7. Start a send, and while WhatsApp is opening the chat refresh the tab once. You should get either one message (if it had not gone out yet) or no second copy (if it had already been accepted). You should not get two copies of a message that already left.
8. From another phone, send a new text to the business account. It shows on Received and is stored once in the POS. Refresh WhatsApp Web. The same message is not posted a second time.
9. Turn message reading off in Settings, reload the sidebar, send another text from the second phone. It is not saved to the POS.
10. Disconnect the network, press Start. The status shows a retry, not a crash. Restore the network and confirm it continues or stops cleanly when you press Stop.
11. Close the WhatsApp tab in the middle of a send. Open WhatsApp Web again. The queue must not still be running.
12. Optional voice: place a call with the AI agent off. No mp3 is saved. No request to `generativelanguage.googleapis.com` or `api.x.ai` should appear in the extension service worker network log.
13. Optional agent: save a Gemini key, enable the agent, place one call. The service worker can open `generativelanguage.googleapis.com`. Hang up from Take over. Repeat once with Grok if you use that provider.

## Changelog (1.118)

- The service worker only calls the configured POS chat API, and it only attaches the POS token when the URL is that host.
- A page script on WhatsApp Web can no longer start the queue through `postMessage`.
- Incoming chat names are shown as text, not HTML.
- Logs and on-screen API errors no longer include the POS token or message body. The store package drops `console.log`.
- After a refresh, a chat WhatsApp already accepted is marked sent instead of being sent again.
- The AI call agent can reach Google Gemini (`generativelanguage.googleapis.com`), which the default provider needs.
- Privacy policy and the store-listing notes describe the optional AI providers. Call recording is not part of this version.

## Known limits (not fixed)

- A script already running inside WhatsApp Web can still dispatch the page-world agent events. That is how the call tap is built. It cannot, by itself, start the POS queue or read the POS token.
- Updating the extension clears "listening stopped" and starts reply reading again until the user presses Stop.
- The `cookies` permission stays so older POS logins that use `pos_auth_token` still work.
- WhatsApp's page markup was not exercised in this pass. If Start cannot find the send button, that is a selector change, not a packaging failure.
