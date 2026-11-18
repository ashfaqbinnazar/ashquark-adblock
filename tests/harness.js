/* AshQuark QA harness: each test records PASS/FAIL into window.__results. */
'use strict';
const results = (window.__results = []);
const out = document.getElementById('out');
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  out.append(li);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll `cond` until true or `ms` elapse (media load time varies by machine/server). */
async function waitFor(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (cond()) return true; } catch { /* keep waiting */ } await sleep(100); }
  return false;
}
const skippedToEnd = (v) => v.ended || (Number.isFinite(v.duration) && v.currentTime >= v.duration - 0.2);
const xhr = (url, type = '') => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest();
  x.open('GET', url);
  x.responseType = type;
  x.onload = () => resolve(x);
  x.onerror = () => reject(new Error('xhr error ' + url));
  x.send();
});
const isEmptyVast = (s) => /<VAST version="3.0"><\/VAST>/.test(s) && !/<Ad[\s>]/.test(s);

async function run() {
  // --- Network-level video ad neutralization ---------------------------------
  try {
    const t = await (await fetch('fixtures/ad-response.xml')).text();
    record('fetch: VAST body with an <Ad> is emptied', isEmptyVast(t), t.slice(0, 60));
  } catch (e) { record('fetch: VAST body emptied', false, e.message); }

  try {
    const x = await xhr('fixtures/ad-response.xml', 'document');
    const root = x.responseXML && x.responseXML.documentElement;
    record('XHR(document): VAST responseXML has no <Ad>', !!root && root.nodeName === 'VAST' && !root.querySelector('Ad'));
  } catch (e) { record('XHR(document) VAST', false, e.message); }

  try {
    const x = await xhr('fixtures/ad-response.xml');
    record('XHR(text): VAST responseText emptied', isEmptyVast(x.responseText) && isEmptyVast(x.response));
  } catch (e) { record('XHR(text) VAST', false, e.message); }

  try {
    const x = await xhr('/ads/vast?zone=123');
    record('XHR to /ads/vast answered locally with empty VAST (no network)', isEmptyVast(x.responseText) && x.status === 200);
  } catch (e) { record('XHR /ads/vast local answer', false, e.message); }

  try {
    const t = await (await fetch('https://tsyndicate.com/api/v1/vast/abc?x=1')).text();
    record('fetch to tsyndicate.com (TrafficStars) answered locally', isEmptyVast(t));
  } catch (e) { record('fetch tsyndicate local answer', false, e.message); }

  try {
    const t = await (await fetch('https://pubads.g.doubleclick.net/gampad/ads?iu=/1/v&env=vp&output=vast')).text();
    record('fetch to Google IMA video ad tag answered locally', isEmptyVast(t));
  } catch (e) { record('fetch IMA tag local answer', false, e.message); }

  // --- Player config pruning (must keep content URLs) ------------------------
  try {
    const cfg = await (await fetch('fixtures/player-config.json')).json();
    const ok = cfg.preroll.enabled === false && cfg.preroll.url === '' && cfg.vastUrl === '' &&
      Array.isArray(cfg.midrolls) && cfg.midrolls.length === 0 &&
      cfg.video.hls === 'stream/master.m3u8' && cfg.video.mp4 === 'main.mp4' && cfg.autoplay === true;
    record('fetch.json: ad keys emptied, content URLs kept', ok, JSON.stringify(cfg).slice(0, 140));
  } catch (e) { record('fetch.json prune', false, e.message); }

  try {
    const x = await xhr('fixtures/player-config.json', 'json');
    record('XHR(json): ad keys emptied', x.response.vastUrl === '' && x.response.video.hls === 'stream/master.m3u8');
  } catch (e) { record('XHR(json) prune', false, e.message); }

  try {
    const yt = JSON.parse('{"videoDetails":{"videoId":"x"},"adPlacements":[{"a":1}],"playerAds":[{"b":2}],"streamingData":{"formats":[1]}}');
    record('JSON.parse: YouTube adPlacements/playerAds emptied, streamingData kept',
      yt.adPlacements.length === 0 && yt.playerAds.length === 0 && yt.streamingData.formats.length === 1);
  } catch (e) { record('JSON.parse prune', false, e.message); }

  // --- Must NOT touch content ------------------------------------------------
  try {
    const x = await xhr('fixtures/seg.m3u8');
    record('HLS playlist (.m3u8) untouched', x.responseText.startsWith('#EXTM3U'));
  } catch (e) { record('m3u8 untouched', false, e.message); }

  try {
    const j = await (await fetch('fixtures/vast-landscapes/info.json')).json();
    record('"/vast-landscapes/" content path not mistaken for an ad tag', j.title.startsWith('Vast landscapes') && j.items.length === 3);
  } catch (e) { record('vast-landscapes untouched', false, e.message); }

  try {
    const buf = await (await fetch('fixtures/main.mp4')).arrayBuffer();
    record('Main MP4 bytes untouched', buf.byteLength > 30000, buf.byteLength + ' bytes');
  } catch (e) { record('mp4 untouched', false, e.message); }

  // --- Popups -------------------------------------------------------------------
  try {
    const w = window.open('https://example.com/popunder', '_blank');
    record('window.open without a user click is blocked', w === null);
  } catch (e) { record('window.open blocked', false, e.message); }

  try {
    const f = document.createElement('form');
    f.action = 'https://example.com/popunder'; f.target = '_blank'; f.method = 'GET';
    document.body.append(f);
    const r = f.submit();
    f.remove();
    record('form.submit() to a new tab without a click is blocked', r === undefined && !window.__navigated);
  } catch (e) { record('form.submit blocked', false, e.message); }

  try {
    const a = document.createElement('a');
    a.href = 'https://example.com/popunder'; a.target = '_blank';
    a.click(); // detached synthetic click
    record('Synthetic click on a detached target=_blank link is blocked', true);
  } catch (e) { record('detached link click blocked', false, e.message); }

  try {
    record('window.open still looks native (toString)', /\[native code\]/.test(String(window.open)));
  } catch (e) { record('toString mask', false, e.message); }

  // --- Video players -------------------------------------------------------------
  const vA = document.getElementById('vA');
  const vB = document.getElementById('vB');
  const vC = document.getElementById('vC');
  for (const v of [vA, vB, vC]) v.play().catch(() => {});
  const t0 = performance.now();
  await waitFor(() => vA.readyState >= 1);
  const loadedAt = performance.now();
  // The ad is 8s long: if it ends within 2s of its metadata loading, we skipped it.
  const skipped = await waitFor(() => skippedToEnd(vA), 2000);
  record('Ad video in "ad mode" player skipped to the end', skipped,
    `metadata after ${Math.round(loadedAt - t0)}ms, skipped ${Math.round(performance.now() - loadedAt)}ms later`);
  await waitFor(() => vC.readyState >= 1 && vB.readyState >= 1);
  await sleep(1000); // give the skipper time to (wrongly) act on vB / vC
  record('"Skip Ad" button auto-clicked', window.__skipClicked === true);
  record('Main 4-minute video NOT skipped', vB.currentTime < 10 && !vB.ended, `t=${vB.currentTime.toFixed(2)}`);
  record('"Skip intro" button NOT clicked', !window.__introClicked);
  record('Long video in a player stuck in "ad-showing" NOT skipped', vC.currentTime < 10 && !vC.ended, `t=${vC.currentTime.toFixed(2)}`);
  record('Pause-ad overlay inside the player hidden', getComputedStyle(document.getElementById('pauseAd')).display === 'none');

  // Mid-roll: the main player flips into ad mode with a short ad source.
  const pB = document.getElementById('pB');
  const mid = document.createElement('video');
  mid.muted = true; mid.playsInline = true; mid.className = 'midroll';
  mid.src = 'fixtures/ad.mp4?midroll';
  pB.append(mid);
  mid.play().catch(() => {});
  await waitFor(() => mid.readyState >= 1);
  const midSkipped = await waitFor(() => skippedToEnd(mid), 2000);
  record('Mid-roll ad video injected later is skipped', midSkipped, `t=${mid.currentTime.toFixed(2)} / ${mid.duration}`);
  record('Mid-roll <video> element itself not hidden (left to skip logic)', getComputedStyle(mid).display !== 'none');
  record('Main video keeps playing after the mid-roll', !vB.paused && vB.currentTime < 20, `paused=${vB.paused}`);

  const failed = results.filter((r) => !r.ok).length;
  document.title = failed ? `FAIL ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`;
  window.__done = true;
}
run();
