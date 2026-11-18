/**
 * Adblock by AshQuark — shared helpers.
 *
 * Loaded by the service worker (importScripts) and by popup.html / options.html
 * (<script src>). Everything hangs off a single global `AQ` object.
 * Pure functions only: no network, no chrome.* side effects.
 */
'use strict';

(function (root) {
  /** Settings stored in chrome.storage.sync, with their defaults. */
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,            // global on/off switch
    allowlist: [],            // domains where blocking is turned off
    customDomains: [],        // user-added domains to block (dynamic DNR rules)
    customSelectors: [],      // user-added CSS selectors to hide
    hideCookieBanners: false, // optional: hide cookie/consent banners (off by default)
    blockVideoAds: true       // pre-roll / mid-roll / VAST video ads (on by default)
  });

  // A conservative hostname check: labels of [a-z0-9-], at least one dot, valid TLD.
  const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

  /**
   * Turn user input ("https://www.Example.com/path", "*.example.com", "example.com")
   * into a bare, lower-case, punycoded domain, or null when it isn't valid.
   */
  function normalizeDomain(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');  // scheme
    s = s.split(/[/?#]/)[0];                        // path, query, hash
    s = s.replace(/^.*@/, '').replace(/:\d+$/, ''); // credentials, port
    s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    try {
      s = new URL('http://' + s).hostname;          // IDN -> punycode
    } catch {
      return null;
    }
    return DOMAIN_RE.test(s) ? s : null;
  }

  /** Hostname of an http(s) URL, or null for chrome://, file://, etc. */
  function hostnameFromUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  /** The key we store in the allowlist for a hostname ("www." is dropped). */
  function siteKey(hostname) {
    return String(hostname || '').toLowerCase().replace(/^www\./, '');
  }

  /** Allowlist entries that cover `hostname` (exact match or a parent domain). */
  function matchingAllowlistEntries(hostname, allowlist) {
    const host = siteKey(hostname);
    return (allowlist || []).filter((d) => host === d || host.endsWith('.' + d));
  }

  function isAllowlisted(hostname, allowlist) {
    return matchingAllowlistEntries(hostname, allowlist).length > 0;
  }

  /**
   * A CSS selector is accepted when the browser can parse it and it can't
   * escape its rule block (no braces / angle brackets / comments).
   * Needs a DOM, so only used on extension pages.
   */
  function isValidSelector(sel) {
    if (!sel || /[{}<>]|\/\*/.test(sel)) return false;
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch {
      return false;
    }
  }

  root.AQ = Object.freeze({
    DEFAULT_SETTINGS,
    normalizeDomain,
    hostnameFromUrl,
    siteKey,
    matchingAllowlistEntries,
    isAllowlisted,
    isValidSelector
  });
})(globalThis);
