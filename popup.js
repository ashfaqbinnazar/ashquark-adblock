/**
 * Adblock by AshQuark — action popup.
 *
 *  - Per-site switch: adds/removes the current site in the allowlist
 *    (chrome.storage.sync). The service worker turns that into an
 *    allowAllRequests dynamic rule, then the tab reloads.
 *  - Global switch: settings.enabled, which turns the static rulesets on or off.
 *  - Counters: blocked requests (getMatchedRules via the service worker) and
 *    popups blocked by main-world.js. They refresh every second while open.
 */
'use strict';

const $ = (id) => document.getElementById(id);

let tab = null;
let host = null;

/** Ask the service worker to apply the settings we just stored. */
async function syncBackground() {
  const res = await chrome.runtime.sendMessage({ type: 'aq:sync' });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Background sync failed');
}

async function loadSettings() {
  return chrome.storage.sync.get(AQ.DEFAULT_SETTINGS);
}

function render(settings) {
  const enabled = settings.enabled !== false;
  const allowlisted = host ? AQ.isAllowlisted(host, settings.allowlist) : false;

  $('globalToggle').checked = enabled;
  $('globalSub').textContent = enabled ? 'Ad, tracker & popup rules active' : 'All blocking is paused';

  const siteToggle = $('siteToggle');
  const status = $('siteStatus');
  status.className = 'status';

  if (!host) {
    $('host').textContent = 'Not a web page';
    siteToggle.checked = false;
    siteToggle.disabled = true;
    status.textContent = 'Blocking only applies to http(s) pages.';
    return;
  }

  $('host').textContent = AQ.siteKey(host);
  siteToggle.disabled = !enabled;
  siteToggle.checked = enabled && !allowlisted;

  if (!enabled) {
    status.textContent = 'Paused everywhere. Turn protection back on below.';
    status.classList.add('off');
  } else if (allowlisted) {
    status.textContent = 'Blocking is off for this site (allowlisted).';
    status.classList.add('off');
  } else {
    status.textContent = 'Protected: ads, trackers & popups are blocked.';
    status.classList.add('on');
  }
}

async function refreshStats() {
  if (!tab || tab.id == null) return;
  try {
    const stats = await chrome.runtime.sendMessage({ type: 'aq:getStats', tabId: tab.id });
    if (stats) {
      $('blockedCount').textContent = Number(stats.blocked || 0).toLocaleString();
      $('popupCount').textContent = Number(stats.popups || 0).toLocaleString();
    }
  } catch { /* service worker restarting; next tick will retry */ }
}

async function onSiteToggle(e) {
  const wantBlocking = e.target.checked;
  const settings = await loadSettings();
  let list = Array.isArray(settings.allowlist) ? settings.allowlist : [];

  if (wantBlocking) {
    // Remove every entry covering this host (exact or parent domain).
    const covering = new Set(AQ.matchingAllowlistEntries(host, list));
    list = list.filter((d) => !covering.has(d));
  } else {
    const key = AQ.normalizeDomain(host);
    if (key && !list.includes(key)) list = [...list, key];
  }

  await chrome.storage.sync.set({ allowlist: list });
  await syncBackground();
  render({ ...settings, allowlist: list });
  chrome.tabs.reload(tab.id); // apply to the page immediately
}

async function onGlobalToggle(e) {
  const enabled = e.target.checked;
  await chrome.storage.sync.set({ enabled });
  await syncBackground();
  render(await loadSettings());
  if (host) chrome.tabs.reload(tab.id);
}

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version} · Fast · Private`;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = tab ? AQ.hostnameFromUrl(tab.url) : null;

  render(await loadSettings());
  refreshStats();
  setInterval(refreshStats, 1000);

  $('siteToggle').addEventListener('change', (e) => onSiteToggle(e).catch(console.error));
  $('globalToggle').addEventListener('change', (e) => onGlobalToggle(e).catch(console.error));
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init().catch((err) => {
  console.error(err);
  $('siteStatus').textContent = 'Something went wrong. Try reopening the popup.';
});
