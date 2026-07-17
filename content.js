(function () {
  const QUEUE_KEY = 'wa_sender_queue';
  const API_SETTINGS_KEY = 'wa_api_settings';

  // Shared across reinjections so old async loops stop when Stop is pressed
  if (typeof window.__waSenderActiveRun !== 'number') {
    window.__waSenderActiveRun = 0;
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

  function saveApiSettings(fetchUrl, updateUrl, notAvailableUrl) {
    localStorage.setItem(API_SETTINGS_KEY, JSON.stringify({ fetchUrl, updateUrl, notAvailableUrl }));
  }

  function loadApiSettings() {
    try {
      const raw = localStorage.getItem(API_SETTINGS_KEY);
      return raw ? JSON.parse(raw) : { fetchUrl: '', updateUrl: '', notAvailableUrl: '' };
    } catch {
      return { fetchUrl: '', updateUrl: '', notAvailableUrl: '' };
    }
  }

  function persistApiUrlsFromInputs() {
    const fetchUrl = document.getElementById('wa-fetch-url')?.value.trim() || '';
    const updateUrl = document.getElementById('wa-update-url')?.value.trim() || '';
    const notAvailableUrl = document.getElementById('wa-not-available-url')?.value.trim() || '';
    saveApiSettings(fetchUrl, updateUrl, notAvailableUrl);
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

  function createSidebar(forceRebuild = false) {
    // Kill any leftover loops from a previous injection/sidebar
    cancelAllSenderRuns();

    const currentVersion = chrome.runtime.getManifest().version;
    const existingSidebar = document.getElementById('wa-cursor-sidebar');
    if (existingSidebar) {
      const isCurrent =
        existingSidebar.dataset.version === currentVersion &&
        existingSidebar.querySelector('.wa-tabs') &&
        existingSidebar.querySelector('#wa-not-available-url') &&
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
          <span class="wa-version">v${currentVersion}</span>
        </div>
        <button id="wa-sidebar-close">&times;</button>
      </div>
      <div class="wa-tabs">
        <button type="button" class="wa-tab active" data-tab="manual">Manual</button>
        <button type="button" class="wa-tab" data-tab="api">API</button>
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
    `;
    document.body.appendChild(sidebar);

    document.getElementById('wa-fetch-url').value = apiSettings.fetchUrl || '';
    document.getElementById('wa-update-url').value = apiSettings.updateUrl || '';
    document.getElementById('wa-not-available-url').value = apiSettings.notAvailableUrl || '';

    ['wa-fetch-url', 'wa-update-url', 'wa-not-available-url'].forEach((id) => {
      const input = document.getElementById(id);
      input.addEventListener('input', persistApiUrlsFromInputs);
      input.addEventListener('change', persistApiUrlsFromInputs);
      input.addEventListener('blur', persistApiUrlsFromInputs);
    });

    let stopSending = false;
    let activeTimeout = null;
    let activeTab = 'manual';
    let activeRunId = 0;

    function isActive() {
      return !stopSending && isSenderRunActive(activeRunId);
    }

    function updateStartButtonLabel() {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      if (!startBtn) return;
      startBtn.textContent = activeTab === 'api'
        ? (startBtn.dataset.labelApi || 'Start')
        : (startBtn.dataset.labelManual || 'Start Sending Messages');
    }

    sidebar.querySelectorAll('.wa-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        if (document.getElementById('wa-start-whatsapp-chat').disabled) return;
        activeTab = tabBtn.dataset.tab;
        sidebar.querySelectorAll('.wa-tab').forEach((btn) => btn.classList.toggle('active', btn === tabBtn));
        sidebar.querySelectorAll('.wa-tab-panel').forEach((panel) => {
          panel.style.display = panel.dataset.panel === activeTab ? 'block' : 'none';
        });
        updateStartButtonLabel();
      });
    });

    updateStartButtonLabel();

    function setRunning(running) {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      const stopBtn = document.getElementById('wa-stop-whatsapp-chat');
      if (!startBtn || !stopBtn) return;
      stopBtn.style.display = running ? 'inline-block' : 'none';
      startBtn.disabled = !!running;
      startBtn.setAttribute('aria-disabled', running ? 'true' : 'false');
      sidebar.querySelectorAll('.wa-tab').forEach((btn) => {
        btn.disabled = !!running;
      });
      if (!running) {
        updateStartButtonLabel();
      }
    }

    function setSendStatus(text) {
      // Ignore status updates from cancelled/old runs
      if (!isActive() && text !== 'Stopped.') return;
      const status = document.getElementById('wa-send-status');
      if (status) {
        status.textContent = text;
      }
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

      const activeBtn = sidebar.querySelector('.wa-tab.active');
      activeTab = activeBtn?.dataset.tab || activeTab;
      updateStartButtonLabel();

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
        sidebar.querySelectorAll('.wa-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === 'api'));
        sidebar.querySelectorAll('.wa-tab-panel').forEach((panel) => {
          panel.style.display = panel.dataset.panel === 'api' ? 'block' : 'none';
        });
        updateStartButtonLabel();
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
