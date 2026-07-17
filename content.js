(function () {
  const QUEUE_KEY = 'wa_sender_queue';

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

  function createSidebar() {
    if (document.getElementById('wa-cursor-sidebar')) {
      return document.getElementById('wa-cursor-sidebar');
    }

    const sidebar = document.createElement('div');
    sidebar.id = 'wa-cursor-sidebar';
    sidebar.innerHTML = `
      <div class="wa-sidebar-header">
        <span>Store Sync WhatsApp Sender</span>
        <button id="wa-sidebar-close">&times;</button>
      </div>
      <div class="wa-sidebar-content">
        <label for="wa-numbers-input">Phone Numbers:</label>
        <input type="text" id="wa-numbers-input" placeholder="e.g. +1234567890, +1987654321" style="width:100%; margin-bottom:5px;" />
        <label for="wa-message-input">Message:</label>
        <input type="text" id="wa-message-input" placeholder="Enter your message" style="width:100%; margin-bottom:10px;" />
        <div style="display: flex; gap: 10px; margin-bottom: 10px;">
          <div>
            <label for="wa-min-delay">Min Delay (seconds):</label>
            <input type="number" id="wa-min-delay" value="2" min="1" style="width:100%;" />
          </div>
          <div>
            <label for="wa-max-delay">Max Delay (seconds):</label>
            <input type="number" id="wa-max-delay" value="12" min="1" style="width:100%;" />
          </div>
        </div>
        <button id="wa-start-whatsapp-chat">Start Sending Messages</button>
        <button id="wa-stop-whatsapp-chat" style="display:none; background:#e74c3c; color:white;">Stop</button>
      </div>
    `;
    document.body.appendChild(sidebar);

    let stopSending = false;
    let activeTimeout = null;

    function setRunning(running) {
      document.getElementById('wa-stop-whatsapp-chat').style.display = running ? 'inline-block' : 'none';
      document.getElementById('wa-start-whatsapp-chat').disabled = running;
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
        if (stopSending) return false;
        const sendButton = findSendButton();
        if (sendButton) {
          sendButton.click();
          return true;
        }
        await sleep(400);
      }
      return false;
    }

    // Open chat inside the same WhatsApp Web tab (no api.whatsapp.com, no new tab)
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

    async function processQueue(state) {
      while (state.index < state.numbers.length) {
        if (stopSending) {
          clearQueue();
          setRunning(false);
          return;
        }

        const number = state.numbers[state.index];
        const phone = normalizePhone(number);
        saveQueue(state);

        if (phone) {
          openChatSameTab(phone, state.message);
          await sleep(3500);
          if (stopSending) {
            clearQueue();
            setRunning(false);
            return;
          }

          const sent = await clickSendWhenReady();
          console.log(sent ? `Message sent to ${number}` : `Send button not found for ${number}`);
        }

        state.index += 1;
        saveQueue(state);

        if (state.index >= state.numbers.length) break;

        const waitMs = 1000 + getRandomDelay(state.minDelay, state.maxDelay);
        await sleep(waitMs);
      }

      clearQueue();
      setRunning(false);
    }

    async function startSending() {
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

      const numbers = numbersInput.split(',').map((n) => n.trim()).filter((n) => n);
      stopSending = false;
      setRunning(true);

      const state = {
        numbers,
        message: messageInput,
        minDelay,
        maxDelay,
        index: 0
      };
      saveQueue(state);
      await processQueue(state);
    }

    document.getElementById('wa-start-whatsapp-chat').addEventListener('click', () => {
      startSending();
    });

    document.getElementById('wa-stop-whatsapp-chat').addEventListener('click', () => {
      stopSending = true;
      if (activeTimeout) clearTimeout(activeTimeout);
      clearQueue();
      setRunning(false);
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

    // Resume queue after WhatsApp in-app navigation
    const pending = loadQueue();
    if (pending && pending.numbers && pending.index < pending.numbers.length) {
      stopSending = false;
      setRunning(true);
      // Small delay so WA finishes loading the chat UI
      sleep(2500).then(() => processQueue(pending));
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

  if (!window.__waSidebarInitialized) {
    window.__waSidebarInitialized = true;
    createSidebar();

    chrome.runtime.onMessage.addListener((message) => {
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
    });
  }
})();
