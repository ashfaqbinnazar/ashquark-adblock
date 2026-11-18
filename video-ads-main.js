/**
 * Adblock by AshQuark — video ad neutralizer (runs in the page's MAIN world).
 *
 * Registered only when "Block video ads" is on (default). Works on any HTML5
 * player (custom tube-site players, video.js, JW Player, Fluid Player, Google IMA,
 * YouTube) because it targets the ad *protocols*, not a site's markup:
 *
 *  1. Ad requests short-circuited: XHR/fetch calls to VAST/VMAP ad-tag URLs
 *     (known ad hosts, or URLs whose path is clearly a VAST/VMAP endpoint) get an
 *     immediate, valid *empty* VAST/VMAP response. Per the IAB spec an empty VAST
 *     means "no ad", so the player starts the main video at once instead of waiting
 *     for a timeout. No request leaves the browser.
 *  2. Ad responses neutralized: any XHR/fetch response whose body IS a VAST/VMAP
 *     document (including first-party-proxied ones) is replaced with the empty one.
 *  3. Player configs pruned: JSON (from fetch/XHR or JSON.parse) is scrubbed of
 *     well-known ad keys (vastUrl, adTagUrl, preroll, midroll, adBreaks, YouTube's
 *     adPlacements/playerAds/adSlots, …). Values are emptied in place, keeping their
 *     type (string -> "", array -> [], boolean -> false, number -> 0), so player
 *     code reading them doesn't crash.
 *
 * Never touched: media segments (.m3u8/.ts/.mp4/.m4s, arraybuffer/blob responses) and any
 * response that isn't VAST/VMAP XML or JSON containing an ad key.
 * Fail-safe: every hook is wrapped in try/catch and falls back to the native result.
 */
(() => {
  'use strict';

  const FLAG = Symbol.for('ashquark.adblock.videoMain');
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true });

  const TAG = '[AshQuark]';
  const warn = (...a) => { try { console.warn(TAG, ...a); } catch { /* ignore */ } };
  const info = (...a) => { try { console.info(TAG, ...a); } catch { /* ignore */ } };

  // Empty documents = "no ad available" in VAST 2/3/4 and VMAP 1.0.
  // (The VMAP namespace URI is an XML identifier, not something we fetch.)
  const EMPTY_VAST = '<?xml version="1.0" encoding="UTF-8"?><VAST version="3.0"></VAST>';
  const EMPTY_VMAP =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>';

  // Video/tube ad servers: every XHR/fetch to these is a VAST/VMAP ad request.
  // (Display-ad exchanges such as Rubicon or Criteo are NOT listed: their XHRs are
  // header-bidding JSON calls. The DNR rules already block those.)
  const VIDEO_AD_HOST_RE = new RegExp(
    '(?:^|\\.)(?:' + [
      'tsyndicate\\.com', 'trafficstars\\.com', 'exoclick\\.com', 'exosrv\\.com', 'exdynsrv\\.com',
      'realsrv\\.com', 'juicyads\\.com', 'trafficjunky\\.(?:net|com)', 'trafficfactory\\.biz',
      'adxpansion\\.com', 'plugrush\\.com', 'ero-advertising\\.com', 'adspyglass\\.com',
      'spotxchange\\.com', 'spotx\\.tv', 'springserve\\.com', 'tremorhub\\.com', 'aniview\\.com',
      'lkqd\\.net', 'innovid\\.com', 'stickyadstv\\.com', 'smartclip\\.net', 'vidazoo\\.com',
      'connatix\\.com', 'primis\\.tech'
    ].join('|') + ')$',
    'i'
  );

  // Google Ad Manager video (IMA) ad tags: /gampad/ads with a video/VAST/VMAP output.
  const GAM_HOST_RE = /(?:^|\.)doubleclick\.net$/i;
  const GAM_VIDEO_QS_RE = /(?:^|&)(?:env=(?:vp|instream)|output=(?:xml_)?(?:vast\d?|vmap\d?)|ad_rule=1)(?:&|$)/i;

  // Paths that are unambiguously VAST/VMAP ad tags, e.g. /vast, /vast.xml, /vast3/,
  // /api/vmap?…, /ads/vast.php. Whole path segments only, so "/vast-landscapes/" is safe.
  const AD_PATH_RE = /\/(?:vast|vmap|vpaid)(?:[234](?:\.\d)?)?(?:\.(?:xml|php|aspx?))?(?:\/|$)/i;

  // Content never to touch, even on an ad host (belt and braces).
  const MEDIA_RE = /\.(?:m3u8|mpd|ts|m4s|mp4|webm|m4a|aac|mp3)(?:$|[?#])/i;

  function classifyUrl(raw) {
    try {
      const u = new URL(String(raw), location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (MEDIA_RE.test(u.pathname)) return null;
      if (AD_PATH_RE.test(u.pathname)) return /vmap/i.test(u.pathname) ? 'vmap' : 'vast';
      if (VIDEO_AD_HOST_RE.test(u.hostname)) return 'vast';
      if (GAM_HOST_RE.test(u.hostname) && /\/gampad\/(?:live\/)?ads/.test(u.pathname) && GAM_VIDEO_QS_RE.test(u.search.slice(1))) {
        return /ad_rule=1|output=(?:xml_)?vmap/i.test(u.search) ? 'vmap' : 'vast';
      }
    } catch { /* bad URL: leave alone */ }
    return null;
  }

  const looksLikeVast = (s) => typeof s === 'string' && s.length < 2e6 && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<VAST[\s>]/i.test(s.slice(0, 4096));
  const looksLikeVmap = (s) => typeof s === 'string' && s.length < 2e6 && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:vmap:)?VMAP[\s>]/i.test(s.slice(0, 4096));

  /** Replacement body for an ad XML document, or null when `text` isn't one. */
  function neutralXml(text) {
    if (looksLikeVmap(text)) return EMPTY_VMAP;
    if (looksLikeVast(text) && /<Ad[\s>]/i.test(text)) return EMPTY_VAST; // already-empty VAST left alone
    return null;
  }

  // ---------------------------------------------------------------------------
  // JSON pruning
  // ---------------------------------------------------------------------------

  // Exact key names (case-insensitive) that hold ad configuration in common players.
  const AD_KEYS = [
    'vast', 'vastUrl', 'vast_url', 'vastTag', 'vastTagUrl', 'vast_tag', 'vastTags', 'vastXml',
    'vmap', 'vmapUrl', 'vmap_url', 'adTag', 'adTagUrl', 'ad_tag', 'ad_tag_url', 'adTagUri',
    'preroll', 'prerolls', 'preRoll', 'pre_roll', 'midroll', 'midrolls', 'midRoll', 'mid_roll',
    'postroll', 'postrolls', 'postRoll', 'post_roll', 'adBreaks', 'ad_breaks', 'adSchedule',
    'ad_schedule', 'vpaid', 'videoAds', 'video_ads', 'adsConfig', 'imaAdTag',
    // YouTube player responses
    'adPlacements', 'adSlots', 'playerAds'
  ];
  const AD_KEY_SET = new Set(AD_KEYS.map((k) => k.toLowerCase()));
  const AD_KEY_TEXT_RE = new RegExp('"(?:' + AD_KEYS.join('|') + ')"\\s*:', 'i');

  /** Empty a value while keeping its type, so code that reads it doesn't throw. */
  function emptied(v) {
    if (Array.isArray(v)) return [];
    switch (typeof v) {
      case 'string': return '';
      case 'number': return 0;
      case 'boolean': return false;
      case 'object':
        if (v === null) return null;
        // e.g. preroll: { enabled: true, url: "…" } -> { enabled: false, url: "" }
        for (const k of Object.keys(v)) {
          const x = v[k];
          if (typeof x !== 'object' || x === null || Array.isArray(x)) v[k] = emptied(x);
        }
        return v;
      default: return v;
    }
  }

  /** Recursively empty ad keys in a parsed JSON value. Returns how many were changed. */
  function prune(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return 0;
    let n = 0;
    if (Array.isArray(node)) {
      for (const item of node) n += prune(item, depth + 1);
      return n;
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (AD_KEY_SET.has(key.toLowerCase()) && val !== null && val !== '' && val !== false && val !== 0) {
        node[key] = emptied(val);
        n++;
      } else if (val && typeof val === 'object') {
        n += prune(val, depth + 1);
      }
    }
    return n;
  }

  /** JSON text -> pruned JSON text (or null when there's nothing to change). */
  function prunedJsonText(text) {
    if (typeof text !== 'string' || text.length > 8e6 || !AD_KEY_TEXT_RE.test(text)) return null;
    const first = text.trimStart()[0];
    if (first !== '{' && first !== '[') return null;
    try {
      const data = nativeJsonParse(text);
      return prune(data) ? JSON.stringify(data) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // toString masking (same technique as main-world.js; per-script, harmless if both run)
  // ---------------------------------------------------------------------------
  const nativeFnToString = Function.prototype.toString;
  const masks = new WeakMap();
  const toString = function toString() {
    return Reflect.apply(nativeFnToString, masks.get(this) || this, arguments);
  };
  masks.set(toString, nativeFnToString);
  Function.prototype.toString = toString;
  const disguise = (fn, original) => (masks.set(fn, original), fn);

  let stats = 0;
  const note = (what, detail) => {
    stats++;
    if (stats <= 20) info(`video ad ${what}`, detail || '');
    try { document.dispatchEvent(new CustomEvent('aq:blocked', { detail: 'videoad' })); } catch { /* ignore */ }
  };

  // ---------------------------------------------------------------------------
  // JSON.parse (inline player configs are often parsed with it)
  // ---------------------------------------------------------------------------
  const nativeJsonParse = JSON.parse;
  JSON.parse = disguise(function parse(text, reviver) {
    const result = Reflect.apply(nativeJsonParse, this, arguments);
    try {
      if (typeof text === 'string' && text.length < 8e6 && AD_KEY_TEXT_RE.test(text) && prune(result)) {
        note('config pruned', 'JSON.parse');
      }
    } catch (e) { warn('JSON prune failed', e); }
    return result;
  }, nativeJsonParse);

  // ---------------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = disguise(function fetch(input, init) {
      try {
        const url = input instanceof Request ? input.url : input;
        const kind = classifyUrl(url);
        if (kind) {
          note('request answered with empty ' + kind.toUpperCase(), String(url).slice(0, 120));
          return Promise.resolve(new Response(kind === 'vmap' ? EMPTY_VMAP : EMPTY_VAST, {
            status: 200,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' }
          }));
        }
      } catch (e) { warn('fetch hook failed', e); }
      return Reflect.apply(nativeFetch, this, arguments);
    }, nativeFetch);
  }

  // Response bodies: VAST/VMAP documents and ad keys in JSON.
  const R = Response.prototype;
  const nativeText = R.text;
  const nativeJson = R.json;
  const isTextual = (res) => {
    const ct = (res.headers && res.headers.get('content-type')) || '';
    return ct === '' || /xml|json|text|javascript/i.test(ct);
  };

  R.text = disguise(function text() {
    const p = Reflect.apply(nativeText, this, arguments);
    if (!isTextual(this)) return p;
    return p.then((body) => {
      try {
        const xml = neutralXml(body);
        if (xml) { note('response emptied', this.url); return xml; }
        const json = prunedJsonText(body);
        if (json) { note('config pruned', this.url); return json; }
      } catch (e) { warn('response hook failed', e); }
      return body;
    });
  }, nativeText);

  R.json = disguise(function json() {
    return Reflect.apply(nativeJson, this, arguments).then((data) => {
      try { if (prune(data)) note('config pruned', this.url); } catch (e) { warn('json hook failed', e); }
      return data;
    });
  }, nativeJson);

  // ---------------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------------
  const X = XMLHttpRequest.prototype;
  const nativeOpen = X.open;
  const xhrUrl = new WeakMap();      // xhr -> requested URL
  const xhrCache = new WeakMap();    // xhr -> { text, doc, json } replacement

  X.open = disguise(function open(method, url) {
    try {
      const kind = classifyUrl(url);
      if (kind) {
        // Answer locally from a data: URL; the player sees a normal 200 with "no ad".
        note('request answered with empty ' + kind.toUpperCase(), String(url).slice(0, 120));
        const args = Array.from(arguments);
        args[1] = 'data:application/xml;charset=utf-8,' + encodeURIComponent(kind === 'vmap' ? EMPTY_VMAP : EMPTY_VAST);
        xhrUrl.set(this, args[1]);
        return Reflect.apply(nativeOpen, this, args);
      }
      xhrUrl.set(this, String(url));
    } catch (e) { warn('xhr open hook failed', e); }
    return Reflect.apply(nativeOpen, this, arguments);
  }, nativeOpen);

  // Data URLs can't carry credentials; drop withCredentials for our local answers.
  const wcDesc = Object.getOwnPropertyDescriptor(X, 'withCredentials');
  if (wcDesc && wcDesc.set) {
    Object.defineProperty(X, 'withCredentials', {
      ...wcDesc,
      set: disguise(function (v) {
        const u = xhrUrl.get(this);
        return Reflect.apply(wcDesc.set, this, [u && u.startsWith('data:') ? false : v]);
      }, wcDesc.set)
    });
  }

  const desc = (name) => Object.getOwnPropertyDescriptor(X, name);
  const dText = desc('responseText');
  const dResp = desc('response');
  const dXml = desc('responseXML');
  const dType = desc('responseType');
  const dState = desc('readyState');

  /** Work out (once, when the request is DONE) whether this XHR's body must be replaced. */
  function replacementFor(xhr) {
    if (xhrCache.has(xhr)) return xhrCache.get(xhr);
    if (Reflect.apply(dState.get, xhr, []) !== 4) return null; // not finished: don't cache
    let rep = null;
    try {
      const type = Reflect.apply(dType.get, xhr, []);
      if (type === '' || type === 'text') {
        const body = Reflect.apply(dText.get, xhr, []);
        const xml = neutralXml(body);
        if (xml) rep = { text: xml };
        else {
          const json = prunedJsonText(body);
          if (json) rep = { text: json };
        }
      } else if (type === 'document') {
        const doc = Reflect.apply(dResp.get, xhr, []);
        const root = doc && doc.documentElement;
        if (root && /^(?:VAST|vmap:VMAP|VMAP)$/i.test(root.nodeName) && (root.nodeName.toLowerCase() !== 'vast' || root.querySelector('Ad'))) {
          rep = { text: root.nodeName.toLowerCase() === 'vast' ? EMPTY_VAST : EMPTY_VMAP };
        }
      } else if (type === 'json') {
        // Chrome hands out a fresh object on every .response read, so the pruned
        // object must be cached and returned from then on.
        const data = Reflect.apply(dResp.get, xhr, []);
        if (prune(data)) {
          note('config pruned', xhrUrl.get(xhr));
          xhrCache.set(xhr, { json: data });
          return xhrCache.get(xhr);
        }
      }
      // arraybuffer / blob (media segments) are never inspected.
      if (rep) {
        rep.doc = new DOMParser().parseFromString(rep.text, 'text/xml');
        note(rep.text.startsWith('<') ? 'response emptied' : 'config pruned', xhrUrl.get(xhr));
      }
    } catch (e) {
      warn('xhr response hook failed', e);
    }
    xhrCache.set(xhr, rep);
    return rep;
  }

  const hookGetter = (name, d, pick) => {
    if (!d || !d.get) return;
    Object.defineProperty(X, name, {
      ...d,
      get: disguise(function () {
        const native = Reflect.apply(d.get, this, []);
        try {
          const rep = replacementFor(this);
          if (rep) return pick(rep, this, native);
        } catch { /* fall through */ }
        return native;
      }, d.get)
    });
  };

  hookGetter('responseText', dText, (rep, xhr, native) => ('text' in rep ? rep.text : native));
  hookGetter('responseXML', dXml, (rep, xhr, native) => ('doc' in rep ? rep.doc : native));
  hookGetter('response', dResp, (rep, xhr, native) => {
    const type = Reflect.apply(dType.get, xhr, []);
    if (type === '' || type === 'text') return rep.text;
    if (type === 'document') return rep.doc;
    if (type === 'json' && 'json' in rep) return rep.json;
    return native;
  });

  // A new open() on a reused XHR object starts a fresh request.
  X.open = disguise(((prevOpen) => function open() {
    xhrCache.delete(this);
    return Reflect.apply(prevOpen, this, arguments);
  })(X.open), nativeOpen);
})();
