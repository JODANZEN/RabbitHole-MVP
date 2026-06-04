/**
 * RabbitHole - Background Service Worker (MV3)
 * Handles: extension icon click, Dumbify right-click context menu
 */

chrome.runtime.onInstalled.addListener(() => {
  console.debug('[RabbitHole] Extension installed/updated');

  // Register the right-click "Explain with RabbitHole" context menu item
  chrome.contextMenus.create({
    id: 'rabbithole-dumbify',
    title: '🐇 Explain with RabbitHole',
    contexts: ['selection'],
  });
});

// ─── Icon click → trigger analysis ─────────────────────────────────

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

async function injectAndSend(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  // Give the script a moment to initialize
  await new Promise((r) => setTimeout(r, 350));
  return sendToTab(tabId, message);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const ok = await sendToTab(tab.id, { type: 'ANALYZE_PAGE' });
  if (!ok) {
    console.debug('[RabbitHole] Content script not ready, injecting...');
    await injectAndSend(tab.id, { type: 'ANALYZE_PAGE' });
  }
});

// ─── Context menu → trigger Dumbify ────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'rabbithole-dumbify' || !tab?.id) return;

  const text = (info.selectionText || '').trim();
  if (!text) return;

  const message = { type: 'DUMBIFY_SELECTION', text };
  const ok = await sendToTab(tab.id, message);
  if (!ok) {
    console.debug('[RabbitHole] Dumbify: content script not ready, injecting...');
    await injectAndSend(tab.id, message);
  }
});
