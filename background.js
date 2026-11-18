/**
 * Adblock by AshQuark — background service worker (Manifest V3).
 *
 * Responsibilities
 *  1. Keep Chrome's blocking state in sync with the user's settings
 *     (chrome.storage.sync is the single source of truth):
 *       - static rulesets on/off       -> declarativeNetRequest.updateEnabledRulesets
 *       - allowlist + custom domains   -> dynamic DNR rules
 *       - content scripts              -> chrome.scripting.registerContentScripts
 *         (registered dynamically so allowlisted sites can be excluded entirely)
 *       - toolbar badge                -> setExtensionActionOptions (blocked-request count)
 *  2. Answer the popup's stats request (blocked requests + popups for a tab).
 *  3. Count popups/redirects blocked by main-world.js (relayed by content.js).
 *
 * Privacy: no network calls, no analytics, no remote code. Nothing leaves the browser.
 */
'use strict';

importScripts('shared.js'); // provides globalThis.AQ

const STATIC_RULESETS = ['ads', 'trackers', 'popups'];

// Dynamic rule ID ranges (kept apart so we can tell rule kinds apart in getMatchedRules).
const ALLOW_RULE_ID_MIN = 1;        // allowlist rules:    1 … 9 999
const CUSTOM_RULE_ID_MIN = 10000;   // custom block rules: 10 000+
const MAX_ALLOW_RULES = CUSTOM_RULE_ID_MIN - ALLOW_RULE_ID_MIN;

// Allowlist rules must outrank every block rule (static rules use priority 1).
const ALLOW_PRIORITY = 1000;
const CUSTOM_BLOCK_PRIORITY = 2;

// Everything except the top-level page itself (custom domains stay visitable).
const BLOCK_RESOURCE_TYPES = [
  'script', 'image', 'sub_frame', 'xmlhttprequest', 'media', 'ping',
  'stylesheet', 'font', 'object', 'websocket', 'other'
];

const SCRIPT_ID_MAIN = 'aq-main-world';
const SCRIPT_ID_CONTENT = 'aq-content';
const SCRIPT_ID_VIDEO_MAIN = 'aq-video-main';
const SCRIPT_ID_VIDEO = 'aq-video';
const ALL_SCRIPT_IDS = [SCRIPT_ID_MAIN, SCRIPT_ID_CONTENT, SCRIPT_ID_VIDEO_MAIN, SCRIPT_ID_VIDEO];

const BADGE_COLOR_ON = '#7C5CFF';
const BADGE_COLOR_OFF = '#475569';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Read settings, filling in defaults and dropping anything malformed. */
async function getSettings() {
  const raw = await chrome.storage.sync.get(AQ.DEFAULT_SETTINGS);
  const domains = (list) => [...new Set((Array.isArray(list) ? list : []).map(AQ.normalizeDomain).filter(Boolean))];
  return {
    enabled: raw.enabled !== false,
    allowlist: domains(raw.allowlist).slice(0, MAX_ALLOW_RULES),
    customDomains: domains(raw.customDomains),
    customSelectors: Array.isArray(raw.customSelectors) ? raw.customSelectors : [],
    hideCookieBanners: raw.hideCookieBanners === true,
    blockVideoAds: raw.blockVideoAds !== false
  };
}

// ---------------------------------------------------------------------------
// Applying settings (serialized so concurrent calls can't interleave)
// ---------------------------------------------------------------------------

let applyQueue = Promise.resolve();

/** Queue a full re-sync of Chrome's blocking state. Resolves when it is done. */
function applySettings() {
  const run = applyQueue.catch(() => {}).then(doApplySettings);
  applyQueue = run;
  return run;
}

async function doApplySettings() {
  const s = await getSettings();

  // 1. Static rulesets: all on, or all off.
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    s.enabled ? { enableRulesetIds: STATIC_RULESETS } : { disableRulesetIds: STATIC_RULESETS }
  );

  // 2. Dynamic rules: rebuild from scratch (cheap; there are only a handful).
  const addRules = [];
  s.allowlist.forEach((domain, i) => {
    addRules.push({
      id: ALLOW_RULE_ID_MIN + i,
      priority: ALLOW_PRIORITY,
      // allowAllRequests on the top frame allows every request made by that page
      // (including its iframes), which is exactly "turn blocking off for this site".
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] }
    });
  });
  if (s.enabled) {
    s.customDomains.forEach((domain, i) => {
      addRules.push({
        id: CUSTOM_RULE_ID_MIN + i,
        priority: CUSTOM_BLOCK_PRIORITY,
        action: { type: 'block' },
        condition: { requestDomains: [domain], resourceTypes: BLOCK_RESOURCE_TYPES }
      });
    });
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules
  });

  // 3. Content scripts (cosmetic filtering + popup blocking).
  await syncContentScripts(s);

  // 4. Toolbar badge: live blocked-request count when on, "OFF" when off.
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: s.enabled });
  await chrome.action.setBadgeBackgroundColor({ color: s.enabled ? BADGE_COLOR_ON : BADGE_COLOR_OFF });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setBadgeText({ text: s.enabled ? '' : 'OFF' });
}

/**
 * Register our content scripts, excluding allowlisted sites.
 *  - main-world.js       MAIN world: popup / popunder / tab-under blocking
 *  - content.js + css    ISOLATED:   cosmetic filtering, overlays, scroll restore
 *  - video-ads-main.js   MAIN world: empty VAST/VMAP answers, ad-key pruning   (blockVideoAds)
 *  - video-ads.js        ISOLATED:   ad <video> skipping, "Skip ad" auto-click (blockVideoAds)
 * All run at document_start in all frames, including about:blank / srcdoc frames
 * (matchOriginAsFallback), where many ads render. When blocking is globally off
 * they are unregistered completely.
 */
async function syncContentScripts(s) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ALL_SCRIPT_IDS });
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: registered.map((r) => r.id) });
  }
  if (!s.enabled) return;

  const excludeMatches = s.allowlist.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
  const common = {
    matches: ['<all_urls>'],
    excludeMatches,
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true
  };
  const scripts = [
    { id: SCRIPT_ID_MAIN, js: ['main-world.js'], world: 'MAIN', ...common },
    { id: SCRIPT_ID_CONTENT, js: ['content.js'], css: ['cosmetic.css'], world: 'ISOLATED', ...common }
  ];
  if (s.blockVideoAds) {
    scripts.push(
      { id: SCRIPT_ID_VIDEO_MAIN, js: ['video-ads-main.js'], world: 'MAIN', ...common },
      { id: SCRIPT_ID_VIDEO, js: ['video-ads.js'], world: 'ISOLATED', ...common }
    );
  }
  try {
    await chrome.scripting.registerContentScripts(scripts.map((x) => ({ ...x, matchOriginAsFallback: true })));
  } catch (e) {
    // Older Chrome without matchOriginAsFallback for registered scripts: register without it.
    console.warn('[AshQuark] matchOriginAsFallback unsupported, retrying without it', e);
    await chrome.scripting.registerContentScripts(scripts);
  }
}

// ---------------------------------------------------------------------------
// Per-tab stats (kept in storage.session so they survive service-worker restarts)
// ---------------------------------------------------------------------------

const statsKey = (tabId) => `tab:${tabId}`;
let statsQueue = Promise.resolve();

/** Read-modify-write a tab's stats record, serialized to avoid lost updates. */
function updateTabStats(tabId, mutate) {
  statsQueue = statsQueue
    .then(async () => {
      const key = statsKey(tabId);
      const current = (await chrome.storage.session.get(key))[key] || { popups: 0, since: Date.now() };
      mutate(current);
      await chrome.storage.session.set({ [key]: current });
    })
    .catch((e) => console.warn('[AshQuark] stats update failed', e));
  return statsQueue;
}

async function getTabStats(tabId) {
  const key = statsKey(tabId);
  const record = (await chrome.storage.session.get(key))[key] || { popups: 0 };

  let blocked = 0;
  try {
    const filter = { tabId };
    if (record.since) filter.minTimeStamp = record.since; // only the current page load
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules(filter);
    // Count block rules only: skip our allowAllRequests allowlist matches.
    blocked = rulesMatchedInfo.filter(
      (m) => !(m.rule.rulesetId === '_dynamic' && m.rule.ruleId < CUSTOM_RULE_ID_MIN)
    ).length;
  } catch (e) {
    console.warn('[AshQuark] getMatchedRules failed', e);
  }
  return { blocked, popups: record.popups || 0 };
}

// A new page load in a tab resets that tab's counters (the badge resets too).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    updateTabStats(tabId, (st) => {
      st.popups = 0;
      st.since = Date.now();
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(statsKey(tabId)).catch(() => {});
});

// ---------------------------------------------------------------------------
// Messaging (popup, options page, content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    // Popup / options page changed settings: re-apply and report back.
    case 'aq:sync':
      applySettings().then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e && e.message || e) })
      );
      return true; // async response

    // Popup asks for the current tab's counters.
    case 'aq:getStats':
      getTabStats(Number(msg.tabId)).then(sendResponse, () => sendResponse({ blocked: 0, popups: 0 }));
      return true;

    // content.js relays a popup/redirect blocked by main-world.js.
    case 'aq:blocked':
      if (sender.tab && sender.tab.id >= 0) {
        updateTabStats(sender.tab.id, (st) => { st.popups = (st.popups || 0) + 1; });
      }
      return false;

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Rulesets / registrations reset on install and update, so always re-apply.
chrome.runtime.onInstalled.addListener(() => { applySettings().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { applySettings().catch(console.error); });

// Settings can also change via Chrome Sync from another device.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') applySettings().catch(console.error);
});
