const statusEl = document.getElementById('status');
const versionEl = document.getElementById('ext-version');
const welcomeEl = document.getElementById('welcome');

try {
  const version = chrome.runtime.getManifest().version;
  if (versionEl) versionEl.textContent = `v${version}`;
} catch (_) {}

function setStatus(text) {
  statusEl.textContent = text || '';
}

function setWelcome(text) {
  if (welcomeEl) welcomeEl.textContent = text || '';
}

chrome.runtime.sendMessage({ type: 'wa-get-pos-auth' }, (response) => {
  if (chrome.runtime.lastError || !response?.authenticated) {
    setWelcome('Welcome — keep AI POS open & logged in');
    return;
  }
  const name = String(response.companyName || '').trim();
  setWelcome(name ? `Welcome ${name}` : 'Welcome');
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectSidebar(tabId) {
  // Always re-inject so extension reloads pick up the latest UI/code
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['sidebar.css']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  await chrome.tabs.sendMessage(tabId, { type: 'wa-show-sidebar' });
  return true;
}

document.getElementById('openWa').addEventListener('click', async () => {
  const tab = await getActiveTab();

  if (tab?.url && tab.url.includes('web.whatsapp.com')) {
    // Already on WhatsApp Web — show the sidebar instead
    try {
      await injectSidebar(tab.id);
      window.close();
    } catch (err) {
      console.error(err);
      setStatus('Failed. Refresh WhatsApp Web and try again.');
    }
    return;
  }

  await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
  window.close();
});
