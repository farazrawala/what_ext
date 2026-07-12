// Prevent multiple injections
if (!document.getElementById('wa-cursor-sidebar')) {
  const sidebar = document.createElement('div');
  sidebar.id = 'wa-cursor-sidebar';
  sidebar.innerHTML = `
    <div class="wa-sidebar-header">
      <span>WhatsApp Message Sender</span>
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
  let timeouts = [];

  function getRandomDelay(min, max) {
    return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
  }

  document.getElementById("wa-start-whatsapp-chat").addEventListener("click", () => {
    const numbersInput = document.getElementById('wa-numbers-input').value;
    const messageInput = document.getElementById('wa-message-input').value;
    const minDelay = parseInt(document.getElementById('wa-min-delay').value) || 2;
    const maxDelay = parseInt(document.getElementById('wa-max-delay').value) || 12;

    if (!numbersInput.trim() || !messageInput.trim()) {
      alert('Please enter valid numbers and message.');
      return;
    }
    if (minDelay > maxDelay) {
      alert('Min delay should be less than or equal to max delay.');
      return;
    }

    const numbers = numbersInput.split(',').map(n => n.trim()).filter(n => n);
    let totalDelay = 0;
    stopSending = false;
    document.getElementById("wa-stop-whatsapp-chat").style.display = "inline-block";
    document.getElementById("wa-start-whatsapp-chat").disabled = true;

    numbers.forEach((number, idx) => {
      const timeoutId = setTimeout(() => {
        if (stopSending) return;

        // Create and click hidden anchor tag
        const waUrl = `https://api.whatsapp.com/send?phone=${encodeURIComponent(number)}&text=${encodeURIComponent(messageInput)}`;
        let anchor = document.getElementById('wa-hidden-link');
        if (anchor) anchor.remove(); // Remove previous if exists
        anchor = document.createElement('a');
        anchor.href = waUrl;
        anchor.title = waUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        anchor.id = 'wa-hidden-link';
        anchor.className = '_ao3e selectable-text copyable-text x1bvjpef x1lku1pv x11iimpl xbvygy2 x1wp9yj1 x1e2wovf x1ph7ams x17f7hit x1k74hu9 xn69kzl xrys4gj xhmieyt';
        anchor.innerText = waUrl;
        document.body.appendChild(anchor);
        anchor.click();

        setTimeout(() => {
          if (stopSending) return;
          const sendButton = document.querySelector('[aria-label="Send"]');
          if (sendButton) {
            sendButton.click();
            console.log(`Message sent to ${number}`);
          }
          setTimeout(() => anchor.remove(), 1000);
          // Hide stop button and re-enable start button after last message
          if (idx === numbers.length - 1) {
            document.getElementById("wa-stop-whatsapp-chat").style.display = "none";
            document.getElementById("wa-start-whatsapp-chat").disabled = false;
          }
        }, 3000); // Wait 3 seconds after anchor click before clicking send
      }, totalDelay);

      timeouts.push(timeoutId);
      const nextDelay = getRandomDelay(minDelay, maxDelay);
      totalDelay += (1000 + nextDelay);
    });
  });

  document.getElementById("wa-stop-whatsapp-chat").addEventListener("click", () => {
    stopSending = true;
    timeouts.forEach(timeoutId => clearTimeout(timeoutId));
    timeouts = [];
    document.getElementById("wa-stop-whatsapp-chat").style.display = "none";
    document.getElementById("wa-start-whatsapp-chat").disabled = false;
  });

  document.getElementById("wa-sidebar-close").onclick = () => {
    stopSending = true;
    timeouts.forEach(timeoutId => clearTimeout(timeoutId));
    timeouts = [];
    sidebar.remove();
  };

  // Listen for socket-triggered start event
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'wa-start-sending-from-socket') {
      const startBtn = document.getElementById('wa-start-whatsapp-chat');
      if (startBtn && !startBtn.disabled) {
        startBtn.click();
      }
    }
  });
}
