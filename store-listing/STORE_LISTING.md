# Chrome Web Store listing — Store Sync POS Messenger

Copy-paste text and assets for the Chrome Web Store developer dashboard.
Upload file: `build/store-sync-whatsapp-sender-v{version}-live-store.zip` (from `npm run build:live`).

---

## Store listing tab

**Name** (from the manifest): Store Sync POS Messenger for WhatsApp Web

**Summary** (from the manifest, 132 max):
> Sends customer messages queued in your Store Sync POS via WhatsApp Web and saves replies to the POS. Not affiliated with WhatsApp.

**Category:** Productivity → Communication
**Language:** English

**Description:**

```text
Store Sync POS Messenger connects your Store Sync POS account to WhatsApp Web, so your team can message customers from the POS without copying and pasting.

WHAT IT DOES
• Sends queued messages: press Start and the extension sends the customer messages your Store Sync POS has queued, one at a time, from your own WhatsApp Web. Each message is marked "sent" or "not available" in your POS.
• Saves customer replies: while listening is on, new incoming text messages are copied into your Store Sync POS so your team can follow up there. Messages you sent yourself are skipped.
• Uses your POS sign-in: keep your Store Sync POS open and signed in; the extension uses that session, so there is nothing extra to log in to.
• Adjustable pacing: set the gap between messages and how often replies are checked on the Settings tab.

HOW TO USE
1. Sign in to your Store Sync POS in Chrome.
2. Open WhatsApp Web and sign in with the business's WhatsApp account.
3. Click the extension icon and choose "Open WhatsApp Web" to show the sidebar.
4. Press Start to send queued messages. Listening for replies starts automatically and can be stopped at any time.

WHO IT IS FOR
Businesses that use Store Sync POS and want to message their own customers from WhatsApp Web. A Store Sync POS account is required.

PRIVACY
Message data goes only to your Store Sync POS server. Nothing is sold, used for advertising, or shared with anyone else. The extension only runs on WhatsApp Web and your Store Sync POS site. Full policy: https://testv3.websitedemolynk.com/pos/privacy-policy.html

Store Sync POS Messenger is not affiliated with, endorsed by, or sponsored by WhatsApp or Meta. WhatsApp is a trademark of WhatsApp LLC.
```

**Images** (all in this folder):

| Dashboard field | File | Size |
| --- | --- | --- |
| Store icon | `../icons/icon128.png` | 128×128 |
| Screenshot 1 | `screenshot-1-send.png` | 1280×800 |
| Screenshot 2 | `screenshot-2-received.png` | 1280×800 |
| Small promo tile | `promo-tile-440x280.png` | 440×280 |

**Homepage URL:** https://testv3.websitedemolynk.com/pos/
**Support URL:** https://ordershub.pk (or a contact page there), support email info@ordershub.pk

**Account tab:** publisher display name `OrdersHub`, contact email `info@ordershub.pk` (Google sends a verification link to it).

---

## Privacy practices tab

**Single purpose:**

```text
Lets a business that uses Store Sync POS message its customers through WhatsApp Web: it sends the customer messages queued in the business's Store Sync POS and saves the customers' replies back into that POS.
```

**Permission justifications:**

`storage`
```text
Stores the user's Store Sync POS sign-in (token, company ID and name) so the extension stays signed in, plus the extension's settings and the IDs of messages already saved, so the same reply is not saved twice. Kept only in the browser.
```

`scripting`
```text
Shows the extension's sidebar on WhatsApp Web when the user clicks "Open WhatsApp Web" in the popup, and reads the user's Store Sync POS sign-in from the open POS tab. Scripts run only on web.whatsapp.com and the Store Sync POS site.
```

`cookies`
```text
Reads the Store Sync POS sign-in cookie on the Store Sync POS domain only, so the extension can call the POS API as the signed-in user. No other site's cookies are read.
```

Host permissions (`https://web.whatsapp.com/*`, `https://testv3.websitedemolynk.com/*`)
```text
web.whatsapp.com: the extension's sidebar runs on WhatsApp Web to send the messages queued in the user's POS and to read new incoming replies.
testv3.websitedemolynk.com: this is the Store Sync POS. The extension reads the user's POS sign-in there and calls the POS API to get queued messages, mark them sent, and save incoming replies.
```

**Remote code:** No, I am not using remote code.
(All JavaScript is in the package; nothing is downloaded and run.)

**Data usage — what the extension collects:**

| Category | Tick? | Why |
| --- | --- | --- |
| Personally identifiable information | ✅ | Customer phone numbers and names in chats; POS user name/email |
| Health information | ☐ | |
| Financial and payment information | ☐ | |
| Authentication information | ✅ | Store Sync POS sign-in token |
| Personal communications | ✅ | Text of messages sent and received |
| Location | ☐ | |
| Web history | ☐ | |
| User activity | ☐ | |
| Website content | ☐ | Message text is already covered by "Personal communications" |

**Certifications** — tick all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://testv3.websitedemolynk.com/pos/privacy-policy.html (served from `public/privacy-policy.html` in the ai-pos repo; keep it in sync with `../privacy-policy.html`)

---

## Distribution tab

**Visibility:** Unlisted (install from a direct link; not shown in search).
**Regions:** all regions, or only the countries you sell in.

---

## Test instructions tab

Enter the demo account in the dashboard only — never commit it to this repo.

```text
1. Sign in at https://testv3.websitedemolynk.com/pos/ with:
   Username: <demo username>
   Password: <demo password>
   The demo account already has a few queued messages.
2. Open https://web.whatsapp.com and sign in with any WhatsApp account (scan the QR code with a phone).
3. Click the extension icon → "Open WhatsApp Web". The sidebar shows "Store Sync POS Messenger".
4. On "Start Sending Messages", press Start. The queued messages are sent one at a time to the demo numbers and marked sent in the POS.
5. Send a WhatsApp message to the signed-in account from another phone. It appears on the "Received" tab and is saved to the POS.
```

---

## Regenerating the images

The screenshots render the real `content.js` and `sidebar.css` with demo data (`screenshot.html`; `promo-tile.html` for the tile). After UI changes, from the repo root:

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
for t in api received; do
  "$CHROME" --headless=new --hide-scrollbars --allow-file-access-from-files \
    --window-size=1280,900 --virtual-time-budget=3000 \
    --screenshot="store-listing/$t-tall.png" \
    "file:///$PWD/store-listing/screenshot.html?tab=$t&v=<version>"
done
```

Then crop each to the top 1280×800 (the extra height avoids a blank strip at the bottom) and save as `screenshot-1-send.png` / `screenshot-2-received.png`.
