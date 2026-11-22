// ClassCard 단어 도우미 - service worker

chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  if (msg && msg.type === 'cc-badge' && sender.tab && sender.tab.id != null) {
    const text = msg.count > 0 ? String(msg.count) : '';
    chrome.action.setBadgeText({ tabId: sender.tab.id, text });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#4f46e5' });
  }
});

async function toggleSetting(key) {
  const d = await chrome.storage.local.get('cc_settings');
  const s = d.cc_settings || {};
  s[key] = !s[key];
  await chrome.storage.local.set({ cc_settings: s });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'cc-settings', settings: s }).catch(() => {});
  }
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-hint') toggleSetting('hint');
  if (cmd === 'toggle-auto') toggleSetting('auto');
});
