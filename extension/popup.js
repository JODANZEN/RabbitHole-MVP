'use strict';

const GEMINI_KEY_STORAGE   = 'rabbithole_gemini_key';
const GROQ_KEY_STORAGE     = 'rabbithole_groq_key';
const PRIMARY_PROVIDER_KEY = 'rabbithole_primary_provider';

const geminiInput  = document.getElementById('gemini-key');
const groqInput    = document.getElementById('groq-key');
const primaryGemini = document.getElementById('primary-gemini');
const primaryGroq   = document.getElementById('primary-groq');
const saveBtn      = document.getElementById('save-btn');
const statusEl     = document.getElementById('status');
const dot          = document.getElementById('status-dot');
const label        = document.getElementById('status-label');

let currentPrimary = 'gemini';

function setToggle(val) {
  currentPrimary = val;
  const activeStyle   = 'background:#667eea; color:#fff; border-color:#667eea;';
  const inactiveStyle = 'background:#fff; color:#888; border-color:#d4d8f0;';
  primaryGemini.style.cssText += val === 'gemini' ? activeStyle : inactiveStyle;
  primaryGroq.style.cssText   += val === 'groq'   ? activeStyle : inactiveStyle;
}

function updateIndicator(hasAny) {
  dot.className     = 'info-dot' + (hasAny ? ' active' : '');
  label.textContent = hasAny ? 'Keys saved — ready to use' : 'No API keys set';
}

chrome.storage.local.get([GEMINI_KEY_STORAGE, GROQ_KEY_STORAGE, PRIMARY_PROVIDER_KEY], (r) => {
  if (r[GEMINI_KEY_STORAGE]) { geminiInput.value = r[GEMINI_KEY_STORAGE]; geminiInput.classList.add('saved'); }
  if (r[GROQ_KEY_STORAGE])   { groqInput.value   = r[GROQ_KEY_STORAGE];   groqInput.classList.add('saved'); }
  setToggle(r[PRIMARY_PROVIDER_KEY] || 'gemini');
  updateIndicator(!!(r[GEMINI_KEY_STORAGE] || r[GROQ_KEY_STORAGE]));
});

primaryGemini.addEventListener('click', () => setToggle('gemini'));
primaryGroq.addEventListener('click',   () => setToggle('groq'));

document.getElementById('toggle-gemini').addEventListener('click', () => {
  geminiInput.type = geminiInput.type === 'password' ? 'text' : 'password';
});
document.getElementById('toggle-groq').addEventListener('click', () => {
  groqInput.type = groqInput.type === 'password' ? 'text' : 'password';
});

[geminiInput, groqInput].forEach((inp) => {
  inp.addEventListener('input', () => { inp.classList.remove('saved'); statusEl.textContent = ''; statusEl.className = 'status'; });
});

saveBtn.addEventListener('click', () => {
  const gemini = geminiInput.value.trim();
  const groq   = groqInput.value.trim();
  if (!gemini && !groq) {
    statusEl.textContent = 'Enter at least one key.';
    statusEl.className = 'status error';
    return;
  }
  const toSave = { [PRIMARY_PROVIDER_KEY]: currentPrimary };
  if (gemini) toSave[GEMINI_KEY_STORAGE] = gemini;
  if (groq)   toSave[GROQ_KEY_STORAGE]   = groq;
  saveBtn.disabled = true;
  chrome.storage.local.set(toSave, () => {
    if (gemini) geminiInput.classList.add('saved');
    if (groq)   groqInput.classList.add('saved');
    statusEl.textContent = 'Saved!';
    statusEl.className = 'status';
    updateIndicator(true);
    saveBtn.disabled = false;
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  });
});
