#!/usr/bin/env node
/**
 * Adblock by AshQuark — pre-flight validator.
 *
 * Checks:
 *  - manifest.json parses, is MV3, and every file it references exists
 *  - each ruleset is a JSON array of rules matching Chrome's DNR schema:
 *      integer id >= 1, unique within the ruleset AND across all rulesets,
 *      optional integer priority >= 1, a known action type, a condition with
 *      exactly one of urlFilter / regexFilter / requestDomains (domain lists
 *      lowercase ASCII), known resourceTypes, domainType valid, no unknown keys
 *  - total static rules >= 300 and within Chrome's per-ruleset limits
 *  - every extension JS file parses (node --check)
 *  - no remote code / analytics: no http(s) URLs fetched or loaded in extension code
 *
 * Exit code 0 = all good, 1 = problems found.  Run with:  node tools/validate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const errors = [];
const fail = (msg) => errors.push(msg);

const RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other'
]);
const ACTION_TYPES = new Set(['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests']);
const RULE_KEYS = new Set(['id', 'priority', 'action', 'condition']);
const CONDITION_KEYS = new Set([
  'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'initiatorDomains', 'excludedInitiatorDomains',
  'requestDomains', 'excludedRequestDomains', 'topDomains', 'excludedTopDomains', 'requestMethods',
  'excludedRequestMethods', 'domainType', 'tabIds', 'excludedTabIds', 'resourceTypes',
  'excludedResourceTypes', 'responseHeaders', 'excludedResponseHeaders'
]);
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const MAX_RULES_PER_RULESET = 30000; // GUARANTEED_MINIMUM_STATIC_RULES

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    fail(`${rel}: ${e.message}`);
    return null;
  }
}

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = readJson('manifest.json');
if (!manifest) {
  report();
}
if (manifest.manifest_version !== 3) fail('manifest: manifest_version must be 3');
for (const key of ['name', 'version', 'description']) if (!manifest[key]) fail(`manifest: missing ${key}`);
if (manifest.description && manifest.description.length > 132) fail('manifest: description longer than 132 chars');

const referenced = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  manifest.options_ui && manifest.options_ui.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  // files registered dynamically by background.js
  'main-world.js', 'content.js', 'cosmetic.css', 'shared.js', 'video-ads-main.js', 'video-ads.js',
  'popup.js', 'popup.css', 'options.js', 'options.css'
].filter(Boolean);
for (const f of referenced) if (!exists(f)) fail(`missing file referenced by extension: ${f}`);

// ---------------------------------------------------------------------------
// Rulesets
// ---------------------------------------------------------------------------
const resources = (manifest.declarative_net_request || {}).rule_resources || [];
if (!resources.length) fail('manifest: no declarative_net_request.rule_resources');

const globalIds = new Map(); // id -> ruleset
const rulesetIds = new Set();
let total = 0;

for (const res of resources) {
  if (rulesetIds.has(res.id)) fail(`manifest: duplicate ruleset id "${res.id}"`);
  rulesetIds.add(res.id);
  if (res.id.startsWith('_')) fail(`ruleset id "${res.id}" must not start with "_"`);
  if (!exists(res.path)) { fail(`ruleset file missing: ${res.path}`); continue; }

  const rules = readJson(res.path);
  if (!Array.isArray(rules)) { fail(`${res.path}: must be a JSON array`); continue; }
  if (rules.length > MAX_RULES_PER_RULESET) fail(`${res.path}: too many rules (${rules.length})`);
  total += rules.length;

  const localIds = new Set();
  const seenConditions = new Set();
  rules.forEach((rule, i) => {
    const where = `${res.path}[${i}]`;
    if (!rule || typeof rule !== 'object') return fail(`${where}: not an object`);

    for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k)) fail(`${where}: unknown key "${k}"`);

    if (!Number.isInteger(rule.id) || rule.id < 1) fail(`${where}: id must be an integer >= 1`);
    if (localIds.has(rule.id)) fail(`${where}: duplicate id ${rule.id} in ${res.id}`);
    localIds.add(rule.id);
    if (globalIds.has(rule.id) && globalIds.get(rule.id) !== res.id) {
      fail(`${where}: id ${rule.id} also used in ${globalIds.get(rule.id)}`);
    }
    globalIds.set(rule.id, res.id);

    if (rule.priority !== undefined && (!Number.isInteger(rule.priority) || rule.priority < 1)) {
      fail(`${where}: priority must be an integer >= 1`);
    }

    if (!rule.action || !ACTION_TYPES.has(rule.action.type)) fail(`${where}: invalid action.type`);
    if (rule.action && rule.action.type === 'allowAllRequests') {
      const rt = (rule.condition || {}).resourceTypes || [];
      if (!rt.length || rt.some((t) => t !== 'main_frame' && t !== 'sub_frame')) {
        fail(`${where}: allowAllRequests requires resourceTypes of main_frame/sub_frame only`);
      }
    }

    const c = rule.condition;
    if (!c || typeof c !== 'object') return fail(`${where}: missing condition`);
    for (const k of Object.keys(c)) if (!CONDITION_KEYS.has(k)) fail(`${where}: unknown condition key "${k}"`);

    const matchers = ['urlFilter', 'regexFilter', 'requestDomains'].filter((k) => c[k] !== undefined);
    if (matchers.length === 0) fail(`${where}: condition needs urlFilter, regexFilter or requestDomains`);
    if (c.urlFilter !== undefined && c.regexFilter !== undefined) fail(`${where}: urlFilter and regexFilter are exclusive`);

    if (c.urlFilter !== undefined) {
      if (typeof c.urlFilter !== 'string' || !c.urlFilter) fail(`${where}: urlFilter must be a non-empty string`);
      else if (!/^[\x20-\x7e]+$/.test(c.urlFilter)) fail(`${where}: urlFilter must be printable ASCII`);
      else if (c.urlFilter.startsWith('||*')) fail(`${where}: urlFilter may not start with "||*"`);
    }
    if (c.regexFilter !== undefined) {
      try { new RegExp(c.regexFilter); } catch { fail(`${where}: invalid regexFilter`); }
    }

    for (const key of ['requestDomains', 'excludedRequestDomains', 'initiatorDomains', 'excludedInitiatorDomains']) {
      if (c[key] === undefined) continue;
      if (!Array.isArray(c[key]) || !c[key].length) { fail(`${where}: ${key} must be a non-empty array`); continue; }
      for (const d of c[key]) {
        if (typeof d !== 'string' || !DOMAIN_RE.test(d)) fail(`${where}: invalid domain in ${key}: "${d}"`);
      }
    }

    if (c.resourceTypes !== undefined) {
      if (!Array.isArray(c.resourceTypes) || !c.resourceTypes.length) fail(`${where}: resourceTypes must be a non-empty array`);
      else for (const t of c.resourceTypes) if (!RESOURCE_TYPES.has(t)) fail(`${where}: unknown resource type "${t}"`);
      if (new Set(c.resourceTypes).size !== c.resourceTypes.length) fail(`${where}: duplicate resourceTypes`);
    }
    if (c.domainType !== undefined && !['firstParty', 'thirdParty'].includes(c.domainType)) {
      fail(`${where}: domainType must be firstParty or thirdParty`);
    }

    const sig = JSON.stringify([rule.action, c]);
    if (seenConditions.has(sig)) fail(`${where}: duplicate rule (same action + condition)`);
    seenConditions.add(sig);
  });

  console.log(`  ${res.id.padEnd(9)} ${String(rules.length).padStart(4)} rules  ok-schema=${errors.length === 0}`);
}

if (total < 300) fail(`only ${total} static rules; expected 300+`);
console.log(`  total     ${String(total).padStart(4)} rules, ${globalIds.size} unique ids`);

// ---------------------------------------------------------------------------
// JavaScript syntax + "no remote code" scan
// ---------------------------------------------------------------------------
const jsFiles = [
  'background.js', 'content.js', 'main-world.js', 'shared.js', 'popup.js', 'options.js',
  'video-ads-main.js', 'video-ads.js'
];
// URL-shaped strings that are identifiers, never fetched (XML namespaces).
const ALLOWED_URL_STRINGS = ['http://www.iab.net/videosuite/vmap'];
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  } catch (e) {
    fail(`${f}: syntax error\n${String(e.stderr || e.message).trim()}`);
  }
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  let code = src.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"])\/\/[^\n]*/g, '$1'); // strip comments
  for (const allowed of ALLOWED_URL_STRINGS) code = code.split(allowed).join('');
  if (/https?:\/\/[a-z0-9]/i.test(code)) { // a scheme + host = a fetchable URL
    fail(`${f}: contains an http(s) URL outside comments (no external network calls allowed)`);
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(src)) fail(`${f}: uses eval/new Function`);
}
for (const f of ['popup.html', 'options.html']) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/<script[^>]+src=["']https?:/i.test(html) || /<link[^>]+href=["']https?:/i.test(html)) {
    fail(`${f}: loads a remote resource`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`${f}: inline <script> is blocked by MV3 CSP`);
}

report();

function report() {
  if (errors.length) {
    console.error(`\n✗ ${errors.length} problem(s):`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('\n✓ All checks passed.');
  process.exit(0);
}
