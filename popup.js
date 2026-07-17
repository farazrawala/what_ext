const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text || '';
}

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
