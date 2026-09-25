# Store Sync WhatsApp Sender — API URLs

Base origin comes from the **active environment** (`env.js` / build `--env`).

| Env | POS URL | Chat API base |
| --- | ------- | ------------- |
| **Local** | `http://localhost:8000/` | `{origin}/api/chat/...` |
| **Live** | [https://testv3.websitedemolynk.com/pos/](https://testv3.websitedemolynk.com/pos/) | `{origin}/pos_admin/api/chat/...` |

Live AI POS sets `VITE_API_BASE_URL` to `/pos_admin/api` (backend). The SPA at `/pos/` is not the API — calling `/pos/api/...` returns HTML.

Auth: Live AI POS stores the JWT in **localStorage** (`authToken`). The extension reads it from an open POS tab (and still supports cookie `pos_auth_token` for older/dev builds). That token is sent as `Authorization: Bearer <token>` on requests from the extension background.

Switch env (unpacked repo):

```bash
npm run env:local
npm run env:live
```

Build packages:

```bash
npm run build:local   # → build/...-vX.Y-local/
npm run build:live    # → build/...-vX.Y-live/
npm run build:all
```

---

## 1. Fetch next outbound chat (API send tab)

|             |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| **Method**  | `GET`                                                                             |
| **URL**     | `{apiBase}/fetch-random?company_id={companyId}`                                   |
| **Local**   | `http://localhost:8000/api/chat/fetch-random?company_id=abc123`                   |
| **Live**    | `https://testv3.websitedemolynk.com/pos_admin/api/chat/fetch-random?company_id=…` |
| **When**    | While **Start** is running on the API tab — polls for the next chat to send       |

**Expected response (success):** JSON with a chat that has status `not_started`. The extension reads:

```json
{
  "success": true,
  "data": {
    "_id": "<chatId>",
    "message": "Hello…",
    "to_user_id": "923001234567"
  }
}
```

Accepted field aliases for the item:

- id: `_id` or `id`
- message: `message`, `text`, or `body`
- number: `number`, `phone`, `to_user_id`, `toUserId`, or `recipient`

If nothing is available (`success` false / empty data), the extension waits (min–max delay) and retries.

---

## 2. Mark chat as sent

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| **Method**  | `GET`                                                   |
| **URL**     | `{apiBase}/mark-sent/:id`                               |
| **Example** | `http://localhost:8000/api/chat/mark-sent/64f1a2b3c4d5` |
| **When**    | After WhatsApp send succeeds for that chat              |

`:id` is replaced with the chat `_id` from fetch-random (`data._id` only — not `message_id`).

Sets status → `sent`.

On failure, the API may return `received_id` showing exactly which id the extension sent.

---

## 3. Mark chat as not available

|             |                                                                       |
| ----------- | --------------------------------------------------------------------- |
| **Method**  | `GET`                                                                 |
| **URL**     | `{apiBase}/mark-not-available/:id`                                    |
| **Example** | `http://localhost:8000/api/chat/mark-not-available/64f1a2b3c4d5`      |
| **When**    | After WhatsApp send fails (invalid number / chat could not be opened) |

`:id` is replaced with the chat `_id` from fetch-random.

Sets status → `not_available`.

---

## 4. Create / store incoming chat message (Received tab)

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| **Method**  | `POST`                                                    |
| **URL**     | `{apiBase}/create/:token`                                 |
| **Example** | `http://localhost:8000/api/chat/create/<pos_auth_token>`  |
| **When**    | New incoming WhatsApp message is captured while listening |

`:token` (or `:pos_auth_token`) is replaced with the POS auth token from cookies.

**Request body:**

```json
{
  "from_user_id": "923001234567",
  "to_user_id": "923009876543",
  "message": "Hello, is this available?",
  "message_id": "wa_msg_abc123",
  "whatsapp_time": "2026-07-25T02:15:30.000Z"
}
```

| Field           | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `from_user_id`  | Customer WhatsApp number (who sent the message) — digits only     |
| `to_user_id`    | Store / logged-in WhatsApp number (who received it) — digits only |
| `message`       | Message text                                                      |
| `message_id`    | WhatsApp message id                                               |
| `whatsapp_time` | WhatsApp message timestamp (ISO string preferred)                 |

**Headers:**

```http
Accept: application/json
Content-Type: application/json
Authorization: Bearer <pos_auth_token>
```

---

## URL templates (as built by the extension)

When POS is connected, defaults are:

```text
GET  {origin}/api/chat/fetch-random?company_id={companyId}          # local
GET  {origin}/pos_admin/api/chat/fetch-random?company_id={companyId} # live
GET  …/mark-sent/:id
GET  …/mark-not-available/:id
POST …/create/:token
```

---

## Related (not REST chat APIs)

| Connection            | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `ws://localhost:3000` | Local WebSocket — can trigger **Start** via `{ "type": "start-sending" }` |
| Cookies on POS origin | `pos_auth_token`, `pos_company_id`, `pos_company_name`                    |

---

## Quick reference

| Tab / feature           | Method | Path (local) / Path (live)                                      |
| ----------------------- | ------ | --------------------------------------------------------------- |
| API → fetch next        | `GET`  | `/api/chat/fetch-random` · `/pos_admin/api/chat/fetch-random`   |
| API → mark sent         | `GET`  | `/api/chat/mark-sent/:id` · `/pos_admin/api/chat/mark-sent/:id` |
| API → mark failed       | `GET`  | `/api/chat/mark-not-available/:id` · same under `pos_admin`     |
| Received → save inbound | `POST` | `/api/chat/create/:token` · `/pos_admin/api/chat/create/:token` |

// 4203
// Always auto-start listening on sidebar launch (ignore prior Stop in this tab)
sessionStorage.removeItem(LISTENING_STOPPED_KEY);
listeningManuallyStopped = false;
stopListening = false;
ensureReceiveListening({ forceRestart: true });
