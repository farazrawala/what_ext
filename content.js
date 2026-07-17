(function () {
  const QUEUE_KEY = 'wa_sender_queue';
  const API_SETTINGS_KEY = 'wa_api_settings';
  const SEEN_MSG_KEY = 'wa_seen_incoming_ids';
  const MAX_SEEN_IDS = 500;
  const MAX_LIST_ITEMS = 50;

  // Shared across reinjections so old async loops stop when Stop is pressed
  if (typeof window.__waSenderActiveRun !== 'number') {
    window.__waSenderActiveRun = 0;
  }
  if (typeof window.__waReceiveActiveRun !== 'number') {
    window.__waReceiveActiveRun = 0;
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
  }

  function isReceiveRunActive(runId) {
    return runId === window.__waReceiveActiveRun;
  }

  function normalizePhone(number) {
    return String(number).replace(/\D/g, '');
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

  function saveApiSettings(fetchUrl, updateUrl, notAvailableUrl, receiveUrl) {
    const prev = loadApiSettings();
    localStorage.setItem(
      API_SETTINGS_KEY,
      JSON.stringify({
        fetchUrl: fetchUrl ?? prev.fetchUrl,
        updateUrl: updateUrl ?? prev.updateUrl,
        notAvailableUrl: notAvailableUrl ?? prev.notAvailableUrl,
        receiveUrl: receiveUrl ?? prev.receiveUrl
      })
    );
  }

  function loadApiSettings() {
    try {
      const raw = localStorage.getItem(API_SETTINGS_KEY);
      return raw
        ? JSON.parse(raw)
        : { fetchUrl: '', updateUrl: '', notAvailableUrl: '', receiveUrl: '' };
    } catch {
      return { fetchUrl: '', updateUrl: '', notAvailableUrl: '', receiveUrl: '' };
    }
  }

  function persistApiUrlsFromInputs() {
    const fetchUrl = document.getElementById('wa-fetch-url')?.value.trim() || '';
    const updateUrl = document.getElementById('wa-update-url')?.value.trim() || '';
    const notAvailableUrl = document.getElementById('wa-not-available-url')?.value.trim() || '';
    const receiveUrl = document.getElementById('wa-receive-url')?.value.trim() || '';
    saveApiSettings(fetchUrl, updateUrl, notAvailableUrl, receiveUrl);
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
    const trimmed = arr.length > MAX_SEEN_IDS ? arr.slice(arr.length - MAX_SEEN_IDS) : arr;
    sessionStorage.setItem(SEEN_MSG_KEY, JSON.stringify(trimmed));
  }

  function buildIdUrl(template, id) {
    if (!template) return '';
    if (template.includes(':id')) {
      return template.replace(/:id/g, encodeURIComponent(id));
    }
    return template.replace(/\/?$/, '/') + encodeURIComponent(id);
  }

  function apiRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'wa-api-request', method, url, body },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || `Request failed (${response?.status || 0})`));
            return;
          }
          resolve(response.data);
        }
      );
    });
  }

  function parseChatIdFromDataId(dataId) {
    if (!dataId) return { fromMe: null, chatId: '', phone: '', isGroup: false };
    // Legacy: false_92300...@c.us_ABCDEF  |  true_1203...@g.us_...
    // Newer WA builds may use bare ids without true_/false_ prefix
    const raw = String(dataId);
    const parts = raw.split('_');
    let fromMe = null;
    let chatId = '';
    if (parts[0] === 'true' || parts[0] === 'false') {
      fromMe = parts[0] === 'true';
      chatId = parts[1] || '';
    } else if (raw.includes('@c.us') || raw.includes('@g.us') || raw.includes('@lid')) {
      chatId = parts.find((p) => p.includes('@')) || '';
    }
    const isGroup = chatId.includes('@g.us');
    const phone = chatId.includes('@c.us') ? normalizePhone(chatId.split('@')[0]) : '';
    return { fromMe, chatId, phone, isGroup };
  }

  function getOpenChatName() {
    const header =
      document.querySelector('#main header') ||
      document.querySelector('[data-testid="conversation-header"]') ||
      document.querySelector('#main [data-testid="conversation-info-header"]') ||
      document.querySelector('header');
    if (!header) return '';
    const title =
      header.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
      header.querySelector('span[dir="auto"][title]') ||
      header.querySelector('span[title]') ||
      header.querySelector('span[dir="auto"]');
    return (title?.getAttribute('title') || title?.textContent || '').trim();
  }

  function isOutgoingMessage(node) {
    if (!node) return false;
    if (node.classList?.contains('message-out') || node.closest?.('.message-out')) return true;
    if (node.classList?.contains('message-in') || node.closest?.('.message-in')) return false;
    const dataId = node.getAttribute?.('data-id') || node.closest?.('[data-id]')?.getAttribute('data-id') || '';
    if (dataId.startsWith('true_')) return true;
    if (dataId.startsWith('false_')) return false;
    // Outgoing bubbles usually show delivery ticks
    if (
      node.querySelector?.(
        '[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-dblcheck-ack"], [data-icon="msg-time"], [data-testid="msg-meta"] [data-icon]'
      )
    ) {
      return true;
    }
    return false;
  }

  function findMessageRow(el) {
    if (!el || el.nodeType !== 1) return null;
    return (
      el.closest?.('[data-id]') ||
      (el.getAttribute?.('data-id') ? el : null) ||
      el.closest?.('.message-in') ||
      el.closest?.('.message-out') ||
      el.closest?.('.copyable-text[data-pre-plain-text]')?.parentElement
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
      if (!row.closest?.('#main')) return;
      if (isOutgoingMessage(row)) return;
      const dataId = row.getAttribute?.('data-id') || '';
      const text = getMessageText(row);
      if (!dataId && !text) return;
      seen.add(row);
      list.push(row);
    };

    pushNode(scope);

    // Search within the given root (for mutation nodes) and/or the open chat panel
    const searchRoots = new Set();
    if (scope !== document) searchRoots.add(scope);
    const main = document.querySelector('#main');
    if (main && (scope === document || scope === main || scope.contains?.(main) || main.contains?.(scope))) {
      searchRoots.add(main);
    }
    if (!searchRoots.size && main) searchRoots.add(main);

    searchRoots.forEach((sr) => {
      sr.querySelectorAll?.(
        '[data-id], .message-in, .copyable-text[data-pre-plain-text]'
      ).forEach(pushNode);
    });

    return list;
  }

  function stableHash(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i += 1) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  function extractIncomingPayload(node) {
    const withId = findMessageRow(node);
    if (!withId) return null;
    if (isOutgoingMessage(withId)) return null;

    const dataId = withId.getAttribute('data-id') || '';
    const parsed = parseChatIdFromDataId(dataId);
    if (parsed.fromMe === true) return null;

    const text = getMessageText(withId);
    if (!text) return null;

    const pre =
      withId.querySelector?.('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || '';
    const chatName = getOpenChatName();
    const messageId = dataId || `dom_${stableHash(`${chatName}|${pre}|${text}`)}`;

    return {
      messageId,
      from: parsed.phone || '',
      chatId: parsed.chatId || '',
      chatName: chatName || parsed.phone || parsed.chatId || 'Unknown',
      text,
      isGroup: parsed.isGroup,
      receivedAt: new Date().toISOString(),
      source: 'conversation'
    };
  }

  function normalizeMessageText(text) {
    return String(text || '')
      .replace(/[\u200e\u200f\ufeff]/g, '')
      // Strip Material/WhatsApp icon ligatures that leak from DOM textContent
      .replace(
        /\b(ic-expand-more|ic-expand-less|ic-check|ic-done|ic-done-all|ic-access-time|ic-photo-camera|ic-mic|ic-videocam|expand[_-]?more|expand[_-]?less)\b/gi,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isGarbageMessageText(text) {
    const t = normalizeMessageText(text);
    if (!t) return true;
    if (/^[\d?\s]+$/.test(t) && t.length <= 3) return true;
    if (/ic-|expand-more|expand-less/i.test(t)) return true;
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
    if (!node) return '';
    // Prefer real message body only — avoid broad selectors that pick icons/meta
    const selectors = [
      'span.selectable-text.copyable-text',
      '[data-testid="message-text"] span.selectable-text',
      '[data-testid="message-text"]',
      '.copyable-text span.selectable-text',
      'span.selectable-text'
    ];
    for (const sel of selectors) {
      const el = node.querySelector?.(sel);
      const text = normalizeMessageText(el?.innerText || el?.textContent || '');
      if (text && !isGarbageMessageText(text)) return text;
    }
    const copyable = node.querySelector?.('.copyable-text[data-pre-plain-text], [data-pre-plain-text]');
    if (copyable) {
      const nested = normalizeMessageText(
        copyable.querySelector('span.selectable-text')?.innerText ||
          copyable.querySelector('span')?.innerText ||
          ''
      );
      if (nested && !isGarbageMessageText(nested)) return nested;
    }
    return '';
  }

  // Only used to detect chat-list changes (never posted as message text)
  function getPreviewFromRow(row) {
    if (!row) return '';
    const secondary = row.querySelector('[data-testid="cell-frame-secondary"]');
    const candidate =
      secondary?.querySelector?.('span[title]') ||
      secondary?.querySelector?.('span.selectable-text') ||
      secondary;
    if (!candidate) return '';
    const titled = (candidate.getAttribute?.('title') || '').trim();
    if (titled) return normalizeMessageText(titled);
    return normalizeMessageText(candidate.innerText || candidate.textContent || '');
  }

  function getUnreadCountFromCell(cell) {
    const badge =
      cell.querySelector('[aria-label*="unread" i]') ||
      cell.querySelector('[data-testid="icon-unread-count"]') ||
      cell.querySelector('[data-testid="unread-count"]') ||
      cell.querySelector('[data-testid="unread-mention-count"]');
    if (badge) return parseUnreadCountFromBadge(badge);

    let found = 0;
    cell.querySelectorAll('span').forEach((el) => {
      const text = (el.textContent || '').trim();
      if (!/^\d{1,3}$/.test(text)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.width > 36 || rect.height < 10 || rect.height > 36) return;
      found = Math.max(found, parseInt(text, 10) || 0);
    });
    return found > 0 ? Math.min(found, 10) : 0;
  }

  function findChatListPane() {
    return (
      document.querySelector('#pane-side') ||
      document.querySelector('[data-testid="chat-list"]') ||
      document.querySelector('[aria-label="Chat list"]') ||
      document.querySelector('[aria-label="Chats"]')
    );
  }

  function getChatRowFromEl(el) {
    if (!el || el.closest?.('#wa-cursor-sidebar')) return null;
    return (
      el.closest('[data-testid="cell-frame-container"]') ||
      el.closest('[data-testid="list-item"]') ||
      el.closest('[role="listitem"]') ||
      el.closest('[role="row"]') ||
      el.closest('div[aria-selected]') ||
      el.closest('div[tabindex="-1"]') ||
      el.closest('div[tabindex="0"]')
    );
  }

  function getChatTitleFromRow(row) {
    if (!row) return '';
    const titleEl =
      row.querySelector('[data-testid="cell-frame-title"] span[title]') ||
      row.querySelector('[data-testid="cell-frame-title"]') ||
      row.querySelector('span[title][dir="auto"]') ||
      row.querySelector('span[title]');
    return (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim();
  }

  function parseUnreadCountFromBadge(badge) {
    if (!badge) return 1;
    const label = badge.getAttribute?.('aria-label') || '';
    const fromLabel = label.match(/(\d+)/);
    if (fromLabel) {
      const n = parseInt(fromLabel[1], 10);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 10);
    }
    const text = (badge.textContent || '').trim();
    if (/^\d{1,3}$/.test(text)) {
      const n = parseInt(text, 10);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 10);
    }
    return 1;
  }

  function isConversationOpen() {
    return !!(
      document.querySelector('#main [data-testid="conversation-panel-messages"]') ||
      document.querySelector('#main [data-testid="conversation-panel-body"]') ||
      document.querySelector('#main footer') ||
      document.querySelector('#main [contenteditable="true"]') ||
      document.querySelector('#main [data-testid="conversation-compose-box-input"]')
    );
  }

  function simulateUserClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {}

    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const x = rect.left + Math.min(Math.max(rect.width / 2, 8), rect.width - 8);
    const y = rect.top + Math.min(Math.max(rect.height / 2, 8), rect.height - 8);
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
      pointerType: 'mouse',
      isPrimary: true
    };

    try {
      el.focus?.();
    } catch (_) {}

    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(
      (type) => {
        let event;
        if (type.startsWith('pointer')) {
          try {
            event = new PointerEvent(type, common);
          } catch (_) {
            event = new MouseEvent(type, common);
          }
        } else {
          event = new MouseEvent(type, common);
        }
        el.dispatchEvent(event);
      }
    );

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
      if (el.closest('button')) return true;
      if (el.closest('[role="button"]') && !el.closest('[data-testid="cell-frame-container"]')) {
        // chat rows are rarely role=button at the outer level for filters
        const label = (el.getAttribute?.('aria-label') || el.textContent || '').toLowerCase();
        if (/\b(unread|all|favourites|groups|contacts)\b/.test(label) && !el.closest('[data-testid="cell-frame-container"]')) {
          return true;
        }
      }
      return false;
    };

    const addRow = (badgeOrRow, badge) => {
      if (isFilterOrToolbar(badgeOrRow)) return;
      const row = getChatRowFromEl(badgeOrRow);
      if (!row || seen.has(row) || !pane.contains(row)) return;
      if (row.closest('#wa-cursor-sidebar')) return;
      // Must look like a chat cell, not a filter chip
      if (
        !row.matches?.('[data-testid="cell-frame-container"]') &&
        !row.querySelector?.('[data-testid="cell-frame-title"]') &&
        !row.querySelector?.('span[title]')
      ) {
        return;
      }
      seen.add(row);
      rows.push({
        row,
        title: getChatTitleFromRow(row),
        unreadCount: parseUnreadCountFromBadge(badge || badgeOrRow)
      });
    };

    // Prefer searching inside known chat cells only
    const cells = pane.querySelectorAll('[data-testid="cell-frame-container"]');
    if (cells.length) {
      cells.forEach((cell) => {
        const badge =
          cell.querySelector('[aria-label*="unread" i]') ||
          cell.querySelector('[data-testid="icon-unread-count"]') ||
          cell.querySelector('[data-testid="unread-count"]') ||
          cell.querySelector('[data-testid="unread-mention-count"]');
        if (badge) {
          addRow(cell, badge);
          return;
        }

        // Numeric green pill inside this cell
        cell.querySelectorAll('span').forEach((el) => {
          const text = (el.textContent || '').trim();
          if (!/^\d{1,3}$/.test(text)) return;
          const rect = el.getBoundingClientRect();
          if (rect.width < 10 || rect.width > 36 || rect.height < 10 || rect.height > 36) return;
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
      const filterBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find((btn) => {
        const t = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`.toLowerCase();
        return t.includes('unread') && (btn.getAttribute('aria-pressed') === 'true' || btn.getAttribute('aria-selected') === 'true');
      });
      const limit = filterBtn ? cells.length : Math.min(cells.length, 3);
      Array.from(cells).slice(0, limit).forEach((cell) => addRow(cell, null));
    }

    return rows;
  }

  function createSidebar(forceRebuild = false) {
    // Kill any leftover loops from a previous injection/sidebar
    cancelAllSenderRuns();
    cancelAllReceiveRuns();

    const currentVersion = chrome.runtime.getManifest().version;
    const existingSidebar = document.getElementById('wa-cursor-sidebar');
    if (existingSidebar) {
      const isCurrent =
        existingSidebar.dataset.version === currentVersion &&
        existingSidebar.querySelector('.wa-tabs') &&
        existingSidebar.querySelector('#wa-not-available-url') &&
        existingSidebar.querySelector('#wa-receive-url') &&
        existingSidebar.querySelector('[data-tab="received"]') &&
        typeof existingSidebar.querySelector === 'function';
      if (!forceRebuild && isCurrent) {
        return existingSidebar;
      }
      existingSidebar.remove();
    }

    const apiSettings = loadApiSettings();
    const sidebar = document.createElement('div');
    sidebar.id = 'wa-cursor-sidebar';
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
        <button type="button" class="wa-tab active" data-tab="manual">Manual</button>
        <button type="button" class="wa-tab" data-tab="api">API</button>
        <button type="button" class="wa-tab" data-tab="received">Received</button>
      </div>
      <div class="wa-sidebar-content">
        <div class="wa-tab-panel" data-panel="manual">
          <label for="wa-numbers-input">Phone Numbers (comma-separated):</label>
          <textarea id="wa-numbers-input" placeholder="e.g. +1234567890, +1987654321"></textarea>
          <label for="wa-message-input">Message:</label>
          <textarea id="wa-message-input" placeholder="Enter your message"></textarea>
        </div>
        <div class="wa-tab-panel" data-panel="api" style="display:none;">
          <label for="wa-fetch-url">Fetch Message URL (GET):</label>
          <input type="text" id="wa-fetch-url" placeholder="http://localhost:5173/api/whatsapp_message/fetch-random?company_id=..." />
          <label for="wa-update-url">Mark Sent URL (GET):</label>
          <input type="text" id="wa-update-url" placeholder="http://localhost:5173/api/whatsapp_message/mark-sent/:id" />
          <label for="wa-not-available-url">Mark Not Available URL (GET):</label>
          <input type="text" id="wa-not-available-url" placeholder="http://localhost:5173/api/whatsapp_message/mark-not-available/:id" />
          <p class="wa-hint">All endpoints are GET. Use <code>:id</code> in mark URLs. Sent → mark-sent; send failed → mark-not-available.</p>
        </div>
        <div class="wa-tab-panel" data-panel="received" style="display:none;">
          <label for="wa-receive-url">Incoming Webhook URL (POST):</label>
          <input type="text" id="wa-receive-url" placeholder="http://localhost:5173/api/whatsapp_message/incoming" />
          <p class="wa-hint">Keep listening on. Captures real message bubbles from open chats (opens unread chats automatically). Chat-list previews are not posted.</p>
          <div id="wa-receive-status" class="wa-send-status"></div>
          <ul id="wa-received-list" class="wa-received-list"></ul>
          <button id="wa-start-listening" type="button">Start Listening</button>
          <button id="wa-stop-listening" type="button" style="display:none; background:#e74c3c; color:white;">Stop Listening</button>
        </div>
        <div id="wa-send-controls">
          <div style="display: flex; gap: 10px; margin-bottom: 10px;">
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
          <button id="wa-start-whatsapp-chat" data-label-manual="Start Sending Messages" data-label-api="Start">Start Sending Messages</button>
          <button id="wa-stop-whatsapp-chat" style="display:none; background:#e74c3c; color:white;">Stop</button>
        </div>
      </div>
    `;
    document.body.appendChild(sidebar);

    document.getElementById('wa-fetch-url').value = apiSettings.fetchUrl || '';
    document.getElementById('wa-update-url').value = apiSettings.updateUrl || '';
    document.getElementById('wa-not-available-url').value = apiSettings.notAvailableUrl || '';
    document.getElementById('wa-receive-url').value = apiSettings.receiveUrl || '';

    ['wa-fetch-url', 'wa-update-url', 'wa-not-available-url', 'wa-receive-url'].forEach((id) => {
      const input = document.getElementById(id);
      input.addEventListener('input', persistApiUrlsFromInputs);
      input.addEventListener('change', persistApiUrlsFromInputs);
      input.addEventListener('blur', persistApiUrlsFromInputs);
    });

    let stopSending = false;
    let stopListening = false;
    let activeTimeout = null;
    let activeTab = 'manual';
    let activeRunId = 0;
    let receiveRunId = 0;
    let openingUnread = false;
    const openFailCounts = new Map();
    const chatListState = new Map(); // title -> { preview, unread }
    const recentByChat = new Map(); // chatName -> [{ text, at, source }]
    let chatListSeeded = false;
    const seenIds = loadSeenIds();
    let postQueue = Promise.resolve();
    let scanDebounceTimer = null;

    function isActive() {
      return !stopSending && isSenderRunActive(activeRunId);
    }

    function isListening() {
      return !stopListening && isReceiveRunActive(receiveRunId);
    }

    function updateStartButtonLabel() {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      if (!startBtn) return;
      startBtn.textContent = activeTab === 'api'
        ? (startBtn.dataset.labelApi || 'Start')
        : (startBtn.dataset.labelManual || 'Start Sending Messages');
    }

    function updatePanelVisibility() {
      sidebar.querySelectorAll('.wa-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === activeTab);
      });
      sidebar.querySelectorAll('.wa-tab-panel').forEach((panel) => {
        panel.style.display = panel.dataset.panel === activeTab ? 'block' : 'none';
      });
      const sendControls = document.getElementById('wa-send-controls');
      if (sendControls) {
        sendControls.style.display = activeTab === 'received' ? 'none' : 'block';
      }
      updateStartButtonLabel();
    }

    function tabsLocked() {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      const listenBtn = document.getElementById('wa-start-listening');
      return !!(startBtn?.disabled || listenBtn?.disabled);
    }

    sidebar.querySelectorAll('.wa-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        if (tabsLocked()) return;
        activeTab = tabBtn.dataset.tab;
        updatePanelVisibility();
      });
    });

    updatePanelVisibility();

    function setRunning(running) {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      const stopBtn = document.getElementById('wa-stop-whatsapp-chat');
      const listenBtn = document.getElementById('wa-start-listening');
      if (!startBtn || !stopBtn) return;
      stopBtn.style.display = running ? 'inline-block' : 'none';
      startBtn.disabled = !!running;
      startBtn.setAttribute('aria-disabled', running ? 'true' : 'false');
      if (listenBtn && !isListening()) {
        listenBtn.disabled = !!running;
      }
      sidebar.querySelectorAll('.wa-tab').forEach((btn) => {
        btn.disabled = !!(running || isListening());
      });
      if (!running) {
        updateStartButtonLabel();
      }
    }

    function setListeningUi(running) {
      const startBtn = document.getElementById('wa-start-listening');
      const stopBtn = document.getElementById('wa-stop-listening');
      const sendStart = document.getElementById('wa-start-whatsapp-chat');
      if (!startBtn || !stopBtn) return;
      stopBtn.style.display = running ? 'inline-block' : 'none';
      startBtn.disabled = !!running;
      startBtn.style.display = running ? 'none' : 'inline-block';
      if (sendStart && !isActive()) {
        sendStart.disabled = !!running;
      }
      sidebar.querySelectorAll('.wa-tab').forEach((btn) => {
        btn.disabled = !!(running || isActive());
      });
    }

    function setSendStatus(text) {
      // Ignore status updates from cancelled/old runs
      if (!isActive() && text !== 'Stopped.') return;
      const status = document.getElementById('wa-send-status');
      if (status) {
        status.textContent = text;
      }
    }

    function setReceiveStatus(text) {
      if (!isListening() && text !== 'Stopped listening.' && text !== 'Listening stopped.') return;
      const status = document.getElementById('wa-receive-status');
      if (status) {
        status.textContent = text;
      }
    }

    function prependReceivedItem(payload, postState) {
      const list = document.getElementById('wa-received-list');
      if (!list) return;

      const li = document.createElement('li');
      li.className = 'wa-received-item';
      li.dataset.messageId = payload.messageId;

      const time = new Date(payload.receivedAt);
      const timeLabel = Number.isNaN(time.getTime())
        ? ''
        : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const fromLabel = payload.from
        ? `${payload.chatName} (${payload.from})`
        : payload.chatName;

      li.innerHTML = `
        <div class="wa-received-meta">
          <span class="wa-received-from" title="${fromLabel.replace(/"/g, '&quot;')}">${fromLabel}</span>
          <span class="wa-received-time">${timeLabel}</span>
        </div>
        <div class="wa-received-text"></div>
        <div class="wa-received-posted"></div>
      `;
      li.querySelector('.wa-received-text').textContent = payload.text;

      const postedEl = li.querySelector('.wa-received-posted');
      if (postState === 'ok') {
        postedEl.textContent = 'Posted to webhook';
      } else if (postState === 'skip') {
        postedEl.textContent = 'Saved locally (no webhook URL)';
      } else if (postState?.error) {
        postedEl.classList.add('error');
        postedEl.textContent = `Post failed: ${postState.error}`;
      } else {
        postedEl.textContent = 'Posting...';
      }

      list.prepend(li);
      while (list.children.length > MAX_LIST_ITEMS) {
        list.removeChild(list.lastChild);
      }
      return li;
    }

    function updateReceivedItemStatus(messageId, postState) {
      const li = document.querySelector(`#wa-received-list [data-message-id="${CSS.escape(messageId)}"]`);
      if (!li) return;
      const postedEl = li.querySelector('.wa-received-posted');
      if (!postedEl) return;
      postedEl.classList.remove('error');
      if (postState === 'ok') {
        postedEl.textContent = 'Posted to webhook';
      } else if (postState === 'skip') {
        postedEl.textContent = 'Saved locally (no webhook URL)';
      } else if (postState?.error) {
        postedEl.classList.add('error');
        postedEl.textContent = `Post failed: ${postState.error}`;
      }
    }

    async function handleIncomingPayload(payload) {
      if (!payload?.messageId || !payload?.text) return;
      // Never accept chat-list scrapes as message bodies (icons/unread bleed)
      if (payload.source === 'chat-list') return;

      payload.text = normalizeMessageText(payload.text);
      if (!payload.text || isGarbageMessageText(payload.text)) return;
      if (seenIds.has(payload.messageId)) return;

      const chatKey = payload.chatName || payload.from || 'unknown';
      const now = Date.now();
      const recent = (recentByChat.get(chatKey) || []).filter((item) => now - item.at < 90000);

      // Drop duplicates like conversation "Ass" + polluted "Ass1ic-expand-more"
      if (recent.some((item) => textsAreSameMessage(item.text, payload.text))) {
        recentByChat.set(chatKey, recent);
        return;
      }

      recent.push({ text: payload.text, at: now, source: payload.source || 'unknown' });
      recentByChat.set(chatKey, recent.slice(-20));

      seenIds.add(payload.messageId);
      saveSeenIds(seenIds);

      const receiveUrl = document.getElementById('wa-receive-url')?.value.trim() || '';
      prependReceivedItem(payload, receiveUrl ? 'pending' : 'skip');
      setReceiveStatus(`New from ${payload.chatName || payload.from || 'chat'}`);

      if (!receiveUrl) return;

      postQueue = postQueue.then(async () => {
        if (!isListening()) return;
        try {
          await apiRequest('POST', receiveUrl, payload);
          updateReceivedItemStatus(payload.messageId, 'ok');
        } catch (err) {
          updateReceivedItemStatus(payload.messageId, {
            error: err.message || 'Request failed'
          });
        }
      });
    }

    function scanForIncomingMessages(root, options = {}) {
      if (!isListening()) return;
      const { onlyNewest = 0, markOnly = false } = options;
      let nodes = findIncomingMessageRoots(root || document.querySelector('#main') || document);
      if (onlyNewest > 0 && nodes.length > onlyNewest) {
        nodes = nodes.slice(-onlyNewest);
      }

      // When opening a chat, mark older visible bubbles as seen so we don't POST history
      if (onlyNewest > 0) {
        const all = findIncomingMessageRoots(document.querySelector('#main') || document);
        const keep = new Set(nodes);
        all.forEach((node) => {
          if (keep.has(node)) return;
          const payload = extractIncomingPayload(node);
          if (payload?.messageId) {
            seenIds.add(payload.messageId);
          }
        });
        saveSeenIds(seenIds);
      }

      nodes.forEach((node) => {
        const payload = extractIncomingPayload(node);
        if (!payload) return;
        if (markOnly) {
          seenIds.add(payload.messageId);
          return;
        }
        handleIncomingPayload(payload);
      });
      if (markOnly) saveSeenIds(seenIds);
    }

    function scheduleConversationScan() {
      if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(() => {
        scanDebounceTimer = null;
        if (!isListening()) return;
        if (isConversationOpen()) {
          scanForIncomingMessages(document.querySelector('#main') || document);
        }
      }, 200);
    }

    function seedChatListState() {
      const pane = findChatListPane();
      if (!pane) return;
      const cells = pane.querySelectorAll('[data-testid="cell-frame-container"]');
      cells.forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;
        chatListState.set(title, {
          preview: getPreviewFromRow(cell),
          unread: getUnreadCountFromCell(cell)
        });
      });
      chatListSeeded = true;
    }

    function scanChatListForRuntimeIncoming() {
      if (!isListening()) return;
      const pane = findChatListPane();
      if (!pane) return;

      if (!chatListSeeded) {
        seedChatListState();
        return;
      }

      // Chat list is only a signal to open unread chats.
      // Never POST preview text (it mixes unread badges + icon ligatures like "1ic-expand-more").
      const cells = pane.querySelectorAll('[data-testid="cell-frame-container"]');
      cells.forEach((cell) => {
        const title = getChatTitleFromRow(cell);
        if (!title) return;

        const preview = getPreviewFromRow(cell);
        const unread = getUnreadCountFromCell(cell);
        chatListState.set(title, { preview, unread });
      });
    }

    function getUnreadCountFromRow(row) {
      return getUnreadCountFromCell(row);
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

    async function openNextUnreadChat() {
      if (!isListening() || openingUnread) return;
      const items = findUnreadChatRows();
      if (!items.length) return;

      const item = items.find((entry) => {
        const key = entry.title || 'unknown';
        return (openFailCounts.get(key) || 0) < 3;
      }) || items[0];

      const title = item.title || 'chat';
      const unreadCount = item.unreadCount || getUnreadCountFromRow(item.row) || 1;

      openingUnread = true;
      try {
        setReceiveStatus(`Opening: ${title}...`);
        simulateUserClick(item.row);

        await sleep(400);
        if (!isConversationOpen()) {
          const titleEl =
            item.row.querySelector('[data-testid="cell-frame-title"]') ||
            item.row.querySelector('span[title]') ||
            item.row;
          simulateUserClick(titleEl);
        }

        const opened = await waitForConversation(8000);
        if (!isListening()) return;

        if (!opened) {
          const fails = (openFailCounts.get(title) || 0) + 1;
          openFailCounts.set(title, fails);
          setReceiveStatus(`Could not open "${title}" (try ${fails}/3). Still watching chat list...`);
          await sleep(800);
          return;
        }

        openFailCounts.delete(title);
        setReceiveStatus(`Reading messages from ${title}...`);
        await sleep(500);
        scanForIncomingMessages(document.querySelector('#main') || document, {
          onlyNewest: unreadCount
        });
        if (isListening()) {
          setReceiveStatus('Listening for incoming messages...');
        }
      } catch (err) {
        setReceiveStatus(`Open failed: ${err.message || 'unknown error'}`);
        await sleep(800);
      } finally {
        openingUnread = false;
      }
    }

    function startReceiveObservers() {
      const target = document.querySelector('#app') || document.body;

      const observer = new MutationObserver(() => {
        if (!isListening()) return;
        scheduleConversationScan();
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false
      });
      window.__waReceiveObserver = observer;

      // Fast poll: open chat bubbles + chat-list preview changes
      window.__waReceivePollTimer = setInterval(() => {
        if (!isListening()) return;

        if (isConversationOpen()) {
          scanForIncomingMessages(document.querySelector('#main') || document);
        }

        scanChatListForRuntimeIncoming();

        // Opportunistically open unread chats (does not block list watching)
        if (!openingUnread) {
          openNextUnreadChat();
        }
      }, 1200);
    }

    async function startListening() {
      const receiveUrl = document.getElementById('wa-receive-url')?.value.trim() || '';
      if (receiveUrl && !/^https?:\/\//i.test(receiveUrl)) {
        alert('Incoming webhook URL must start with http:// or https://');
        return;
      }

      persistApiUrlsFromInputs();
      stopListening = false;
      receiveRunId = beginReceiveRun();
      openFailCounts.clear();
      chatListState.clear();
      recentByChat.clear();
      chatListSeeded = false;
      setListeningUi(true);
      setReceiveStatus('Listening for incoming messages...');

      startReceiveObservers();
      // Seed current chat-list + open-chat state so we only capture NEW runtime messages
      seedChatListState();
      scanForIncomingMessages(document.querySelector('#main') || document, { markOnly: true });
      setReceiveStatus('Listening… send a WhatsApp message to test');
    }

    function stopReceiveListening(statusText = 'Stopped listening.') {
      stopListening = true;
      cancelAllReceiveRuns();
      setListeningUi(false);
      const status = document.getElementById('wa-receive-status');
      if (status) status.textContent = statusText;
    }

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
      setSendStatus('Sending...');
      return true;
    }

    function findSendButton() {
      return (
        document.querySelector('[data-icon="send"]')?.closest('button') ||
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
      let anchor = document.getElementById('wa-hidden-link');
      if (anchor) anchor.remove();
      anchor = document.createElement('a');
      anchor.href = waUrl;
      anchor.id = 'wa-hidden-link';
      anchor.style.display = 'none';
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
      setSendStatus(sent ? `Sent to ${number}` : `Send button not found for ${number}`);
      console.log(sent ? `Message sent to ${number}` : `Send button not found for ${number}`);
      return sent;
    }

    async function waitBeforeNext(minDelay, maxDelay) {
      const waitMs = 1000 + getRandomDelay(minDelay, maxDelay);
      return countdownSeconds(Math.ceil(waitMs / 1000), (remaining) => `Next message in ${remaining}s`);
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

        const readyForNext = await waitBeforeNext(state.minDelay, state.maxDelay);
        if (!readyForNext) {
          clearQueue();
          setRunning(false);
          return;
        }
      }

      clearQueue();
      setRunning(false);
      if (isActive()) {
        setSendStatus('All messages sent.');
      }
    }

    async function processApiQueue(state) {
      while (isActive()) {
        saveQueue(state);
        setSendStatus('Fetching next message...');

        let payload = null;
        try {
          payload = await apiRequest('GET', state.fetchUrl);
        } catch (err) {
          if (!isActive()) break;
          const msg = err.message || 'Fetch failed';
          const readyToRetry = await countdownSeconds(
            Math.ceil((1000 + getRandomDelay(state.minDelay, state.maxDelay)) / 1000),
            (remaining) => `${msg}. Retrying in ${remaining}s`
          );
          if (!readyToRetry) break;
          continue;
        }

        if (!isActive()) break;

        const item = payload?.data;
        if (!payload?.success || !item?._id || !item?.number || !item?.message) {
          if (!isActive()) break;
          const readyToRetry = await countdownSeconds(
            Math.ceil((1000 + getRandomDelay(state.minDelay, state.maxDelay)) / 1000),
            (remaining) => `No messages found. Retrying in ${remaining}s`
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
            setSendStatus('Updating message status...');
            const updateUrl = buildIdUrl(state.updateUrl, item._id);
            await apiRequest('GET', updateUrl);
            if (!isActive()) break;
            setSendStatus(`Sent & marked: ${item.number}`);
          } catch (err) {
            if (!isActive()) break;
            const msg = err.message || 'Update failed';
            setSendStatus(`Sent, but mark-sent failed: ${msg}`);
            clearQueue();
            setRunning(false);
            return;
          }
        } else {
          try {
            setSendStatus(`Marking ${item.number} as not available...`);
            const notAvailableUrl = buildIdUrl(state.notAvailableUrl, item._id);
            await apiRequest('GET', notAvailableUrl);
            if (!isActive()) break;
            setSendStatus(`Marked not available: ${item.number}`);
          } catch (err) {
            if (!isActive()) break;
            const msg = err.message || 'Not-available update failed';
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

        const readyForNext = await waitBeforeNext(state.minDelay, state.maxDelay);
        if (!readyForNext) break;
      }

      clearQueue();
      setRunning(false);
    }

    async function startManualSending() {
      const numbersInput = document.getElementById('wa-numbers-input').value;
      const messageInput = document.getElementById('wa-message-input').value;
      const minDelay = parseInt(document.getElementById('wa-min-delay').value, 10) || 2;
      const maxDelay = parseInt(document.getElementById('wa-max-delay').value, 10) || 12;

      if (!numbersInput.trim() || !messageInput.trim()) {
        alert('Please enter valid numbers and message.');
        return;
      }
      if (minDelay > maxDelay) {
        alert('Min delay should be less than or equal to max delay.');
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
        mode: 'manual',
        numbers,
        message: messageInput,
        minDelay,
        maxDelay,
        index: 0
      };
      saveQueue(state);
      await processManualQueue(state);
    }

    async function startApiSending() {
      const fetchUrl = document.getElementById('wa-fetch-url').value.trim();
      const updateUrl = document.getElementById('wa-update-url').value.trim();
      const notAvailableUrl = document.getElementById('wa-not-available-url').value.trim();
      const minDelay = parseInt(document.getElementById('wa-min-delay').value, 10) || 2;
      const maxDelay = parseInt(document.getElementById('wa-max-delay').value, 10) || 12;

      if (!fetchUrl || !updateUrl || !notAvailableUrl) {
        alert('Please enter Fetch, Mark Sent, and Mark Not Available API URLs.');
        return;
      }
      if (!/^https?:\/\//i.test(fetchUrl) || !/^https?:\/\//i.test(updateUrl) || !/^https?:\/\//i.test(notAvailableUrl)) {
        alert('All API URLs must start with http:// or https://');
        return;
      }
      if (minDelay > maxDelay) {
        alert('Min delay should be less than or equal to max delay.');
        return;
      }

      saveApiSettings(fetchUrl, updateUrl, notAvailableUrl);
      stopSending = false;
      activeRunId = beginSenderRun();
      setRunning(true);
      setSendStatus('Starting...');

      const state = {
        mode: 'api',
        fetchUrl,
        updateUrl,
        notAvailableUrl,
        minDelay,
        maxDelay
      };
      saveQueue(state);
      try {
        await processApiQueue(state);
      } catch (err) {
        clearQueue();
        setRunning(false);
        setSendStatus(err.message || 'Something went wrong');
        alert(`Start failed.\n\n${err.message || 'Unknown error'}`);
      }
    }

    document.getElementById('wa-start-whatsapp-chat').addEventListener('click', () => {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      if (startBtn.disabled) return;
      if (isListening()) {
        alert('Stop listening before sending messages.');
        return;
      }

      const activeBtn = sidebar.querySelector('.wa-tab.active');
      activeTab = activeBtn?.dataset.tab || activeTab;
      updatePanelVisibility();

      if (activeTab === 'api') {
        startApiSending().catch((err) => {
          clearQueue();
          setRunning(false);
          setSendStatus(err.message || 'Start failed');
          alert(`Start failed.\n\n${err.message || 'Unknown error'}`);
        });
      } else {
        startManualSending().catch((err) => {
          clearQueue();
          setRunning(false);
          setSendStatus(err.message || 'Start failed');
          alert(`Start failed.\n\n${err.message || 'Unknown error'}`);
        });
      }
    });

    document.getElementById('wa-stop-whatsapp-chat').addEventListener('click', () => {
      stopSending = true;
      cancelAllSenderRuns(); // invalidates every in-flight countdown/loop
      if (activeTimeout) clearTimeout(activeTimeout);
      clearQueue();
      setRunning(false);
      const status = document.getElementById('wa-send-status');
      if (status) status.textContent = 'Stopped.';
    });

    document.getElementById('wa-start-listening').addEventListener('click', () => {
      const btn = document.getElementById('wa-start-listening');
      if (btn.disabled) return;
      if (isActive()) {
        alert('Stop sending before listening for messages.');
        return;
      }
      startListening().catch((err) => {
        stopReceiveListening('Listening failed.');
        alert(`Listen failed.\n\n${err.message || 'Unknown error'}`);
      });
    });

    document.getElementById('wa-stop-listening').addEventListener('click', () => {
      stopReceiveListening();
    });

    document.getElementById('wa-sidebar-close').onclick = () => {
      sidebar.style.display = 'none';
    };

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'wa-start-sending-from-socket') {
        const startBtn = document.getElementById('wa-start-whatsapp-chat');
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
      if (pending.mode === 'api') {
        activeTab = 'api';
        updatePanelVisibility();
        sleep(2500).then(async () => {
          // Resume mid-send if chat was opened before reload
          if (pending.currentId && pending.currentNumber && pending.currentMessage) {
            const sent = await sendOneMessage(pending.currentNumber, pending.currentMessage);
            if (!stopSending) {
              try {
                if (sent) {
                  setSendStatus('Updating message status...');
                  await apiRequest('GET', buildIdUrl(pending.updateUrl, pending.currentId));
                } else {
                  setSendStatus(`Marking ${pending.currentNumber} as not available...`);
                  await apiRequest('GET', buildIdUrl(pending.notAvailableUrl, pending.currentId));
                  setSendStatus(`Marked not available: ${pending.currentNumber}`);
                }
              } catch (err) {
                setSendStatus(sent
                  ? `Sent, but update failed: ${err.message}. Continuing...`
                  : `Not-available update failed: ${err.message}. Continuing...`);
              }
            }
            delete pending.currentId;
            delete pending.currentNumber;
            delete pending.currentMessage;
            saveQueue(pending);
            if (!stopSending) {
              const ready = await waitBeforeNext(pending.minDelay, pending.maxDelay);
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

    return sidebar;
  }

  function showSidebar() {
    const sidebar = createSidebar();
    sidebar.style.display = 'flex';
  }

  function toggleSidebar() {
    const existing = document.getElementById('wa-cursor-sidebar');
    if (!existing) {
      showSidebar();
      return;
    }
    existing.style.display = existing.style.display === 'none' ? 'flex' : 'none';
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
    if (message?.type === 'wa-toggle-sidebar') {
      toggleSidebar();
    } else if (message?.type === 'wa-show-sidebar') {
      showSidebar();
    } else if (message?.type === 'wa-start-sending') {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      if (startBtn && !startBtn.disabled) {
        startBtn.click();
      }
    }
  };

  chrome.runtime.onMessage.addListener(window.__waSidebarOnMessage);
})();
