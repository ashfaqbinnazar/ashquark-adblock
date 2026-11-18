/**
 * Adblock by AshQuark — options page.
 *
 * Settings live in chrome.storage.sync. After every change we message the
 * service worker ("aq:sync"), which rebuilds the dynamic DNR rules (allowlist,
 * custom domains) and content-script registrations. Open tabs pick up custom
 * selectors and the cookie-banner option live through storage.onChanged.
 */
'use strict';

const $ = (id) => document.getElementById(id);

/** How each editable list validates and normalizes its entries. */
const LISTS = {
  allowlist: {
    normalize: (v) => AQ.normalizeDomain(v),
    split: /[\s,]+/,
    empty: 'No allowlisted sites.',
    invalidMsg: 'Not a valid domain'
  },
  customDomains: {
    normalize: (v) => AQ.normalizeDomain(v),
    split: /[\s,]+/,
    empty: 'No custom blocked domains.',
    invalidMsg: 'Not a valid domain'
  },
  customSelectors: {
    normalize: (v) => (AQ.isValidSelector(v.trim()) ? v.trim() : null),
    split: /\n+/, // selectors may contain commas and spaces
    empty: 'No custom hiding rules.',
    invalidMsg: 'Not a valid CSS selector'
  }
};

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/** Save a partial settings object, then have the service worker apply it. */
async function save(patch) {
  try {
    await chrome.storage.sync.set(patch);
    const res = await chrome.runtime.sendMessage({ type: 'aq:sync' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not apply settings');
    toast('Saved');
  } catch (e) {
    // e.g. QUOTA_BYTES_PER_ITEM exceeded for very long lists
    toast(`Error: ${e.message || e}`, true);
    throw e;
  }
}

function renderList(name, items) {
  const ul = $(`list-${name}`);
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = LISTS[name].empty;
    ul.append(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = item; // textContent: never interpret user input as HTML
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remove';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      const current = (await chrome.storage.sync.get({ [name]: [] }))[name];
      const next = current.filter((x) => x !== item);
      await save({ [name]: next });
      renderList(name, next);
    });
    li.append(text, btn);
    ul.append(li);
  }
}

function wireAddForm(form) {
  const name = form.dataset.list;
  const cfg = LISTS[name];
  const input = form.querySelector('input, textarea');
  // Ctrl/Cmd+Enter submits a textarea; plain Enter adds a new line.
  if (input.tagName === 'TEXTAREA') {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
    });
  }
  input.addEventListener('input', () => input.classList.remove('invalid'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.split(cfg.split).map((s) => s.trim()).filter(Boolean);
    if (!raw.length) return;

    const valid = [];
    const invalid = [];
    for (const r of raw) {
      const v = cfg.normalize(r);
      (v ? valid : invalid).push(v || r);
    }
    if (invalid.length) {
      input.classList.add('invalid');
      toast(`${cfg.invalidMsg}: ${invalid.slice(0, 3).join(', ')}`, true);
      return;
    }

    const current = (await chrome.storage.sync.get({ [name]: [] }))[name];
    const next = [...new Set([...current, ...valid])];
    await save({ [name]: next });
    renderList(name, next);
    input.value = '';
  });
}

/** Show how many built-in rules ship with the extension (read from our own files). */
async function showRuleCounts() {
  try {
    const { rule_resources: resources } = chrome.runtime.getManifest().declarative_net_request;
    const counts = await Promise.all(
      resources.map(async (r) => {
        const rules = await (await fetch(chrome.runtime.getURL(r.path))).json();
        return `${r.id} ${rules.length}`;
      })
    );
    $('rulesInfo').textContent = `Built-in network rules: ${counts.join(' · ')}`;
  } catch { /* purely informational */ }
}

async function init() {
  $('version').textContent = `Settings · v${chrome.runtime.getManifest().version}`;
  const settings = await chrome.storage.sync.get(AQ.DEFAULT_SETTINGS);

  // enabled / blockVideoAds default ON, hideCookieBanners defaults OFF.
  const DEFAULT_ON = new Set(['enabled', 'blockVideoAds']);
  for (const key of ['enabled', 'blockVideoAds', 'hideCookieBanners']) {
    const box = $(key);
    box.checked = DEFAULT_ON.has(key) ? settings[key] !== false : settings[key] === true;
    box.addEventListener('change', () => save({ [key]: box.checked }).catch(() => { box.checked = !box.checked; }));
  }

  for (const name of Object.keys(LISTS)) renderList(name, settings[name] || []);
  document.querySelectorAll('form.add').forEach(wireAddForm);

  // Keep the page in sync if the popup (or another device) changes something.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in LISTS) renderList(key, newValue || []);
      if (key === 'enabled' || key === 'blockVideoAds') $(key).checked = newValue !== false; // default on
      if (key === 'hideCookieBanners') $(key).checked = newValue === true;                    // default off
    }
  });

  showRuleCounts();
}

init().catch((e) => toast(`Error: ${e.message || e}`, true));
