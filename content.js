(function () {
  const QUEUE_KEY = "wa_sender_queue";
  const API_SETTINGS_KEY = "wa_api_settings";
  const SEEN_MSG_KEY = "wa_seen_incoming_ids";
  const RECEIVED_LIST_KEY = "wa_received_list";
  const LISTENING_STOPPED_KEY = "wa_listening_stopped";
  const MAX_SEEN_IDS = 500;
  const MAX_LIST_ITEMS = 50;
  const DEFAULT_RECEIVE_DAYS = 1;
  const RECEIVE_CHAT_GAP_MIN_SEC = 2;
  const RECEIVE_CHAT_GAP_MAX_SEC = 3;
  const RECEIVE_POLL_INTERVAL_MS = 4000;

  function getReceiveReadDays() {
    // Locked to 1 day for now
    return 1;
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
    const domScore = domPhone ?
      scorePhoneCandidate(domPhone, domPhone)
    : 0;

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
        console.log("[WA] peer phone from Contact info →", scraped.phone, scraped.display);
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

  function normalizeChatQueueItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = raw._id || raw.id || "";
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
      _id: String(id),
      number: String(number),
      message: String(message),
    };
  }

  function applyPosAuthToSidebar(sidebar) {
    const statusEl = sidebar.querySelector("#wa-pos-auth-status");
    if (!statusEl) return;

    const apiSettings = loadApiSettings();
    const hintUrl =
      apiSettings.fetchUrl ||
      apiSettings.receiveUrl ||
      "http://localhost:5173/api/chat/fetch-random";

    chrome.runtime.sendMessage(
      { type: "wa-get-pos-auth", apiUrl: hintUrl },
      (response) => {
        if (chrome.runtime.lastError) {
          statusEl.textContent = "POS auth: extension error";
          statusEl.className = "wa-pos-auth-status is-error wa-api-urls-hidden";
          return;
        }

        if (!response?.authenticated) {
          statusEl.textContent =
            "POS auth: log in to AI POS in this browser first";
          statusEl.className = "wa-pos-auth-status is-muted wa-api-urls-hidden";
          return;
        }

        statusEl.textContent =
          response.companyName ?
            `POS connected — Welcome ${response.companyName}`
          : response.companyId ?
            `POS connected (company ${response.companyId.slice(0, 8)}…)`
          : "POS connected";
        statusEl.className = "wa-pos-auth-status is-ok wa-api-urls-hidden";

        if (!response.urls) return;

        const setIfEmpty = (id, value) => {
          const el = sidebar.querySelector(`#${id}`);
          if (!el || el.value.trim()) return;
          el.value = value;
        };

        setIfEmpty("wa-fetch-url", response.urls.fetchUrl);
        setIfEmpty("wa-update-url", response.urls.updateUrl);
        setIfEmpty("wa-not-available-url", response.urls.notAvailableUrl);
        setIfEmpty("wa-receive-url", response.urls.receiveUrl);

        const urlFields = [
          ["wa-fetch-url", "fetchUrl"],
          ["wa-update-url", "updateUrl"],
          ["wa-not-available-url", "notAvailableUrl"],
          ["wa-receive-url", "receiveUrl"],
        ];
        urlFields.forEach(([id, key]) => {
          const el = sidebar.querySelector(`#${id}`);
          if (
            el &&
            response.urls?.[key] &&
            (!el.value.trim() || isLegacyApiUrl(el.value))
          ) {
            el.value = response.urls[key];
          }
        });
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
      items.length > MAX_LIST_ITEMS ?
        items.slice(0, MAX_LIST_ITEMS)
      : items;
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
    if (template.includes(":id")) {
      return template.replace(/:id/g, encodeURIComponent(id));
    }
    return template.replace(/\/?$/, "/") + encodeURIComponent(id);
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
            reject(
              new Error(
                response?.error || `Request failed (${response?.status || 0})`,
              ),
            );
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
    if (
      node.classList?.contains("message-out") ||
      node.closest?.(".message-out")
    )
      return true;
    if (node.classList?.contains("message-in") || node.closest?.(".message-in"))
      return false;
    const dataId =
      node.getAttribute?.("data-id") ||
      node.closest?.("[data-id]")?.getAttribute("data-id") ||
      "";
    if (dataId.startsWith("true_")) return true;
    if (dataId.startsWith("false_")) return false;
    // Outgoing bubbles usually show delivery ticks
    if (
      node.querySelector?.(
        '[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-dblcheck-ack"], [data-icon="msg-time"], [data-testid="msg-meta"] [data-icon]',
      )
    ) {
      return true;
    }
    return false;
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
      .querySelectorAll?.(
        '[role="row"], [data-testid="msg-system"], div, span',
      )
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
      .querySelectorAll?.(
        '[role="row"], [data-testid="msg-system"], div, span',
      )
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

    const dataId = withId.getAttribute("data-id") || "";
    const parsed = parseChatIdFromDataId(dataId);
    if (parsed.fromMe === true) return null;

    const text = getMessageText(withId);
    if (!text) return null;

    const pre =
      withId
        .querySelector?.("[data-pre-plain-text]")
        ?.getAttribute("data-pre-plain-text") || "";
    let messageDate = getMessageTimestamp(withId);

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

    if (!options.unreadCatchup && !options.isRuntime && !isWithinReadWindow(messageDate)) return null;

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
    const badge =
      cell.querySelector('[aria-label*="unread" i]') ||
      cell.querySelector('[data-testid="icon-unread-count"]') ||
      cell.querySelector('[data-testid="icon-unread"]') ||
      cell.querySelector('[data-testid="unread-count"]') ||
      cell.querySelector('[data-testid="unread-mention-count"]') ||
      cell.querySelector('span[data-icon="unread-count"]') ||
      cell.querySelector('[data-icon="unread-count"]');
    if (badge) return parseUnreadCountFromBadge(badge);

    let found = 0;
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
      postedEl.textContent = "Posting...";
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
        <button type="button" class="wa-tab" data-tab="manual">Manual</button>
        <button type="button" class="wa-tab active" data-tab="api">API</button>
        <button type="button" class="wa-tab" data-tab="received">Received</button>
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
          <div class="wa-api-urls-hidden" aria-hidden="true">
            <label for="wa-fetch-url">Fetch Chat URL (GET):</label>
            <input type="text" id="wa-fetch-url" placeholder="http://localhost:5173/api/chat/fetch-random?company_id=..." />
            <label for="wa-update-url">Mark Sent URL (GET):</label>
            <input type="text" id="wa-update-url" placeholder="http://localhost:5173/api/chat/mark-sent/:id" />
            <label for="wa-not-available-url">Mark Not Available URL (GET):</label>
            <input type="text" id="wa-not-available-url" placeholder="http://localhost:5173/api/chat/mark-not-available/:id" />
            <p class="wa-hint">GET <code>fetch-random</code> returns one chat with status <code>not_started</code>. Use <code>:id</code> in mark URLs. Sent → <code>sent</code>; failed → <code>not_available</code>.</p>
          </div>
        </div>
        <div class="wa-tab-panel" data-panel="received" style="display:none;">
          <div class="wa-api-urls-hidden" aria-hidden="true">
            <label for="wa-receive-url">Chat API URL (POST):</label>
            <input type="text" id="wa-receive-url" placeholder="http://localhost:5173/api/chat/create/:token" />
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
    const openFailCounts = new Map();
    const chatListState = new Map(); // title -> { preview, unread }
    const recentByChat = new Map(); // chatName -> [{ text, at, source }]
    let chatListSeeded = false;
    const seenIds = loadSeenIds();
    let postQueue = Promise.resolve();
    let scanDebounceTimer = null;
    let lastChatSwitchFinishedAt = 0;
    const baselineMessageIds = new Set();

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
          activeTab === "received" ? "none" : "block";
      }
      const startBtn = document.getElementById("wa-start-whatsapp-chat");
      const stopBtn = document.getElementById("wa-stop-whatsapp-chat");
      const running = !!startBtn?.disabled;
      if (startBtn) {
        startBtn.style.display =
          activeTab === "received" || running ? "none" : "";
      }
      if (stopBtn) {
        const showStop = running && activeTab !== "received";
        stopBtn.hidden = !showStop;
        stopBtn.style.display = showStop ? "block" : "none";
      }
      updateStartButtonLabel();
    }

    function tabsLocked() {
      const startBtn = document.getElementById("wa-start-whatsapp-chat");
      return !!startBtn?.disabled;
    }

    sidebar.querySelectorAll(".wa-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        if (tabsLocked()) return;
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
      const showStop = !!running && activeTab !== "received";
      stopBtn.hidden = !showStop;
      stopBtn.style.display = showStop ? "block" : "none";
      startBtn.style.display =
        activeTab === "received" || running ? "none" : "";
      sidebar.querySelectorAll(".wa-tab").forEach((btn) => {
        btn.disabled = !!running;
      });
      if (!running) {
        updateStartButtonLabel();
      }
    }

    function setListeningUi(running) {
      const startBtn = document.getElementById("wa-start-listening");
      const stopBtn = document.getElementById("wa-stop-listening");
      if (!startBtn || !stopBtn) return;
      stopBtn.style.display = running ? "inline-block" : "none";
      startBtn.style.display = running ? "none" : "inline-block";
    }

    function stopReceiveListening() {
      stopListening = true;
      listeningManuallyStopped = true;
      sessionStorage.setItem(LISTENING_STOPPED_KEY, "1");
      cancelAllReceiveRuns();
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
        text === "Starting listener…" ||
        text.startsWith("Waiting for WhatsApp") ||
        text.startsWith("Listen failed:");
      if (!isListening() && !allowedWhileStopped) return;
      const status = document.getElementById("wa-receive-status");
      if (status) {
        status.textContent = text;
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

    function updateReceivedItemStatus(messageId, postState) {
      const li = document.querySelector(
        `#wa-received-list [data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!li) return;
      const postedEl = li.querySelector(".wa-received-posted");
      if (!postedEl) return;
      renderReceivedPostState(postedEl, postState);

      const items = loadReceivedList();
      const idx = items.findIndex(
        (item) => item?.payload?.messageId === messageId,
      );
      if (idx >= 0) {
        items[idx] = { ...items[idx], postState };
        saveReceivedList(items);
      }
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
            normalizePhone(payload.to) ||
            getMyWhatsAppNumber() ||
            "unknown",
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

      postQueue = postQueue.then(async () => {
        if (!isListening()) return;
        try {
          // Resolve sender phone from Contact info (ignore weak/wrong cache)
          const existing = normalizePhone(payload.from);
          const existingScore = existing ?
            scorePhoneCandidate(existing, existing)
          : 0;
          if (!existing || existingScore < 20) {
            const resolved = await ensurePeerPhone(
              payload.chatName,
              payload.prePlainText,
            );
            if (resolved) payload.from = resolved;
          }
          await postIncomingToChatApi(payload);
          updateReceivedItemStatus(payload.messageId, "ok");
        } catch (err) {
          updateReceivedItemStatus(
            payload.messageId,
            err.postState || { error: err.message || "Request failed" },
          );
        }
      });
    }

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
        eligible.length > MAX_CATCHUP ?
          eligible.slice(-MAX_CATCHUP)
        : eligible;
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
          if (!id || seenIds.has(id) || baselineMessageIds.has(id)) return false;
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

      queryChatListCells(pane).forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        const unread = getUnreadCountFromCell(cell);
        if (!unread || !isChatRowWithinReadWindow(cell, unread)) return;
        if (openTitle && title.trim() === openTitle.trim()) {
          processUnreadCatchup(unread);
          queued += 1;
          return;
        }
        queueChatOpen({
          row: cell,
          title,
          unreadCount: unread,
          reason: "startup-unread",
        });
        queued += 1;
      });

      if (queued > 0) {
        setReceiveStatus(
          `Listening — opening ${queued} unread chat${queued === 1 ? "" : "s"}…`,
        );
      } else {
        const cells = queryChatListCells(pane);
        const unreadVisible = cells.filter(
          (c) => getUnreadCountFromCell(c) > 0,
        ).length;
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
        chatListState.set(title, {
          preview: getPreviewFromRow(cell),
          unread: getUnreadCountFromCell(cell),
        });
      });
      chatListSeeded = true;
      return true;
    }

    function isOutgoingChatPreview(preview) {
      return /^(you|me|yo|tú|vous|você)\s*:/i.test(
        String(preview || "").trim(),
      );
    }

    function scanChatListForRuntimeIncoming() {
      if (!isListening()) return;
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
        const prev = chatListState.get(title) || { preview: "", unread: 0 };

        const unreadIncreased = unread > prev.unread;
        const previewChanged =
          !!preview &&
          preview !== prev.preview &&
          !textsAreSameMessage(prev.preview, preview);
        // Preview-only changes matter too (message read on phone then synced,
        // or unread badge already cleared). Still ignore our own outgoing previews.
        const syncedPreview =
          previewChanged && !!preview && !isOutgoingChatPreview(preview);
        const hasNewActivity =
          unreadIncreased || (unread > 0 && previewChanged) || syncedPreview;

        // User (or WA) opened a chat that had unread — badge cleared but messages still there
        if (
          prev.unread > 0 &&
          unread < prev.unread &&
          isChatCurrentlyOpen(title)
        ) {
          chatListState.set(title, { preview, unread });
          processConversationCatchup({ unreadHint: prev.unread });
          return;
        }

        if (!hasNewActivity || !isChatRowWithinReadWindow(cell, Math.max(unread, 1))) {
          chatListState.set(title, { preview, unread });
          return;
        }

        // Commit state only after we schedule work so a failed open can still
        // re-detect the same preview on the next poll if needed.
        const newUnread =
          unreadIncreased ? Math.max(1, unread - prev.unread) : unread;

        if (isChatCurrentlyOpen(title)) {
          chatListState.set(title, { preview, unread });
          processConversationCatchup({
            unreadHint: Math.max(newUnread, 1),
            expectedPreview: preview,
          });
          return;
        }

        chatListState.set(title, { preview, unread });
        queueChatOpen({
          row: cell,
          title,
          unreadCount: Math.max(newUnread, syncedPreview ? 1 : 0),
          expectedPreview: preview,
          reason: syncedPreview ? "preview-sync" : "unread",
        });
      });
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
      if (!canOpenNextChat() || !chatOpenQueue.length) return;
      const item = chatOpenQueue.shift();
      await openChatRow(item.row, item.title, {
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

    async function openChatRow(row, title, options = {}) {
      if (!isListening() || !row) return;

      openingChat = true;
      openingChatTitle = title || "chat";
      const unreadCount = options.unreadCount || 0;
      const expectedPreview = String(options.expectedPreview || "").trim();
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
          setReceiveStatus(
            `Could not open "${openingChatTitle}" (try ${fails}/3).`,
          );
          await sleep(800);
          return;
        }

        openFailCounts.delete(openingChatTitle);

        // Retries: WA often marks read before bubbles finish rendering
        const catchCount = Math.max(unreadCount || 0, getUnreadDividerCount() || 0, 1);
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
        if (isListening()) {
          setReceiveStatus(
            captured > 0 ?
              `Captured ${captured} synced message${captured === 1 ? "" : "s"}`
            : "Listening for new messages...",
          );
          await sleep(getChatSwitchGapMs());
        }
      } catch (err) {
        setReceiveStatus(`Read failed: ${err.message || "unknown error"}`);
        await sleep(800);
      } finally {
        lastChatSwitchFinishedAt = Date.now();
        openingChat = false;
        openingChatTitle = "";
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

      const target = document.querySelector("#app") || document.body;

      const observer = new MutationObserver(() => {
        if (!isListening()) return;
        scheduleConversationScan();
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
        if (!isListening()) return;

        // Re-scan open conversation for unread divider + new messages
        if (isConversationOpen()) {
          catchupOpenConversationUnread();
          scanForIncomingMessages(document.querySelector("#main") || document);
        }

        scanChatListForRuntimeIncoming();
        processChatOpenQueue();
      }, RECEIVE_POLL_INTERVAL_MS);
    }

    async function startListening() {
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
      const forceRestart = !!options.forceRestart;
      if (listeningManuallyStopped && !forceRestart) {
        setListeningUi(false);
        setReceiveStatus("Stopped listening.");
        return;
      }
      if (
        !forceRestart &&
        isListening() &&
        receiveInfrastructureAlive()
      ) {
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
      .getElementById("wa-start-listening")
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

    async function clickSendWhenReady(timeoutMs = 20000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (!isActive()) return false;
        const sendButton = findSendButton();
        if (sendButton) {
          sendButton.click();
          return true;
        }
        await sleep(400);
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
          payload = await apiRequest("GET", state.fetchUrl);
        } catch (err) {
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

        const item = normalizeChatQueueItem(payload?.data);
        if (!payload?.success || !item) {
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

    applyPosAuthToSidebar(sidebar);

    rehydrateReceivedList();

    // Always auto-start listening on sidebar launch (ignore prior Stop in this tab)
    sessionStorage.removeItem(LISTENING_STOPPED_KEY);
    listeningManuallyStopped = false;
    stopListening = false;
    ensureReceiveListening({ forceRestart: true });

    // If hooks die after launch (reinjection / WA remount), restart automatically
    if (window.__waListenWatchdog) {
      clearInterval(window.__waListenWatchdog);
    }
    window.__waListenWatchdog = setInterval(() => {
      if (listeningManuallyStopped || stopListening) return;
      if (isListening() && receiveInfrastructureAlive()) return;
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
