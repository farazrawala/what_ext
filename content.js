(function () {
  const QUEUE_KEY = "wa_sender_queue";
  const API_SETTINGS_KEY = "wa_api_settings";
  const SEEN_MSG_KEY = "wa_seen_incoming_ids";
  const RECEIVED_LIST_KEY = "wa_received_list";
  const LISTENING_STOPPED_KEY = "wa_listening_stopped";
  const RECEIVE_SETTINGS_KEY = "wa_receive_settings";
  const RECEIVE_DISABLED_STATUS = "Message reading is turned off.";

  // Tunables edited on the Settings tab (saved in localStorage). Times are
  // entered in seconds; applyReceiveSettings() converts them to ms.
  const RECEIVE_SETTINGS_FIELDS = [
    { key: "readingEnabled", label: "Enable message reading", type: "bool", def: true },
    { key: "receiveDays", label: "Read messages from last (days)", min: 1, max: 30, def: 1 },
    { key: "chatGapMinSec", label: "Min gap between chats (seconds)", min: 5, max: 3600, def: 60 },
    { key: "chatGapMaxSec", label: "Max gap between chats (seconds)", min: 5, max: 3600, def: 120 },
    { key: "pollIntervalSec", label: "Check for new messages every (seconds)", min: 5, max: 600, def: 30 },
    { key: "openStuckSec", label: "Give up opening a chat after (seconds)", min: 10, max: 600, def: 45 },
    { key: "unreadRequeueSec", label: "Re-check unread badges every (seconds)", min: 5, max: 600, def: 16 },
    { key: "postRetrySec", label: "Retry failed API posts every (seconds)", min: 10, max: 3600, def: 60 },
    { key: "maxSeenIds", label: "Remember captured message IDs (count)", min: 50, max: 5000, def: 500 },
    { key: "maxListItems", label: "Received list size (messages)", min: 10, max: 500, def: 50 },
  ];

  function defaultReceiveSettings() {
    const out = {};
    RECEIVE_SETTINGS_FIELDS.forEach((f) => (out[f.key] = f.def));
    return out;
  }

  function sanitizeReceiveSettings(raw) {
    const out = defaultReceiveSettings();
    RECEIVE_SETTINGS_FIELDS.forEach((f) => {
      const v = raw?.[f.key];
      if (f.type === "bool") {
        if (typeof v === "boolean") out[f.key] = v;
        return;
      }
      const n = Math.round(Number(v));
      if (Number.isFinite(n)) out[f.key] = Math.min(f.max, Math.max(f.min, n));
    });
    if (out.chatGapMaxSec < out.chatGapMinSec) {
      out.chatGapMaxSec = out.chatGapMinSec;
    }
    return out;
  }

  function loadReceiveSettings() {
    try {
      const raw = localStorage.getItem(RECEIVE_SETTINGS_KEY);
      return sanitizeReceiveSettings(raw ? JSON.parse(raw) : {});
    } catch {
      return defaultReceiveSettings();
    }
  }

  function saveReceiveSettings(settings) {
    const clean = sanitizeReceiveSettings(settings);
    try {
      localStorage.setItem(RECEIVE_SETTINGS_KEY, JSON.stringify(clean));
    } catch (_) {}
    applyReceiveSettings(clean);
    return clean;
  }

  let MAX_SEEN_IDS;
  let MAX_LIST_ITEMS;
  let DEFAULT_RECEIVE_DAYS;
  // false → Received tab stays visible but reading is disabled (no Start/Stop).
  let RECEIVE_READING_ENABLED;
  let RECEIVE_CHAT_GAP_MIN_SEC;
  let RECEIVE_CHAT_GAP_MAX_SEC;
  let RECEIVE_POLL_INTERVAL_MS;
  let RECEIVE_OPEN_STUCK_MS;
  let RECEIVE_UNREAD_REQUEUE_MS;
  // Failed chat API posts are re-sent on this interval until they succeed.
  let RECEIVE_POST_RETRY_MS;

  function applyReceiveSettings(st) {
    RECEIVE_READING_ENABLED = st.readingEnabled;
    DEFAULT_RECEIVE_DAYS = st.receiveDays;
    RECEIVE_CHAT_GAP_MIN_SEC = st.chatGapMinSec;
    RECEIVE_CHAT_GAP_MAX_SEC = st.chatGapMaxSec;
    RECEIVE_POLL_INTERVAL_MS = st.pollIntervalSec * 1000;
    RECEIVE_OPEN_STUCK_MS = st.openStuckSec * 1000;
    RECEIVE_UNREAD_REQUEUE_MS = st.unreadRequeueSec * 1000;
    RECEIVE_POST_RETRY_MS = st.postRetrySec * 1000;
    MAX_SEEN_IDS = st.maxSeenIds;
    MAX_LIST_ITEMS = st.maxListItems;
  }

  applyReceiveSettings(loadReceiveSettings());
  const CHAT_MESSAGE_CURSOR_STORAGE_KEY = "wa_chat_message_cursor_v1";
  const CHAT_CURSOR_PERSIST_DEBOUNCE_MS = 1000;

  function getReceiveReadDays() {
    return DEFAULT_RECEIVE_DAYS;
  }

  function getReadCutoffMs(days) {
    const windowDays = days ?? getReceiveReadDays();
    return Date.now() - windowDays * 24 * 60 * 60 * 1000;
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  function isWithinReadWindow(date, days) {
    if (!date || Number.isNaN(date.getTime())) return false;
    return date.getTime() >= getReadCutoffMs(days);
  }

  function parseDateParts(day, month, year) {
    if (!day || !month || !year) return null;
    const d = new Date(year, month - 1, day, 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function parseSlashDate(datePart) {
    const m = String(datePart || "").match(
      /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/,
    );
    if (!m) return null;
    let a = parseInt(m[1], 10);
    let b = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    let day;
    let month;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      day = b;
      month = a;
    } else {
      day = a;
      month = b;
    }
    return parseDateParts(day, month, year);
  }

  function parseDateSeparatorText(text) {
    const raw = String(text || "").trim();
    if (!raw || raw.length > 60) return null;

    const lower = raw.toLowerCase();
    if (lower === "today") return startOfDay(new Date());
    if (lower === "yesterday") {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return startOfDay(d);
    }

    const weekdays = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const wd = weekdays.indexOf(lower);
    if (wd >= 0) {
      const d = new Date();
      let diff = d.getDay() - wd;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() - diff);
      return startOfDay(d);
    }

    const slash = parseSlashDate(raw);
    if (slash) return slash;

    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return startOfDay(d);
    return null;
  }

  function applyTimeToDate(baseDate, timePart) {
    if (!baseDate) return null;
    const m = String(timePart || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return baseDate;
    let hour = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = (m[3] || "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const d = new Date(baseDate);
    d.setHours(hour, min, 0, 0);
    return d;
  }

  function parseMessageTimestamp(prePlainText, options = {}) {
    if (!prePlainText) return null;
    const match = String(prePlainText).match(/\[([^\]]+)\]/);
    if (!match) return null;
    const inner = match[1].trim();

    const lower = inner.toLowerCase();
    if (lower === "today") return new Date();
    if (lower === "yesterday") {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      d.setHours(12, 0, 0, 0);
      return d;
    }

    const timeOnly = inner.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (timeOnly) {
      if (!options.allowTimeOnly) return null;
      return applyTimeToDate(startOfDay(new Date()), inner);
    }

    const comma = inner.indexOf(",");
    if (comma !== -1) {
      const timePart = inner.slice(0, comma).trim();
      const datePart = inner.slice(comma + 1).trim();
      const slashDate = parseSlashDate(datePart);
      if (slashDate) return applyTimeToDate(slashDate, timePart) || slashDate;

      const combined = new Date(`${datePart} ${timePart}`);
      if (!Number.isNaN(combined.getTime())) return combined;
    }

    const slashOnly = parseSlashDate(inner);
    if (slashOnly) return slashOnly;

    const parsed = new Date(inner);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    return null;
  }

  function getConversationPanel() {
    return (
      document.querySelector(
        '#main [data-testid="conversation-panel-messages"]',
      ) ||
      document.querySelector('#main [data-testid="conversation-panel-body"]') ||
      document.querySelector("#main")
    );
  }

  function getMessageTimestamp(node) {
    const row = node?.closest?.("[data-id]") || node;
    const pre =
      row
        ?.querySelector?.("[data-pre-plain-text]")
        ?.getAttribute("data-pre-plain-text") ||
      row?.getAttribute?.("data-pre-plain-text") ||
      "";
    const fromPre = parseMessageTimestamp(pre);
    if (fromPre) return fromPre;

    const panel = getConversationPanel();
    if (!panel || !row) return null;

    let currentDate = null;
    const ordered = panel.querySelectorAll('[role="row"], [data-id]');
    for (const el of ordered) {
      const isMessage =
        el.hasAttribute?.("data-id") || el.querySelector?.("[data-id]");
      if (!isMessage) {
        const sep = parseDateSeparatorText((el.textContent || "").trim());
        if (sep) currentDate = sep;
        continue;
      }

      const msgEl =
        el.hasAttribute("data-id") ? el : el.querySelector("[data-id]");
      if (msgEl !== row && !msgEl?.contains(row) && !row.contains(msgEl))
        continue;

      if (!currentDate) return null;
      const innerPre =
        pre ||
        msgEl
          ?.querySelector?.("[data-pre-plain-text]")
          ?.getAttribute("data-pre-plain-text") ||
        "";
      const bracket = innerPre.match(/\[([^\]]+)\]/);
      if (bracket) {
        const merged = applyTimeToDate(currentDate, bracket[1].trim());
        if (merged) return merged;
      }
      return currentDate;
    }
    return null;
  }

  function getChatRowTimeText(cell) {
    if (!cell) return "";
    const direct =
      cell.querySelector('[data-testid="msg-time"]') ||
      cell.querySelector("time") ||
      cell.querySelector(
        '[data-testid="cell-frame-secondary"] span[dir="auto"]:last-child',
      );
    if (direct) {
      const t = (
        direct.getAttribute?.("title") ||
        direct.textContent ||
        ""
      ).trim();
      if (t) return t;
    }

    let best = "";
    cell.querySelectorAll("span").forEach((span) => {
      const t = (span.textContent || "").trim();
      if (!t || t.length > 24) return;
      if (
        /^\d{1,2}:\d{2}(\s*[ap]m)?$/i.test(t) ||
        /^(today|yesterday)$/i.test(t) ||
        /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.test(
          t,
        ) ||
        /^\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?$/.test(t)
      ) {
        best = t;
      }
    });
    return best;
  }

  function parseChatRowActivityDate(cell) {
    const timeText = getChatRowTimeText(cell);
    if (!timeText) return null;
    if (/^\d{1,2}:\d{2}(\s*[ap]m)?$/i.test(timeText)) {
      return startOfDay(new Date());
    }
    return parseDateSeparatorText(timeText) || parseSlashDate(timeText);
  }

  function isChatRowWithinReadWindow(cell, unread = 0) {
    // Any unread chat is always eligible (don't drop due to date parsing)
    if (Number(unread) > 0) return true;
    const activity = parseChatRowActivityDate(cell);
    if (!activity) return false;
    return isWithinReadWindow(activity);
  }

  function getVisibleDateSeparatorsOlderThanCutoff() {
    const panel = getConversationPanel();
    if (!panel) return false;
    const cutoff = getReadCutoffMs();
    let foundOld = false;
    panel.querySelectorAll('[role="row"]').forEach((row) => {
      if (row.querySelector("[data-id]")) return;
      const sep = parseDateSeparatorText((row.textContent || "").trim());
      if (sep && sep.getTime() < cutoff) foundOld = true;
    });
    return foundOld;
  }

  function getOldestIncomingTimestampMs() {
    const main = document.querySelector("#main");
    if (!main) return null;
    const nodes = findIncomingMessageRoots(main);
    let oldest = null;
    for (const node of nodes) {
      const ts = getMessageTimestamp(node);
      const ms = ts?.getTime();
      if (!ms || Number.isNaN(ms)) continue;
      if (oldest === null || ms < oldest) oldest = ms;
    }
    return oldest;
  }

  function hasScrolledPastReadWindow() {
    const cutoff = getReadCutoffMs();
    const oldest = getOldestIncomingTimestampMs();
    if (oldest !== null && oldest < cutoff) return true;
    return getVisibleDateSeparatorsOlderThanCutoff();
  }

  // Shared across reinjections so old async loops stop when Stop is pressed
  if (typeof window.__waSenderActiveRun !== "number") {
    window.__waSenderActiveRun = 0;
  }
  if (typeof window.__waReceiveActiveRun !== "number") {
    window.__waReceiveActiveRun = 0;
  }
  // Reinjection: drop any prior observer/poll and invalidate the old listen run
  // so ensureReceiveListening() won't think it's still active with dead hooks.
  if (
    window.__waReceiveObserver ||
    window.__waReceivePollTimer ||
    window.__waReceiveOnlineHandler ||
    window.__waReceiveVisibilityHandler
  ) {
    window.__waReceiveActiveRun += 1;
  }
  if (window.__waReceiveObserver) {
    try {
      window.__waReceiveObserver.disconnect();
    } catch (_) {}
    window.__waReceiveObserver = null;
  }
  if (window.__waReceivePollTimer) {
    clearInterval(window.__waReceivePollTimer);
    window.__waReceivePollTimer = null;
  }
  if (window.__waReceiveOnlineHandler) {
    try {
      window.removeEventListener("online", window.__waReceiveOnlineHandler);
    } catch (_) {}
    window.__waReceiveOnlineHandler = null;
  }
  if (window.__waReceiveVisibilityHandler) {
    try {
      document.removeEventListener(
        "visibilitychange",
        window.__waReceiveVisibilityHandler,
      );
    } catch (_) {}
    window.__waReceiveVisibilityHandler = null;
  }

  function beginSenderRun() {
    window.__waSenderActiveRun += 1;
    return window.__waSenderActiveRun;
  }

  function cancelAllSenderRuns() {
    window.__waSenderActiveRun += 1;
  }

  function isSenderRunActive(runId) {
    return runId === window.__waSenderActiveRun;
  }

  function beginReceiveRun() {
    window.__waReceiveActiveRun += 1;
    return window.__waReceiveActiveRun;
  }

  function cancelAllReceiveRuns() {
    window.__waReceiveActiveRun += 1;
    if (window.__waReceiveObserver) {
      try {
        window.__waReceiveObserver.disconnect();
      } catch (_) {}
      window.__waReceiveObserver = null;
    }
    if (window.__waReceivePollTimer) {
      clearInterval(window.__waReceivePollTimer);
      window.__waReceivePollTimer = null;
    }
    if (window.__waReceiveOnlineHandler) {
      try {
        window.removeEventListener("online", window.__waReceiveOnlineHandler);
      } catch (_) {}
      window.__waReceiveOnlineHandler = null;
    }
    if (window.__waReceiveVisibilityHandler) {
      try {
        document.removeEventListener(
          "visibilitychange",
          window.__waReceiveVisibilityHandler,
        );
      } catch (_) {}
      window.__waReceiveVisibilityHandler = null;
    }
  }

  function isReceiveRunActive(runId) {
    return runId === window.__waReceiveActiveRun;
  }

  function normalizePhone(number) {
    return String(number || "").replace(/\D/g, "");
  }

  /** Logged-in WhatsApp account phone (digits only). */
  function getMyWhatsAppNumber() {
    if (window.__waMyNumber) return window.__waMyNumber;

    const tryWid = (raw) => {
      if (!raw) return "";
      const cleaned = String(raw).replace(/^"+|"+$/g, "");
      // "923001234567:emma.t@example.net" or "923001234567@c.us"
      const before =
        cleaned.split(":")[0].split("@")[0].replace(/\D/g, "") || "";
      return before.length >= 8 && before.length <= 15 ? before : "";
    };

    try {
      const keys = ["last-wid", "last-wid-md", "PreferredIdentityId"];
      for (const key of keys) {
        const n = tryWid(localStorage.getItem(key));
        if (n) {
          window.__waMyNumber = n;
          return n;
        }
      }
    } catch (_) {}

    // Profile drawer / header sometimes exposes the number as title
    const profileCandidates = [
      document.querySelector('[data-testid="drawer-left"] span[title]'),
      document.querySelector('[data-testid="menu-bar-profile"] span[title]'),
      document.querySelector('header span[title^="+"]'),
    ];
    for (const el of profileCandidates) {
      const n = normalizePhone(el?.getAttribute?.("title") || el?.textContent);
      if (n.length >= 8 && n.length <= 15) {
        window.__waMyNumber = n;
        return n;
      }
    }

    // Fallback: any outgoing/incoming legacy data-id won't include "me",
    // but some profile about lines do.
    return "";
  }

  function phoneFromChatId(chatId) {
    const raw = String(chatId || "");
    const cUs = raw.match(/^(\d+)@c\.us$/i);
    if (cUs) return cUs[1];
    const beforeAt = raw.split("@")[0] || "";
    if (/^\d{8,15}$/.test(beforeAt)) return beforeAt;
    return "";
  }

  function isLikelyPhoneDigits(digits) {
    const n = String(digits || "");
    // Real mobile/E.164-ish lengths; reject odd 13+ blobs we were picking up
    return n.length >= 10 && n.length <= 15;
  }

  function scorePhoneCandidate(displayText, digits) {
    const n = normalizePhone(digits);
    if (!isLikelyPhoneDigits(n)) return 0;
    if (n === getMyWhatsAppNumber()) return 0;
    let score = 1;
    const t = String(displayText || "").trim();
    // Strong signal: WhatsApp Contact info style "+92 313 2178663"
    if (/^\+\d{1,3}[\s\-]?\d/.test(t)) score += 20;
    if (t.includes("+")) score += 5;
    // Common PK mobile: 92 + 10 digits
    if (/^92\d{10}$/.test(n)) score += 5;
    // Penalize unusual lengths we saw from bad scrapes
    if (n.length === 13) score -= 8;
    if (n.length > 13) score -= 10;
    return score;
  }

  function extractPhoneFromText(text) {
    const raw = String(text || "").trim();
    if (!raw || raw.length > 40) return "";

    // Prefer explicit international formatting
    const plus = raw.match(/\+\d{1,3}[\s\-]?\d[\d\s\-().]{6,}\d/);
    if (plus) {
      const n = normalizePhone(plus[0]);
      if (scorePhoneCandidate(plus[0], n) > 0) return n;
    }

    // Whole string is only a number (unsaved contact title)
    if (/^[\d\s+\-().]+$/.test(raw)) {
      const bare = normalizePhone(raw);
      if (scorePhoneCandidate(raw, bare) > 0) return bare;
    }
    return "";
  }

  function phoneFromPrePlainText(pre) {
    // "[6:52 AM, 7/25/2026] +92 300 1234567: " or "... Faraz: "
    const m = String(pre || "").match(/\]\s*(.+?):\s*$/);
    if (!m) return "";
    return extractPhoneFromText(m[1]);
  }

  function getPeerPhoneCache() {
    if (!window.__waPeerPhoneByChat) {
      window.__waPeerPhoneByChat = new Map();
    }
    return window.__waPeerPhoneByChat;
  }

  function cachePeerPhone(chatKey, phone, meta = {}) {
    const n = normalizePhone(phone);
    if (!chatKey || !isLikelyPhoneDigits(n)) return;
    const key = String(chatKey).trim();
    const prev = getPeerPhoneCache().get(key);
    const prevScore = prev?.score || 0;
    const nextScore = meta.score ?? scorePhoneCandidate(meta.display || n, n);
    if (prev && prevScore > nextScore) return;
    getPeerPhoneCache().set(key, {
      phone: n,
      score: nextScore,
      source: meta.source || "dom",
    });
  }

  function getCachedPeerPhone(chatKey) {
    if (!chatKey) return "";
    const entry = getPeerPhoneCache().get(String(chatKey).trim());
    if (!entry) return "";
    // Legacy string cache
    if (typeof entry === "string") return entry;
    return entry.phone || "";
  }

  function getCachedPeerPhoneScore(chatKey) {
    if (!chatKey) return 0;
    const entry = getPeerPhoneCache().get(String(chatKey).trim());
    if (!entry) return 0;
    if (typeof entry === "string") return 1;
    return entry.score || 0;
  }

  /** Best-effort peer phone from visible chat chrome (no contact-info open). */
  function getPeerPhoneFromOpenChatDom(prePlainText) {
    const chatName = getOpenChatName();
    let best = { phone: "", score: 0, display: "" };

    const consider = (display, source) => {
      const n = extractPhoneFromText(display);
      if (!n) return;
      const score = scorePhoneCandidate(display, n);
      if (score > best.score) best = { phone: n, score, display, source };
    };

    // 1) Title itself is a number (unsaved contact)
    consider(chatName, "title");

    // 2) Header subtitle lines (often "+92 …" under the name)
    const header =
      document.querySelector("#main header") ||
      document.querySelector('[data-testid="conversation-header"]') ||
      document.querySelector('#main [data-testid="conversation-info-header"]');
    if (header) {
      header.querySelectorAll("[title], span").forEach((el) => {
        const title = el.getAttribute?.("title") || "";
        const text = (el.textContent || "").trim();
        if (title) consider(title, "header-title");
        // Only short leaf texts — avoid concatenating whole header
        if (text && text.length <= 24 && el.children.length === 0) {
          consider(text, "header-text");
        }
      });
    }

    // 3) Message pre-plain-text sender (only if phone-formatted)
    const preSender = (String(prePlainText || "").match(/\]\s*(.+?):\s*$/) ||
      [])[1];
    if (preSender) consider(preSender, "pre");

    // Do NOT use avatar img ?u=… — often wrong / stale vs Contact info

    if (best.phone) {
      cachePeerPhone(chatName, best.phone, {
        score: best.score,
        display: best.display,
        source: best.source,
      });
      return best.phone;
    }

    const cached = getCachedPeerPhone(chatName);
    return cached || "";
  }

  function findContactInfoDrawer() {
    const drawers = [
      document.querySelector('[data-testid="contact-info-drawer"]'),
      document.querySelector('[data-testid="drawer-right"]'),
      document.querySelector('#app div[data-animate-drawer-inner="true"]'),
    ].filter(Boolean);

    for (const d of drawers) {
      const label = (d.textContent || "").slice(0, 200);
      if (/contact info|group info/i.test(label)) return d;
    }

    // Fallback: section that contains both "Contact info" and a +phone
    const headers = Array.from(document.querySelectorAll("header, div")).filter(
      (el) =>
        /^(contact info|group info)$/i.test(
          (el.textContent || "").replace(/\s+/g, " ").trim(),
        ),
    );
    for (const h of headers) {
      const root =
        h.closest('[data-testid="drawer-right"]') ||
        h.closest('[role="dialog"]') ||
        h.parentElement?.parentElement;
      if (root) return root;
    }
    return null;
  }

  function extractPhoneFromContactInfoRoot(root) {
    if (!root) return "";
    let best = { phone: "", score: 0, display: "" };

    const consider = (display) => {
      const n = extractPhoneFromText(display);
      if (!n) return;
      const score = scorePhoneCandidate(display, n) + 15; // contact-info bonus
      if (score > best.score) best = { phone: n, score, display };
    };

    // Prefer copyable / titled phone rows in the drawer only
    root.querySelectorAll("[title], span, a").forEach((el) => {
      const title = el.getAttribute?.("title") || "";
      const text = (el.textContent || "").trim();
      if (title && title.length <= 24) consider(title);
      if (
        text &&
        text.length <= 24 &&
        el.children.length === 0 &&
        /\+?\d/.test(text)
      ) {
        consider(text);
      }
    });

    return best.phone ?
        { phone: best.phone, score: best.score, display: best.display }
      : null;
  }

  async function scrapePeerPhoneFromContactInfo() {
    const header =
      document.querySelector("#main header") ||
      document.querySelector('[data-testid="conversation-header"]');
    if (!header) return "";

    let drawer = findContactInfoDrawer();
    if (!drawer) {
      const clickTarget =
        header.querySelector(
          '[data-testid="conversation-info-header"], [data-testid="conversation-info-header-chat-title"]',
        ) || header;
      simulateUserClick(clickTarget);
      for (let i = 0; i < 10 && !drawer; i += 1) {
        await sleep(200);
        drawer = findContactInfoDrawer();
      }
    }

    const found = extractPhoneFromContactInfoRoot(drawer);
    // Close drawer so we don't leave contact info open
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
        }),
      );
    } catch (_) {}

    return found;
  }

  async function ensurePeerPhone(chatName, prePlainText) {
    const key = String(chatName || "").trim() || "__open__";
    const domPhone = getPeerPhoneFromOpenChatDom(prePlainText);
    const cachedScore = getCachedPeerPhoneScore(key);
    const domScore = domPhone ? scorePhoneCandidate(domPhone, domPhone) : 0;

    // High-confidence already (e.g. title/header showed "+92 …")
    if (domPhone && Math.max(domScore, cachedScore) >= 20) {
      return getCachedPeerPhone(key) || domPhone;
    }

    // Always confirm via Contact info once — it's the ground truth in WA UI
    const tried = (window.__waPeerPhoneTried =
      window.__waPeerPhoneTried || new Set());
    if (!tried.has(key)) {
      tried.add(key);
      const scraped = await scrapePeerPhoneFromContactInfo();
      if (scraped?.phone) {
        cachePeerPhone(chatName || key, scraped.phone, {
          score: scraped.score,
          display: scraped.display,
          source: "contact-info",
        });
        console.log(
          "[WA] peer phone from Contact info →",
          scraped.phone,
          scraped.display,
        );
        return scraped.phone;
      }
    }

    return getCachedPeerPhone(key) || domPhone || "";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRandomDelay(min, max) {
    return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
  }

  function saveQueue(state) {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(state));
  }

  function loadQueue() {
    try {
      const raw = sessionStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearQueue() {
    sessionStorage.removeItem(QUEUE_KEY);
  }

  function saveApiSettings(
    fetchUrl,
    updateUrl,
    notAvailableUrl,
    receiveUrl,
    receiveDays,
  ) {
    const prev = loadApiSettings();
    localStorage.setItem(
      API_SETTINGS_KEY,
      JSON.stringify({
        fetchUrl: fetchUrl ?? prev.fetchUrl,
        updateUrl: updateUrl ?? prev.updateUrl,
        notAvailableUrl: notAvailableUrl ?? prev.notAvailableUrl,
        receiveUrl: receiveUrl ?? prev.receiveUrl,
        receiveDays: receiveDays ?? prev.receiveDays ?? DEFAULT_RECEIVE_DAYS,
      }),
    );
  }

  function loadApiSettings() {
    try {
      const raw = localStorage.getItem(API_SETTINGS_KEY);
      return raw ?
          JSON.parse(raw)
        : {
            fetchUrl: "",
            updateUrl: "",
            notAvailableUrl: "",
            receiveUrl: "",
            receiveDays: DEFAULT_RECEIVE_DAYS,
          };
    } catch {
      return {
        fetchUrl: "",
        updateUrl: "",
        notAvailableUrl: "",
        receiveUrl: "",
        receiveDays: DEFAULT_RECEIVE_DAYS,
      };
    }
  }

  function isLegacyApiUrl(url) {
    return String(url || "").includes("whatsapp_message");
  }

  function isLocalhostApiUrl(url) {
    try {
      const host = new URL(String(url || "")).hostname;
      return host === "localhost" || host === "127.0.0.1";
    } catch {
      return /localhost|127\.0\.0\.1/i.test(String(url || ""));
    }
  }

  /** Replace stale localhost / legacy / wrong live API paths. */
  function shouldReplaceApiUrl(currentUrl, authOrigin) {
    const cur = String(currentUrl || "").trim();
    if (!cur) return true;
    if (isLegacyApiUrl(cur)) return true;
    if (!authOrigin) return false;
    try {
      const authHost = new URL(authOrigin).host;
      const curUrl = new URL(cur);
      if (curUrl.host !== authHost) return true;
      // Live demolyink must use /pos_admin/api/... (SPA /pos/api is HTML)
      if (/websitedemolynk\.com$/i.test(curUrl.hostname)) {
        if (!curUrl.pathname.includes("/pos_admin/api/")) return true;
      }
    } catch {
      return isLocalhostApiUrl(cur);
    }
    return false;
  }

  /** Keep fetch-random company_id in sync with current POS cookie. */
  function withCompanyId(url, companyId) {
    const raw = String(url || "").trim();
    const id = String(companyId || "").trim();
    if (!raw || !id) return raw;
    try {
      const u = new URL(raw);
      if (!/\/(?:pos_admin\/)?api\/chat\/fetch-random\/?$/i.test(u.pathname))
        return raw;
      u.searchParams.set("company_id", id);
      return u.toString();
    } catch {
      return raw;
    }
  }

  function companyIdFromUrl(url) {
    try {
      return new URL(String(url || "")).searchParams.get("company_id") || "";
    } catch {
      return "";
    }
  }

  /**
   * Chat document id for mark-sent / mark-not-available.
   * Prefer data._id from fetch-random — never message_id / whatsapp_message_id.
   */
  function extractChatDocumentId(raw) {
    if (!raw || typeof raw !== "object") return "";
    const candidates = [raw._id, raw.id];
    for (const value of candidates) {
      if (value == null || value === "") continue;
      if (typeof value === "object") {
        const oid = value.$oid || value.oid || value.id;
        if (oid != null && String(oid).trim()) return String(oid).trim();
        if (typeof value.toHexString === "function") {
          try {
            const hex = value.toHexString();
            if (hex) return String(hex).trim();
          } catch (_) {}
        }
        continue;
      }
      const s = String(value).trim();
      if (!s || s === ":id" || s === "undefined" || s === "null") continue;
      if (s === "[object Object]") continue;
      return s;
    }
    return "";
  }

  function normalizeChatQueueItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = extractChatDocumentId(raw);
    const message = raw.message || raw.text || raw.body || "";
    const number =
      raw.number ||
      raw.phone ||
      raw.to_user_id ||
      raw.toUserId ||
      raw.recipient ||
      "";
    if (!id || !message || !number) return null;
    return {
      _id: id,
      number: String(number),
      message: String(message),
    };
  }

  function applyPosAuthToSidebar(sidebar) {
    const statusEl = sidebar.querySelector("#wa-pos-auth-status");
    if (!statusEl) return;

    const env =
      typeof WA_ENV !== "undefined" && WA_ENV ?
        WA_ENV
      : { posOrigin: "http://localhost:8000", chatApiPath: "/api/chat" };
    const defaultFetch = `${env.posOrigin}${env.chatApiPath || "/api/chat"}/fetch-random`;
    const apiSettings = loadApiSettings();
    const hintUrl =
      apiSettings.fetchUrl || apiSettings.receiveUrl || defaultFetch;

    chrome.runtime.sendMessage(
      { type: "wa-get-pos-auth", apiUrl: hintUrl },
      (response) => {
        if (chrome.runtime.lastError) {
          statusEl.textContent = "POS auth: extension error";
          statusEl.className = "wa-pos-auth-status is-error wa-api-urls-hidden";
          return;
        }

        if (!response?.authenticated) {
          statusEl.textContent = "POS auth: keep AI POS tab open & logged in";
          statusEl.className = "wa-pos-auth-status is-muted wa-api-urls-hidden";
          console.warn(
            "[WA] POS not authenticated — open live POS and log in",
            {
              hintUrl,
            },
          );
          return;
        }

        statusEl.textContent =
          response.companyName ?
            `POS connected — Welcome ${response.companyName}`
          : response.companyId ?
            `POS connected (company ${response.companyId.slice(0, 8)}…)`
          : "POS connected";
        statusEl.className = "wa-pos-auth-status is-ok wa-api-urls-hidden";
        console.log("[WA] POS connected →", {
          origin: response.origin,
          companyId: response.companyId,
          urls: response.urls,
        });

        if (!response.urls) return;

        const authOrigin = response.origin || "";
        const urlFields = [
          ["wa-fetch-url", "fetchUrl"],
          ["wa-update-url", "updateUrl"],
          ["wa-not-available-url", "notAvailableUrl"],
          ["wa-receive-url", "receiveUrl"],
        ];
        urlFields.forEach(([id, key]) => {
          const el = sidebar.querySelector(`#${id}`);
          const next = response.urls?.[key];
          if (!el || !next) return;
          if (shouldReplaceApiUrl(el.value, authOrigin)) {
            el.value = next;
          }
        });

        // Always refresh company_id on fetch URL from current POS cookie
        const fetchEl = sidebar.querySelector("#wa-fetch-url");
        if (fetchEl && response.companyId) {
          const nextFetch =
            response.urls.fetchUrl ||
            withCompanyId(fetchEl.value, response.companyId);
          const currentId = companyIdFromUrl(fetchEl.value);
          if (
            !fetchEl.value.trim() ||
            shouldReplaceApiUrl(fetchEl.value, authOrigin) ||
            (currentId && currentId !== response.companyId) ||
            !currentId
          ) {
            fetchEl.value = nextFetch;
            console.log("[WA] refreshed fetch URL company_id →", {
              from: currentId || "(none)",
              to: response.companyId,
              url: nextFetch,
            });
          }
        }
        persistApiUrlsFromInputs();
      },
    );
  }

  function persistApiUrlsFromInputs() {
    const fetchUrl =
      document.getElementById("wa-fetch-url")?.value.trim() || "";
    const updateUrl =
      document.getElementById("wa-update-url")?.value.trim() || "";
    const notAvailableUrl =
      document.getElementById("wa-not-available-url")?.value.trim() || "";
    const receiveUrl =
      document.getElementById("wa-receive-url")?.value.trim() || "";
    const receiveDays = getReceiveReadDays();
    saveApiSettings(
      fetchUrl,
      updateUrl,
      notAvailableUrl,
      receiveUrl,
      receiveDays,
    );
  }

  function loadSeenIds() {
    try {
      const raw = sessionStorage.getItem(SEEN_MSG_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  function saveSeenIds(seen) {
    const arr = Array.from(seen);
    const trimmed =
      arr.length > MAX_SEEN_IDS ? arr.slice(arr.length - MAX_SEEN_IDS) : arr;
    sessionStorage.setItem(SEEN_MSG_KEY, JSON.stringify(trimmed));
  }

  function loadReceivedList() {
    try {
      const raw = sessionStorage.getItem(RECEIVED_LIST_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveReceivedList(items) {
    const trimmed =
      items.length > MAX_LIST_ITEMS ? items.slice(0, MAX_LIST_ITEMS) : items;
    sessionStorage.setItem(RECEIVED_LIST_KEY, JSON.stringify(trimmed));
  }

  function upsertReceivedListItem(payload, postState) {
    if (!payload?.messageId) return;
    const items = loadReceivedList().filter(
      (item) => item?.payload?.messageId !== payload.messageId,
    );
    items.unshift({ payload, postState: postState || "pending" });
    saveReceivedList(items);
  }

  function buildIdUrl(template, id) {
    if (!template) return "";
    const chatId = String(id ?? "").trim();
    if (
      !chatId ||
      chatId === ":id" ||
      chatId === "undefined" ||
      chatId === "null"
    ) {
      throw new Error(
        `Missing chat _id for URL (got ${JSON.stringify(id)}). Use data._id from fetch-random.`,
      );
    }
    if (template.includes(":id")) {
      return template.replace(/:id/g, encodeURIComponent(chatId));
    }
    return template.replace(/\/?$/, "/") + encodeURIComponent(chatId);
  }

  function apiRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "wa-api-request", method, url, body },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            const receivedId =
              response?.data?.received_id ?? response?.data?.receivedId;
            let msg =
              response?.error || `Request failed (${response?.status || 0})`;
            if (
              receivedId != null &&
              String(receivedId).trim() &&
              !String(msg).includes("received_id=")
            ) {
              msg = `${msg} (received_id=${String(receivedId).trim()})`;
            }
            reject(new Error(msg));
            return;
          }
          resolve(response.data);
        },
      );
    });
  }

  function parseChatIdFromDataId(dataId) {
    if (!dataId) return { fromMe: null, chatId: "", phone: "", isGroup: false };
    // Legacy: false_92300...@c.us_ABCDEF  |  true_1203...@g.us_...
    // Newer WA builds may use bare ids without true_/false_ prefix
    const raw = String(dataId);
    const parts = raw.split("_");
    let fromMe = null;
    let chatId = "";
    if (parts[0] === "true" || parts[0] === "false") {
      fromMe = parts[0] === "true";
      chatId = parts[1] || "";
    } else if (
      raw.includes("@c.us") ||
      raw.includes("@g.us") ||
      raw.includes("@lid")
    ) {
      chatId = parts.find((p) => p.includes("@")) || "";
    }
    const isGroup = chatId.includes("@g.us");
    const phone =
      chatId.includes("@c.us") ?
        normalizePhone(chatId.split("@")[0])
      : phoneFromChatId(chatId);
    return { fromMe, chatId, phone, isGroup };
  }

  function getOpenChatName() {
    const header =
      document.querySelector("#main header") ||
      document.querySelector('[data-testid="conversation-header"]') ||
      document.querySelector(
        '#main [data-testid="conversation-info-header"]',
      ) ||
      document.querySelector("header");
    if (!header) return "";
    const title =
      header.querySelector(
        '[data-testid="conversation-info-header-chat-title"]',
      ) ||
      header.querySelector('span[dir="auto"][title]') ||
      header.querySelector("span[title]") ||
      header.querySelector('span[dir="auto"]');
    return (title?.getAttribute("title") || title?.textContent || "").trim();
  }

  function isOutgoingMessage(node) {
    if (!node) return false;
    const row = findMessageRow(node) || node;

    if (
      row.classList?.contains("message-out") ||
      row.closest?.(".message-out") ||
      row.querySelector?.(".message-out")
    ) {
      return true;
    }
    if (
      row.classList?.contains("message-in") ||
      row.closest?.(".message-in") ||
      row.querySelector?.(".message-in")
    ) {
      return false;
    }

    const dataId =
      row.getAttribute?.("data-id") ||
      row.closest?.("[data-id]")?.getAttribute("data-id") ||
      "";
    if (dataId.startsWith("true_")) return true;
    if (dataId.startsWith("false_")) return false;

    // Delivery / clock ticks only appear on your own (outgoing) bubbles
    if (
      row.querySelector?.(
        [
          '[data-icon="msg-check"]',
          '[data-icon="msg-dblcheck"]',
          '[data-icon="msg-dblcheck-ack"]',
          '[data-icon="msg-time"]',
          '[data-icon="msg-dblcheck-ack-light"]',
          '[data-icon="status-check"]',
          '[data-icon="status-dblcheck"]',
          '[data-icon="msg-check-light"]',
          '[data-icon="msg-dblcheck-light"]',
          // Newer WA icon names
          '[data-icon^="ic-done"]',
          '[data-icon="ic-access-time"]',
          '[data-icon*="dblcheck"]',
          '[data-testid*="dblcheck"]',
          '[data-testid="msg-check"]',
          '[data-testid="msg-time-status"]',
        ].join(", "),
      )
    ) {
      return true;
    }

    // Tick status labels (" Read ", " Delivered ", ...) only exist on own bubbles
    const statusLabel = [...(row.querySelectorAll?.("[aria-label]") || [])].some(
      (el) =>
        /^(read|delivered|sent|pending)$/i.test(
          (el.getAttribute("aria-label") || "").trim(),
        ),
    );
    if (statusLabel) return true;

    const meta = row.querySelector?.('[data-testid="msg-meta"]');
    if (meta) {
      const label = `${meta.getAttribute("aria-label") || ""} ${meta.textContent || ""}`;
      if (/\b(delivered|read|sent|played)\b/i.test(label)) return true;
    }

    // Green / right-side bubbles are outgoing
    const main = document.querySelector("#main");
    const bubble =
      row.querySelector?.('[data-testid="msg-container"]') ||
      row.querySelector?.(".copyable-text") ||
      row;
    if (main && bubble?.getBoundingClientRect) {
      const m = main.getBoundingClientRect();
      const b = bubble.getBoundingClientRect();
      if (b.width > 20 && m.width > 0) {
        // Incoming bubbles hug the left edge (~5% in). Outgoing ones are
        // right-aligned, so even long ones start well away from the left —
        // and the sidebar overlays #main, so the right edge can't be used.
        if (b.left - m.left > m.width * 0.25) return true;
      }
    }

    return false;
  }

  function isIncomingMessage(node) {
    // Anything that isn't clearly outgoing is eligible as incoming.
    // (Fail-open for receive — fail-closed was dropping real peer messages.)
    return !!node && !isOutgoingMessage(node);
  }

  function findMessageRow(el) {
    if (!el || el.nodeType !== 1) return null;
    return (
      el.closest?.("[data-id]") ||
      (el.getAttribute?.("data-id") ? el : null) ||
      el.closest?.(".message-in") ||
      el.closest?.(".message-out") ||
      el.closest?.(".copyable-text[data-pre-plain-text]")?.parentElement
    );
  }

  function findIncomingMessageRoots(root) {
    const scope = root && root.nodeType === 1 ? root : document;
    const list = [];
    const seen = new Set();

    const pushNode = (el) => {
      const row = findMessageRow(el);
      if (!row || seen.has(row)) return;
      // Only conversation panel messages
      if (!row.closest?.("#main")) return;
      if (isOutgoingMessage(row)) return;
      if (!isIncomingMessage(row)) return; // skip ambiguous / own messages
      const dataId = row.getAttribute?.("data-id") || "";
      const text = getMessageText(row);
      if (!dataId && !text) return;
      seen.add(row);
      list.push(row);
    };

    pushNode(scope);

    // Search within the given root (for mutation nodes) and/or the open chat panel
    const searchRoots = new Set();
    if (scope !== document) searchRoots.add(scope);
    const main = document.querySelector("#main");
    if (
      main &&
      (scope === document ||
        scope === main ||
        scope.contains?.(main) ||
        main.contains?.(scope))
    ) {
      searchRoots.add(main);
    }
    if (!searchRoots.size && main) searchRoots.add(main);

    searchRoots.forEach((sr) => {
      sr.querySelectorAll?.(
        "[data-id], .message-in, .copyable-text[data-pre-plain-text]",
      ).forEach(pushNode);
    });

    return list;
  }

  function stableHash(str) {
    let h = 0;
    const s = String(str || "");
    for (let i = 0; i < s.length; i += 1) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  function getMessageIdFromNode(node) {
    const withId = findMessageRow(node);
    if (!withId) return "";
    const dataId = withId.getAttribute("data-id") || "";
    if (dataId) return dataId;
    const pre =
      withId
        .querySelector?.("[data-pre-plain-text]")
        ?.getAttribute("data-pre-plain-text") || "";
    const text = getMessageText(withId);
    const chatName = getOpenChatName();
    return `dom_${stableHash(`${chatName}|${pre}|${text}`)}`;
  }

  function seedVisibleConversationBaseline(baselineIds) {
    const main = document.querySelector("#main");
    if (!main) return;
    // Only baseline messages outside the read window — keep today's/synced
    // messages eligible for capture (including ones already read on phone).
    findIncomingMessageRoots(main).forEach((node) => {
      const id = getMessageIdFromNode(node);
      if (!id) return;
      const ts = getMessageTimestamp(node);
      if (ts && !isWithinReadWindow(ts)) {
        baselineIds.add(id);
      }
    });
  }

  /** WhatsApp shows e.g. "3 unread messages" above the unread block. */
  function getUnreadDividerCount(root) {
    const scope =
      root && root.nodeType === 1 ?
        root
      : document.querySelector("#main") || document;
    let found = 0;
    scope
      .querySelectorAll?.('[role="row"], [data-testid="msg-system"], div, span')
      ?.forEach((el) => {
        if (found) return;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 40) return;
        const m = text.match(/^(\d+)\s+unread\s+messages?$/i);
        if (m) found = parseInt(m[1], 10) || 0;
      });
    return found > 0 ? Math.min(found, 99) : 0;
  }

  function findUnreadDividerElement(root) {
    const scope =
      root && root.nodeType === 1 ?
        root
      : document.querySelector("#main") || document;
    let match = null;
    scope
      .querySelectorAll?.('[role="row"], [data-testid="msg-system"], div, span')
      ?.forEach((el) => {
        if (match) return;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 40) return;
        if (/^\d+\s+unread\s+messages?$/i.test(text)) match = el;
      });
    return match;
  }

  /** Incoming message nodes that appear after the "N unread messages" divider. */
  function getIncomingNodesAfterUnreadDivider(root) {
    const main =
      (root && root.nodeType === 1 ? root : null) ||
      document.querySelector("#main");
    if (!main) return [];
    const divider = findUnreadDividerElement(main);
    const all = findIncomingMessageRoots(main);
    if (!divider) return [];

    // Keep nodes that are visually/document-order after the divider
    return all.filter((node) => {
      const pos = divider.compareDocumentPosition(node);
      return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  }

  function extractIncomingPayload(node, options = {}) {
    const withId = findMessageRow(node);
    if (!withId) return null;
    if (isOutgoingMessage(withId)) return null;
    if (!isIncomingMessage(withId)) return null;

    const dataId = withId.getAttribute("data-id") || "";
    const parsed = parseChatIdFromDataId(dataId);
    if (parsed.fromMe === true) return null;
    // Bare ids (no true_/false_): never treat as incoming unless DOM says so
    if (parsed.fromMe == null && isOutgoingMessage(withId)) return null;

    const text = getMessageText(withId);
    if (!text) return null;

    const pre =
      withId
        .querySelector?.("[data-pre-plain-text]")
        ?.getAttribute("data-pre-plain-text") || "";
    let messageDate = getMessageTimestamp(withId);
    // Real dates always respect the read window, even during unread catch-up.
    if (messageDate && !isWithinReadWindow(messageDate)) return null;

    const messageId = (() => {
      const dataId = withId.getAttribute("data-id") || "";
      if (dataId) return dataId;
      const chatName = getOpenChatName();
      return `dom_${stableHash(`${chatName}|${pre}|${text}`)}`;
    })();

    if (options.baselineIds?.has(messageId)) return null;

    if (!messageDate && (options.isRuntime || options.unreadCatchup)) {
      const timeOnly = parseMessageTimestamp(pre, { allowTimeOnly: true });
      if (timeOnly) messageDate = timeOnly;
      else if (options.allowUndatedRuntime || options.unreadCatchup) {
        messageDate = new Date();
      }
    }

    if (!messageDate) return null;

    if (
      !options.unreadCatchup &&
      !options.isRuntime &&
      !isWithinReadWindow(messageDate)
    )
      return null;

    const chatName = getOpenChatName();
    const customerPhone =
      parsed.phone ||
      phoneFromChatId(parsed.chatId) ||
      getPeerPhoneFromOpenChatDom(pre) ||
      (/^\+?\d[\d\s\-()]{7,}$/.test(chatName) ? normalizePhone(chatName) : "");
    const myPhone = getMyWhatsAppNumber();

    return {
      messageId,
      from: customerPhone,
      to: myPhone,
      chatId: parsed.chatId || "",
      chatName: chatName || customerPhone || parsed.chatId || "Unknown",
      text,
      isGroup: parsed.isGroup,
      receivedAt: messageDate.toISOString(),
      source: options.isRuntime ? "runtime" : "conversation",
      prePlainText: pre,
    };
  }

  function normalizeMessageText(text) {
    return (
      String(text || "")
        .replace(/[\u200e\u200f\ufeff]/g, "")
        // Strip Material/WhatsApp icon ligatures that leak from DOM textContent
        .replace(
          /\b(ic-expand-more|ic-expand-less|ic-check|ic-done|ic-done-all|ic-access-time|ic-photo-camera|ic-mic|ic-videocam|expand[_-]?more|expand[_-]?less)\b/gi,
          "",
        )
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  function isGarbageMessageText(text) {
    const t = normalizeMessageText(text);
    if (!t) return true;
    // Icon ligatures / Material icons leaking into textContent
    if (/ic-|expand-more|expand-less/i.test(t)) return true;
    // Allow short real messages like "1", "2", "ok", "?"
    return false;
  }

  function textsAreSameMessage(a, b) {
    const na = normalizeMessageText(a);
    const nb = normalizeMessageText(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // Chat-list bleed: "Ass" + unread/"1ic-expand-more" => "Ass1..."
    const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
    if (longer.startsWith(shorter)) {
      const rest = longer.slice(shorter.length);
      if (/^[\d\s]*$/i.test(rest)) return true;
      if (/^\d{0,3}(ic-expand-more|ic-expand-less)?$/i.test(rest)) return true;
    }
    return false;
  }

  function getMessageText(node) {
    if (!node) return "";
    // Prefer real message body only — avoid broad selectors that pick icons/meta
    const selectors = [
      "span.selectable-text.copyable-text",
      '[data-testid="message-text"] span.selectable-text',
      '[data-testid="message-text"]',
      ".copyable-text span.selectable-text",
      "span.selectable-text",
    ];
    for (const sel of selectors) {
      const el = node.querySelector?.(sel);
      const text = normalizeMessageText(el?.innerText || el?.textContent || "");
      if (text && !isGarbageMessageText(text)) return text;
    }
    const copyable = node.querySelector?.(
      ".copyable-text[data-pre-plain-text], [data-pre-plain-text]",
    );
    if (copyable) {
      const nested = normalizeMessageText(
        copyable.querySelector("span.selectable-text")?.innerText ||
          copyable.querySelector("span")?.innerText ||
          "",
      );
      if (nested && !isGarbageMessageText(nested)) return nested;
    }
    return "";
  }

  // Only used to detect chat-list changes (never posted as message text)
  function getPreviewFromRow(row) {
    if (!row) return "";
    const secondary = row.querySelector('[data-testid="cell-frame-secondary"]');
    const candidate =
      secondary?.querySelector?.("span[title]") ||
      secondary?.querySelector?.("span.selectable-text") ||
      secondary;
    if (!candidate) return "";
    const titled = (candidate.getAttribute?.("title") || "").trim();
    if (titled) return normalizeMessageText(titled);
    return normalizeMessageText(
      candidate.innerText || candidate.textContent || "",
    );
  }

  function getUnreadCountFromCell(cell) {
    if (!cell) return 0;
    const selectors = [
      '[aria-label*="unread" i]',
      '[aria-label*="Unread"]',
      '[aria-label*="unread"]',
      '[data-testid="icon-unread-count"]',
      '[data-testid="icon-unread"]',
      '[data-testid="unread-count"]',
      '[data-testid="unread-mention-count"]',
      'span[data-icon="unread-count"]',
      '[data-icon="unread-count"]',
    ];
    for (const sel of selectors) {
      let badge = null;
      try {
        badge = cell.querySelector(sel);
      } catch (_) {
        badge = null;
      }
      if (badge) return parseUnreadCountFromBadge(badge);
    }

    let found = 0;
    cell.querySelectorAll("span, div").forEach((el) => {
      const text = (el.textContent || "").trim();
      if (!/^\d{1,3}$/.test(text)) return;
      const rect = el.getBoundingClientRect();
      if (
        rect.width < 8 ||
        rect.width > 48 ||
        rect.height < 8 ||
        rect.height > 48
      ) {
        return;
      }
      // Green unread pills sit on the right side of the row
      const cellRect = cell.getBoundingClientRect();
      if (
        cellRect.width > 0 &&
        rect.left < cellRect.left + cellRect.width * 0.55
      ) {
        return;
      }
      found = Math.max(found, parseInt(text, 10) || 0);
    });
    return found > 0 ? Math.min(found, 99) : 0;
  }

  function findChatListPane() {
    return (
      document.querySelector('#pane-side [data-testid="chat-list"]') ||
      document.querySelector('[data-testid="chat-list"]') ||
      document.querySelector("#pane-side") ||
      document.querySelector('[aria-label="Chat list"]') ||
      document.querySelector('[aria-label="Chats"]') ||
      document.querySelector('[aria-label^="Chat list"]')
    );
  }

  /** All chat row cells currently visible in the sidebar list. */
  function queryChatListCells(pane) {
    const root = pane || findChatListPane();
    if (!root) return [];
    const seen = new Set();
    const out = [];
    const selectors = [
      '[data-testid="cell-frame-container"]',
      '[data-testid="list-item"]',
      'div[role="listitem"]',
      'div[role="row"]',
    ];
    for (const sel of selectors) {
      root.querySelectorAll(sel).forEach((cell) => {
        if (seen.has(cell) || cell.closest("#wa-cursor-sidebar")) return;
        // Prefer the innermost chat cell when nested matches exist
        if (
          cell.querySelector?.('[data-testid="cell-frame-container"]') &&
          sel !== '[data-testid="cell-frame-container"]'
        ) {
          return;
        }
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        seen.add(cell);
        out.push(cell);
      });
      if (out.length) break;
    }
    return out;
  }

  function getChatRowFromEl(el) {
    if (!el || el.closest?.("#wa-cursor-sidebar")) return null;
    return (
      el.closest('[data-testid="cell-frame-container"]') ||
      el.closest('[data-testid="list-item"]') ||
      el.closest('[role="listitem"]') ||
      el.closest('[role="row"]') ||
      el.closest("div[aria-selected]") ||
      el.closest('div[tabindex="-1"]') ||
      el.closest('div[tabindex="0"]')
    );
  }

  function getChatTitleFromRow(row) {
    if (!row) return "";
    const titleEl =
      row.querySelector('[data-testid="cell-frame-title"] span[title]') ||
      row.querySelector('[data-testid="cell-frame-title"]') ||
      row.querySelector('span[title][dir="auto"]') ||
      row.querySelector("span[title]");
    return (
      titleEl?.getAttribute("title") ||
      titleEl?.textContent ||
      ""
    ).trim();
  }

  function parseUnreadCountFromBadge(badge) {
    if (!badge) return 1;
    const label = badge.getAttribute?.("aria-label") || "";
    const fromLabel = label.match(/(\d+)/);
    if (fromLabel) {
      const n = parseInt(fromLabel[1], 10);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 99);
    }
    const text = (badge.textContent || "").trim();
    if (/^\d{1,3}$/.test(text)) {
      const n = parseInt(text, 10);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 99);
    }
    return 1;
  }

  function isConversationOpen() {
    return !!(
      document.querySelector(
        '#main [data-testid="conversation-panel-messages"]',
      ) ||
      document.querySelector('#main [data-testid="conversation-panel-body"]') ||
      document.querySelector("#main footer") ||
      document.querySelector('#main [contenteditable="true"]') ||
      document.querySelector(
        '#main [data-testid="conversation-compose-box-input"]',
      )
    );
  }

  function simulateUserClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (_) {}

    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const x = rect.left + Math.min(Math.max(rect.width / 2, 8), rect.width - 8);
    const y =
      rect.top + Math.min(Math.max(rect.height / 2, 8), rect.height - 8);
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };

    try {
      el.focus?.();
    } catch (_) {}

    [
      "pointerover",
      "pointerenter",
      "mouseover",
      "mouseenter",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ].forEach((type) => {
      let event;
      if (type.startsWith("pointer")) {
        try {
          event = new PointerEvent(type, common);
        } catch (_) {
          event = new MouseEvent(type, common);
        }
      } else {
        event = new MouseEvent(type, common);
      }
      el.dispatchEvent(event);
    });

    try {
      el.click();
    } catch (_) {}
    return true;
  }

  function findUnreadChatRows() {
    const pane = findChatListPane();
    if (!pane) return [];

    const rows = [];
    const seen = new Set();

    const isFilterOrToolbar = (el) => {
      if (!el) return true;
      // Exclude the Unread/All/Groups filter chips and header controls
      if (el.closest("button")) return true;
      if (
        el.closest('[role="button"]') &&
        !el.closest('[data-testid="cell-frame-container"]')
      ) {
        // chat rows are rarely role=button at the outer level for filters
        const label = (
          el.getAttribute?.("aria-label") ||
          el.textContent ||
          ""
        ).toLowerCase();
        if (
          /\b(unread|all|favourites|groups|contacts)\b/.test(label) &&
          !el.closest('[data-testid="cell-frame-container"]')
        ) {
          return true;
        }
      }
      return false;
    };

    const addRow = (badgeOrRow, badge) => {
      if (isFilterOrToolbar(badgeOrRow)) return;
      const row = getChatRowFromEl(badgeOrRow);
      if (!row || seen.has(row) || !pane.contains(row)) return;
      if (row.closest("#wa-cursor-sidebar")) return;
      // Must look like a chat cell, not a filter chip
      if (
        !row.matches?.('[data-testid="cell-frame-container"]') &&
        !row.querySelector?.('[data-testid="cell-frame-title"]') &&
        !row.querySelector?.("span[title]")
      ) {
        return;
      }
      seen.add(row);
      rows.push({
        row,
        title: getChatTitleFromRow(row),
        unreadCount: parseUnreadCountFromBadge(badge || badgeOrRow),
      });
    };

    // Prefer searching inside known chat cells only
    const cells = queryChatListCells(pane);
    if (cells.length) {
      cells.forEach((cell) => {
        const badge =
          cell.querySelector('[aria-label*="unread" i]') ||
          cell.querySelector('[data-testid="icon-unread-count"]') ||
          cell.querySelector('[data-testid="icon-unread"]') ||
          cell.querySelector('[data-testid="unread-count"]') ||
          cell.querySelector('[data-testid="unread-mention-count"]') ||
          cell.querySelector('[data-icon="unread-count"]');
        if (badge) {
          addRow(cell, badge);
          return;
        }

        // Numeric green pill inside this cell
        cell.querySelectorAll("span").forEach((el) => {
          const text = (el.textContent || "").trim();
          if (!/^\d{1,3}$/.test(text)) return;
          const rect = el.getBoundingClientRect();
          if (
            rect.width < 10 ||
            rect.width > 36 ||
            rect.height < 10 ||
            rect.height > 36
          )
            return;
          addRow(cell, el);
        });
      });
    } else {
      pane.querySelectorAll('[aria-label*="unread" i]').forEach((badge) => {
        if (isFilterOrToolbar(badge)) return;
        addRow(badge, badge);
      });
    }

    // If Unread filter is on and badges still missing, open visible chat cells
    if (!rows.length && cells.length) {
      const filterBtn = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      ).find((btn) => {
        const t =
          `${btn.getAttribute("aria-label") || ""} ${btn.textContent || ""}`.toLowerCase();
        return (
          t.includes("unread") &&
          (btn.getAttribute("aria-pressed") === "true" ||
            btn.getAttribute("aria-selected") === "true")
        );
      });
      const limit = filterBtn ? cells.length : Math.min(cells.length, 3);
      Array.from(cells)
        .slice(0, limit)
        .forEach((cell) => addRow(cell, null));
    }

    return rows;
  }

  function findAllChatRows() {
    return queryChatListCells().map((cell) => ({
      row: cell,
      title: getChatTitleFromRow(cell),
    }));
  }

  function findRecentChatRows() {
    return findAllChatRows().filter((item) =>
      isChatRowWithinReadWindow(item.row),
    );
  }

  function scanVisibleConversation(scanFn) {
    scanFn();
  }

  function renderReceivedPostState(postedEl, postState) {
    postedEl.classList.remove("error");
    postedEl.replaceChildren();

    // Row dataset feeds the per-second progress line (see refreshPostProgress)
    const li = postedEl.closest?.(".wa-received-item");
    if (li) {
      li.dataset.postState =
        postState === "ok" || postState === "skip" ? "ok"
        : !postState || postState === "pending" ? "pending"
        : "error";
      li.dataset.attempts = String(postState?.attempts || 0);
      li.dataset.nextRetryAt = String(postState?.nextRetryAt || 0);
    }

    if (postState === "ok") {
      postedEl.textContent = "Posted to chat API";
      postedEl.removeAttribute("title");
      return;
    }
    if (postState === "skip") {
      postedEl.textContent = "Saved locally (log in to POS for chat API)";
      postedEl.removeAttribute("title");
      return;
    }
    if (!postState || postState === "pending") {
      postedEl.textContent = "Not posted yet";
      postedEl.removeAttribute("title");
      return;
    }

    const info = postState.errorInfo || {
      summary: postState.summary || postState.error || "Request failed",
      detail: postState.detail || "",
      url: postState.url || "",
      tooltip: [postState.error || postState.summary, postState.url]
        .filter(Boolean)
        .join("\n"),
    };

    const main = document.createElement("div");
    main.textContent = `Post failed: ${info.summary}`;
    postedEl.appendChild(main);

    if (info.detail && !info.summary.includes(info.detail)) {
      const detailEl = document.createElement("div");
      detailEl.className = "wa-received-error-detail";
      detailEl.textContent = info.detail;
      postedEl.appendChild(detailEl);
    }

    if (info.url) {
      const urlEl = document.createElement("div");
      urlEl.className = "wa-received-error-detail";
      urlEl.textContent = info.url;
      postedEl.appendChild(urlEl);
    }

    postedEl.classList.add("error");
    if (info.tooltip) postedEl.title = info.tooltip;
  }

  function createSidebar(forceRebuild = false) {
    // Kill any leftover send loops from a previous injection/sidebar
    cancelAllSenderRuns();

    const currentVersion = chrome.runtime.getManifest().version;
    const existingSidebar = document.getElementById("wa-cursor-sidebar");
    if (existingSidebar) {
      const isCurrent =
        existingSidebar.dataset.version === currentVersion &&
        existingSidebar.querySelector(".wa-tabs") &&
        existingSidebar.querySelector("#wa-not-available-url") &&
        existingSidebar.querySelector("#wa-receive-url") &&
        existingSidebar.querySelector('[data-tab="received"]') &&
        existingSidebar.querySelector('[data-tab="settings"]') &&
        existingSidebar.querySelector(".wa-send-actions") &&
        existingSidebar.querySelector("#wa-stop-whatsapp-chat") &&
        typeof existingSidebar.querySelector === "function";
      if (!forceRebuild && isCurrent) {
        if (typeof window.__waEnsureReceiveListening === "function") {
          window.__waEnsureReceiveListening();
        }
        return existingSidebar;
      }
      // Version/UI rebuild — resume listening even if user stopped on an older build
      if (existingSidebar.dataset.version !== currentVersion) {
        sessionStorage.removeItem(LISTENING_STOPPED_KEY);
      }
      cancelAllReceiveRuns();
      existingSidebar.remove();
    }

    const apiSettings = loadApiSettings();
    const sidebar = document.createElement("div");
    sidebar.id = "wa-cursor-sidebar";
    sidebar.dataset.version = currentVersion;
    sidebar.innerHTML = `
      <div class="wa-sidebar-header">
        <div class="wa-sidebar-title">
          <span>Store Sync WhatsApp Sender</span>
          <span class="wa-version" id="wa-ext-version">v${currentVersion}</span>
        </div>
        <button id="wa-sidebar-close">&times;</button>
      </div>
        <div class="wa-tabs">
        <button type="button" class="wa-tab" data-tab="manual" style="display:none;" hidden>Manual</button>
        <button type="button" class="wa-tab active" data-tab="api">Start Sending Messages</button>
        <button type="button" class="wa-tab" data-tab="received">Received</button>
        <button type="button" class="wa-tab" data-tab="settings">Settings</button>
        </div>
      <div class="wa-sidebar-content">
        <div class="wa-tab-panel" data-panel="manual" style="display:none;">
          <label for="wa-numbers-input">Phone Numbers (comma-separated):</label>
          <textarea id="wa-numbers-input" placeholder="e.g. +1234567890, +1987654321"></textarea>
          <label for="wa-message-input">Message:</label>
          <textarea id="wa-message-input" placeholder="Enter your message"></textarea>
        </div>
        <div class="wa-tab-panel" data-panel="api">
          <div id="wa-pos-auth-status" class="wa-pos-auth-status is-muted wa-api-urls-hidden" aria-hidden="true">Checking POS login…</div>
          <div class="wa-receive-controls" style="display:flex; gap:10px; margin-bottom:10px; align-items:center;">
            <div id="wa-api-listening-status" class="wa-send-status" style="margin:0; flex:1;">Listening…</div>
            <button id="wa-api-start-listening" type="button" style="display:none;">Start Listening</button>
            <button id="wa-api-stop-listening" type="button" style="display:none; background:#e74c3c; color:white;">Stop Listening</button>
          </div>
          <div class="wa-api-urls-hidden" aria-hidden="true">
            <label for="wa-fetch-url">Fetch Chat URL (GET):</label>
            <input type="text" id="wa-fetch-url" placeholder="http://localhost:8000/api/chat/fetch-random?company_id=..." />
            <label for="wa-update-url">Mark Sent URL (GET):</label>
            <input type="text" id="wa-update-url" placeholder="http://localhost:8000/api/chat/mark-sent/:id" />
            <label for="wa-not-available-url">Mark Not Available URL (GET):</label>
            <input type="text" id="wa-not-available-url" placeholder="http://localhost:8000/api/chat/mark-not-available/:id" />
            <p class="wa-hint">GET <code>fetch-random</code> returns one chat with status <code>not_started</code>. Use <code>:id</code> in mark URLs. Sent → <code>sent</code>; failed → <code>not_available</code>.</p>
          </div>
        </div>
        <div class="wa-tab-panel" data-panel="received" style="display:none;">
          <div class="wa-api-urls-hidden" aria-hidden="true">
            <label for="wa-receive-url">Chat API URL (POST):</label>
            <input type="text" id="wa-receive-url" placeholder="http://localhost:8000/api/chat/create/:token" />
            <label for="wa-receive-days">Read messages from last (days):</label>
            <input type="number" id="wa-receive-days" value="1" min="1" max="1" readonly />
          </div>
          <p class="wa-hint">Captures messages that sync to WhatsApp Web — including ones already read on your phone. Only older history outside the read window is ignored.</p>
          <div id="wa-receive-status" class="wa-send-status"></div>
          <div class="wa-receive-controls" style="display:flex; gap:10px; margin-bottom:10px;">
            <button id="wa-start-listening" type="button" style="display:none;">Start Listening</button>
            <button id="wa-stop-listening" type="button" style="display:none; background:#e74c3c; color:white;">Stop Listening</button>
          </div>
          <ul id="wa-received-list" class="wa-received-list"></ul>
        </div>
        <div class="wa-tab-panel" data-panel="settings" style="display:none;">
          <p class="wa-hint">Saved in this browser only. Changes apply right away (listening restarts if it is on).</p>
          <form id="wa-settings-form" novalidate>
            ${RECEIVE_SETTINGS_FIELDS.map((f) =>
              f.type === "bool" ?
                `<label class="wa-settings-check"><input type="checkbox" name="${f.key}" /> ${f.label}</label>`
              : `<label for="wa-setting-${f.key}">${f.label}</label>
                 <input type="number" id="wa-setting-${f.key}" name="${f.key}" min="${f.min}" max="${f.max}" step="1" />`,
            ).join("")}
            <div id="wa-settings-status" class="wa-send-status"></div>
            <button type="submit" id="wa-settings-save">Save Settings</button>
            <button type="button" id="wa-settings-reset" class="wa-settings-reset">Reset to defaults</button>
          </form>
        </div>
        <div id="wa-send-controls">
          <div class="wa-api-urls-hidden" aria-hidden="true" style="display: flex; gap: 10px; margin-bottom: 10px;">
            <div style="flex:1;">
              <label for="wa-min-delay">Min Delay (seconds):</label>
              <input type="number" id="wa-min-delay" value="2" min="1" />
            </div>
            <div style="flex:1;">
              <label for="wa-max-delay">Max Delay (seconds):</label>
              <input type="number" id="wa-max-delay" value="12" min="1" />
            </div>
          </div>
          <div id="wa-send-status" class="wa-send-status"></div>
          <div class="wa-send-actions">
            <button id="wa-start-whatsapp-chat" data-label-manual="Start Sending Messages" data-label-api="Start">Start Sending Messages</button>
            <button id="wa-stop-whatsapp-chat" class="wa-stop-btn" type="button" hidden>Stop</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(sidebar);

    document.getElementById("wa-fetch-url").value = apiSettings.fetchUrl || "";
    document.getElementById("wa-update-url").value =
      apiSettings.updateUrl || "";
    document.getElementById("wa-not-available-url").value =
      apiSettings.notAvailableUrl || "";
    document.getElementById("wa-receive-url").value =
      apiSettings.receiveUrl || "";
    const receiveDaysEl = document.getElementById("wa-receive-days");
    if (receiveDaysEl) {
      receiveDaysEl.value = String(
        apiSettings.receiveDays || DEFAULT_RECEIVE_DAYS,
      );
    }

    [
      "wa-fetch-url",
      "wa-update-url",
      "wa-not-available-url",
      "wa-receive-url",
      "wa-receive-days",
    ].forEach((id) => {
      const input = document.getElementById(id);
      input.addEventListener("input", persistApiUrlsFromInputs);
      input.addEventListener("change", persistApiUrlsFromInputs);
      input.addEventListener("blur", persistApiUrlsFromInputs);
    });

    let stopSending = false;
    let stopListening = sessionStorage.getItem(LISTENING_STOPPED_KEY) === "1";
    let listeningManuallyStopped = stopListening;
    let activeTimeout = null;
    let activeTab = "api";
    let activeRunId = 0;
    let receiveRunId = 0;
    let openingChat = false;
    let openingChatTitle = "";
    const chatOpenQueue = [];
    function getNextListeningMessageCount() {
      // "Next messages" ~= unread messages expected in chats currently queued
      // to open (so we can capture their unread bubbles next).
      try {
        return chatOpenQueue.reduce((sum, item) => {
          const n = Number(item?.unreadCount);
          return sum + (Number.isFinite(n) ? n : 0);
        }, 0);
      } catch (_) {
        return 0;
      }
    }
    let lastNextListeningEstimate = 0;
    // Base text for the API listening strip (without countdown suffix).
    // Updated only when `setReceiveStatus()` runs.
    let lastApiListeningStatusText = "";
    let receiveCountdownTimer = null;
    let nextReceivePollAt = 0;

    // Persisted per-chat cursor: last successfully captured message timestamp/id.
    // Used to avoid re-posting messages that were already sent to your API.
    const chatMessageCursorByChatName = new Map();
    let chatCursorLoaded = false;
    let cursorPersistTimer = null;
    let cursorDirty = false;
    async function loadChatMessageCursors() {
      if (chatCursorLoaded) return;
      chatCursorLoaded = true;
      chatMessageCursorByChatName.clear();
      try {
        if (typeof chrome === "undefined" || !chrome.storage?.local?.get)
          return;
        const data = await chrome.storage.local.get(
          CHAT_MESSAGE_CURSOR_STORAGE_KEY,
        );
        const stored = data?.[CHAT_MESSAGE_CURSOR_STORAGE_KEY];
        if (!stored || typeof stored !== "object") return;
        for (const [k, v] of Object.entries(stored)) {
          const atMs = Number(v?.atMs);
          if (!Number.isFinite(atMs)) continue;
          const ids = Array.isArray(v?.ids) ? v.ids.map(String) : [];
          if (!ids.length && v?.messageId) ids.push(String(v.messageId));
          chatMessageCursorByChatName.set(k, { atMs, ids });
        }
      } catch (_) {}
    }
    async function persistChatMessageCursors() {
      if (!cursorDirty) return;
      cursorDirty = false;
      try {
        if (typeof chrome === "undefined" || !chrome.storage?.local?.set)
          return;
        const obj = {};
        for (const [k, v] of chatMessageCursorByChatName.entries()) {
          if (!v || !Number.isFinite(v.atMs)) continue;
          obj[k] = { atMs: v.atMs, ids: v.ids || [] };
        }
        await chrome.storage.local.set({
          [CHAT_MESSAGE_CURSOR_STORAGE_KEY]: obj,
        });
      } catch (_) {}
    }
    function schedulePersistChatMessageCursors() {
      if (cursorPersistTimer) clearTimeout(cursorPersistTimer);
      cursorPersistTimer = setTimeout(
        persistChatMessageCursors,
        CHAT_CURSOR_PERSIST_DEBOUNCE_MS,
      );
    }
    // WhatsApp timestamps are minute-precision, so several messages can share
    // the cursor's atMs. Only those whose ids were already captured are old.
    function isBehindChatCursor(chatKey, atMs, messageId) {
      const cursor = chatMessageCursorByChatName.get(chatKey);
      if (!cursor || !Number.isFinite(cursor.atMs) || !Number.isFinite(atMs)) {
        return false;
      }
      if (atMs < cursor.atMs) return true;
      return atMs === cursor.atMs && cursor.ids.includes(String(messageId));
    }
    function updateChatCursor(chatKey, receivedAtIso, messageId) {
      if (!chatKey) return;
      const atMs = Date.parse(receivedAtIso);
      if (!Number.isFinite(atMs)) return;
      const id = String(messageId || "");
      const prev = chatMessageCursorByChatName.get(chatKey);
      if (prev && Number.isFinite(prev.atMs) && atMs < prev.atMs) return;
      if (prev && atMs === prev.atMs) {
        if (!id || prev.ids.includes(id)) return;
        prev.ids = [...prev.ids, id].slice(-50);
      } else {
        chatMessageCursorByChatName.set(chatKey, { atMs, ids: id ? [id] : [] });
      }
      cursorDirty = true;
      schedulePersistChatMessageCursors();
    }
    function estimateNextListeningMessagesFromChatList() {
      // Even when listening is stopped, estimate how many unread messages are
      // currently present in the visible chat list (so users still see a
      // “next” counter).
      try {
        const pane = findChatListPane();
        if (!pane) return 0;

        let total = 0;
        queryChatListCells(pane).forEach((cell) => {
          const unread = Number(getUnreadCountFromCell(cell));
          if (Number.isFinite(unread) && unread > 0) total += unread;
        });

        // Keep UI stable / avoid outlier badges from exploding the number.
        return Math.min(total, 999);
      } catch (_) {
        return 0;
      }
    }
    const openFailCounts = new Map();
    const chatListState = new Map(); // title -> { preview, unread }
    const recentByChat = new Map(); // chatName -> [{ text, at, source }]
    let chatListSeeded = false;
    const seenIds = loadSeenIds();
    let postQueue = Promise.resolve();
    let scanDebounceTimer = null;
    let lastChatSwitchFinishedAt = 0;
    const baselineMessageIds = new Set();
    let openingStartedAt = 0;
    let lastReceiveHeartbeatAt = 0;
    let lastUnreadRequeueAt = 0;

    function findChatRowByTitle(title) {
      const want = String(title || "").trim();
      if (!want) return null;
      const pane = findChatListPane();
      if (!pane) return null;
      for (const cell of queryChatListCells(pane)) {
        if (getChatTitleFromRow(cell).trim() === want) return cell;
      }
      return null;
    }

    function markChatActivityHandled(title, preview, unread) {
      if (!title) return;
      chatListState.set(title, {
        preview: preview || "",
        unread: Number(unread) || 0,
        handledPreview: preview || "",
        pending: false,
      });
    }

    function noteChatActivitySeen(title, preview, unread, pending = false) {
      if (!title) return;
      const prev = chatListState.get(title) || {};
      chatListState.set(title, {
        preview: preview || prev.preview || "",
        unread: Number(unread) || 0,
        handledPreview: prev.handledPreview || "",
        pending: !!pending,
      });
    }

    function clearStuckOpenIfNeeded() {
      if (!openingChat || !openingStartedAt) return false;
      if (Date.now() - openingStartedAt < RECEIVE_OPEN_STUCK_MS) return false;
      console.warn("[WA] receive open stuck — resetting", {
        title: openingChatTitle,
        ms: Date.now() - openingStartedAt,
      });
      openingChat = false;
      openingChatTitle = "";
      openingStartedAt = 0;
      lastChatSwitchFinishedAt = Date.now();
      return true;
    }

    function requeueVisibleUnreadChats(force = false) {
      if (!isListening()) return 0;
      const now = Date.now();
      if (
        !force &&
        lastUnreadRequeueAt &&
        now - lastUnreadRequeueAt < RECEIVE_UNREAD_REQUEUE_MS
      ) {
        return 0;
      }
      lastUnreadRequeueAt = now;
      const pane = findChatListPane();
      if (!pane) {
        console.warn("[WA] unread requeue: no chat list pane");
        return 0;
      }
      let queued = 0;
      let queuedMessages = 0;
      const unreadSnap = [];
      queryChatListCells(pane).forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        const unread = getUnreadCountFromCell(cell);
        const preview = getPreviewFromRow(cell);
        if (unread > 0) {
          unreadSnap.push({
            title,
            unread,
            preview: String(preview).slice(0, 40),
          });
        }
        if (!unread || unread < 1) {
          noteChatActivitySeen(title, preview, unread, false);
          return;
        }
        if (isOutgoingChatPreview(preview)) {
          noteChatActivitySeen(title, preview, unread, false);
          return;
        }
        const prev = chatListState.get(title) || {};
        // Short cooldown after a recent open attempt for the same preview
        if (
          !force &&
          prev.lastOpenAttemptAt &&
          now - prev.lastOpenAttemptAt < 8000 &&
          prev.handledPreview &&
          textsAreSameMessage(prev.handledPreview, preview)
        ) {
          return;
        }
        // Always keep trying while unread badge remains (unless just captured)
        if (
          prev.handledPreview &&
          textsAreSameMessage(prev.handledPreview, preview) &&
          !prev.pending &&
          prev.lastCapturedAt &&
          now - prev.lastCapturedAt < 15000
        ) {
          return;
        }

        noteChatActivitySeen(title, preview, unread, true);
        if (isChatCurrentlyOpen(title)) {
          const n = processConversationCatchup({
            unreadHint: Math.max(unread, 1),
            expectedPreview: preview,
          });
          if (n > 0) {
            markChatActivityHandled(title, preview, 0);
            const st = chatListState.get(title) || {};
            st.lastCapturedAt = now;
            chatListState.set(title, st);
          }
          return;
        }
        queueChatOpen({
          row: cell,
          title,
          unreadCount: unread,
          expectedPreview: preview,
          reason: "unread-requeue",
        });
        queued += 1;
        queuedMessages += unread;
      });
      if (unreadSnap.length) {
        console.log("[WA] unread sidebar →", unreadSnap);
      } else {
        console.log("[WA] unread sidebar → (none detected)");
      }
      if (queued > 0) {
        console.log("[WA] requeued unread chats →", queued);
        lastNextListeningEstimate = queuedMessages;
        setReceiveStatus(
          `Listening — ${queued} unread chat${queued === 1 ? "" : "s"} waiting…`,
        );
      }
      return queued;
    }

    function getChatSwitchGapMs() {
      return getRandomDelay(RECEIVE_CHAT_GAP_MIN_SEC, RECEIVE_CHAT_GAP_MAX_SEC);
    }

    function canOpenNextChat() {
      if (openingChat || !isListening()) return false;
      if (!lastChatSwitchFinishedAt) return true;
      const minGapMs = RECEIVE_CHAT_GAP_MIN_SEC * 1000;
      return Date.now() - lastChatSwitchFinishedAt >= minGapMs;
    }

    function isActive() {
      return !stopSending && isSenderRunActive(activeRunId);
    }

    function isListening() {
      return !stopListening && isReceiveRunActive(receiveRunId);
    }

    function updateStartButtonLabel() {
      const startBtn = document.getElementById("wa-start-whatsapp-chat");
      if (!startBtn) return;
      startBtn.textContent =
        activeTab === "api" ?
          startBtn.dataset.labelApi || "Start"
        : startBtn.dataset.labelManual || "Start Sending Messages";
    }

    function isSendTab() {
      return activeTab === "api" || activeTab === "manual";
    }

    function updatePanelVisibility() {
      sidebar.querySelectorAll(".wa-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === activeTab);
      });
      sidebar.querySelectorAll(".wa-tab-panel").forEach((panel) => {
        panel.style.display =
          panel.dataset.panel === activeTab ? "block" : "none";
      });
      const sendControls = document.getElementById("wa-send-controls");
      if (sendControls) {
        sendControls.style.display =
          isSendTab() ? "block" : "none";
      }
      const startBtn = document.getElementById("wa-start-whatsapp-chat");
      const stopBtn = document.getElementById("wa-stop-whatsapp-chat");
      const running = !!startBtn?.disabled;
      if (startBtn) {
        startBtn.style.display =
          !isSendTab() || running ? "none" : "";
      }
      if (stopBtn) {
        const showStop = running && isSendTab();
        stopBtn.hidden = !showStop;
        stopBtn.style.display = showStop ? "block" : "none";
      }
      updateStartButtonLabel();
    }

    // Tabs stay usable while sending — the send loop doesn't depend on them.
    sidebar.querySelectorAll(".wa-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        activeTab = tabBtn.dataset.tab;
        updatePanelVisibility();
      });
    });

    updatePanelVisibility();

    function setRunning(running) {
      const startBtn = document.getElementById("wa-start-whatsapp-chat");
      const stopBtn = document.getElementById("wa-stop-whatsapp-chat");
      if (!startBtn || !stopBtn) return;
      startBtn.disabled = !!running;
      startBtn.setAttribute("aria-disabled", running ? "true" : "false");
      // Always show Stop while the sender loop is active (API + Manual).
      const showStop = !!running && isSendTab();
      stopBtn.hidden = !showStop;
      stopBtn.style.display = showStop ? "block" : "none";
      startBtn.style.display =
        !isSendTab() || running ? "none" : "";
      if (!running) {
        updateStartButtonLabel();
      }
    }

    function setListeningUi(running) {
      const startBtn = document.getElementById("wa-start-listening");
      const stopBtn = document.getElementById("wa-stop-listening");
      const apiStartBtn = document.getElementById("wa-api-start-listening");
      const apiStopBtn = document.getElementById("wa-api-stop-listening");
      if (!RECEIVE_READING_ENABLED) running = null;

      // running === null → reading disabled: hide both Start and Stop
      const startDisplay = running === false ? "inline-block" : "none";
      if (stopBtn) stopBtn.style.display = running ? "inline-block" : "none";
      if (startBtn) startBtn.style.display = startDisplay;
      if (apiStopBtn)
        apiStopBtn.style.display = running ? "inline-block" : "none";
      if (apiStartBtn) apiStartBtn.style.display = startDisplay;
    }

    function stopReceiveListening() {
      stopListening = true;
      listeningManuallyStopped = true;
      sessionStorage.setItem(LISTENING_STOPPED_KEY, "1");
      cancelAllReceiveRuns();
      if (receiveCountdownTimer) clearInterval(receiveCountdownTimer);
      receiveCountdownTimer = null;
      nextReceivePollAt = 0;
      openingChat = false;
      openingChatTitle = "";
      chatOpenQueue.length = 0;
      setListeningUi(false);
      setReceiveStatus("Stopped listening.");
    }

    function setSendStatus(text) {
      // Ignore status updates from cancelled/old runs
      if (!isActive() && text !== "Stopped.") return;
      const status = document.getElementById("wa-send-status");
      if (status) {
        status.textContent = text;
      }
      // Keep Stop visible for the whole API/manual run (incl. "Fetching next…")
      if (isActive()) {
        setRunning(true);
      }
    }

    function setReceiveStatus(text) {
      const allowedWhileStopped =
        text === "Stopped listening." ||
        text === "Listening stopped." ||
        text === RECEIVE_DISABLED_STATUS ||
        text === "Starting listener…" ||
        text.startsWith("Waiting for WhatsApp") ||
        text.startsWith("Listen failed:");
      if (!isListening() && !allowedWhileStopped) return;
      const status = document.getElementById("wa-receive-status");
      if (status) {
        status.textContent = text;
      }
      const apiStatus = document.getElementById("wa-api-listening-status");
      if (apiStatus) {
        if (isListening()) {
          // Append only for the "listening" states that represent upcoming work.
          if (text.startsWith("Listening —")) {
            const next =
              lastNextListeningEstimate || getNextListeningMessageCount();
            apiStatus.textContent =
              next > 0 ?
                `${text} Next: ${next} msg${next === 1 ? "" : "s"}`
              : text;
          } else {
            apiStatus.textContent = text;
          }
        } else {
          const next =
            lastNextListeningEstimate ||
            estimateNextListeningMessagesFromChatList();
          apiStatus.textContent =
            next > 0 ?
              `${text} Next: ${next} msg${next === 1 ? "" : "s"}`
            : text;
        }
        lastApiListeningStatusText = apiStatus.textContent;
      }
    }

    function prependReceivedItem(payload, postState, options = {}) {
      const list = document.getElementById("wa-received-list");
      if (!list || !payload?.messageId) return null;

      const existing = list.querySelector(
        `[data-message-id="${CSS.escape(payload.messageId)}"]`,
      );
      if (existing) {
        const postedEl = existing.querySelector(".wa-received-posted");
        if (postedEl) renderReceivedPostState(postedEl, postState);
        if (!options.skipPersist) upsertReceivedListItem(payload, postState);
        return existing;
      }

      const li = document.createElement("li");
      li.className = "wa-received-item";
      li.dataset.messageId = payload.messageId;

      const time = new Date(payload.receivedAt);
      const timeLabel =
        Number.isNaN(time.getTime()) ? "" : (
          time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        );

      const fromLabel =
        payload.from ?
          `${payload.chatName} (${payload.from})`
        : payload.chatName;

      li.innerHTML = `
        <div class="wa-received-meta">
          <span class="wa-received-from" title="${fromLabel.replace(/"/g, "&quot;")}">${fromLabel}</span>
          <span class="wa-received-time">${timeLabel}</span>
        </div>
        <div class="wa-received-text"></div>
        <div class="wa-received-posted"></div>
        <div class="wa-post-progress" hidden>
          <span class="wa-post-progress-text"></span>
          <button type="button" class="wa-retry-now" hidden>Retry now</button>
        </div>
      `;
      li.querySelector(".wa-received-text").textContent = payload.text;

      const postedEl = li.querySelector(".wa-received-posted");
      renderReceivedPostState(postedEl, postState);

      list.prepend(li);
      while (list.children.length > MAX_LIST_ITEMS) {
        list.removeChild(list.lastChild);
      }
      if (!options.skipPersist) upsertReceivedListItem(payload, postState);
      return li;
    }

    function rehydrateReceivedList() {
      const items = loadReceivedList();
      // Persist order is newest-first; prepend in reverse so newest ends on top
      [...items].reverse().forEach((item) => {
        if (!item?.payload) return;
        prependReceivedItem(item.payload, item.postState || "ok", {
          skipPersist: true,
        });
      });
    }

    function updateReceivedItemStatus(messageId, postState, payload) {
      // Persist first so retries see the latest state even if the row is gone
      const items = loadReceivedList();
      const idx = items.findIndex(
        (item) => item?.payload?.messageId === messageId,
      );
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          postState,
          ...(payload ? { payload } : {}),
        };
        saveReceivedList(items);
      }

      const li = document.querySelector(
        `#wa-received-list [data-message-id="${CSS.escape(messageId)}"]`,
      );
      const postedEl = li?.querySelector(".wa-received-posted");
      if (postedEl) renderReceivedPostState(postedEl, postState);
    }

    function postIncomingToChatApi(payload) {
      return new Promise((resolve, reject) => {
        const receiveTemplate =
          document.getElementById("wa-receive-url")?.value.trim() || "";
        const apiSettings = loadApiSettings();
        const apiBody = {
          from_user_id:
            normalizePhone(payload.from) ||
            phoneFromChatId(payload.chatId) ||
            normalizePhone(payload.chatName) ||
            "unknown",
          to_user_id:
            normalizePhone(payload.to) || getMyWhatsAppNumber() || "unknown",
          message: payload.text || "",
          message_id: payload.messageId || "",
          whatsapp_time: payload.receivedAt || payload.whatsapp_time || "",
        };
        console.log("[WA] POST /api/chat/create payload →", apiBody);

        chrome.runtime.sendMessage(
          {
            type: "wa-post-incoming-chat",
            payload,
            receiveUrlTemplate: receiveTemplate,
            apiUrl:
              receiveTemplate || apiSettings.fetchUrl || apiSettings.receiveUrl,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn(
                "[WA] POST /api/chat/create failed:",
                chrome.runtime.lastError.message,
              );
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!response?.ok) {
              console.warn("[WA] POST /api/chat/create error →", {
                url: response?.url,
                payload: response?.body || apiBody,
                error: response?.error,
                data: response?.data,
              });
              const err = new Error(
                response?.errorInfo?.summary ||
                  response?.error ||
                  `Request failed (${response?.status || 0})`,
              );
              err.postState = response?.errorInfo || {
                summary: response?.error,
                detail:
                  response?.data?.message ||
                  response?.data?.error ||
                  response?.data?.raw ||
                  "",
                url: response?.url || "",
                tooltip: [response?.error, response?.url]
                  .filter(Boolean)
                  .join("\n"),
              };
              reject(err);
              return;
            }
            console.log("[WA] POST /api/chat/create ok →", {
              url: response.url,
              payload: response.body || apiBody,
              data: response.data,
            });
            resolve(response);
          },
        );
      });
    }

    async function handleIncomingPayload(payload) {
      if (!payload?.messageId || !payload?.text) return;
      // Never accept chat-list scrapes as message bodies (icons/unread bleed)
      if (payload.source === "chat-list") return;

      payload.text = normalizeMessageText(payload.text);
      if (!payload.text || isGarbageMessageText(payload.text)) return;
      if (seenIds.has(payload.messageId)) return;

      const chatKey = payload.chatName || payload.from || "unknown";
      const payloadAtMs = Date.parse(payload.receivedAt);
      // Persisted cursor check: avoid re-posting messages already captured
      // in a previous session (or earlier in this run).
      if (isBehindChatCursor(chatKey, payloadAtMs, payload.messageId)) {
        return;
      }
      const now = Date.now();
      const recent = (recentByChat.get(chatKey) || []).filter(
        (item) => now - item.at < 90000,
      );

      // Drop duplicates like conversation "Ass" + polluted "Ass1ic-expand-more"
      if (recent.some((item) => textsAreSameMessage(item.text, payload.text))) {
        recentByChat.set(chatKey, recent);
        return;
      }

      recent.push({
        text: payload.text,
        at: now,
        source: payload.source || "unknown",
      });
      recentByChat.set(chatKey, recent.slice(-20));

      // Show in UI first — only mark seen if the list item was inserted
      const li = prependReceivedItem(payload, "pending");
      if (!li) return;

      seenIds.add(payload.messageId);
      baselineMessageIds.add(payload.messageId);
      saveSeenIds(seenIds);

      setReceiveStatus(
        `New from ${payload.chatName || payload.from || "chat"}`,
      );

      sendIncomingPost(payload, { resolvePhone: true });
    }

    const inFlightPostIds = new Set();
    // Progress tracking for the Received list
    const waitingPostIds = []; // queued behind the active post, in order
    let activePostId = "";
    let activePostStep = "";
    // How often the retry scheduler checks for due items
    const POST_RETRY_CHECK_MS = 5000;

    function getStoredPostState(messageId) {
      return loadReceivedList().find(
        (item) => item?.payload?.messageId === messageId,
      )?.postState;
    }

    function sendIncomingPost(payload, options = {}) {
      const messageId = payload.messageId;
      if (inFlightPostIds.has(messageId)) return;
      inFlightPostIds.add(messageId);
      waitingPostIds.push(messageId);
      refreshPostProgress();
      postQueue = postQueue.then(async () => {
        const waitIdx = waitingPostIds.indexOf(messageId);
        if (waitIdx >= 0) waitingPostIds.splice(waitIdx, 1);
        try {
          // Manual "Retry now" (force) posts even while listening is stopped
          if (!isListening() && !options.force) return;
          activePostId = messageId;
          activePostStep = "Sending to chat API…";
          refreshPostProgress();
          const chatKey = payload.chatName || payload.from || "unknown";
          // Resolve sender phone from Contact info (ignore weak/wrong cache).
          // Retries skip this unless the chat is open, so we never read the
          // wrong contact's drawer.
          const existing = normalizePhone(payload.from);
          const existingScore =
            existing ? scorePhoneCandidate(existing, existing) : 0;
          if (
            (!existing || existingScore < 20) &&
            (options.resolvePhone || isChatCurrentlyOpen(payload.chatName))
          ) {
            activePostStep = "Finding sender phone number…";
            refreshPostProgress();
            const resolved = await ensurePeerPhone(
              payload.chatName,
              payload.prePlainText,
            );
            if (resolved) payload.from = resolved;
            activePostStep = "Sending to chat API…";
            refreshPostProgress();
          }
          await postIncomingToChatApi(payload);
          updateChatCursor(chatKey, payload.receivedAt, messageId);
          updateReceivedItemStatus(messageId, "ok");
        } catch (err) {
          const prevAttempts =
            Number(getStoredPostState(messageId)?.attempts) || 0;
          updateReceivedItemStatus(
            messageId,
            {
              ...(err.postState || { error: err.message || "Request failed" }),
              attempts: prevAttempts + 1,
              nextRetryAt: Date.now() + RECEIVE_POST_RETRY_MS,
            },
            payload,
          );
        } finally {
          inFlightPostIds.delete(messageId);
          if (activePostId === messageId) {
            activePostId = "";
            activePostStep = "";
          }
          refreshPostProgress();
        }
      });
    }

    function formatWait(ms) {
      const sec = Math.max(0, Math.ceil(ms / 1000));
      return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
    }

    // Per-row progress line: waiting / sending / next retry / paused
    function refreshPostProgress() {
      const list = document.getElementById("wa-received-list");
      if (!list) return;
      const now = Date.now();
      const listening = isListening();
      list.querySelectorAll(".wa-received-item").forEach((li) => {
        const id = li.dataset.messageId;
        const wrap = li.querySelector(".wa-post-progress");
        const textEl = li.querySelector(".wa-post-progress-text");
        const btn = li.querySelector(".wa-retry-now");
        if (!wrap || !textEl || !btn) return;
        const state = li.dataset.postState;
        const attempts = Number(li.dataset.attempts) || 0;
        const nextAt = Number(li.dataset.nextRetryAt) || 0;
        let text = "";
        let canRetry = false;

        if (state === "ok") {
          text = "";
        } else if (id === activePostId) {
          text =
            attempts ?
              `${activePostStep} (attempt ${attempts + 1})`
            : activePostStep;
        } else if (waitingPostIds.includes(id)) {
          const ahead = waitingPostIds.indexOf(id) + (activePostId ? 1 : 0);
          text =
            ahead > 0 ? `Waiting to send — ${ahead} ahead` : "Waiting to send…";
        } else if (!listening) {
          text =
            state === "error" ?
              `Failed ${attempts}x — retry paused (listening stopped)`
            : "Waiting to send — paused (listening stopped)";
          canRetry = true;
        } else if (state === "error") {
          text =
            nextAt > now ?
              `Failed ${attempts}x — next retry in ${formatWait(nextAt - now)}`
            : `Failed ${attempts}x — retrying shortly…`;
          canRetry = true;
        } else {
          text = "Waiting to send…";
          canRetry = true;
        }

        if (textEl.textContent !== text) textEl.textContent = text;
        wrap.hidden = !text;
        btn.hidden = !canRetry;
      });
    }

    // Re-send every received item not yet posted (failed, or left pending by
    // a stop/reload). Runs while listening; stops once each post succeeds.
    function retryUnpostedReceivedItems() {
      if (!isListening()) return;
      const now = Date.now();
      loadReceivedList().forEach((item) => {
        const payload = item?.payload;
        if (!payload?.messageId) return;
        if (item.postState === "ok" || item.postState === "skip") return;
        if (Number(item.postState?.nextRetryAt) > now) return;
        sendIncomingPost({ ...payload });
      });
    }

    function startPostRetryTimer() {
      if (window.__waPostRetryTimer) clearInterval(window.__waPostRetryTimer);
      window.__waPostRetryTimer = setInterval(
        retryUnpostedReceivedItems,
        POST_RETRY_CHECK_MS,
      );
      if (window.__waPostProgressTimer) {
        clearInterval(window.__waPostProgressTimer);
      }
      window.__waPostProgressTimer = setInterval(refreshPostProgress, 1000);
    }
    startPostRetryTimer();

    document
      .getElementById("wa-received-list")
      ?.addEventListener("click", (e) => {
        const btn = e.target.closest?.(".wa-retry-now");
        if (!btn) return;
        const id = btn.closest(".wa-received-item")?.dataset.messageId;
        const item = loadReceivedList().find(
          (it) => it?.payload?.messageId === id,
        );
        if (item?.payload) {
          sendIncomingPost({ ...item.payload }, { force: true });
        }
      });

    function getScanOptions(extra = {}) {
      return {
        isRuntime: true,
        baselineIds: baselineMessageIds,
        ...extra,
      };
    }

    function processUnreadCatchup(unreadCount) {
      // Capture ALL synced messages in the open chat (read on phone + unread),
      // not only the "N unread messages" block.
      return processConversationCatchup({ unreadHint: unreadCount });
    }

    function processConversationCatchup(options = {}) {
      if (!isListening()) return 0;
      const main = document.querySelector("#main");
      if (!main) return 0;

      const nodes = findIncomingMessageRoots(main);
      if (!nodes.length) return 0;

      const dividerCount = getUnreadDividerCount(main);
      const unreadHint = Math.max(
        Number(options.unreadHint) || 0,
        dividerCount || 0,
      );
      const MAX_CATCHUP = 50;

      const eligible = [];
      nodes.forEach((node) => {
        const id = getMessageIdFromNode(node);
        if (!id || seenIds.has(id) || baselineMessageIds.has(id)) return;

        const ts = getMessageTimestamp(node);
        // Keep undated + in-window messages; drop clearly old history
        if (ts && !isWithinReadWindow(ts)) {
          baselineMessageIds.add(id);
          return;
        }
        eligible.push(node);
      });

      // Always include the last N (unread hint / divider) even if dated oddly
      if (unreadHint > 0) {
        const tail = nodes.slice(-unreadHint);
        const have = new Set(eligible);
        tail.forEach((node) => {
          const id = getMessageIdFromNode(node);
          if (!id || seenIds.has(id)) return;
          if (!have.has(node)) eligible.push(node);
          baselineMessageIds.delete(id);
        });
      }

      // Force-include the sidebar preview text if it matches an incoming bubble
      const expectedPreview = String(options.expectedPreview || "").trim();
      if (expectedPreview) {
        const previewBody = expectedPreview.replace(/^[^:]*:\s*/, "").trim();
        const have = new Set(eligible);
        nodes.forEach((node) => {
          const id = getMessageIdFromNode(node);
          if (!id || seenIds.has(id)) return;
          const text = normalizeMessageText(getMessageText(node));
          if (
            !text ||
            !(
              textsAreSameMessage(text, expectedPreview) ||
              textsAreSameMessage(text, previewBody) ||
              expectedPreview.includes(text) ||
              text.includes(previewBody)
            )
          ) {
            return;
          }
          baselineMessageIds.delete(id);
          if (!have.has(node)) eligible.push(node);
        });
      }

      const toCapture =
        eligible.length > MAX_CATCHUP ? eligible.slice(-MAX_CATCHUP) : eligible;
      if (!toCapture.length) return 0;

      const captureIds = new Set(
        toCapture.map((n) => getMessageIdFromNode(n)).filter(Boolean),
      );

      // Baseline anything we're intentionally not capturing this pass
      nodes.forEach((node) => {
        const id = getMessageIdFromNode(node);
        if (!id || captureIds.has(id) || seenIds.has(id)) return;
        const ts = getMessageTimestamp(node);
        if (ts && !isWithinReadWindow(ts)) baselineMessageIds.add(id);
      });

      let captured = 0;
      toCapture.forEach((node) => {
        const payload = extractIncomingPayload(
          node,
          getScanOptions({
            unreadCatchup: true,
            allowUndatedRuntime: true,
            conversationCatchup: true,
          }),
        );
        if (payload) {
          handleIncomingPayload(payload);
          captured += 1;
        }
      });

      if (captured > 0) {
        setReceiveStatus(
          `Captured ${captured} synced message${captured === 1 ? "" : "s"}`,
        );
      }
      return captured;
    }

    function catchupOpenConversationUnread() {
      if (!isListening() || !isConversationOpen()) return;
      const main = document.querySelector("#main");
      if (!main) return;

      const openTitle = getOpenChatName();
      const dividerCount = getUnreadDividerCount(main);
      const sidebarUnread = openTitle ? getSidebarUnreadForTitle(openTitle) : 0;
      const nodeCount = findIncomingMessageRoots(main).length;
      const key = `${openTitle || "chat"}|${nodeCount}|${dividerCount}|${sidebarUnread}`;
      if (window.__waLastUnreadCatchupKey === key) return;

      const captured = processConversationCatchup({
        unreadHint: Math.max(dividerCount, sidebarUnread),
      });
      // Lock this snapshot only after a successful pass (or nothing left to grab)
      if (captured > 0 || (!dividerCount && !sidebarUnread && nodeCount > 0)) {
        const stillPending = findIncomingMessageRoots(main).some((node) => {
          const id = getMessageIdFromNode(node);
          if (!id || seenIds.has(id) || baselineMessageIds.has(id))
            return false;
          const ts = getMessageTimestamp(node);
          return !ts || isWithinReadWindow(ts);
        });
        if (!stillPending) window.__waLastUnreadCatchupKey = key;
      }
    }

    function getSidebarUnreadForTitle(title) {
      const pane = findChatListPane();
      if (!pane || !title) return 0;
      let unread = 0;
      queryChatListCells(pane).forEach((cell) => {
        if (getChatTitleFromRow(cell) === title) {
          unread = getUnreadCountFromCell(cell);
        }
      });
      return unread;
    }

    function seedListeningBaseline() {
      baselineMessageIds.clear();
      window.__waLastUnreadCatchupKey = "";
      if (!isConversationOpen()) return;

      // Capture every in-window synced message in the open chat (read + unread)
      const openTitle = getOpenChatName();
      const openUnread = openTitle ? getSidebarUnreadForTitle(openTitle) : 0;
      const dividerUnread = getUnreadDividerCount();
      processConversationCatchup({
        unreadHint: Math.max(openUnread, dividerUnread),
      });
      // Baseline only older-than-window leftovers
      seedVisibleConversationBaseline(baselineMessageIds);
    }

    function queueUnreadChatsOnStart() {
      const pane = findChatListPane();
      if (!pane) {
        setReceiveStatus("Waiting for WhatsApp chat list…");
        return 0;
      }
      const openTitle = getOpenChatName();
      let queued = 0;
      let queuedMessages = 0;

      queryChatListCells(pane).forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        const unread = getUnreadCountFromCell(cell);
        if (!unread || !isChatRowWithinReadWindow(cell, unread)) return;
        if (openTitle && title.trim() === openTitle.trim()) {
          processUnreadCatchup(unread);
          queued += 1;
          queuedMessages += unread;
          return;
        }
        queueChatOpen({
          row: cell,
          title,
          unreadCount: unread,
          reason: "startup-unread",
        });
        queued += 1;
        queuedMessages += unread;
      });

      if (queued > 0) {
        lastNextListeningEstimate = queuedMessages;
        setReceiveStatus(
          `Listening — opening ${queued} unread chat${queued === 1 ? "" : "s"}…`,
        );
      } else {
        const cells = queryChatListCells(pane);
        const unreadVisible = cells.filter(
          (c) => getUnreadCountFromCell(c) > 0,
        ).length;
        const unreadVisibleMessages = cells.reduce((sum, c) => {
          const n = Number(getUnreadCountFromCell(c));
          return sum + (Number.isFinite(n) && n > 0 ? n : 0);
        }, 0);
        lastNextListeningEstimate = unreadVisibleMessages;
        setReceiveStatus(
          unreadVisible > 0 ?
            `Listening — ${unreadVisible} unread visible, retrying open…`
          : "Listening for new messages...",
        );
      }
      return queued;
    }

    function scheduleUnreadStartupPasses() {
      const delays = [800, 2500, 5000, 10000];
      delays.forEach((ms) => {
        sleep(ms).then(() => {
          if (!isListening()) return;
          seedChatListState();
          queueUnreadChatsOnStart();
          processChatOpenQueue();
        });
      });
    }

    function scanForIncomingMessages(root, options = {}) {
      if (!isListening()) return;
      const main = document.querySelector("#main") || document;
      let nodes = findIncomingMessageRoots(root || main);
      const scanOpts = getScanOptions(options);

      if (options.unreadCatchup > 0) {
        nodes = nodes
          .filter((node) => !baselineMessageIds.has(getMessageIdFromNode(node)))
          .slice(-options.unreadCatchup);
        scanOpts.unreadCatchup = true;
      } else {
        nodes = nodes.filter(
          (node) => !baselineMessageIds.has(getMessageIdFromNode(node)),
        );
        scanOpts.allowUndatedRuntime = true;
      }

      nodes.forEach((node) => {
        const payload = extractIncomingPayload(node, scanOpts);
        if (payload) handleIncomingPayload(payload);
      });
    }

    function scheduleConversationScan() {
      if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(() => {
        scanDebounceTimer = null;
        if (!isListening()) return;
        if (isConversationOpen()) {
          catchupOpenConversationUnread();
          scanForIncomingMessages(document.querySelector("#main") || document, {
            isRuntime: true,
          });
        }
      }, 200);
    }

    function seedChatListState() {
      const pane = findChatListPane();
      if (!pane) return false;
      const cells = queryChatListCells(pane);
      if (!cells.length) return false;
      cells.forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        const preview = getPreviewFromRow(cell);
        const unread = getUnreadCountFromCell(cell);
        chatListState.set(title, {
          preview,
          unread,
          handledPreview: unread > 0 ? "" : preview,
          pending: unread > 0,
        });
      });
      chatListSeeded = true;
      return true;
    }

    // Last message is ours when the preview shows sent/delivered/read ticks
    // or the pending clock (1:1 chats have no "You:" prefix).
    function isOutgoingChatRow(cell) {
      if (!cell) return false;
      const secondary =
        cell.querySelector('[data-testid="cell-frame-secondary"]') || cell;
      if (
        secondary.querySelector(
          '[data-icon*="check"], [data-icon*="status-time"], [data-icon^="ic-done"], [data-icon="ic-access-time"], [data-testid*="dblcheck"], [data-testid="msg-check"], [data-testid="msg-time-status"]',
        )
      ) {
        return true;
      }
      return /ic-(done|done-all|check|access-time)/.test(
        secondary.textContent || "",
      );
    }

    function isOutgoingChatPreview(preview) {
      return /^(you|me|yo|tú|vous|você)\s*:/i.test(
        String(preview || "").trim(),
      );
    }

    function scanChatListForRuntimeIncoming() {
      if (!isListening()) return;
      clearStuckOpenIfNeeded();
      const pane = findChatListPane();
      if (!pane) return;

      if (!chatListSeeded) {
        seedChatListState();
        return;
      }

      queryChatListCells(pane).forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;

        const preview = getPreviewFromRow(cell);
        const unread = getUnreadCountFromCell(cell);
        // Row first seen now (virtualized list scrolled into view): remember
        // it instead of treating its old preview as new activity.
        if (!chatListState.has(title) && unread < 1) {
          markChatActivityHandled(title, preview, 0);
          return;
        }
        const outgoing = isOutgoingChatPreview(preview) || isOutgoingChatRow(cell);
        const prev = chatListState.get(title) || {
          preview: "",
          unread: 0,
          handledPreview: "",
          pending: false,
        };

        const unreadIncreased = unread > (prev.unread || 0);
        const previewChanged =
          !!preview &&
          preview !== prev.preview &&
          !textsAreSameMessage(prev.preview, preview);
        const previewNotHandled =
          !!preview &&
          !outgoing &&
          (!prev.handledPreview ||
            !textsAreSameMessage(prev.handledPreview, preview));
        const syncedPreview =
          (previewChanged || (unread > 0 && previewNotHandled)) &&
          !!preview &&
          !outgoing;
        const hasNewActivity =
          unreadIncreased ||
          (unread > 0 && previewChanged) ||
          (unread > 0 && previewNotHandled) ||
          syncedPreview;

        // User (or WA) opened a chat that had unread — badge cleared but messages still there
        if (
          prev.unread > 0 &&
          unread < prev.unread &&
          unread > 0 &&
          isChatCurrentlyOpen(title)
        ) {
          processConversationCatchup({ unreadHint: prev.unread });
          markChatActivityHandled(title, preview, unread);
          return;
        }

        if (
          !hasNewActivity ||
          // Pass the real unread count: preview-only activity must also be
          // within the read window (unread chats are always eligible).
          !isChatRowWithinReadWindow(cell, unread)
        ) {
          noteChatActivitySeen(title, preview, unread, prev.pending);
          return;
        }

        const newUnread =
          unreadIncreased ? Math.max(1, unread - (prev.unread || 0)) : unread;

        if (isChatCurrentlyOpen(title)) {
          // Only process open-chat catchup when the unread badge is actually present.
          // If unread is 0, rely on cursor-based dedupe instead of re-reading scrollback.
          if (unread < 1) return;
          const n = processConversationCatchup({
            unreadHint: Math.max(newUnread, 1),
            expectedPreview: preview,
          });
          if (n > 0) {
            markChatActivityHandled(title, preview, 0);
            const st = chatListState.get(title) || {};
            st.lastCapturedAt = Date.now();
            chatListState.set(title, st);
          } else {
            noteChatActivitySeen(title, preview, unread, true);
          }
          return;
        }

        noteChatActivitySeen(title, preview, unread, true);
        console.log("[WA] queue chat open →", {
          title,
          unread,
          preview: String(preview).slice(0, 60),
          reason: syncedPreview ? "preview-sync" : "unread",
        });
        const unreadCountToQueue = Math.max(newUnread, syncedPreview ? 1 : 0);
        if (unreadCountToQueue > 0) {
          queueChatOpen({
            row: cell,
            title,
            unreadCount: unreadCountToQueue,
            expectedPreview: preview,
            reason: syncedPreview ? "preview-sync" : "unread",
          });
        }
      });

      requeueVisibleUnreadChats(false);
    }

    function getUnreadCountFromRow(row) {
      return getUnreadCountFromCell(row);
    }

    function isChatCurrentlyOpen(title) {
      const open = getOpenChatName();
      if (!open || !title) return false;
      return open.trim() === String(title).trim();
    }

    function queueChatOpen(item) {
      if (!item?.row || !item?.title || !isListening()) return;
      // Chat already open — catch up in place instead of skipping
      if (isChatCurrentlyOpen(item.title)) {
        processConversationCatchup({
          unreadHint: item.unreadCount || 1,
          expectedPreview: item.expectedPreview || "",
        });
        return;
      }
      if (openingChat && openingChatTitle === item.title) return;
      if (chatOpenQueue.some((q) => q.title === item.title)) return;
      chatOpenQueue.push(item);
      processChatOpenQueue();
    }

    async function processChatOpenQueue() {
      clearStuckOpenIfNeeded();
      if (!canOpenNextChat() || !chatOpenQueue.length) return;
      const item = chatOpenQueue.shift();
      // WhatsApp virtualizes the list — refresh the row from current DOM
      const liveRow = findChatRowByTitle(item.title) || item.row;
      if (!liveRow || !document.contains(liveRow)) {
        console.warn("[WA] chat row missing, will requeue later →", item.title);
        noteChatActivitySeen(
          item.title,
          item.expectedPreview || "",
          item.unreadCount || 1,
          true,
        );
        return;
      }
      await openChatRow(liveRow, item.title, {
        unreadCount: item.unreadCount || 0,
        expectedPreview: item.expectedPreview || "",
      });
      if (isListening() && chatOpenQueue.length) {
        processChatOpenQueue();
      }
    }

    async function waitForConversation(timeoutMs = 10000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (!isListening()) return false;
        if (isConversationOpen()) return true;
        await sleep(250);
      }
      return isConversationOpen();
    }

    // WA only sends read receipts when it believes the user is active (recent
    // mouse/scroll input on a focused window). When idle, the badge stays until
    // the real mouse moves — so fake that activity inside the open chat.
    function nudgeUserActivity() {
      const main = document.querySelector("#main");
      if (!main) return;
      const rect = main.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const common = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      };
      try {
        window.dispatchEvent(new FocusEvent("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      } catch (_) {}
      [window, document, main].forEach((t) => {
        try {
          t.dispatchEvent(
            new PointerEvent("pointermove", { ...common, pointerType: "mouse" }),
          );
        } catch (_) {}
        try {
          t.dispatchEvent(new MouseEvent("mousemove", common));
        } catch (_) {}
      });
      // Scroll the message pane to the bottom (WA marks read on scroll-to-end)
      const scroller = [...main.querySelectorAll("div")].find((el) => {
        if (el.scrollHeight <= el.clientHeight + 20) return false;
        const oy = getComputedStyle(el).overflowY;
        return oy === "auto" || oy === "scroll";
      });
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }

    async function markChatReadViaMenu(title) {
      const cell = findChatRowByTitle(title);
      if (!cell) return false;
      simulateHover(cell);
      await sleep(250);
      const chevron =
        cell.querySelector('[data-icon*="down"]')?.closest("button, [role='button'], span") ||
        cell.querySelector('[data-icon*="expand"]')?.closest("button, [role='button'], span") ||
        cell.querySelector('button[aria-label*="menu" i], [aria-label*="open chat context menu" i]');
      if (!chevron) return false;
      simulateUserClick(chevron);
      await sleep(400);
      const item = [
        ...document.querySelectorAll('[role="application"] li, [role="menuitem"], li[data-animate-dropdown-item]'),
      ].find((el) => /^mark as read$/i.test((el.textContent || "").trim()));
      if (!item) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return false;
      }
      simulateUserClick(item);
      await sleep(300);
      return true;
    }

    function simulateHover(el) {
      const r = el.getBoundingClientRect();
      const common = {
        bubbles: true,
        view: window,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"].forEach(
        (type) => {
          try {
            el.dispatchEvent(
              type.startsWith("pointer") ?
                new PointerEvent(type, { ...common, pointerType: "mouse" })
              : new MouseEvent(type, common),
            );
          } catch (_) {}
        },
      );
    }

    /** After capturing, make sure WA actually clears the unread badge. */
    async function ensureChatMarkedRead(title) {
      for (let i = 0; i < 3; i++) {
        nudgeUserActivity();
        await sleep(600);
        const cell = findChatRowByTitle(title);
        if (!cell || getUnreadCountFromCell(cell) < 1) return true;
      }
      const ok = await markChatReadViaMenu(title);
      if (ok) console.log("[WA] marked read via menu →", title);
      return ok;
    }

    async function openChatRow(row, title, options = {}) {
      if (!isListening() || !row) return;

      openingChat = true;
      openingChatTitle = title || "chat";
      openingStartedAt = Date.now();
      const unreadCount = options.unreadCount || 0;
      const expectedPreview = String(options.expectedPreview || "").trim();
      {
        const st = chatListState.get(title) || {};
        st.lastOpenAttemptAt = Date.now();
        st.pending = true;
        chatListState.set(title, st);
      }
      // Cache peer number when the chat title/list row exposes it
      const titlePhone = extractPhoneFromText(title);
      if (titlePhone) {
        cachePeerPhone(title, titlePhone, {
          score: scorePhoneCandidate(title, titlePhone),
          display: title,
          source: "chat-title",
        });
      }
      try {
        setReceiveStatus(`New message in: ${openingChatTitle}...`);
        const clicked = simulateUserClick(row);
        if (!clicked) {
          try {
            row.click();
          } catch (_) {}
        }

        await sleep(400);
        if (!isConversationOpen()) {
          const titleEl =
            row.querySelector('[data-testid="cell-frame-title"]') ||
            row.querySelector("span[title]") ||
            row;
          if (!simulateUserClick(titleEl)) {
            try {
              titleEl.click();
            } catch (_) {}
          }
        }

        const opened = await waitForConversation(8000);
        if (!isListening()) return;

        if (!opened) {
          const fails = (openFailCounts.get(openingChatTitle) || 0) + 1;
          openFailCounts.set(openingChatTitle, fails);
          // Keep pending so unread-requeue will try again
          noteChatActivitySeen(title, expectedPreview, unreadCount, true);
          setReceiveStatus(
            `Could not open "${openingChatTitle}" (try ${fails}/3).`,
          );
          console.warn("[WA] open chat failed →", {
            title: openingChatTitle,
            fails,
          });
          await sleep(800);
          return;
        }

        openFailCounts.delete(openingChatTitle);

        // Retries: WA often marks read before bubbles finish rendering
        const catchCount = Math.max(
          unreadCount || 0,
          getUnreadDividerCount() || 0,
          1,
        );
        let captured = 0;
        for (const waitMs of [400, 800, 1200, 2000]) {
          await sleep(waitMs);
          if (!isListening()) return;
          captured += processConversationCatchup({
            unreadHint: catchCount,
            expectedPreview,
          });
          // If we were chasing a specific sidebar preview, stop once seen
          if (expectedPreview) {
            const nodes = findIncomingMessageRoots(
              document.querySelector("#main") || document,
            );
            const matched = nodes.some((node) => {
              const text = normalizeMessageText(getMessageText(node));
              const previewBody = expectedPreview.replace(/^[^:]*:\s*/, "");
              return (
                text &&
                (textsAreSameMessage(text, expectedPreview) ||
                  textsAreSameMessage(text, previewBody) ||
                  expectedPreview.includes(text) ||
                  text.includes(previewBody))
              );
            });
            if (matched) break;
          } else if (captured > 0) {
            break;
          }
        }

        seedVisibleConversationBaseline(baselineMessageIds);
        // Only force read once we've actually captured — otherwise the badge
        // is our retry signal and clearing it could lose messages.
        if (captured > 0) {
          try {
            await ensureChatMarkedRead(title);
          } catch (_) {}
          if (!isListening()) return;
        }
        const liveCell = findChatRowByTitle(title);
        const liveUnread = liveCell ? getUnreadCountFromCell(liveCell) : 0;
        const livePreview =
          expectedPreview || (liveCell ? getPreviewFromRow(liveCell) : "");
        if (captured > 0) {
          // unread 0: ignore sticky badge so we don't re-open forever
          markChatActivityHandled(title, livePreview, 0);
          const st = chatListState.get(title) || {};
          st.lastCapturedAt = Date.now();
          st.pending = false;
          chatListState.set(title, st);
        } else {
          // Opened but nothing captured — keep pending so we retry
          noteChatActivitySeen(
            title,
            livePreview,
            liveUnread || unreadCount,
            true,
          );
        }
        if (isListening()) {
          setReceiveStatus(
            captured > 0 ?
              `Captured ${captured} synced message${captured === 1 ? "" : "s"}`
            : "Listening for new messages...",
          );
          await sleep(getChatSwitchGapMs());
        }
      } catch (err) {
        noteChatActivitySeen(title, expectedPreview, unreadCount, true);
        setReceiveStatus(`Read failed: ${err.message || "unknown error"}`);
        await sleep(800);
      } finally {
        lastChatSwitchFinishedAt = Date.now();
        openingChat = false;
        openingChatTitle = "";
        openingStartedAt = 0;
      }
    }

    function syncAfterReconnect() {
      if (!isListening()) return;
      setReceiveStatus("Back online — checking unread...");

      const pane = findChatListPane();
      if (!pane) {
        if (isConversationOpen()) {
          scanForIncomingMessages(document.querySelector("#main") || document);
        }
        return;
      }

      const openTitle = getOpenChatName();
      queryChatListCells(pane).forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        const unread = getUnreadCountFromCell(cell);
        const preview = getPreviewFromRow(cell);
        const prev = chatListState.get(title) || { preview: "", unread: 0 };
        const previewChanged =
          !!preview &&
          preview !== prev.preview &&
          !textsAreSameMessage(prev.preview, preview) &&
          !isOutgoingChatPreview(preview);

        chatListState.set(title, { preview, unread });

        if (
          !unread &&
          !previewChanged &&
          !isChatRowWithinReadWindow(cell, unread)
        ) {
          return;
        }
        if (!unread && !previewChanged) return;

        if (openTitle && title.trim() === openTitle.trim()) {
          processConversationCatchup({
            unreadHint: Math.max(unread, 1),
            expectedPreview: preview,
          });
          return;
        }
        queueChatOpen({
          row: cell,
          title,
          unreadCount: Math.max(unread, previewChanged ? 1 : 0),
          expectedPreview: preview,
          reason: "reconnect-unread",
        });
      });

      if (isConversationOpen()) {
        scanForIncomingMessages(document.querySelector("#main") || document);
      }
    }

    function startReceiveObservers() {
      // Drop any previous observer/poll from an earlier listen cycle
      if (window.__waReceiveObserver) {
        try {
          window.__waReceiveObserver.disconnect();
        } catch (_) {}
        window.__waReceiveObserver = null;
      }
      if (window.__waReceivePollTimer) {
        clearInterval(window.__waReceivePollTimer);
        window.__waReceivePollTimer = null;
      }
      if (receiveCountdownTimer) clearInterval(receiveCountdownTimer);
      receiveCountdownTimer = null;

      const target = document.querySelector("#app") || document.body;

      const observer = new MutationObserver(() => {
        if (!isListening()) return;
        const openTitle = getOpenChatName();
        // Only scan open chat when the unread badge is present.
        // New-message events usually coincide with unread becoming > 0.
        if (!openTitle) return;
        const unread = getSidebarUnreadForTitle(openTitle);
        if (unread > 0) scheduleConversationScan();
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false,
      });
      window.__waReceiveObserver = observer;

      // When laptop comes back online, WhatsApp syncs mobile messages — catch unread
      const onOnline = () => {
        if (!isListening()) return;
        setTimeout(() => syncAfterReconnect(), 1500);
        setTimeout(() => syncAfterReconnect(), 4000);
      };
      const onVisibility = () => {
        if (document.visibilityState === "visible") onOnline();
      };
      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisibility);
      window.__waReceiveOnlineHandler = onOnline;
      window.__waReceiveVisibilityHandler = onVisibility;

      // Poll open chat + sidebar for new activity
      window.__waReceivePollTimer = setInterval(() => {
        const stopBtn = document.getElementById("wa-stop-listening");
        const uiListening =
          !!stopBtn &&
          stopBtn.style.display !== "none" &&
          !listeningManuallyStopped;

        if (!isListening()) {
          if (uiListening) {
            console.warn(
              "[WA] listen run dead but UI still active — restarting",
            );
            ensureReceiveListening({ forceRestart: true });
          }
          return;
        }
        lastReceiveHeartbeatAt = Date.now();
        clearStuckOpenIfNeeded();

        // Re-scan open conversation for unread divider + new messages
        if (isConversationOpen()) {
          const openTitle = getOpenChatName();
          const sidebarUnread =
            openTitle ? getSidebarUnreadForTitle(openTitle) : 0;
          if (sidebarUnread > 0) {
            catchupOpenConversationUnread();
            scanForIncomingMessages(
              document.querySelector("#main") || document,
            );
          }
        }

        try {
          scanChatListForRuntimeIncoming();
          processChatOpenQueue();
        } catch (err) {
          console.warn("[WA] receive poll error →", err);
        }

        // Reset countdown target after this poll tick runs.
        nextReceivePollAt = Date.now() + RECEIVE_POLL_INTERVAL_MS;
      }, RECEIVE_POLL_INTERVAL_MS);

      // Countdown UI: “Next read in …” based on the poll loop.
      // We keep it separate so `setReceiveStatus()` can remain the source
      // of the main listening text/counters.
      nextReceivePollAt = Date.now() + RECEIVE_POLL_INTERVAL_MS;
      receiveCountdownTimer = setInterval(() => {
        if (!isListening()) return;
        const apiStatusEl = document.getElementById("wa-api-listening-status");
        if (!apiStatusEl) return;
        const seconds = Math.max(
          0,
          Math.ceil((nextReceivePollAt - Date.now()) / 1000),
        );
        apiStatusEl.textContent =
          seconds > 0 ?
            `${lastApiListeningStatusText} (Next read in ${seconds}s)`
          : lastApiListeningStatusText;
      }, 1000);
    }

    async function startListening() {
      if (!RECEIVE_READING_ENABLED) return;
      const receiveUrl =
        document.getElementById("wa-receive-url")?.value.trim() || "";
      if (receiveUrl && !/^https?:\/\//i.test(receiveUrl)) {
        alert("Chat API URL must start with http:// or https://");
        return;
      }

      persistApiUrlsFromInputs();
      stopListening = false;
      listeningManuallyStopped = false;
      sessionStorage.removeItem(LISTENING_STOPPED_KEY);
      receiveRunId = beginReceiveRun();
      openFailCounts.clear();
      chatListState.clear();
      recentByChat.clear();
      baselineMessageIds.clear();
      chatListSeeded = false;
      chatOpenQueue.length = 0;
      lastChatSwitchFinishedAt = 0;
      await loadChatMessageCursors();
      setListeningUi(true);
      setReceiveStatus("Listening for new messages...");

      // Cache own WhatsApp number for inbound create payload (to_user_id)
      getMyWhatsAppNumber();
      // Reset peer-phone cache so Contact info is re-read with latest logic
      window.__waPeerPhoneByChat = new Map();
      window.__waPeerPhoneTried = new Set();

      startReceiveObservers();
      seedChatListState();
      seedListeningBaseline();
      queueUnreadChatsOnStart();
      scheduleUnreadStartupPasses();
    }

    function receiveInfrastructureAlive() {
      return !!(window.__waReceivePollTimer && window.__waReceiveObserver);
    }

    async function waitForChatList(timeoutMs = 30000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (listeningManuallyStopped || stopListening) return false;
        const pane = findChatListPane();
        if (pane && queryChatListCells(pane).length > 0) return true;
        // Pane exists but still loading chats — keep waiting a bit
        if (pane) {
          setReceiveStatus("Waiting for WhatsApp chats to load…");
        } else {
          setReceiveStatus("Waiting for WhatsApp…");
        }
        await sleep(500);
      }
      return !!findChatListPane();
    }

    let listenStartPromise = null;

    async function startListeningWhenReady() {
      if (listenStartPromise) return listenStartPromise;
      listenStartPromise = (async () => {
        try {
          setListeningUi(true);
          setReceiveStatus("Starting listener…");
          await waitForChatList(30000);
          if (listeningManuallyStopped || stopListening) return;
          await startListening();
        } finally {
          listenStartPromise = null;
        }
      })();
      return listenStartPromise;
    }

    function ensureReceiveListening(options = {}) {
      if (!RECEIVE_READING_ENABLED) {
        setListeningUi(false);
        setReceiveStatus(RECEIVE_DISABLED_STATUS);
        return;
      }
      const forceRestart = !!options.forceRestart;
      if (listeningManuallyStopped && !forceRestart) {
        setListeningUi(false);
        setReceiveStatus("Stopped listening.");
        return;
      }
      if (!forceRestart && isListening() && receiveInfrastructureAlive()) {
        setListeningUi(true);
        setReceiveStatus("Listening for new messages...");
        return;
      }
      // Stale "listening" (run id ok but observer/poll torn down) or first launch
      startListeningWhenReady().catch((err) => {
        setListeningUi(false);
        setReceiveStatus(`Listen failed: ${err.message || "unknown error"}`);
      });
    }

    window.__waEnsureReceiveListening = ensureReceiveListening;

    document
      .getElementById("wa-stop-listening")
      ?.addEventListener("click", stopReceiveListening);
    document
      .getElementById("wa-api-stop-listening")
      ?.addEventListener("click", stopReceiveListening);
    document
      .getElementById("wa-start-listening")
      ?.addEventListener("click", () => {
        listeningManuallyStopped = false;
        stopListening = false;
        sessionStorage.removeItem(LISTENING_STOPPED_KEY);
        ensureReceiveListening({ forceRestart: true });
      });
    document
      .getElementById("wa-api-start-listening")
      ?.addEventListener("click", () => {
        listeningManuallyStopped = false;
        stopListening = false;
        sessionStorage.removeItem(LISTENING_STOPPED_KEY);
        ensureReceiveListening({ forceRestart: true });
      });

    async function countdownSeconds(seconds, getText) {
      if (!isActive()) return false;
      setRunning(true);
      for (let remaining = seconds; remaining > 0; remaining -= 1) {
        if (!isActive()) return false;
        setSendStatus(getText(remaining));
        await sleep(1000);
        if (!isActive()) return false;
      }
      return isActive();
    }

    async function countdownToSending() {
      const ready = await countdownSeconds(3, (remaining) => `${remaining}...`);
      if (!ready) return false;
      setSendStatus("Sending...");
      return true;
    }

    function findSendButton() {
      return (
        document.querySelector('[data-icon="send"]')?.closest("button") ||
        document.querySelector('button[aria-label="Send"]') ||
        document.querySelector('[aria-label="Send"]')
      );
    }

    function findInvalidNumberDialog() {
      const candidates = document.querySelectorAll(
        '[role="dialog"], [data-animate-modal-popup="true"], [data-testid="popup-contents"]',
      );
      for (const el of candidates) {
        const text = el.textContent || "";
        if (
          /isn['’]?t on WhatsApp/i.test(text) ||
          /not on WhatsApp/i.test(text)
        ) {
          return el;
        }
      }
      // Fallback: green OK modal with the phrase in body text
      for (const el of document.querySelectorAll("div, span")) {
        const text = (el.textContent || "").trim();
        if (
          text.length > 20 &&
          text.length < 160 &&
          /isn['’]?t on WhatsApp/i.test(text)
        ) {
          return (
            el.closest('[role="dialog"]') ||
            el.closest('[data-animate-modal-popup="true"]') ||
            el.parentElement ||
            el
          );
        }
      }
      return null;
    }

    function dismissInvalidNumberPopup() {
      const dialog = findInvalidNumberDialog();
      if (!dialog) return false;

      const clickables = [
        ...dialog.querySelectorAll(
          'button, [role="button"], div[role="button"]',
        ),
      ];
      const okBtn = clickables.find((b) =>
        /^(ok|okay)$/i.test((b.textContent || "").trim()),
      );
      if (okBtn) {
        simulateUserClick(okBtn);
        console.log("[WA] dismissed invalid-number popup via OK");
        return true;
      }

      // Escape + click outside / overlay
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch (_) {}

      const overlay =
        dialog.parentElement ||
        document.querySelector('[data-animate-modal-backdrop="true"]') ||
        document.body;
      simulateUserClick(overlay);
      console.log("[WA] dismissed invalid-number popup via click/Escape");
      return true;
    }

    async function clickSendWhenReady(timeoutMs = 20000) {
      const started = Date.now();
      let invalidSeenAt = 0;
      while (Date.now() - started < timeoutMs) {
        if (!isActive()) return false;

        if (findInvalidNumberDialog()) {
          if (!invalidSeenAt) {
            invalidSeenAt = Date.now();
            setSendStatus("Number not on WhatsApp. Closing popup in 3s...");
            console.log("[WA] invalid number popup detected");
          } else if (Date.now() - invalidSeenAt >= 3000) {
            dismissInvalidNumberPopup();
            await sleep(300);
            if (findInvalidNumberDialog()) dismissInvalidNumberPopup();
            return false;
          }
          await sleep(200);
          continue;
        }

        const sendButton = findSendButton();
        if (sendButton) {
          sendButton.click();
          return true;
        }
        await sleep(400);
      }
      // Last chance: popup may have appeared at the end
      if (findInvalidNumberDialog()) {
        await sleep(3000);
        dismissInvalidNumberPopup();
      }
      return false;
    }

    function openChatSameTab(phone, text) {
      const waUrl = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`;
      let anchor = document.getElementById("wa-hidden-link");
      if (anchor) anchor.remove();
      anchor = document.createElement("a");
      anchor.href = waUrl;
      anchor.id = "wa-hidden-link";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => anchor.remove(), 500);
    }

    async function sendOneMessage(number, message) {
      const phone = normalizePhone(number);
      if (!phone) return false;

      const readyToSend = await countdownToSending();
      if (!readyToSend) return false;

      openChatSameTab(phone, message);
      await sleep(3500);
      if (!isActive()) return false;

      const sent = await clickSendWhenReady();
      if (!isActive()) return false;
      setSendStatus(
        sent ? `Sent to ${number}` : `Send button not found for ${number}`,
      );
      console.log(
        sent ?
          `Message sent to ${number}`
        : `Send button not found for ${number}`,
      );
      return sent;
    }

    async function waitBeforeNext(minDelay, maxDelay) {
      const waitMs = 1000 + getRandomDelay(minDelay, maxDelay);
      return countdownSeconds(
        Math.ceil(waitMs / 1000),
        (remaining) => `Next message in ${remaining}s`,
      );
    }

    async function processManualQueue(state) {
      while (state.index < state.numbers.length) {
        if (!isActive()) {
          clearQueue();
          setRunning(false);
          return;
        }

        saveQueue(state);
        const number = state.numbers[state.index];
        await sendOneMessage(number, state.message);
        if (!isActive()) {
          clearQueue();
          setRunning(false);
          return;
        }

        state.index += 1;
        saveQueue(state);

        if (state.index >= state.numbers.length) break;

        const readyForNext = await waitBeforeNext(
          state.minDelay,
          state.maxDelay,
        );
        if (!readyForNext) {
          clearQueue();
          setRunning(false);
          return;
        }
      }

      clearQueue();
      setRunning(false);
      if (isActive()) {
        setSendStatus("All messages sent.");
      }
    }

    async function processApiQueue(state) {
      while (isActive()) {
        saveQueue(state);
        setSendStatus("Fetching next message...");

        let payload = null;
        try {
          console.log("[WA] fetch-random request →", state.fetchUrl);
          payload = await apiRequest("GET", state.fetchUrl);
          console.log("[WA] fetch-random response →", payload);
        } catch (err) {
          console.warn("[WA] fetch-random error →", {
            url: state.fetchUrl,
            message: err.message,
          });
          if (!isActive()) break;
          const msg = err.message || "Fetch failed";
          const readyToRetry = await countdownSeconds(
            Math.ceil(
              (1000 + getRandomDelay(state.minDelay, state.maxDelay)) / 1000,
            ),
            (remaining) => `${msg}. Retrying in ${remaining}s`,
          );
          if (!readyToRetry) break;
          continue;
        }

        if (!isActive()) break;

        const rawData = payload?.data;
        const item = normalizeChatQueueItem(rawData);
        if (!payload?.success || !item) {
          console.warn("[WA] fetch-random skipped (no usable chat) →", {
            success: payload?.success,
            hasData: rawData != null,
            dataKeys:
              rawData && typeof rawData === "object" ?
                Object.keys(rawData)
              : [],
            rawData,
            parsed: {
              _id: extractChatDocumentId(rawData || {}),
              message: rawData?.message || rawData?.text || rawData?.body || "",
              number:
                rawData?.number ||
                rawData?.phone ||
                rawData?.to_user_id ||
                rawData?.toUserId ||
                rawData?.recipient ||
                "",
            },
          });
          if (!isActive()) break;
          const readyToRetry = await countdownSeconds(
            Math.ceil(
              (1000 + getRandomDelay(state.minDelay, state.maxDelay)) / 1000,
            ),
            (remaining) =>
              `No chats with status not_started. Retrying in ${remaining}s`,
          );
          if (!readyToRetry) break;
          continue;
        }

        console.log("[WA] fetch-random item →", {
          _id: item._id,
          number: item.number,
          messagePreview: String(item.message).slice(0, 80),
        });
        state.currentId = item._id;
        state.currentNumber = item.number;
        state.currentMessage = item.message;
        saveQueue(state);

        const sent = await sendOneMessage(item.number, item.message);
        if (!isActive()) break;

        if (sent) {
          try {
            setSendStatus("Updating message status...");
            const updateUrl = buildIdUrl(state.updateUrl, item._id);
            console.log("[WA] GET mark-sent →", updateUrl, { _id: item._id });
            await apiRequest("GET", updateUrl);
            if (!isActive()) break;
            setSendStatus(`Sent & marked: ${item.number}`);
          } catch (err) {
            if (!isActive()) break;
            const msg = err.message || "Update failed";
            setSendStatus(`Sent, but mark-sent failed: ${msg}`);
            clearQueue();
            setRunning(false);
            return;
          }
        } else {
          try {
            setSendStatus(`Marking ${item.number} as not available...`);
            const notAvailableUrl = buildIdUrl(state.notAvailableUrl, item._id);
            console.log("[WA] GET mark-not-available →", notAvailableUrl, {
              _id: item._id,
            });
            await apiRequest("GET", notAvailableUrl);
            if (!isActive()) break;
            setSendStatus(`Marked not available: ${item.number}`);
          } catch (err) {
            if (!isActive()) break;
            const msg = err.message || "Not-available update failed";
            setSendStatus(msg);
            clearQueue();
            setRunning(false);
            return;
          }
        }

        delete state.currentId;
        delete state.currentNumber;
        delete state.currentMessage;
        saveQueue(state);

        if (!isActive()) break;

        const readyForNext = await waitBeforeNext(
          state.minDelay,
          state.maxDelay,
        );
        if (!readyForNext) break;
      }

      clearQueue();
      setRunning(false);
    }

    async function startManualSending() {
      const numbersInput = document.getElementById("wa-numbers-input").value;
      const messageInput = document.getElementById("wa-message-input").value;
      const minDelay =
        parseInt(document.getElementById("wa-min-delay").value, 10) || 2;
      const maxDelay =
        parseInt(document.getElementById("wa-max-delay").value, 10) || 12;

      if (!numbersInput.trim() || !messageInput.trim()) {
        alert("Please enter valid numbers and message.");
        return;
      }
      if (minDelay > maxDelay) {
        alert("Min delay should be less than or equal to max delay.");
        return;
      }

      const numbers = numbersInput
        .split(/[\n,]+/)
        .map((n) => n.trim())
        .filter((n) => n);

      stopSending = false;
      activeRunId = beginSenderRun();
      setRunning(true);

      const state = {
        mode: "manual",
        numbers,
        message: messageInput,
        minDelay,
        maxDelay,
        index: 0,
      };
      saveQueue(state);
      await processManualQueue(state);
    }

    async function startApiSending() {
      const fetchUrl = document.getElementById("wa-fetch-url").value.trim();
      const updateUrl = document.getElementById("wa-update-url").value.trim();
      const notAvailableUrl = document
        .getElementById("wa-not-available-url")
        .value.trim();
      console.log("[WA] API Start URLs →", {
        fetchUrl,
        updateUrl,
        notAvailableUrl,
      });
      const minDelay =
        parseInt(document.getElementById("wa-min-delay").value, 10) || 2;
      const maxDelay =
        parseInt(document.getElementById("wa-max-delay").value, 10) || 12;

      if (!fetchUrl || !updateUrl || !notAvailableUrl) {
        alert(
          "Please enter Fetch, Mark Sent, and Mark Not Available API URLs.",
        );
        return;
      }
      if (
        !/^https?:\/\//i.test(fetchUrl) ||
        !/^https?:\/\//i.test(updateUrl) ||
        !/^https?:\/\//i.test(notAvailableUrl)
      ) {
        alert("All API URLs must start with http:// or https://");
        return;
      }
      if (minDelay > maxDelay) {
        alert("Min delay should be less than or equal to max delay.");
        return;
      }

      saveApiSettings(fetchUrl, updateUrl, notAvailableUrl);
      stopSending = false;
      activeRunId = beginSenderRun();
      setRunning(true);
      setSendStatus("Starting...");

      const state = {
        mode: "api",
        fetchUrl,
        updateUrl,
        notAvailableUrl,
        minDelay,
        maxDelay,
      };
      saveQueue(state);
      try {
        await processApiQueue(state);
      } catch (err) {
        clearQueue();
        setRunning(false);
        setSendStatus(err.message || "Something went wrong");
        alert(`Start failed.\n\n${err.message || "Unknown error"}`);
      }
    }

    document
      .getElementById("wa-start-whatsapp-chat")
      .addEventListener("click", () => {
        const startBtn = document.getElementById("wa-start-whatsapp-chat");
        if (startBtn.disabled) return;

        const activeBtn = sidebar.querySelector(".wa-tab.active");
        activeTab = activeBtn?.dataset.tab || activeTab;
        updatePanelVisibility();

        if (activeTab === "api") {
          startApiSending().catch((err) => {
            clearQueue();
            setRunning(false);
            setSendStatus(err.message || "Start failed");
            alert(`Start failed.\n\n${err.message || "Unknown error"}`);
          });
        } else {
          startManualSending().catch((err) => {
            clearQueue();
            setRunning(false);
            setSendStatus(err.message || "Start failed");
            alert(`Start failed.\n\n${err.message || "Unknown error"}`);
          });
        }
      });

    document
      .getElementById("wa-stop-whatsapp-chat")
      .addEventListener("click", () => {
        stopSending = true;
        cancelAllSenderRuns(); // invalidates every in-flight countdown/loop
        if (activeTimeout) clearTimeout(activeTimeout);
        clearQueue();
        setRunning(false);
        const status = document.getElementById("wa-send-status");
        if (status) status.textContent = "Stopped.";
      });

    document.getElementById("wa-sidebar-close").onclick = () => {
      sidebar.style.display = "none";
    };

    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "wa-start-sending-from-socket") {
        const startBtn = document.getElementById("wa-start-whatsapp-chat");
        if (startBtn && !startBtn.disabled) {
          startBtn.click();
        }
      }
    });

    const pending = loadQueue();
    if (pending) {
      stopSending = false;
      activeRunId = beginSenderRun();
      setRunning(true);
      if (pending.mode === "api") {
        activeTab = "api";
        updatePanelVisibility();
        sleep(2500).then(async () => {
          // Resume mid-send if chat was opened before reload
          if (
            pending.currentId &&
            pending.currentNumber &&
            pending.currentMessage
          ) {
            const sent = await sendOneMessage(
              pending.currentNumber,
              pending.currentMessage,
            );
            if (!stopSending) {
              try {
                if (sent) {
                  setSendStatus("Updating message status...");
                  await apiRequest(
                    "GET",
                    buildIdUrl(pending.updateUrl, pending.currentId),
                  );
                } else {
                  setSendStatus(
                    `Marking ${pending.currentNumber} as not available...`,
                  );
                  await apiRequest(
                    "GET",
                    buildIdUrl(pending.notAvailableUrl, pending.currentId),
                  );
                  setSendStatus(
                    `Marked not available: ${pending.currentNumber}`,
                  );
                }
              } catch (err) {
                setSendStatus(
                  sent ?
                    `Sent, but update failed: ${err.message}. Continuing...`
                  : `Not-available update failed: ${err.message}. Continuing...`,
                );
              }
            }
            delete pending.currentId;
            delete pending.currentNumber;
            delete pending.currentMessage;
            saveQueue(pending);
            if (!stopSending) {
              const ready = await waitBeforeNext(
                pending.minDelay,
                pending.maxDelay,
              );
              if (!ready) {
                clearQueue();
                setRunning(false);
                return;
              }
            }
          }
          await processApiQueue(pending);
        });
      } else if (pending.numbers && pending.index < pending.numbers.length) {
        sleep(2500).then(() => processManualQueue(pending));
      } else {
        clearQueue();
        setRunning(false);
      }
    }

    const settingsForm = document.getElementById("wa-settings-form");
    const settingsStatus = document.getElementById("wa-settings-status");

    function fillSettingsForm(st) {
      RECEIVE_SETTINGS_FIELDS.forEach((f) => {
        const input = settingsForm.elements[f.key];
        if (!input) return;
        if (f.type === "bool") input.checked = !!st[f.key];
        else input.value = String(st[f.key]);
      });
    }

    function readSettingsForm() {
      const out = {};
      RECEIVE_SETTINGS_FIELDS.forEach((f) => {
        const input = settingsForm.elements[f.key];
        if (!input) return;
        out[f.key] = f.type === "bool" ? input.checked : input.value;
      });
      return out;
    }

    function setApiListeningRowVisible(visible) {
      const row = document
        .getElementById("wa-api-listening-status")
        ?.closest(".wa-receive-controls");
      if (row) row.style.display = visible ? "flex" : "none";
    }

    // Re-apply timers/UI that captured the old values
    function onReceiveSettingsChanged() {
      startPostRetryTimer();
      setApiListeningRowVisible(RECEIVE_READING_ENABLED);
      if (!RECEIVE_READING_ENABLED) {
        if (isListening()) stopReceiveListening();
        setListeningUi(false);
        setReceiveStatus(RECEIVE_DISABLED_STATUS);
        return;
      }
      if (isListening()) {
        ensureReceiveListening({ forceRestart: true });
      } else {
        setListeningUi(false);
        setReceiveStatus("Stopped listening.");
      }
    }

    function showSettingsStatus(text) {
      settingsStatus.textContent = text;
    }

    fillSettingsForm(loadReceiveSettings());

    settingsForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const wanted = readSettingsForm();
      const saved = saveReceiveSettings(wanted);
      fillSettingsForm(saved);
      const adjusted = RECEIVE_SETTINGS_FIELDS.some(
        (f) => f.type !== "bool" && Number(wanted[f.key]) !== saved[f.key],
      );
      onReceiveSettingsChanged();
      showSettingsStatus(
        adjusted ? "Saved (some values adjusted to allowed range)." : "Saved.",
      );
    });

    document
      .getElementById("wa-settings-reset")
      .addEventListener("click", () => {
        const saved = saveReceiveSettings(defaultReceiveSettings());
        fillSettingsForm(saved);
        onReceiveSettingsChanged();
        showSettingsStatus("Defaults restored.");
      });

    applyPosAuthToSidebar(sidebar);

    rehydrateReceivedList();

    lastNextListeningEstimate = estimateNextListeningMessagesFromChatList();

    // Do not auto-start listening on sidebar launch.
    // Listening starts only after the user clicks "Start Listening".
    sessionStorage.setItem(LISTENING_STOPPED_KEY, "1");
    listeningManuallyStopped = true;
    stopListening = true;
    setListeningUi(false);
    setReceiveStatus(
      RECEIVE_READING_ENABLED ? "Stopped listening." : RECEIVE_DISABLED_STATUS,
    );
    if (!RECEIVE_READING_ENABLED) {
      // Sending tab: hide the listening status row entirely
      const apiListenRow = document
        .getElementById("wa-api-listening-status")
        ?.closest(".wa-receive-controls");
      if (apiListenRow) apiListenRow.style.display = "none";
    }

    // If hooks die after launch (reinjection / WA remount), restart automatically
    if (window.__waListenWatchdog) {
      clearInterval(window.__waListenWatchdog);
    }
    window.__waListenWatchdog = setInterval(() => {
      if (listeningManuallyStopped || stopListening) return;
      clearStuckOpenIfNeeded();
      const heartbeatStale =
        lastReceiveHeartbeatAt > 0 &&
        Date.now() - lastReceiveHeartbeatAt > RECEIVE_POLL_INTERVAL_MS * 4;
      if (isListening() && receiveInfrastructureAlive() && !heartbeatStale) {
        // Soft keep-alive: force unread requeue if quiet too long
        requeueVisibleUnreadChats(false);
        return;
      }
      console.warn("[WA] receive watchdog restart →", {
        listening: isListening(),
        alive: receiveInfrastructureAlive(),
        heartbeatStale,
      });
      ensureReceiveListening({ forceRestart: true });
    }, 8000);

    return sidebar;
  }

  function showSidebar() {
    const sidebar = createSidebar();
    sidebar.style.display = "flex";
  }

  function toggleSidebar() {
    const existing = document.getElementById("wa-cursor-sidebar");
    if (!existing) {
      showSidebar();
      return;
    }
    existing.style.display =
      existing.style.display === "none" ? "flex" : "none";
  }

  // Always (re)build the sidebar on injection so extension reloads take effect
  createSidebar(true);

  // Replace any previous listener so re-injected scripts don't stack handlers
  if (window.__waSidebarOnMessage) {
    try {
      chrome.runtime.onMessage.removeListener(window.__waSidebarOnMessage);
    } catch (_) {}
  }

  window.__waSidebarOnMessage = (message) => {
    if (message?.type === "wa-toggle-sidebar") {
      toggleSidebar();
    } else if (message?.type === "wa-show-sidebar") {
      showSidebar();
    } else if (message?.type === "wa-start-sending") {
      const startBtn = document.getElementById("wa-start-whatsapp-chat");
      if (startBtn && !startBtn.disabled) {
        startBtn.click();
      }
    }
  };

  chrome.runtime.onMessage.addListener(window.__waSidebarOnMessage);
})();
