/** Cookie names — must match ai-pos `src/utils/authCookie.js`. */
const POS_TOKEN_COOKIE = 'pos_auth_token';
const POS_COMPANY_COOKIE = 'pos_company_id';
const POS_COMPANY_NAME_COOKIE = 'pos_company_name';

/** POS dev server origins (cookie may live here while API URL points at :8000). */
const FALLBACK_ORIGINS = ['http://localhost:5173/', 'http://127.0.0.1:5173/'];

function decodeCookieValue(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function readCookiesFromOrigin(origin) {
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) {
    return { token: '', companyId: '', companyName: '' };
  }
  try {
    const cookies = await chrome.cookies.getAll({ url: origin });
    const token = decodeCookieValue(
      cookies.find((c) => c.name === POS_TOKEN_COOKIE)?.value || ''
    );
    const companyId = decodeCookieValue(
      cookies.find((c) => c.name === POS_COMPANY_COOKIE)?.value || ''
    );
    const companyName = decodeCookieValue(
      cookies.find((c) => c.name === POS_COMPANY_NAME_COOKIE)?.value || ''
    );
    return { token, companyId, companyName };
  } catch {
    return { token: '', companyId: '', companyName: '' };
  }
}

/**
 * Read POS auth cookies for an API URL (and common dev fallbacks).
 * @returns {{ token: string, companyId: string, origin: string, authenticated: boolean }}
 */
async function readPosAuth(apiUrl) {
  const tried = new Set();
  const origins = [];

  try {
    const u = new URL(apiUrl);
    origins.push(`${u.protocol}//${u.host}/`);
  } catch {
    // ignore invalid URL
  }

  FALLBACK_ORIGINS.forEach((o) => origins.push(o));

  for (const origin of origins) {
    if (tried.has(origin)) continue;
    tried.add(origin);
    const { token, companyId, companyName } = await readCookiesFromOrigin(origin);
    if (token) {
      return { token, companyId, companyName, origin, authenticated: true };
    }
  }

  return { token: '', companyId: '', companyName: '', origin: origins[0] || '', authenticated: false };
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
  if (typeof data === 'string') return data.trim();
  const direct = data.message || data.error || data.detail;
  if (direct) return String(direct);
  if (Array.isArray(data.errors)) {
    return data.errors
      .map((entry) =>
        typeof entry === 'string' ? entry : entry?.message || JSON.stringify(entry)
      )
      .join('; ');
  }
  if (data.errors && typeof data.errors === 'object') {
    return Object.entries(data.errors)
      .map(([key, value]) => {
        const text = Array.isArray(value) ? value.join(', ') : String(value);
        return `${key}: ${text}`;
      })
      .join('; ');
  }
  if (data.raw) return String(data.raw).trim().slice(0, 300);
  return '';
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
  const base = String(origin || 'http://localhost:5173/').replace(/\/+$/, '');
  const apiBase = `${base}/api/chat`;
  const q = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
  return {
    fetchUrl: `${apiBase}/fetch-random${q}`,
    updateUrl: `${apiBase}/mark-sent/:id`,
    notAvailableUrl: `${apiBase}/mark-not-available/:id`,
    receiveUrl: `${apiBase}/create/:token`
  };
}

function normalizeChatQueueItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw._id || raw.id || '';
  const message = raw.message || raw.text || raw.body || '';
  const number =
    raw.number ||
    raw.phone ||
    raw.to_user_id ||
    raw.toUserId ||
    raw.recipient ||
    '';
  if (!id || !message || !number) return null;
  return { _id: String(id), number: String(number), message: String(message) };
}

// Service worker (background.js)
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.readPosAuth = readPosAuth;
  self.buildDefaultApiUrls = buildDefaultApiUrls;
  self.buildChatCreateBody = buildChatCreateBody;
  self.buildReceivePostUrl = buildReceivePostUrl;
  self.formatApiErrorInfo = formatApiErrorInfo;
  self.normalizeChatQueueItem = normalizeChatQueueItem;
  self.formatCompanyDisplayName = formatCompanyDisplayName;
  self.POS_TOKEN_COOKIE = POS_TOKEN_COOKIE;
}
