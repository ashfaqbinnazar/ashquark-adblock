# Adblock by AshQuark: project context

Manifest V3 Chrome extension that blocks ads, trackers, popups/popunders and video ads.
Plain JavaScript, no build step, no dependencies. Load it unpacked from this folder.

## Hard rules
- **Privacy:** no external network calls, no analytics, no remote code, no `eval`/`new Function`.
  `tools/validate.js` enforces this. Only XML namespace strings are allowlisted there.
- **Never break the page's own content.** Video CDN / HLS (`.m3u8`, `.ts`, `.m4s`, `.mp4`)
  requests and long main videos must never be blocked or skipped. When unsure, hide instead
  of removing, and do nothing instead of guessing.
- **Fail safe:** page-side hooks are wrapped in try/catch, fall back to native behaviour,
  and log with the `[AshQuark]` prefix.
- **Don't guess domains or selectors.** Only add domains you're confident about. Some
  domains are left out on purpose because blocking them breaks sites (IMA SDK, Tealium,
  Adobe Launch, A/B-testing tools such as VWO and Optimizely).

## Architecture
| File | World / context | Role |
|---|---|---|
| `manifest.json` | n/a | MV3, static DNR rulesets `ads`, `trackers`, `popups` |
| `background.js` | service worker | Single source of truth = `chrome.storage.sync`. `applySettings()` (serialized queue) toggles rulesets, rebuilds dynamic rules, (re)registers content scripts, sets the badge. Per-tab stats live in `storage.session`. |
| `shared.js` | SW + extension pages | `globalThis.AQ`: `DEFAULT_SETTINGS`, `normalizeDomain`, allowlist helpers |
| `main-world.js` | MAIN | Popup/popunder policy for `window.open`, synthetic link clicks, `form.submit`, about:blank iframe `open`; Navigation-API tab-under guard |
| `content.js` + `cosmetic.css` | ISOLATED | Cosmetic hiding, MutationObserver sweep, ad-overlay removal + scroll restore, custom selectors, optional cookie banners, relays `aq:blocked` events to the SW |
| `video-ads-main.js` | MAIN | Answers VAST/VMAP ad requests with an empty "no ad" reply, empties VAST responses, removes ad keys from JSON (fetch/XHR/`JSON.parse`) |
| `video-ads.js` | ISOLATED | Skips ad `<video>`s that still play (seek to end), auto-clicks "Skip ad", hides in-player ad overlays |
| `popup.*`, `options.*` | extension pages | UI. Write settings, then `sendMessage({type:'aq:sync'})` |

Content scripts are **registered dynamically** (`chrome.scripting.registerContentScripts`)
rather than in the manifest, so allowlisted sites can be excluded with `excludeMatches` and
the video scripts can follow the `blockVideoAds` toggle. They use `matchOriginAsFallback`
(with a retry without it on older Chrome).

### Settings (`chrome.storage.sync`)
`enabled` (true), `allowlist` [], `customDomains` [], `customSelectors` [],
`hideCookieBanners` (false), `blockVideoAds` (true).

### Rule IDs
Static: ads 1+, trackers 10001+, popups 20001+ (unique across rulesets).
Dynamic: allowlist `allowAllRequests` 1–9999 (priority 1000), custom blocks 10000+ (priority 2).
Ads/trackers rules are `domainType: thirdParty`; popups also block `main_frame`.

### Messages
`aq:sync` (re-apply settings), `aq:getStats` {tabId}, `aq:blocked` (from content.js).
Main-world scripts talk to content.js via the DOM `CustomEvent('aq:blocked', {detail: string})`.

## Workflow
```sh
node tools/build-rules.js   # edit domain lists HERE, never rules/*.json by hand
node tools/make-icons.js    # regenerate icons (pure Node PNG encoder)
node tools/validate.js      # must pass before every commit
python3 -m http.server 8765 --bind 127.0.0.1   # then open /tests/harness.html; expect "PASS 25/25"
```
After changes, reload the extension at `chrome://extensions`.

## Testing notes
- `tests/harness.html` loads the real scripts with a stubbed `chrome.*`, plus generated
  videos (8 s ad, 240 s main). Poll for conditions instead of using fixed sleeps, because
  media load time varies.
- Lessons learned: Chrome returns a fresh object on each XHR `.response` read for `json`,
  so cache the pruned copy. Only skip *playing* ad videos, because `play()` on an ended
  video restarts it. Never hide `<video>` elements, because players reuse them.

## Known limits
Ads stitched into the stream server-side (SSAI) and first-party ads can't be fully blocked.
xhamster video-ad handling is generic and hasn't been checked against the live site
(the browser tool can't open it). Add site rules only from real request data.
