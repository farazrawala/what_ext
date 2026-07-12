// Prevent multiple injections
if (!document.getElementById('wa-cursor-sidebar')) {
  // Sidebar HTML
  const sidebar = document.createElement('div');
  sidebar.id = 'wa-cursor-sidebar';
  sidebar.innerHTML = `
    <div class="wa-sidebar-header">
      <span>Cursor & WhatsApp</span>
      <button id="wa-sidebar-close">&times;</button>
    </div>
    <div class="wa-sidebar-content">
      <label for="wa-numbers-input">Numbers (comma separated):</label>
      <input type="text" id="wa-numbers-input" placeholder="e.g. +1234567890, +1987654321" style="width:100%; margin-bottom:5px;" />
      <label for="wa-message-input">Message:</label>
      <input type="text" id="wa-message-input" placeholder="Enter your message" style="width:100%; margin-bottom:10px;" />
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <div>
          <label for="wa-min-delay">Min Delay (seconds):</label>
          <input type="number" id="wa-min-delay" value="10" min="1" style="width:100%;" />
        </div>
        <div>
          <label for="wa-max-delay">Max Delay (seconds):</label>
          <input type="number" id="wa-max-delay" value="30" min="1" style="width:100%;" />
        </div>
      </div>
      <button id="wa-start-whatsapp-chat">Start New Chat on WhatsApp</button>
      <button id="wa-stop-whatsapp-chat" style="display:none; background:#e74c3c; color:white;">Stop</button>
    </div>
  `;
  document.body.appendChild(sidebar);

  // Random delay function (returns milliseconds)
  function getRandomDelay(min, max) {
    const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
    console.log(`Generated random delay: ${delay / 1000} seconds`);  // Log the delay time in seconds
    return delay;
  }

  // Stop flag and timeouts
  let stopSending = false;
  let timeouts = [];

  // WhatsApp new chat for multiple numbers with random delays and stop button
  document.getElementById("wa-start-whatsapp-chat").addEventListener("click", () => {
    const numbersInput = document.getElementById('wa-numbers-input').value;
    const messageInput = document.getElementById('wa-message-input').value;
    const minDelay = parseInt(document.getElementById('wa-min-delay').value) || 10;
    const maxDelay = parseInt(document.getElementById('wa-max-delay').value) || 30;

    if (!numbersInput.trim()) {
      alert('Please enter at least one number.');
      return;
    }
    if (!messageInput.trim()) {
      alert('Please enter a message.');
      return;
    }
    if (minDelay > maxDelay) {
      alert('Minimum delay should be less than maximum delay.');
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
        const btn = document.querySelector('button[title="New chat"]');
        if (btn) {
          btn.click();
          setTimeout(() => {
            if (stopSending) return;
            function waitForEditableDivAndType(text, timeout = 5000) {
              const xpath = '//*[@id="app"]/div/div[3]/div/div[2]/div[1]/span/div/span/div/div[1]/div[2]/div/div/div';
              const interval = 300;
              let elapsed = 0;
              const checkAndType = setInterval(() => {
                if (stopSending) {
                  clearInterval(checkAndType);
                  return;
                }
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const editableDiv = result.singleNodeValue;
                if (editableDiv) {
                  clearInterval(checkAndType);
                  editableDiv.focus();
                  document.execCommand('insertText', false, text);
                  editableDiv.focus();
                } else {
                  elapsed += interval;
                  if (elapsed >= timeout) {
                    clearInterval(checkAndType);
                    alert("Editable div not found after waiting.");
                  }
                }
              }, interval);
            }
            waitForEditableDivAndType(number);
          }, 3000);
          setTimeout(() => {
            if (stopSending) return;
            const xpath =
              '//*[@id="app"]/div/div[3]/div/div[2]/div[1]/span/div/span/div/div[2]/div[2]/div/div/div[2]/div/div/div[1]/div';
            const result = document.evaluate(
              xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            const targetDiv = result.singleNodeValue;

            if (targetDiv) {
              targetDiv.click();
              console.log("Clicked target div.");
            } else {
              console.log("Target div not found.");
            }
          }, 6000);
          setTimeout(() => {
            if (stopSending) return;
            const msgBox = document.querySelector("[aria-label='Type a message']");
            if (msgBox) {
              msgBox.focus();
              document.execCommand('insertText', false, messageInput);
              setTimeout(() => {
                if (stopSending) return;
                const sendBtn = document.querySelector('[aria-label="Send"]');
                if (sendBtn) {
                  sendBtn.click();
                  console.log(`Message sent to ${number}!`);
                } else {
                  console.log('Send button not found.');
                }
                // If last message, re-enable start button and hide stop
                if (idx === numbers.length - 1) {
                  document.getElementById("wa-stop-whatsapp-chat").style.display = "none";  // Hide stop button
                  document.getElementById("wa-start-whatsapp-chat").disabled = false;  // Re-enable start button
                }
              }, 500);
            } else {
              console.log('Message box not found.');
            }
          }, 8000);
        } else {
          alert("New chat button not found. Make sure you are on https://web.whatsapp.com");
        }
      }, totalDelay);

      timeouts.push(timeoutId);

      // Calculate next delay
      const nextDelay = getRandomDelay(minDelay, maxDelay);
      totalDelay += (9000 + nextDelay);  // Adding a fixed delay plus random delay
      console.log(`Next total delay after message: ${totalDelay / 1000} seconds`);  // Log the total delay
    });
  });

  // Stop button logic
  document.getElementById("wa-stop-whatsapp-chat").addEventListener("click", () => {
    stopSending = true;  // Set stop flag to true
    timeouts.forEach(timeoutId => clearTimeout(timeoutId));  // Clear all timeouts
    timeouts = [];
    document.getElementById("wa-stop-whatsapp-chat").style.display = "none";  // Hide stop button
    document.getElementById("wa-start-whatsapp-chat").disabled = false;  // Re-enable the start button
    console.log("Stopped sending messages.");
  });

  // Close sidebar
  document.getElementById("wa-sidebar-close").onclick = () => {
    stopSending = true;
    timeouts.forEach(timeoutId => clearTimeout(timeoutId));
    timeouts = [];
    sidebar.remove();
    document.body.style.cursor = "";
  };
}