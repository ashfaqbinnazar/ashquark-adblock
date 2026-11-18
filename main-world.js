/**
 * Adblock by AshQuark — popup / popunder blocker (runs in the page's MAIN world).
 *
 * Registered by background.js with world: "MAIN", run_at: document_start,
 * all_frames: true, so it runs before any page script and can wrap window.open.
 * It has no access to chrome.* APIs. It reports blocks to content.js through a
 * DOM CustomEvent ("aq:blocked"), and content.js forwards them to the service worker.
 *
 * Policy for opening a new window or tab (window.open, or a scripted click on a
 * target=_blank link):
 *   1. There must be a real (isTrusted) user gesture in THIS document within the
 *      last second. One gesture allows only one new window, which stops a
 *      "one click, three popunders" script.
 *   2. Same-origin URLs are allowed after such a gesture.
 *   3. Cross-origin URLs (and about:blank, often used as a popunder trampoline)
 *      are only allowed if the user clicked a genuine interactive control
 *      (link, button, …) that isn't a transparent full-page click-jacking layer.
 *      If the user clicked a real link, the opened URL must also match that link's
 *      origin, so a script can't swap in an ad.
 *
 * Tab-under / target=_blank hijack protection: right after a new tab is opened
 * (or a popup is blocked), a cross-origin, script-initiated navigation of the
 * current page is cancelled for 2 seconds. The Navigation API makes this possible.
 */
(() => {
  'use strict';

  const FLAG = Symbol.for('ashquark.adblock.main');
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true });

  const GESTURE_TTL_MS = 1000;   // how long a click "authorizes" a new window
  const NAV_GUARD_MS = 2000;     // how long to guard against tab-under redirects
  const now = () => performance.now();

  // ---- Keep wrapped functions looking native (some sites check .toString()) ----
  const nativeFnToString = Function.prototype.toString;
  const masks = new WeakMap();
  const toString = function toString() {
    return Reflect.apply(nativeFnToString, masks.get(this) || this, arguments);
  };
  masks.set(toString, nativeFnToString);
  Function.prototype.toString = toString;
  const disguise = (fn, original) => (masks.set(fn, original), fn);

  // ---- Notify content.js (isolated world) of a block, for the popup counter ----
  const notify = (kind) => {
    try { document.dispatchEvent(new CustomEvent('aq:blocked', { detail: String(kind) })); } catch { /* ignore */ }
  };

  // ---------------------------------------------------------------------------
  // User-gesture tracking
  // ---------------------------------------------------------------------------
  const gesture = { time: -Infinity, target: null, used: false };

  // Our capture listeners on window are registered first, so they run before page handlers.
  const onGestureStart = (e) => {
    if (!e.isTrusted) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    gesture.time = now();
    gesture.target = (e.composedPath && e.composedPath()[0]) || e.target;
    gesture.used = false; // a new physical gesture allows one new window
  };
  const onGestureEnd = (e) => {
    if (!e.isTrusted) return;
    gesture.time = now();
    gesture.target = (e.composedPath && e.composedPath()[0]) || e.target;
  };
  for (const t of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
    window.addEventListener(t, onGestureStart, { capture: true, passive: true });
  }
  for (const t of ['click', 'pointerup', 'touchend']) {
    window.addEventListener(t, onGestureEnd, { capture: true, passive: true });
  }

  const INTERACTIVE =
    'a[href],area[href],button,input,select,textarea,label,summary,' +
    '[role="button"],[role="link"],[role="menuitem"],[role="tab"],[onclick]';

  /** The interactive element the user actually clicked, or null if it looks like click-jacking. */
  function genuineClickTarget(node) {
    const el = node instanceof Element ? node : node && node.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const hit = el.closest(INTERACTIVE);
    if (!hit) return null; // clicked plain text / background: typical popunder trigger
    const r = hit.getBoundingClientRect();
    // Invisible layers stretched over the page are a classic popunder trick.
    if (r.width * r.height > 0.6 * window.innerWidth * window.innerHeight) return null;
    return hit;
  }

  function resolveUrl(raw) {
    try {
      return new URL(raw == null || raw === '' ? 'about:blank' : String(raw), location.href);
    } catch {
      return null;
    }
  }

  const isNewWindowTarget = (t) => {
    t = String(t || '').toLowerCase();
    return t !== '' && t !== '_self' && t !== '_top' && t !== '_parent';
  };

  /** Decide whether a new window/tab for `rawUrl` may open now. Consumes the gesture if so. */
  function allowNewWindow(rawUrl) {
    if (gesture.used || now() - gesture.time > GESTURE_TTL_MS) return false;
    const url = resolveUrl(rawUrl);
    if (!url) return false;

    if (url.origin !== location.origin) {
      const hit = genuineClickTarget(gesture.target);
      if (!hit) return false;
      // Clicked a real link but a different site is being opened: likely an ad swap.
      if (hit.href && /^https?:/i.test(hit.href)) {
        const linkOrigin = resolveUrl(hit.href);
        if (linkOrigin && linkOrigin.origin !== url.origin && linkOrigin.origin !== location.origin) return false;
      }
    }
    gesture.used = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Tab-under / redirect guard (Navigation API, Chrome 102+)
  // ---------------------------------------------------------------------------
  let guardUntil = 0;
  const armNavGuard = () => { guardUntil = now() + NAV_GUARD_MS; };
  const isCrossOrigin = (raw) => {
    const u = resolveUrl(raw);
    return !!u && u.origin !== location.origin;
  };

  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', (e) => {
      if (now() > guardUntil) return;
      if (!e.cancelable || e.userInitiated || e.hashChange || e.downloadRequest !== null) return;
      if (!isCrossOrigin(e.destination.url)) return;
      e.preventDefault(); // script tried to redirect this tab right after opening a new one
      notify('redirect');
    });
  }

  // ---------------------------------------------------------------------------
  // window.open wrapper
  // ---------------------------------------------------------------------------
  function makeOpen(originalOpen) {
    const open = function open(url, target /* , features */) {
      // Navigating this or an ancestor frame isn't a popup; let it through.
      // (For window.open an empty/missing target means "new window", unlike <a target>.)
      const t = String(target == null ? '' : target).toLowerCase();
      if (t === '_self' || t === '_top' || t === '_parent') {
        return Reflect.apply(originalOpen, this, arguments);
      }
      if (!allowNewWindow(url)) {
        armNavGuard();
        notify('popup');
        return null; // same as Chrome's built-in popup blocker
      }
      if (isCrossOrigin(url)) armNavGuard();
      return Reflect.apply(originalOpen, this, arguments);
    };
    return disguise(open, originalOpen);
  }

  window.open = makeOpen(window.open);

  // Popunder scripts grab a pristine window.open from a fresh about:blank iframe.
  // Patch same-origin child windows the moment the page asks for them.
  const patchedWindows = new WeakSet([window]);
  function patchChildWindow(w) {
    try {
      if (!w || patchedWindows.has(w)) return;
      const childOpen = w.open; // throws for cross-origin frames: they get their own copy of this script
      patchedWindows.add(w);
      w.open = makeOpen(childOpen);
    } catch { /* cross-origin */ }
  }
  for (const Ctor of [window.HTMLIFrameElement, window.HTMLFrameElement]) {
    const desc = Ctor && Object.getOwnPropertyDescriptor(Ctor.prototype, 'contentWindow');
    if (!desc || !desc.get) continue;
    Object.defineProperty(Ctor.prototype, 'contentWindow', {
      ...desc,
      get: disguise(function () {
        const w = Reflect.apply(desc.get, this, []);
        patchChildWindow(w);
        return w;
      }, desc.get)
    });
  }

  // ---------------------------------------------------------------------------
  // target=_blank links
  // ---------------------------------------------------------------------------
  const isLink = (n) => n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement;

  /** Cross-origin new-tab links get rel=noopener so the new page can't redirect this one. */
  function hardenRel(a) {
    try {
      if (isCrossOrigin(a.href) && !a.relList.contains('noopener')) a.relList.add('noopener');
    } catch { /* ignore */ }
  }

  window.addEventListener('click', (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const a = path.find(isLink);
    if (!a || !a.href || !isNewWindowTarget(a.target)) return;
    hardenRel(a);

    if (e.isTrusted) {
      // A real click on a new-tab link: this click has now used its one window,
      // so a script can't piggyback a popunder on it, and the current tab is
      // guarded against being redirected behind the user's back.
      gesture.used = true;
      if (isCrossOrigin(a.href)) armNavGuard();
      return;
    }
    // Synthetic click (a.click() / dispatchEvent) on a new-tab link = scripted popup.
    if (!allowNewWindow(a.href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      armNavGuard();
      notify('popup');
    }
  }, true);

  // Detached links (never inserted in the page) don't pass through the listener
  // above, so cover HTMLElement#click and EventTarget#dispatchEvent for them.
  const blockDetachedLink = (el) =>
    isLink(el) && !el.isConnected && el.href && isNewWindowTarget(el.target) && !allowNewWindow(el.href);

  const nativeClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = disguise(function click() {
    if (blockDetachedLink(this)) { armNavGuard(); notify('popup'); return undefined; }
    return Reflect.apply(nativeClick, this, arguments);
  }, nativeClick);

  // Popunders also use <form target="_blank"> + form.submit(), which opens a new
  // tab without window.open or a link. Apply the same gesture policy.
  for (const method of ['submit', 'requestSubmit']) {
    const native = HTMLFormElement.prototype[method];
    if (typeof native !== 'function') continue;
    HTMLFormElement.prototype[method] = disguise({
      [method]() {
        try {
          const target = (arguments[0] && arguments[0].formTarget) || this.target;
          if (isNewWindowTarget(target) && !allowNewWindow(this.action)) {
            armNavGuard();
            notify('popup');
            return undefined;
          }
        } catch { /* fall through to native */ }
        return Reflect.apply(native, this, arguments);
      }
    }[method], native);
  }

  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = disguise(function dispatchEvent(event) {
    if (event && event.type === 'click' && blockDetachedLink(this)) { armNavGuard(); notify('popup'); return false; }
    return Reflect.apply(nativeDispatch, this, arguments);
  }, nativeDispatch);
})();
