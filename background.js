// FortifyXRB (X Region Blocker) v1.0 - Background Service Worker
// Programmatically injects content scripts into existing X tabs
// to work around Brave's MV3 content script injection timing bug

'use strict';

// Track which tabs have already been injected to prevent double-injection
// on X's SPA navigations that re-trigger 'complete' status
const injectedTabs = new Set();

// Inject into a single tab
async function injectIntoTab(tabId) {
  if (injectedTabs.has(tabId)) return;
  injectedTabs.add(tabId);
  try {
    // Inject injector.js in MAIN world first
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['injector.js'],
      world: 'MAIN'
    });
    // Then inject content.js in ISOLATED world
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED'
    });
    // Inject CSS
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    });
    console.log('[XRB-BG] Injected into tab:', tabId);
  } catch (e) {
    // Tab may not be ready — remove from set so it can be retried
    injectedTabs.delete(tabId);
    console.log('[XRB-BG] Inject skipped for tab', tabId, ':', e.message);
  }
}

// Clean up tracking set when a tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  injectedTabs.delete(tabId);
});

// Inject into all existing X tabs on startup
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://x.com/*', 'https://twitter.com/*']
    });
    console.log('[XRB-BG] Found', tabs.length, 'existing X tabs');
    for (const tab of tabs) {
      if (tab.id) await injectIntoTab(tab.id);
    }
  } catch (e) {
    console.log('[XRB-BG] Error injecting into existing tabs:', e.message);
  }
}

// Inject when a new X tab navigates to complete
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';
  if (url.startsWith('https://x.com/') || url.startsWith('https://twitter.com/')) {
    console.log('[XRB-BG] X tab navigated, injecting:', tabId);
    injectIntoTab(tabId);
  }
});

// Inject into existing tabs on service worker startup
injectIntoExistingTabs();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true, version: '1.1.0' });
    return true;
  }
});

console.log('[XRB-BG] v1.0 Background started — programmatic injection active');
