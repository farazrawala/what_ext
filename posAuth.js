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

function buildDefaultApiUrls(origin, companyId) {
  const base = String(origin || 'http://localhost:5173/').replace(/\/+$/, '');
  const apiBase = `${base}/api`;
  const q = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
  return {
    fetchUrl: `${apiBase}/whatsapp_message/fetch-random${q}`,
    updateUrl: `${apiBase}/whatsapp_message/mark-sent/:id${q}`,
    notAvailableUrl: `${apiBase}/whatsapp_message/mark-not-available/:id${q}`,
    receiveUrl: `${apiBase}/whatsapp_message/incoming`
  };
}

// Service worker (background.js)
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.readPosAuth = readPosAuth;
  self.buildDefaultApiUrls = buildDefaultApiUrls;
  self.POS_TOKEN_COOKIE = POS_TOKEN_COOKIE;
}
