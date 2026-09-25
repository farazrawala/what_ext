/** Cookie names — must match ai-pos `src/utils/authCookie.js`. */
const POS_TOKEN_COOKIE = 'pos_auth_token';
const POS_COMPANY_COOKIE = 'pos_company_id';
const POS_COMPANY_NAME_COOKIE = 'pos_company_name';

function getWaEnv() {
  try {
    if (typeof WA_ENV !== 'undefined' && WA_ENV) return WA_ENV;
  } catch (_) {}
  try {
    if (typeof self !== 'undefined' && self.WA_ENV) return self.WA_ENV;
  } catch (_) {}
  try {
    if (typeof window !== 'undefined' && window.WA_ENV) return window.WA_ENV;
  } catch (_) {}
  return {
    name: 'local',
    label: 'Local',
    posOrigin: 'http://localhost:8000',
    posUrl: 'http://localhost:8000/',
    chatApiPath: '/api/chat',
    preferredHosts: ['http://localhost:8000', 'http://127.0.0.1:8000'],
    posTabMatch: ['http://localhost:8000/*', 'http://127.0.0.1:8000/*'],
  };
}

/** Known POS hosts to probe for auth cookies (order = preference). */
const PREFERRED_POS_HOSTS = getWaEnv().preferredHosts || [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

/** Paths to try when reading cookies for a host (Path=/pos cookies need /pos/). */
const COOKIE_PATH_TRIES = ['/pos/', '/pos', '/'];

function decodeCookieValue(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Origin used for host resolution — protocol + host only. */
function normalizeApiOrigin(urlOrOrigin) {
  try {
    const u = new URL(urlOrOrigin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(urlOrOrigin || '')
      .replace(/\/pos\/?$/i, '')
      .replace(/\/+$/, '');
  }
}

/**
 * Chat API base path from active WA_ENV (or host heuristics as fallback).
 * Live: /pos_admin/api/chat — Local: /api/chat
 */
function resolveChatApiBase(origin) {
  const env = getWaEnv();
  const fallbackOrigin = env.posOrigin || 'http://localhost:8000';
  const base = normalizeApiOrigin(origin || fallbackOrigin);
  const chatPath = String(env.chatApiPath || '/api/chat').replace(/\/$/, '');

  try {
    const envHost = new URL(normalizeApiOrigin(env.posOrigin || fallbackOrigin))
      .host;
    const baseHost = new URL(base).host;
    if (envHost && baseHost === envHost) {
      return `${base}${chatPath}`;
    }
  } catch (_) {}

  let host = '';
  try {
    host = new URL(base).hostname;
  } catch (_) {}
  if (/websitedemolynk\.com$/i.test(host)) {
    return `${base}/pos_admin/api/chat`;
  }
  return `${base}/api/chat`;
}

/** True if a tab URL belongs to a known POS host for this env. */
function isPosTabUrl(url) {
  const raw = String(url || '');
  if (!raw) return false;
  const env = getWaEnv();
  const hosts = env.preferredHosts || PREFERRED_POS_HOSTS;
  for (const host of hosts) {
    try {
      const origin = normalizeApiOrigin(host);
      if (raw.startsWith(origin + '/') || raw === origin) return true;
    } catch (_) {}
  }
  return (
    /https:\/\/testv3\.websitedemolynk\.com\//i.test(raw) ||
    /http:\/\/localhost:8000\//i.test(raw) ||
    /http:\/\/127\.0\.0\.1:8000\//i.test(raw) ||
    /http:\/\/localhost:5173\//i.test(raw) ||
    /http:\/\/127\.0\.0\.1:5173\//i.test(raw)
  );
}

function cookieMapFromList(cookies) {
  const map = new Map();
  (cookies || []).forEach((c) => {
    if (c?.name && !map.has(c.name)) map.set(c.name, c.value || '');
  });
  return map;
}

function authFromCookieMap(map) {
  const token = decodeCookieValue(
    map.get(POS_TOKEN_COOKIE) ||
      map.get('authToken') ||
      map.get('token') ||
      map.get('accessToken') ||
      '',
  );
  const companyId = decodeCookieValue(
    map.get(POS_COMPANY_COOKIE) ||
      map.get('companyId') ||
      map.get('company_id') ||
      '',
  );
  const companyName = decodeCookieValue(
    map.get(POS_COMPANY_NAME_COOKIE) ||
      map.get('companyName') ||
      map.get('userName') ||
      '',
  );
  return { token, companyId, companyName };
}

async function readCookiesFromUrl(url) {
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) {
    return { token: '', companyId: '', companyName: '' };
  }
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return authFromCookieMap(cookieMapFromList(cookies));
  } catch {
    return { token: '', companyId: '', companyName: '' };
  }
}

/**
 * Domain-wide lookup — finds cookies even when Path is /pos or host-only.
 */
async function readCookiesFromDomain(hostname) {
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll || !hostname) {
    return { token: '', companyId: '', companyName: '' };
  }
  try {
    const host = String(hostname).replace(/^\./, '');
    const variants = [host, `.${host}`];
    // Also try parent domain (e.g. .websitedemolynk.com)
    const parts = host.split('.');
    if (parts.length > 2) {
      variants.push(parts.slice(1).join('.'), `.${parts.slice(1).join('.')}`);
    }

    const merged = new Map();
    for (const domain of variants) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        cookies.forEach((c) => {
          if (c?.name && !merged.has(c.name)) merged.set(c.name, c.value || '');
        });
      } catch (_) {}
    }
    return authFromCookieMap(merged);
  } catch {
    return { token: '', companyId: '', companyName: '' };
  }
}

async function readCookiesForHost(baseHostUrl) {
  const apiOrigin = normalizeApiOrigin(baseHostUrl);
  let host = '';
  try {
    host = new URL(apiOrigin).hostname;
  } catch (_) {}

  // 1) Domain scan (most reliable for Path=/pos HttpOnly cookies)
  if (host) {
    const byDomain = await readCookiesFromDomain(host);
    if (byDomain.token) return { ...byDomain, origin: apiOrigin };
  }

  // 2) URL probes including /pos paths
  for (const p of COOKIE_PATH_TRIES) {
    const url = `${apiOrigin}${p}`;
    const byUrl = await readCookiesFromUrl(url);
    if (byUrl.token) return { ...byUrl, origin: apiOrigin };
  }

  return { token: '', companyId: '', companyName: '', origin: apiOrigin };
}

/**
 * Live AI POS stores auth in localStorage (authToken, companyData, userData),
 * not cookies. Prefer chrome.storage cache (filled by posBridge.js), then
 * inject a self-contained reader into open POS tabs.
 */
const POS_AUTH_STORAGE_KEY = 'wa_pos_auth_cache';

/** Must stay self-contained — Chrome serializes this into the page; no outer refs. */
function extractPosAuthFromPageStorageInline() {
  function pick() {
    for (var i = 0; i < arguments.length; i += 1) {
      var v = localStorage.getItem(arguments[i]);
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  var token = pick(
    'authToken',
    'pos_auth_token',
    'token',
    'accessToken',
    'access_token',
  );
  if (!token) return { token: '', companyId: '', companyName: '' };

  var companyId = pick('pos_company_id', 'companyId', 'company_id');
  var companyName = pick(
    'pos_company_name',
    'companyName',
    'company_name',
    'userName',
  );

  try {
    var company = JSON.parse(localStorage.getItem('companyData') || '{}');
    if (!companyId) companyId = String(company._id || company.id || '').trim();
    if (!companyName) {
      companyName = String(
        company.name || company.company_name || company.companyName || '',
      ).trim();
    }
  } catch (e) {}

  try {
    var user = JSON.parse(localStorage.getItem('userData') || '{}');
    if (!companyName) {
      companyName = String(user.name || user.full_name || user.email || '').trim();
    }
    if (!companyId) {
      var nested =
        user.company && typeof user.company === 'object'
          ? user.company._id || user.company.id
          : '';
      companyId = String(
        user.company_id || user.companyId || nested || '',
      ).trim();
    }
  } catch (e2) {}

  return { token: token, companyId: companyId, companyName: companyName };
}

async function readAuthFromStorageCache() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) return null;
  try {
    const data = await chrome.storage.local.get(POS_AUTH_STORAGE_KEY);
    const auth = data?.[POS_AUTH_STORAGE_KEY];
    if (!auth?.token) return null;
    if (auth.updatedAt && Date.now() - Number(auth.updatedAt) > 86400000) {
      return null;
    }
    return {
      token: auth.token,
      companyId: auth.companyId || '',
      companyName: auth.companyName || '',
      origin: normalizeApiOrigin(auth.origin || PREFERRED_POS_HOSTS[0]),
      authenticated: true,
      source: 'storage',
    };
  } catch (_) {
    return null;
  }
}

async function readAuthFromPosTabs() {
  if (
    typeof chrome === 'undefined' ||
    !chrome.tabs?.query ||
    !chrome.scripting?.executeScript
  ) {
    return null;
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn('[WA] POS tab query failed →', err?.message || err);
    return null;
  }

  tabs = tabs.filter((tab) => isPosTabUrl(tab.url));

  const env = getWaEnv();
  const preferLive = env.name === 'live';
  tabs.sort((a, b) => {
    const aLive = /websitedemolynk\.com/i.test(a.url || '') ? 0 : 1;
    const bLive = /websitedemolynk\.com/i.test(b.url || '') ? 0 : 1;
    return preferLive ? aLive - bLive : bLive - aLive;
  });

  for (const tab of tabs) {
    if (!tab?.id) continue;
    try {
      // Use a plain file inject — survives extension obfuscation builds
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['posInject.js'],
      });
      // posInject posts wa-pos-auth-sync; give SW a moment then read cache
      await new Promise((r) => setTimeout(r, 150));
      const cached = await readAuthFromStorageCache();
      if (cached?.authenticated) {
        console.log('[WA] POS auth via posInject →', {
          origin: cached.origin,
          tabId: tab.id,
        });
        return cached;
      }
    } catch (err) {
      console.warn('[WA] POS localStorage read failed →', {
        tabId: tab.id,
        url: tab.url,
        error: err?.message || String(err),
      });
    }
  }
  return null;
}

/**
 * Read POS auth from storage cache, open POS tab localStorage, or cookies.
 * Live testv3 uses localStorage authToken (not cookies).
 * @returns {{ token: string, companyId: string, companyName: string, origin: string, authenticated: boolean }}
 */
async function readPosAuth(apiUrl) {
  const fromStorage = await readAuthFromStorageCache();
  if (fromStorage?.authenticated) {
    console.log('[WA] POS auth from storage cache →', fromStorage.origin);
    return fromStorage;
  }

  const fromTab = await readAuthFromPosTabs();
  if (fromTab?.authenticated) return fromTab;

  const candidates = [];
  const seen = new Set();

  const pushHost = (value) => {
    const origin = normalizeApiOrigin(value);
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    candidates.push(origin);
  };

  PREFERRED_POS_HOSTS.forEach(pushHost);
  try {
    pushHost(apiUrl);
  } catch (_) {}

  let best = null;
  for (const origin of candidates) {
    const auth = await readCookiesForHost(origin);
    if (!auth.token) continue;
    const isLive = /websitedemolynk\.com$/i.test(
      (() => {
        try {
          return new URL(origin).hostname;
        } catch {
          return origin;
        }
      })(),
    );
    if (isLive) {
      console.log('[WA] POS auth from live cookie host →', origin);
      return {
        token: auth.token,
        companyId: auth.companyId,
        companyName: auth.companyName,
        origin,
        authenticated: true,
        source: 'cookie',
      };
    }
    if (!best) {
      best = {
        token: auth.token,
        companyId: auth.companyId,
        companyName: auth.companyName,
        origin,
        authenticated: true,
        source: 'cookie',
      };
    }
  }

  if (best) {
    console.log('[WA] POS auth from cookie host →', best.origin);
    return best;
  }

  const tipUrl = getWaEnv().posUrl || 'http://localhost:8000/';
  console.warn(
    '[WA] POS auth: no authToken/localStorage or pos_auth_token cookie found',
    {
      tried: candidates,
      tip: `Keep ${tipUrl} open while logged in, then reload the extension and refresh the POS tab`,
    },
  );
  return {
    token: '',
    companyId: '',
    companyName: '',
    origin: candidates[0] || '',
    authenticated: false,
  };
}

function formatCompanyDisplayName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*\([^)]*@[^)]*\)\s*/gi, '')
    .trim();
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function phoneFromChatId(chatId) {
  const raw = String(chatId || '');
  const cUs = raw.match(/^(\d+)@c\.us$/i);
  if (cUs) return cUs[1];
  // Some builds embed the peer number before @lid / other suffixes
  const beforeAt = raw.split('@')[0] || '';
  if (/^\d{8,15}$/.test(beforeAt)) return beforeAt;
  return '';
}

function buildChatCreateBody(incoming) {
  const from =
    digitsOnly(incoming.from) ||
    phoneFromChatId(incoming.chatId) ||
    digitsOnly(incoming.chatName) ||
    '';
  const to =
    digitsOnly(incoming.to) ||
    digitsOnly(incoming.myNumber) ||
    digitsOnly(incoming.to_user_id) ||
    '';

  return {
    from_user_id: from || 'unknown',
    to_user_id: to || 'unknown',
    message: incoming.text || '',
    message_id: incoming.messageId || '',
    whatsapp_time:
      incoming.whatsapp_time ||
      incoming.receivedAt ||
      incoming.whatsappTime ||
      '',
  };
}

function extractApiErrorMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') {
    const raw = data.trim();
    if (/^</.test(raw) || /<html[\s>]/i.test(raw)) {
      const title = raw.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
      const h1 = raw.match(/<h1>([^<]*)<\/h1>/i)?.[1]?.trim();
      return title || h1 || 'HTML error page';
    }
    return raw.slice(0, 300);
  }
  const direct = data.message || data.error || data.detail;
  let text = direct ? String(direct) : '';
  if (!text && Array.isArray(data.errors)) {
    text = data.errors
      .map((entry) =>
        typeof entry === 'string' ? entry : entry?.message || JSON.stringify(entry)
      )
      .join('; ');
  } else if (!text && data.errors && typeof data.errors === 'object') {
    text = Object.entries(data.errors)
      .map(([key, value]) => {
        const part = Array.isArray(value) ? value.join(', ') : String(value);
        return `${key}: ${part}`;
      })
      .join('; ');
  } else if (!text && data.raw) {
    const raw = String(data.raw).trim();
    if (/^</.test(raw) || /<html[\s>]/i.test(raw)) {
      const title = raw.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
      const h1 = raw.match(/<h1>([^<]*)<\/h1>/i)?.[1]?.trim();
      text = title || h1 || 'HTML error page';
    } else {
      text = raw.slice(0, 300);
    }
  }
  // Backend 404s may include received_id so we can see what the worker sent
  const receivedId = data.received_id ?? data.receivedId;
  if (receivedId != null && String(receivedId).trim()) {
    const rid = String(receivedId).trim();
    text = text ? `${text} (received_id=${rid})` : `received_id=${rid}`;
  }
  return text;
}

function formatApiErrorInfo(response = {}) {
  const status = response.status;
  const url = response.url || '';
  const detail = extractApiErrorMessage(response.data) || response.error || '';
  const summary =
    [status ? `HTTP ${status}` : '', detail].filter(Boolean).join(' — ') ||
    'Request failed';
  const tooltip = [summary, url].filter(Boolean).join('\n');
  return { summary, detail, status, url, tooltip };
}

function buildReceivePostUrl(template, token) {
  const base = String(template || '').trim();
  if (!base || !token) return '';
  if (base.includes(':pos_auth_token')) {
    return base.replace(/:pos_auth_token/g, encodeURIComponent(token));
  }
  if (base.includes(':token')) {
    return base.replace(/:token/g, encodeURIComponent(token));
  }
  if (/\/chats?\/create\/?$/i.test(base)) {
    return `${base.replace(/\/?$/, '/')}${encodeURIComponent(token)}`;
  }
  return base;
}

function buildDefaultApiUrls(origin, companyId) {
  const apiBase = resolveChatApiBase(origin);
  const q = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
  return {
    fetchUrl: `${apiBase}/fetch-random${q}`,
    updateUrl: `${apiBase}/mark-sent/:id`,
    notAvailableUrl: `${apiBase}/mark-not-available/:id`,
    receiveUrl: `${apiBase}/create/:token`,
  };
}

/**
 * Chat document id for mark-sent / mark-not-available.
 * Prefer data._id from fetch-random — never message_id / whatsapp_message_id.
 */
function extractChatDocumentId(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const candidates = [raw._id, raw.id];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    if (typeof value === 'object') {
      const oid = value.$oid || value.oid || value.id;
      if (oid != null && String(oid).trim()) return String(oid).trim();
      if (typeof value.toHexString === 'function') {
        try {
          const hex = value.toHexString();
          if (hex) return String(hex).trim();
        } catch (_) {}
      }
      continue;
    }
    const s = String(value).trim();
    // Reject placeholder / accidental bad ids
    if (!s || s === ':id' || s === 'undefined' || s === 'null') continue;
    if (s === '[object Object]') continue;
    return s;
  }
  return '';
}

function normalizeChatQueueItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = extractChatDocumentId(raw);
  const message = raw.message || raw.text || raw.body || '';
  const number =
    raw.number ||
    raw.phone ||
    raw.to_user_id ||
    raw.toUserId ||
    raw.recipient ||
    '';
  if (!id || !message || !number) return null;
  return { _id: id, number: String(number), message: String(message) };
}

// Service worker (background.js)
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.readPosAuth = readPosAuth;
  self.buildDefaultApiUrls = buildDefaultApiUrls;
  self.buildChatCreateBody = buildChatCreateBody;
  self.buildReceivePostUrl = buildReceivePostUrl;
  self.formatApiErrorInfo = formatApiErrorInfo;
  self.normalizeChatQueueItem = normalizeChatQueueItem;
  self.extractChatDocumentId = extractChatDocumentId;
  self.formatCompanyDisplayName = formatCompanyDisplayName;
  self.normalizeApiOrigin = normalizeApiOrigin;
  self.resolveChatApiBase = resolveChatApiBase;
  self.getWaEnv = getWaEnv;
  self.isPosTabUrl = isPosTabUrl;
  self.POS_TOKEN_COOKIE = POS_TOKEN_COOKIE;
}
