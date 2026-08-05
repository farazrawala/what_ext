const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "posAuth.js");
let s = fs.readFileSync(file, "utf8");
const start = s.search(
  /\/\*\*\r?\n \* Live AI POS stores auth in localStorage/,
);
const end = s.indexOf("function formatCompanyDisplayName");
if (start < 0 || end < 0) {
  console.error("markers not found", start, end);
  process.exit(1);
}

const insert = `/**
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

  tabs = tabs.filter((tab) => {
    const url = String(tab.url || '');
    return (
      /https:\\/\\/testv3\\.websitedemolynk\\.com\\//i.test(url) ||
      /http:\\/\\/localhost:5173\\//i.test(url) ||
      /http:\\/\\/127\\.0\\.0\\.1:5173\\//i.test(url)
    );
  });

  tabs.sort((a, b) => {
    const aLive = /websitedemolynk\\.com/i.test(a.url || '') ? 0 : 1;
    const bLive = /websitedemolynk\\.com/i.test(b.url || '') ? 0 : 1;
    return aLive - bLive;
  });

  for (const tab of tabs) {
    if (!tab?.id) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: extractPosAuthFromPageStorageInline,
      });
      const data = results?.[0]?.result;
      if (data?.token) {
        const origin = normalizeApiOrigin(tab.url || PREFERRED_POS_HOSTS[0]);
        const auth = {
          token: data.token,
          companyId: data.companyId || '',
          companyName: data.companyName || '',
          origin,
          updatedAt: Date.now(),
        };
        try {
          await chrome.storage.local.set({ [POS_AUTH_STORAGE_KEY]: auth });
        } catch (_) {}
        console.log('[WA] POS auth from localStorage tab →', {
          origin,
          tabId: tab.id,
          companyId: auth.companyId ? String(auth.companyId).slice(0, 8) : '',
        });
        return { ...auth, authenticated: true, source: 'localStorage' };
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
    const isLive = /websitedemolynk\\.com$/i.test(
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

  console.warn(
    '[WA] POS auth: no authToken/localStorage or pos_auth_token cookie found',
    {
      tried: candidates,
      tip: 'Keep https://testv3.websitedemolynk.com/pos open while logged in, then reload the extension and refresh the POS tab',
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

`;

// Fix double-escaped regexes written above for the patch file itself
const fixed = insert
  .replace(/\\\\/g, "\\");

fs.writeFileSync(file, s.slice(0, start) + fixed + s.slice(end));
console.log("posAuth.js patched OK");
