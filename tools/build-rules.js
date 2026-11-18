#!/usr/bin/env node
/**
 * Adblock by AshQuark — static ruleset generator.
 *
 * Writes rules/ads.json, rules/trackers.json and rules/popups.json from the
 * curated lists below. Run with:  node tools/build-rules.js
 *
 * Rule design:
 *  - One rule per domain, using `requestDomains`, which also matches subdomains.
 *  - Ads and trackers are `domainType: "thirdParty"` so a site's own first-party
 *    resources (and visiting e.g. criteo.com directly) still work.
 *  - Popups/malvertising also block `main_frame`, so a popunder tab that slips
 *    through lands on Chrome's "blocked" page instead of the ad.
 *  - Rule IDs are unique across ALL rulesets (ads 1+, trackers 10001+,
 *    popups 20001+) so they're easy to tell apart in debugging output.
 *  - Domains whose blocking commonly breaks sites (video ad SDKs like IMA,
 *    tag managers like Tealium/Adobe Launch, A/B test tools) are left out on purpose.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Every sub-resource type: these domains serve nothing a page needs, and ads/
// trackers also load via CSS, fonts, websockets, beacons ("other") and plugins.
const BLOCK_TYPES = [
  'script', 'image', 'sub_frame', 'xmlhttprequest', 'media', 'ping',
  'stylesheet', 'font', 'object', 'websocket', 'other'
];

// ---------------------------------------------------------------------------
// Ad networks, exchanges, SSPs/DSPs, native-ad widgets, ad verification
// ---------------------------------------------------------------------------
const ADS = [
  // Google
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'googletagservices.com', '2mdn.net', 'admob.com',
  // Amazon / Microsoft / Yahoo / Meta / X
  'amazon-adsystem.com', 'assoc-amazon.com', 'ads.msn.com', 'ads.yahoo.com', 'ybp.yahoo.com',
  'gemini.yahoo.com', 'advertising.com', 'adtechus.com', 'an.facebook.com', 'ads-twitter.com',
  // Native / content recommendation
  'taboola.com', 'taboolasyndication.com', 'outbrain.com', 'outbrainimg.com', 'revcontent.com',
  'mgid.com', 'zergnet.com', 'adblade.com', 'content.ad', 'ntv.io', 'postrelease.com',
  'dianomi.com', 'powerinbox.com', 'mediago.io', 'zemanta.com', 'plista.com', 'ligatus.com',
  'lockerdome.com', 'adskeeper.com', 'adskeeper.co.uk', 'adyoulike.com', 'omnitagjs.com',
  'nativeroll.tv', 'strossle.com', 'adup-tech.com',
  // Exchanges / SSPs / DSPs
  'criteo.com', 'criteo.net', 'adnxs.com', 'adnxs-simple.com', 'adsrvr.org', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'casalemedia.com', 'indexww.com', 'contextweb.com',
  'sharethrough.com', 'triplelift.com', '3lift.com', 'yieldmo.com', 'teads.tv', 'smartadserver.com',
  'sascdn.com', 'adform.net', 'bidswitch.net', 'mathtag.com', 'sovrn.com', 'lijit.com',
  'gumgum.com', 'media.net', 'adroll.com', 'yieldlab.net', 'adition.com', 'improvedigital.com',
  '360yield.com', 'smaato.net', 'inmobi.com', 'applovin.com', 'adcolony.com', 'vungle.com',
  'chartboost.com', 'unityads.unity3d.com', 'pubnative.net', 'startappservice.com',
  'conversantmedia.com', 'dotomi.com', 'emxdgt.com', 'onetag-sys.com', 'adkernel.com',
  'adtelligent.com', 'kargo.com', '33across.com', 'sonobi.com', 'a-mo.net', '1rx.io',
  'rhythmone.com', 'unrulymedia.com', 'zedo.com', 'undertone.com', 'tribalfusion.com',
  'exponential.com', 'bidr.io', 'bidtellect.com', 'e-planning.net', 'admixer.net',
  'creativecdn.com', 'rtbhouse.com', 'simpli.fi', 'steelhousemedia.com', 'adhese.com',
  'adocean.pl', 'adriver.ru', 'adfox.ru', 'an.yandex.ru', 'yandexadexchange.net',
  'seedtag.com', 'richaudience.com', 'smilewanted.com', 'invibes.com', 'adscale.de',
  'adspirit.de', 'adgrx.com', 'adnium.com', 'valueimpression.com', 'nextmillmedia.com',
  'relevant-digital.com', 'sortable.com', 'pub.network', 'adpushup.com', 'adzerk.net',
  'buysellads.com', 'carbonads.net', 'infolinks.com', 'chitika.com', 'a-ads.com',
  'mediavine.com', 'adthrive.com', 'ezoic.net', 'ezojs.com', 'liveintent.com', 'adsymptotic.com',
  'yieldmanager.com', 'adbutler.com', 'servedbyadbutler.com', 'adspeed.com', 'adspeed.net',
  'admanmedia.com', 'adsnative.com', 'clickio.com', 'clickiocdn.com',
  'connectad.io', 'districtm.io', 'gamoshi.io', 'lunamedia.io', 'mobfox.com', 'nexage.com',
  'openwebmp.com', 'pulsepoint.com', 'readpeak.com', 'rtbsystem.com', 'smartyads.com',
  'sublime.xyz', 'targetspot.com', 'yieldone.com', 'ad-stir.com', 'adingo.jp', 'i-mobile.co.jp',
  // Video ad servers
  'spotxchange.com', 'spotx.tv', 'springserve.com', 'tremorhub.com', 'aniview.com',
  'connatix.com', 'primis.tech', 'vidazoo.com', 'lkqd.net', 'innovid.com', 'stickyadstv.com',
  'smartclip.net', 'jivox.com', 'vdo.ai', 'teads.com',
  // Ad serving / verification / measurement
  'serving-sys.com', 'flashtalking.com', 'moatads.com', 'doubleverify.com', 'adsafeprotected.com',
  'adlooxtracking.com', 'adlightning.com', 'cpx.to', 'atdmt.com',
  // Google ad service country variants
  'adservice.google.co.uk', 'adservice.google.de', 'adservice.google.fr', 'adservice.google.ca',
  'adservice.google.com.au', 'adservice.google.co.in', 'adservice.google.es', 'adservice.google.it',
  'adservice.google.nl', 'adservice.google.com.br', 'adservice.google.co.jp', 'adservice.google.pl',
  // More exchanges / video & native networks
  'pubmine.com', 'vidoomy.com', 'adnuntius.com', 'adnami.io', 'acuityplatform.com', 'ad.gt',
  'mfadsrvr.com', 'adhigh.net'
];

// ---------------------------------------------------------------------------
// Analytics, session recording, data brokers, marketing pixels
// ---------------------------------------------------------------------------
const TRACKERS = [
  // Google / Microsoft / Yahoo
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'clarity.ms',
  'bat.bing.com', 'analytics.yahoo.com',
  // Social pixels
  'analytics.twitter.com', 'ads.linkedin.com', 'snap.licdn.com', 'ct.pinterest.com',
  'analytics.tiktok.com', 'tr.snapchat.com', 'alb.reddit.com', 'q.quora.com',
  // Product analytics / session replay
  'hotjar.com', 'hotjar.io', 'mouseflow.com', 'fullstory.com', 'crazyegg.com', 'luckyorange.com',
  'luckyorange.net', 'inspectlet.com', 'mixpanel.com', 'mxpnl.com', 'api.amplitude.com',
  'api2.amplitude.com', 'cdn.amplitude.com', 'api.segment.io', 'cdn.segment.com',
  'heapanalytics.com', 'kissmetrics.io', 'smartlook.com', 'lr-ingest.io', 'sessioncam.com',
  'contentsquare.net', 'decibelinsight.net', 'quantummetric.com', 'clicktale.net',
  'logrocket.io',
  // Audience measurement
  'chartbeat.com', 'chartbeat.net', 'quantserve.com', 'quantcount.com', 'scorecardresearch.com',
  'imrworldwide.com', 'parsely.com', 'gemius.pl', 'ioam.de', 'xiti.com', 'ati-host.net',
  'dotmetrics.net', 'effectivemeasure.net', 'cxense.com', 'statcounter.com', 'histats.com',
  'getclicky.com', 'woopra.com', 'matomo.cloud', 'plausible.io', 'cdn.usefathom.com',
  'pixel.wp.com', 'coremetrics.com', 'webtrends.com', 'webtrendslive.com', 'nr-data.net',
  'js-agent.newrelic.com', 'cloudflareinsights.com', 'jwpltx.com', 'newscgp.com',
  // Adobe / Oracle / Salesforce / marketing automation
  'demdex.net', 'everesttech.net', 'omtrdc.net', '2o7.net', 'bluekai.com', 'exelator.com',
  'cdn.evgnet.com', 'hs-analytics.net', 'track.hubspot.com', 'munchkin.marketo.net',
  'pi.pardot.com', 'bizible.com', '6sc.co', 'company-target.com', 'clearbitscripts.com',
  'lfeeder.com', 'boomtrain.com', 'kochava.com',
  // Data brokers / identity graphs / DMPs
  'krxd.net', 'rlcdn.com', 'crwdcntrl.net', 'tapad.com', 'agkn.com', 'eyeota.net',
  'bounceexchange.com', 'bouncex.net', 'liadm.com', 'id5-sync.com', 'intentiq.com',
  'zeotap.com', 'permutive.com', 'permutive.app', 'navdmp.com', 'sitescout.com', 'pippio.com',
  'mookie1.com', 'owneriq.net', 'turn.com', 'w55c.net', 'rfihub.com', 'ml314.com',
  'c3tag.com', 'ipredictive.com', 'dtscout.com', 'addthis.com', 'addthisedge.com',
  'lotame.com',
  'semasio.net',
  // Regional analytics
  'mc.yandex.ru', 'mc.yandex.com', 'top-fwz1.mail.ru', 'counter.yadro.ru', 'tns-counter.ru',
  'hm.baidu.com', 'cnzz.com', '51.la', 'growingio.com', 'umeng.com',
  // More analytics / RUM / session tools
  'snowplowanalytics.com', 'piwik.pro', 'browser-intake-datadoghq.com', 'mparticle.com',
  'trackcmp.net', 'leadforensics.com'
];

// ---------------------------------------------------------------------------
// Popunder / redirect networks, malvertising, in-browser cryptominers
// ---------------------------------------------------------------------------
const POPUPS = [
  'popads.net', 'popadscdn.net', 'popcash.net', 'propellerads.com', 'propellerclick.com',
  'onclickads.net', 'onclkds.com', 'oclasrv.com', 'onclasrv.com', 'exoclick.com', 'exosrv.com',
  'exdynsrv.com', 'realsrv.com', 'juicyads.com', 'trafficjunky.net', 'trafficjunky.com',
  'adsterra.com', 'hilltopads.net', 'hilltopads.com', 'clickadu.com', 'clickadilla.com',
  'popmyads.com', 'adcash.com', 'poptm.com', 'popunder.net', 'plugrush.com', 'trafficstars.com',
  'tsyndicate.com', 'zeropark.com', 'richads.com', 'admaven.com', 'ad-maven.com',
  'bidvertiser.com', 'clicksor.com', 'revenuehits.com', 'adxpansion.com', 'monetag.com',
  'galaksion.com', 'clickaine.com', 'adspyglass.com', 'evadav.com', 'rollerads.com',
  'mondiad.com', 'adreactor.com', 'traffichaus.com', 'trafficforce.com', 'ero-advertising.com',
  'trafficfactory.biz', 'notix.io', 'popunderjs.com', 'directrev.com',
  // Cryptojacking
  'coinhive.com', 'coin-hive.com', 'authedmine.com', 'crypto-loot.com', 'cryptoloot.pro',
  'jsecoin.com', 'minero.cc', 'webminepool.com', 'coinimp.com', 'ppoi.org',
  'monerominer.rocks', 'coinhave.com', 'webmine.cz'
];

// ---------------------------------------------------------------------------
// Path-specific rules for trackers that live on first-party-ish domains we
// must not block wholesale (facebook.com, google.com, youtube.com, t.co, …).
// ---------------------------------------------------------------------------
const PATH_RULES = {
  ads: [
    '||google.com/pagead/',
    '||youtube.com/pagead/',
    '||youtube.com/api/stats/ads',
    '||redditstatic.com/ads/',
    '||googleapis.com/pagead/'
  ],
  trackers: [
    '||facebook.com/tr^',
    '||facebook.com/tr/',
    '||connect.facebook.net/*/fbevents.js',
    '||connect.facebook.net/signals/',
    '||t.co/i/adsct',
    '||twitter.com/i/adsct',
    '||sc-static.net/scevent.min.js',
    '||google.com/ads/ga-audiences',
    '||linkedin.com/px/',
    '||reddit.com/rp.gif'
  ],
  popups: []
};

const SETS = [
  { id: 'ads', domains: ADS, base: 1, thirdParty: true, types: BLOCK_TYPES },
  { id: 'trackers', domains: TRACKERS, base: 10001, thirdParty: true, types: BLOCK_TYPES },
  { id: 'popups', domains: POPUPS, base: 20001, thirdParty: false, types: [...BLOCK_TYPES, 'main_frame'] }
];

function build() {
  const seen = new Map(); // domain -> ruleset id (no domain may appear twice)
  let total = 0;

  for (const set of SETS) {
    const rules = [];
    let id = set.base;

    for (const raw of set.domains) {
      const d = raw.trim().toLowerCase();
      if (seen.has(d)) {
        if (seen.get(d) === set.id) continue; // duplicate within list: skip silently
        throw new Error(`Domain "${d}" appears in both ${seen.get(d)} and ${set.id}`);
      }
      seen.set(d, set.id);
      const condition = { requestDomains: [d], resourceTypes: set.types };
      if (set.thirdParty) condition.domainType = 'thirdParty';
      rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition });
    }

    for (const urlFilter of PATH_RULES[set.id]) {
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter, resourceTypes: set.types }
      });
    }

    const out = path.join(__dirname, '..', 'rules', `${set.id}.json`);
    fs.writeFileSync(out, JSON.stringify(rules, null, 2) + '\n');
    console.log(`${set.id.padEnd(9)} ${String(rules.length).padStart(4)} rules -> rules/${set.id}.json`);
    total += rules.length;
  }
  console.log(`total     ${String(total).padStart(4)} rules`);
}

build();
