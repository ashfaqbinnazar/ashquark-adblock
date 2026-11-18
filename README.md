# Adblock by AshQuark

Fast, private ad, popup and tracker blocker for Chrome (Manifest V3).

## Layout

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, 3 static DNR rulesets |
| `rules/ads.json`, `rules/trackers.json`, `rules/popups.json` | Generated static rules (394) |
| `background.js` | Service worker: rulesets, allowlist/custom rules, content-script registration, badge, stats |
| `content.js` + `cosmetic.css` | Isolated world: cosmetic hiding, MutationObserver, overlay removal, scroll restore |
| `main-world.js` | Main world: `window.open` / `form.submit` / popunder / tab-under blocking |
| `video-ads-main.js` | Main world: answers VAST/VMAP ad requests with an empty "no ad" reply, empties ad keys in player configs |
| `video-ads.js` | Isolated world: skips ad `<video>`s that still play, auto-clicks "Skip ad", hides in-player ad overlays |
| `shared.js` | Helpers shared by service worker, popup and options |
| `popup.*`, `options.*` | UI |
| `tools/` | Dev-only Node scripts (not used at runtime) |
| `tests/` | Browser QA harness (25 checks) using the real scripts + generated test videos |

## Dev scripts

```sh
node tools/build-rules.js   # regenerate rules/*.json from the curated lists
node tools/make-icons.js    # regenerate icons/*.png
node tools/validate.js      # validate manifest, every rule, JS syntax, no remote code
```

## QA harness

```sh
cd ~/ashquark-adblock && python3 -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/tests/harness.html, the tab title shows "PASS 25/25"
```

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

After editing files, click the ↻ reload button on the extension card.

## Known limits

- Ads stitched into the video stream on the server side (SSAI) can't be told apart from content.
- YouTube changes its ad delivery often. Pruning its ad keys and skipping ads works today but may need updates.
- The content scripts are registered dynamically (not in `manifest.json`), so allowlisted sites can be excluded completely.
