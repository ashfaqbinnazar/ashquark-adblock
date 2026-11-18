/**
 * Adblock by AshQuark — video ad skipper (runs in the ISOLATED world).
 *
 * Second line of defence behind video-ads-main.js (which empties VAST/VMAP
 * responses and ad keys in player configs). If an ad still plays, this script:
 *   1. detects an ad <video> from strong signals only:
 *        - the player root carries an ad *state* class (ad-showing, ads-playing,
 *          vjs-ad-playing, jw-flag-ads, …), or
 *        - the <video> itself (or its container, ≤3 levels up) is marked as an ad
 *          (ima-ad-container, video-ad, preroll, …), or
 *        - its source is on a known video-ad server;
 *   2. skips it: mutes it and seeks to the end (the player's "ended" handler then
 *      resumes the main video). If that doesn't work, it plays at 16× speed;
 *   3. auto-clicks "Skip ad" buttons the moment they appear;
 *   4. hides ad overlays/banners inside the player (pause ads, corner banners);
 *   5. makes sure the main video resumes playing.
 *
 * Main-video safety:
 *   - Only playing videos are touched. A source is re-skipped only if it restarts
 *     within 20 s, at most 3 times, so a false positive can never loop.
 *   - Videos longer than 3 minutes are only skipped when served by a known
 *     video-ad server, because ads are short and the main content usually isn't.
 *   - Every detection is re-checked 250 ms later before acting, which survives the
 *     moment a player switches from the ad back to the content.
 *   - Everything is wrapped in try/catch and logged with "[AshQuark]".
 */
(() => {
  'use strict';

  if (globalThis.__ashquarkVideoAds) return;
  globalThis.__ashquarkVideoAds = true;

  const TAG = '[AshQuark]';
  const log = (...a) => { try { console.info(TAG, ...a); } catch { /* ignore */ } };
  const warn = (...a) => { try { console.warn(TAG, ...a); } catch { /* ignore */ } };

  // The player is currently in "ad mode" (YouTube, video.js + IMA, JW Player, Plyr,
  // Clappr, Flowplayer, Fluid Player, generic). Matched against classes of ancestors.
  const AD_STATE_RE =
    /(?:^|\s)(?:ad-showing|ad-interrupting|vjs-ad-playing|vjs-ad-loading|jw-flag-ads|jw-flag-ads-vpaid|plyr--ad-playing|ad-playing|ads-playing|playing-ad|ad-mode|ad-active|is-ad|is-ad-playing|vast-playing|preroll-playing|midroll-playing|fluid_ad_playing)(?:\s|$)/i;

  // The element itself is an ad video / ad container.
  const AD_CONTAINER_RE =
    /(?:^|[\s_-])(?:ima-ad-container|videoAdUi|video-ads|ad-video|video-ad|ad-player|adplayer|vast|vpaid|preroll|pre-roll|midroll|mid-roll|postroll|instream-ad|fluid_vast[\w-]*)(?:$|[\s_-])/i;

  // Generic ad tokens for overlays inside a player (whole tokens only).
  const AD_TOKEN_RE =
    /(?:^|[\s_-])(?:ad|ads|advert|advertisement|adunit|adbox|sponsor|sponsored|banner-ad|pause-ad|overlay-ad|promo-ad)(?:$|[\s_-])/i;

  const VIDEO_AD_SRC_RE =
    /(?:^|\/\/|\.)(?:tsyndicate\.com|trafficstars\.com|exoclick\.com|exosrv\.com|exdynsrv\.com|realsrv\.com|juicyads\.com|trafficjunky\.(?:net|com)|trafficfactory\.biz|adxpansion\.com|plugrush\.com|doubleclick\.net|googlesyndication\.com|spotxchange\.com|springserve\.com|tremorhub\.com|innovid\.com|aniview\.com|lkqd\.net|vidazoo\.com|connatix\.com|primis\.tech|teads\.tv|serving-sys\.com|flashtalking\.com)\//i;

  // "Skip ad", "Skip Ads ›", "Skip advertisement", "Skip ▶▶", … (not "Skip intro").
  const SKIP_TEXT_RE = /^\s*(?:skip(?:\s+(?:this\s+)?(?:ad|ads|advert|advertisement|video ad))?|pular an[uú]ncio|omitir anuncio|überspringen|passer la pub(?:licité)?|salta annuncio)\s*[›»>▸▶⏭→\s]*$/i;
  const SKIP_CLASS_RE = /skip/i;

  const MAX_AD_SECONDS = 180;

  // key (src + duration) -> { count, last }: limits how often one source is skipped.
  const skipLog = new Map();
  const MAX_SKIPS_PER_SRC = 3;
  const RESKIP_WINDOW_MS = 20000;
  const clicked = new WeakSet();
  const pendingCheck = new WeakSet();

  const classOf = (el) => (el && typeof el.className === 'string' ? el.className : (el && el.getAttribute && el.getAttribute('class')) || '');
  const idOf = (el) => (el && el.id) || '';

  /** Ancestors of `el`, nearest first, up to `max` levels. */
  function ancestors(el, max) {
    const out = [];
    for (let n = el && el.parentElement; n && out.length < max; n = n.parentElement) out.push(n);
    return out;
  }

  /** The visually dominant ancestor that wraps the video (the player root). */
  function playerRoot(video) {
    const vr = video.getBoundingClientRect();
    let root = video.parentElement || video;
    for (const a of ancestors(video, 8)) {
      if (a === document.body || a === document.documentElement) break;
      const r = a.getBoundingClientRect();
      // Stop once the ancestor is much bigger than the video (page column, etc.).
      if (r.width > vr.width * 1.6 + 40 || r.height > vr.height * 1.8 + 120) break;
      root = a;
    }
    return root;
  }

  function inAdState(video) {
    if (AD_STATE_RE.test(classOf(video))) return true;
    return ancestors(video, 8).some((a) => AD_STATE_RE.test(classOf(a)));
  }

  function markedAsAd(video) {
    if (AD_CONTAINER_RE.test(`${idOf(video)} ${classOf(video)}`)) return true;
    return ancestors(video, 3).some((a) => AD_CONTAINER_RE.test(`${idOf(a)} ${classOf(a)}`));
  }

  function adSource(video) {
    const src = video.currentSrc || video.src || '';
    return VIDEO_AD_SRC_RE.test(src);
  }

  /** Is a visible "skip ad" control or "Ad" label present in this player? */
  function adUiVisible(root) {
    if (!root) return false;
    for (const el of root.querySelectorAll('[class*="skip" i],[class*="ad-text" i],[class*="ad-label" i],[class*="ad-badge" i],[class*="countdown" i]')) {
      if (isVisible(el) && /\b(?:ad|ads|advert|advertisement|skip)\b/i.test(el.textContent || el.getAttribute('aria-label') || '')) {
        return true;
      }
    }
    return false;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  /** Decide whether `video` is currently playing an ad. */
  function isAdVideo(video) {
    const duration = video.duration;
    const shortEnough = Number.isFinite(duration) && duration > 0 && duration <= MAX_AD_SECONDS;
    if (adSource(video)) return true;                  // served by a video-ad server
    if (!shortEnough) return false;                    // long video: treat as content
    if (inAdState(video)) return true;                 // player says "ad is playing"
    if (markedAsAd(video)) return true;                // dedicated ad <video>
    return adUiVisible(playerRoot(video));             // short video + visible ad UI
  }

  /** Play the main video(s) in the same player if they're paused after an ad. */
  function resumeMain(adVideo) {
    setTimeout(() => {
      try {
        const root = playerRoot(adVideo);
        const scope = (root && root.parentElement) || document;
        for (const v of scope.querySelectorAll('video')) {
          if (v === adVideo || !v.paused || v.ended || isAdVideo(v)) continue;
          if (!isVisible(v)) continue;
          const p = v.play();
          if (p && p.catch) p.catch(() => { /* autoplay policy: user can press play */ });
        }
      } catch (e) { warn('resume failed', e); }
    }, 350);
  }

  function skip(video) {
    const key = (video.currentSrc || video.src || '') + '#' + Math.round(video.duration || 0);
    const entry = skipLog.get(key) || { count: 0, last: 0 };
    // A player may restart an ad we skipped (play() on an ended video starts from 0),
    // so re-skip within a short window. A user replaying it later is left alone,
    // and the cap stops any loop.
    if (entry.count >= MAX_SKIPS_PER_SRC) return;
    if (entry.count > 0 && Date.now() - entry.last > RESKIP_WINDOW_MS) return;
    entry.count++;
    entry.last = Date.now();
    skipLog.set(key, entry);
    try {
      video.muted = true;
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) {
        video.currentTime = d; // jump to the end -> "ended" -> player loads content
        log('skipped video ad', `${d.toFixed(1)}s`, (video.currentSrc || '').slice(0, 100));
      } else {
        video.playbackRate = 16; // live/unknown duration: fast-forward instead
        log('fast-forwarding video ad (unknown duration)');
      }
      try { document.dispatchEvent(new CustomEvent('aq:blocked', { detail: 'videoad' })); } catch { /* ignore */ }
    } catch (e) {
      warn('skip failed', e);
    }
    resumeMain(video);
  }

  function checkVideo(video) {
    try {
      if (!(video instanceof HTMLVideoElement) || video.ended) return;
      if (video.readyState < 1) return; // wait for metadata (duration)
      // Only act on a video that is actually playing: seeking before playback starts
      // is undone when the player then calls play() (which restarts an ended video).
      if (video.paused) return;
      if (!isAdVideo(video) || pendingCheck.has(video)) return;
      // Re-check shortly after: players flip their "ad mode" class around the
      // ad→content switch, and we must never fast-forward the real video.
      pendingCheck.add(video);
      setTimeout(() => {
        pendingCheck.delete(video);
        try { if (!video.ended && isAdVideo(video)) skip(video); } catch (e) { warn('video check failed', e); }
      }, 250);
    } catch (e) {
      warn('video check failed', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Skip buttons
  // ---------------------------------------------------------------------------
  function clickSkipButtons(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const candidates = scope.querySelectorAll(
      'button, [role="button"], [class*="skip" i], [id*="skip" i], [aria-label*="skip" i]'
    );
    for (const el of candidates) {
      if (clicked.has(el)) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (label.length > 40) continue;
      const textMatch = SKIP_TEXT_RE.test(label);
      const bareSkip = /^\s*skip\s*[›»>▸▶⏭→]*\s*$/i.test(label);
      const classMatch = SKIP_CLASS_RE.test(`${idOf(el)} ${classOf(el)}`) && /\bad/i.test(`${idOf(el)} ${classOf(el)}`);
      if (!textMatch && !classMatch) continue;
      // A bare "Skip" only counts inside a player that is in ad mode.
      if (bareSkip && !classMatch) {
        const video = el.closest('div, section, figure') && el.closest('div, section, figure').querySelector('video');
        const v = video || findNearbyVideo(el);
        if (!v || !(inAdState(v) || markedAsAd(v) || adSource(v))) continue;
      }
      if (!isVisible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      clicked.add(el);
      try {
        el.click();
        log('clicked skip button:', label || classOf(el));
      } catch (e) { warn('skip click failed', e); }
    }
  }

  function findNearbyVideo(el) {
    for (const a of ancestors(el, 6)) {
      const v = a.querySelector('video');
      if (v) return v;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Overlays inside players (pause ads, corner banners, "click to visit" layers)
  // ---------------------------------------------------------------------------
  function cleanPlayer(video) {
    try {
      const root = playerRoot(video);
      if (!root || root === document.body) return;
      for (const el of root.querySelectorAll('[class],[id]')) {
        // Never a <video> (players reuse one element for ad + content; skipping
        // handles ads) and never anything wrapping a video.
        if (el.tagName === 'VIDEO' || el.contains(video) || el.querySelector('video')) continue;
        if (el.closest('[class*="control" i],[class*="progress" i],[class*="seek" i]')) continue; // player UI
        const attrs = `${idOf(el)} ${classOf(el)}`;
        if (!AD_TOKEN_RE.test(attrs) && !AD_CONTAINER_RE.test(attrs)) continue;
        if (/skip/i.test(attrs)) continue; // leave skip buttons clickable
        if (el.style.getPropertyValue('display') === 'none') continue;
        el.style.setProperty('display', 'none', 'important');
        log('hid in-player ad element', attrs.trim().slice(0, 80));
      }
      // Ad iframes laid over the player.
      for (const f of root.querySelectorAll('iframe')) {
        const src = f.src || '';
        if (VIDEO_AD_SRC_RE.test(src) || /\/(?:ads?|banner|vast)\//i.test(src)) {
          f.style.setProperty('display', 'none', 'important');
        }
      }
    } catch (e) {
      warn('player cleanup failed', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function scan() {
    const videos = document.getElementsByTagName('video');
    if (!videos.length) return;
    for (const v of videos) {
      checkVideo(v);
      cleanPlayer(v);
    }
    clickSkipButtons(document);
  }

  // Media events don't bubble, but they do pass through the capture phase on document.
  for (const type of ['loadedmetadata', 'durationchange', 'playing', 'play']) {
    document.addEventListener(type, (e) => {
      if (e.target instanceof HTMLVideoElement) checkVideo(e.target);
    }, true);
  }

  let scheduled = null;
  const schedule = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      try { scan(); } catch (e) { warn('scan failed', e); }
    }, 120);
  };

  function startObserving() {
    const root = document.documentElement;
    if (!root) return;
    // Class changes catch players switching into ad mode (e.g. mid-rolls).
    new MutationObserver(schedule).observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'src', 'style']
    });
    // Safety net for players that never mutate the DOM: a cheap poll, only when a video exists.
    setInterval(() => { if (document.getElementsByTagName('video').length) schedule(); }, 1000);
    schedule();
  }

  // Respect the allowlist and the toggles (the service worker also unregisters us when off).
  chrome.storage.sync.get({ enabled: true, blockVideoAds: true, allowlist: [] }).then((s) => {
    const host = (() => {
      try {
        if (window === window.top) return location.hostname;
        const o = location.ancestorOrigins;
        return o && o.length ? new URL(o[o.length - 1]).hostname : location.hostname;
      } catch { return location.hostname; }
    })().toLowerCase().replace(/^www\./, '');
    const allowlisted = (s.allowlist || []).some((d) => host === d || host.endsWith('.' + d));
    if (s.enabled === false || s.blockVideoAds === false || allowlisted) return;
    startObserving();
  }).catch(() => { /* extension context gone */ });
})();
