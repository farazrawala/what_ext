# Store Sync WhatsApp Sender — API URLs

Base origin is taken from the POS login cookie host (dev default: `http://localhost:5173`).

All chat REST paths are under:

```text
{origin}/api/chat/...
```

Auth: POS cookie `pos_auth_token` is sent as `Authorization: Bearer <token>` on requests from the extension background.

---

## 1. Fetch next outbound chat (API send tab)

|             |                                                                             |
| ----------- | --------------------------------------------------------------------------- |
| **Method**  | `GET`                                                                       |
| **URL**     | `{origin}/api/chat/fetch-random?company_id={companyId}`                     |
| **Example** | `http://localhost:5173/api/chat/fetch-random?company_id=abc123`             |
| **When**    | While **Start** is running on the API tab — polls for the next chat to send |

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
| **URL**     | `{origin}/api/chat/mark-sent/:id`                       |
| **Example** | `http://localhost:5173/api/chat/mark-sent/64f1a2b3c4d5` |
| **When**    | After WhatsApp send succeeds for that chat              |

`:id` is replaced with the chat `_id` from fetch-random.

Sets status → `sent`.

---

## 3. Mark chat as not available

|             |                                                                       |
| ----------- | --------------------------------------------------------------------- |
| **Method**  | `GET`                                                                 |
| **URL**     | `{origin}/api/chat/mark-not-available/:id`                            |
| **Example** | `http://localhost:5173/api/chat/mark-not-available/64f1a2b3c4d5`      |
| **When**    | After WhatsApp send fails (invalid number / chat could not be opened) |

`:id` is replaced with the chat `_id` from fetch-random.

Sets status → `not_available`.

---

## 4. Create / store incoming chat message (Received tab)

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| **Method**  | `POST`                                                    |
| **URL**     | `{origin}/api/chat/create/:token`                         |
| **Example** | `http://localhost:5173/api/chat/create/<pos_auth_token>`  |
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

| Field | Meaning |
|---|---|
| `from_user_id` | Customer WhatsApp number (who sent the message) — digits only |
| `to_user_id` | Store / logged-in WhatsApp number (who received it) — digits only |
| `message` | Message text |
| `message_id` | WhatsApp message id |
| `whatsapp_time` | WhatsApp message timestamp (ISO string preferred) |

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
GET  {origin}/api/chat/fetch-random?company_id={companyId}
GET  {origin}/api/chat/mark-sent/:id
GET  {origin}/api/chat/mark-not-available/:id
POST {origin}/api/chat/create/:token
```

---

## Related (not REST chat APIs)

| Connection            | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `ws://localhost:3000` | Local WebSocket — can trigger **Start** via `{ "type": "start-sending" }` |
| Cookies on POS origin | `pos_auth_token`, `pos_company_id`, `pos_company_name`                    |

---

## Quick reference

| Tab / feature           | Method | Path                                  |
| ----------------------- | ------ | ------------------------------------- |
| API → fetch next        | `GET`  | `/api/chat/fetch-random?company_id=…` |
| API → mark sent         | `GET`  | `/api/chat/mark-sent/:id`             |
| API → mark failed       | `GET`  | `/api/chat/mark-not-available/:id`    |
| Received → save inbound | `POST` | `/api/chat/create/:token`             |
