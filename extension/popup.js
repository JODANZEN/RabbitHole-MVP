'use strict';

const API_KEY_STORAGE = 'rabbithole_api_key';

const input     = document.getElementById('api-key');
const toggleBtn = document.getElementById('toggle-vis');
const saveBtn   = document.getElementById('save-btn');
const statusEl  = document.getElementById('status');
const dot       = document.getElementById('status-dot');
const label     = document.getElementById('status-label');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (isError ? ' error' : '');
}

function updateIndicator(hasKey) {
  dot.className   = 'info-dot' + (hasKey ? ' active' : '');
  label.textContent = hasKey ? 'API key saved — ready to use' : 'No API key set';
}

// Load saved key on open
chrome.storage.local.get(API_KEY_STORAGE, (result) => {
  const saved = result[API_KEY_STORAGE] || '';
  if (saved) {
    input.value = saved;
    input.classList.add('saved');
    updateIndicator(true);
  } else {
    updateIndicator(false);
  }
});

toggleBtn.addEventListener('click', () => {
  input.type = input.type === 'password' ? 'text' : 'password';
});

input.addEventListener('input', () => {
  input.classList.remove('saved');
  setStatus('');
});

saveBtn.addEventListener('click', () => {
  const key = input.value.trim();
  if (!key) {
    setStatus('Enter a key first.', true);
    return;
  }
  if (!key.startsWith('AIza')) {
    setStatus('Gemini keys start with "AIza" — double-check yours.', true);
    return;
  }
  saveBtn.disabled = true;
  chrome.storage.local.set({ [API_KEY_STORAGE]: key }, () => {
    input.classList.add('saved');
    setStatus('Saved!');
    updateIndicator(true);
    saveBtn.disabled = false;
    setTimeout(() => setStatus(''), 2500);
  });
});
