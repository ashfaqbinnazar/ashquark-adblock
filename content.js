/**
 * Adblock by AshQuark — cosmetic filtering (runs in the ISOLATED world).
 *
 * Registered by background.js at document_start in all frames, together with
 * cosmetic.css (the static hiding rules). This script adds:
 *   1. A <style> with the user's custom selectors, plus cookie-banner hiding
 *      when that option is on. It updates live when settings change.
 *   2. A MutationObserver that takes out self-contained ad units injected
 *      after load (ad iframes and <ins class="adsbygoogle">).
 *   3. Removal of ad overlays and interstitials, then restoring page scrolling
 *      when such an overlay had locked it (body/html overflow: hidden).
 *   4. A relay that passes "popup blocked" events from main-world.js to the
 *      service worker for the popup counter.
 *
 * Safety: generic matches are only *hidden*, never removed, so frameworks
 * like React don't crash when they later touch those nodes. Scroll is only
 * restored after we actually removed an ad overlay. Modals that contain
 * login/form fields are never touched.
 */
(() => {
  'use strict';

  if (globalThis.__ashquarkContent) return; // guard against double injection
  globalThis.__ashquarkContent = true;

  const DEFAULTS = { enabled: true, allowlist: [], customSelectors: [], hideCookieBanners: false };

  // Self-contained ad units that are safe to detach from the DOM.
  const REMOVE_SELECTOR = [
    'ins.adsbygoogle',
    'iframe[id^="google_ads_iframe"]',
    'iframe[name^="google_ads_iframe"]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[src*="amazon-adsystem.com"]',
    'iframe[src*="adnxs.com"]',
    'iframe[src*="taboola.com"]',
    'iframe[src*="outbrain.com"]',
    'iframe[src*="criteo."]',
    'iframe[src*="popads.net"]',
    'iframe[src*="exoclick.com"]'
  ].join(',');

  // Ad containers we hide (not remove), because page code may still own them.
  const HIDE_SELECTOR = [
    'div[id^="div-gpt-ad"]',
    'div[data-google-query-id]',
    'div[id^="taboola-"]',
    '.trc_related_container',
    '.OUTBRAIN'
  ].join(',');

  // Words in an id/class that mark an element as an ad. Whole tokens only, so
  // "header", "shadow", "loading" etc. never match.
  const AD_TOKEN_RE =
    /(?:^|[\s_-])(?:ad|ads|adv|advert|advertisement|adunit|adslot|adbox|sponsor|sponsored|interstitial|popunder|preroll|dfp|gpt-ad)(?:$|[\s_-])/i;
  const COOKIE_TOKEN_RE = /cookie|consent|gdpr|ccpa|cmp|onetrust|cookiebot|didomi|usercentrics|trustarc/i;

  // Common cookie/consent banners, hidden only when the user turns the option on.
  const COOKIE_SELECTORS = [
    '#onetrust-banner-sdk', '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
    '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '#cookiebanner',
    '#cookie-banner', '#cookie-notice', '#cookie-law-info-bar', '.cookie-banner',
    '.cookie-consent', '.cc-window', '.cc-banner', '#didomi-host', '#didomi-popup',
    '.qc-cmp2-container', '#qc-cmp2-container', '.fc-consent-root', '#usercentrics-root',
    '#truste-consent-track', '.truste_overlay', '.truste_box_overlay',
    '[id^="sp_message_container"]', '.osano-cm-window', '#gdpr-cookie-message', '.cmpbox',
    '#cmpbox', '#cmpbox2', '.cookie-notice-container', '#moove_gdpr_cookie_info_bar'
  ];

  // Elements that cosmetic.css hides and that typically come with a scroll lock.
  const OVERLAY_HINT_SELECTOR = [
    '[class*="ad-interstitial" i]', '[id*="ad-interstitial" i]',
    '[class*="ad-overlay" i]', '[id*="ad-overlay" i]',
    '[class*="popunder" i]', '[id*="popunder" i]'
  ].join(',');

  let settings = { ...DEFAULTS };
  let styleEl = null;
  let removedOverlay = false;

  // ---------------------------------------------------------------------------
  // Site checks
  // ---------------------------------------------------------------------------

  /** Hostname of the top-level page, also from inside cross-origin iframes. */
  function topHostname() {
    try {
      if (window === window.top) return location.hostname;
      const origins = location.ancestorOrigins;
      if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
    } catch { /* ignore */ }
    return location.hostname;
  }

  function isAllowlisted(hostname, allowlist) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    return (allowlist || []).some((d) => host === d || host.endsWith('.' + d));
  }

  // ---------------------------------------------------------------------------
  // Injected stylesheet (custom selectors + optional cookie banners)
  // ---------------------------------------------------------------------------

  function buildCss() {
    const rules = [];
    const hide = (sel) => {
      // Rejecting braces/comments means a selector can't escape its rule block.
      if (typeof sel === 'string' && sel.trim() && !/[{}<>]|\/\*/.test(sel)) {
        rules.push(`${sel.trim()}{display:none!important}`);
      }
    };
    (Array.isArray(settings.customSelectors) ? settings.customSelectors : []).forEach(hide);
    if (settings.hideCookieBanners) COOKIE_SELECTORS.forEach(hide);
    // Each selector is its own rule, so one invalid selector can't disable the rest.
    return rules.join('\n');
  }

  function applyStyle() {
    const css = buildCss();
    if (!css) {
      if (styleEl) styleEl.textContent = '';
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-aq', '');
    }
    styleEl.textContent = css;
    const parent = document.head || document.documentElement;
    if (parent && styleEl.parentNode !== parent) parent.appendChild(styleEl);
  }

  // ---------------------------------------------------------------------------
  // Ad element neutralization
  // ---------------------------------------------------------------------------

  function hideEl(el) {
    el.style.setProperty('display', 'none', 'important');
  }

  function neutralize(el) {
    if (el.matches(REMOVE_SELECTOR)) el.remove();
    else hideEl(el);
  }

  /** Remove/hide ad units in a newly added subtree. */
  function sweep(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(REMOVE_SELECTOR) || root.matches(HIDE_SELECTOR)) {
      neutralize(root);
      return;
    }
    if (root.firstElementChild) {
      root.querySelectorAll(REMOVE_SELECTOR).forEach((el) => el.remove());
      root.querySelectorAll(HIDE_SELECTOR).forEach(hideEl);
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay / interstitial removal + scroll restore (top frame only)
  // ---------------------------------------------------------------------------

  const attrText = (el) =>
    `${el.id || ''} ${typeof el.className === 'string' ? el.className : el.getAttribute('class') || ''}`;

  /** Outermost position:fixed ancestor of `el` that covers at least half the viewport. */
  function overlayRoot(el) {
    const area = window.innerWidth * window.innerHeight;
    let found = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).position !== 'fixed') continue;
      const r = n.getBoundingClientRect();
      if (r.width * r.height >= 0.5 * area) found = n;
    }
    return found;
  }

  function isAdOverlay(el) {
    // Never touch dialogs where the user may be typing (login, checkout, newsletter, …).
    if (el.querySelector('input[type="password"], input[type="email"], input[type="text"], textarea')) return false;
    const own = attrText(el);
    if (COOKIE_TOKEN_RE.test(own)) return settings.hideCookieBanners;
    if (AD_TOKEN_RE.test(own)) return true;
    if (el.querySelector(REMOVE_SELECTOR)) return true; // wraps an ad iframe
    for (const child of el.children) {
      if (AD_TOKEN_RE.test(attrText(child))) return true;
    }
    return false;
  }

  function restoreScroll() {
    for (const n of [document.documentElement, document.body]) {
      if (!n) continue;
      const cs = getComputedStyle(n);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        n.style.setProperty('overflow-y', 'auto', 'important');
      }
      // Some lockers pin the body with position:fixed.
      if (n === document.body && cs.position === 'fixed') {
        n.style.setProperty('position', 'static', 'important');
      }
      n.classList.remove('modal-open', 'no-scroll', 'noscroll', 'overflow-hidden', 'scroll-lock', 'disable-scroll');
    }
  }

  function checkOverlays() {
    if (window !== window.top || !document.body) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!vw || !vh) return;

    const seen = new Set();
    for (const [px, py] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.7]]) {
      for (const el of document.elementsFromPoint(vw * px, vh * py)) {
        const root = overlayRoot(el);
        if (!root || seen.has(root)) continue;
        seen.add(root);
        if (isAdOverlay(root)) {
          hideEl(root);
          removedOverlay = true;
        }
      }
    }
    // Overlays already hidden by cosmetic.css (or cookie banners we hid) may have left a scroll lock.
    if (!removedOverlay && document.querySelector(OVERLAY_HINT_SELECTOR)) removedOverlay = true;
    if (!removedOverlay && settings.hideCookieBanners && document.querySelector(COOKIE_SELECTORS.join(','))) {
      removedOverlay = true;
    }
    if (removedOverlay) restoreScroll();
  }

  let overlayTimer = null;
  function scheduleOverlayCheck() {
    if (overlayTimer) return;
    overlayTimer = setTimeout(() => {
      overlayTimer = null;
      try { checkOverlays(); } catch { /* never break the page */ }
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // MutationObserver for dynamically injected ads
  // ---------------------------------------------------------------------------

  const pending = new Set();
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    for (const node of pending) {
      if (node.isConnected) {
        try { sweep(node); } catch { /* ignore */ }
      }
    }
    pending.clear();
    if (styleEl && !styleEl.isConnected) applyStyle(); // some pages wipe <head>
    scheduleOverlayCheck();
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) pending.add(n);
      }
    }
    if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 50); // batch bursts
  });

  // ---------------------------------------------------------------------------
  // Popup-blocked relay (main-world.js -> service worker)
  // ---------------------------------------------------------------------------

  let relayed = 0;
  document.addEventListener('aq:blocked', (e) => {
    if (++relayed > 100) return; // pages could spam the event; cap it
    try {
      chrome.runtime.sendMessage({ type: 'aq:blocked', kind: String(e.detail || 'popup') }).catch(() => {});
    } catch { /* extension reloaded */ }
  }, true);

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  let running = false;

  function start() {
    if (running) return;
    running = true;
    applyStyle();
    const root = document.documentElement;
    if (root) {
      sweep(root);
      observer.observe(root, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scheduleOverlayCheck, { once: true });
    }
    window.addEventListener('load', scheduleOverlayCheck, { once: true });
    scheduleOverlayCheck();
  }

  function stop() {
    running = false;
    observer.disconnect();
    if (styleEl) styleEl.textContent = '';
  }

  const shouldRun = () => settings.enabled !== false && !isAllowlisted(topHostname(), settings.allowlist);

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    if (shouldRun()) start();

    // Live-update custom selectors / cookie option without a reload.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in DEFAULTS) settings[key] = newValue === undefined ? DEFAULTS[key] : newValue;
      }
      if (!shouldRun()) return stop();
      if (!running) return start();
      applyStyle();
      scheduleOverlayCheck();
    });
  }).catch(() => { /* extension context gone */ });
})();
