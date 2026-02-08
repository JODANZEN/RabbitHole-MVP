/**
 * RabbitHole - Background Service Worker (MV3)
 * Handles extension icon click to trigger page analysis
 */

chrome.runtime.onInstalled.addListener(() => {
  console.debug('[RabbitHole] Extension installed');
});

// When user clicks the extension icon, message the content script to analyze
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ANALYZE_PAGE' });
  } catch (err) {
    // Content script may not be injected yet — inject it then retry
    console.debug('[RabbitHole] Content script not ready, injecting...', err.message);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    // Small delay to let the script initialize
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'ANALYZE_PAGE' });
      } catch (e) {
        console.error('[RabbitHole] Failed to trigger analysis:', e.message);
      }
    }, 300);
  }
});
