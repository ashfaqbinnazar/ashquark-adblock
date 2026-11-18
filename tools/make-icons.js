#!/usr/bin/env node
/**
 * Adblock by AshQuark — icon generator (no dependencies).
 *
 * Draws a modern shield: a dark navy body, a violet-to-cyan accent rim, and a
 * subtle "AQ" monogram (shown at 32px and up; at 16px it's left out for clarity).
 * Writes icons/icon{16,32,48,128}.png.
 *
 * Rendering: each pixel is supersampled (SS×SS), and every sample is tested
 * against analytic shapes (polygon + stroked segments/rings) in a 0..1 unit
 * square, which gives smooth anti-aliasing at every size.
 * PNG encoding: RGBA8, filter 0, zlib deflate, with a hand-rolled CRC32.
 *
 * Run with:  node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const VIOLET = [124, 92, 255];
const CYAN = [34, 211, 238];
const NAVY_TOP = [24, 30, 52];
const NAVY_BOTTOM = [11, 15, 26];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], Math.min(1, Math.max(0, t))));

// ---------------------------------------------------------------------------
// Geometry (unit square, y grows downwards)
// ---------------------------------------------------------------------------

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
  ];
}

/** Shield outline as a polygon: gently arched top, straight sides, curved point. */
function shieldPolygon() {
  const pts = [];
  const N = 40;
  // top edge: left shoulder -> centre crest -> right shoulder
  for (let i = 0; i <= N; i++) pts.push(cubic([0.13, 0.20], [0.30, 0.17], [0.40, 0.08], [0.5, 0.07], i / N));
  for (let i = 1; i <= N; i++) pts.push(cubic([0.5, 0.07], [0.60, 0.08], [0.70, 0.17], [0.87, 0.20], i / N));
  // right side down, then curve into the bottom point
  for (let i = 1; i <= N; i++) pts.push(cubic([0.87, 0.20], [0.87, 0.36], [0.87, 0.44], [0.86, 0.52], i / N));
  for (let i = 1; i <= N; i++) pts.push(cubic([0.86, 0.52], [0.83, 0.74], [0.68, 0.87], [0.5, 0.95], i / N));
  // mirror back up the left side
  for (let i = 1; i <= N; i++) pts.push(cubic([0.5, 0.95], [0.32, 0.87], [0.17, 0.74], [0.14, 0.52], i / N));
  for (let i = 1; i < N; i++) pts.push(cubic([0.14, 0.52], [0.13, 0.44], [0.13, 0.36], [0.13, 0.20], i / N));
  return pts;
}

/** Scale a polygon about a centre point (used for the inner shield). */
function scalePolygon(pts, k, cx, cy) {
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

/** Even-odd point-in-polygon test. */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** "AQ" monogram as stroked primitives, centred inside the shield. */
const MONO = {
  stroke: 0.052,
  segments: [
    // A
    [[0.285, 0.64], [0.385, 0.35]],
    [[0.385, 0.35], [0.485, 0.64]],
    [[0.325, 0.545], [0.445, 0.545]],
    // Q tail
    [[0.645, 0.565], [0.725, 0.665]]
  ],
  ring: { cx: 0.615, cy: 0.495, r: 0.105 }
};

function inMonogram(x, y) {
  const h = MONO.stroke / 2;
  for (const [a, b] of MONO.segments) if (distToSegment(x, y, a, b) <= h) return true;
  const { cx, cy, r } = MONO.ring;
  return Math.abs(Math.hypot(x - cx, y - cy) - r) <= h;
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

function render(size) {
  const outer = shieldPolygon();
  // Smaller icons get a proportionally thicker rim so it stays visible.
  const rimScale = size <= 16 ? 0.74 : size <= 32 ? 0.8 : 0.84;
  const inner = scalePolygon(outer, rimScale, 0.5, 0.52);
  const showMonogram = size >= 32;
  const SS = size <= 32 ? 8 : 5;

  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0; // premultiplied accumulators
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inPolygon(x, y, outer)) continue;

          let c;
          const diag = (x + y) / 2; // accent gradient runs top-left -> bottom-right
          if (!inPolygon(x, y, inner)) {
            c = mix(VIOLET, CYAN, (diag - 0.2) / 0.65);              // rim
          } else if (showMonogram && inMonogram(x, y)) {
            c = mix(mix(VIOLET, CYAN, (diag - 0.3) / 0.45), [255, 255, 255], 0.18); // monogram
          } else {
            c = mix(NAVY_TOP, NAVY_BOTTOM, (y - 0.1) / 0.8);          // body
          }
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const n = SS * SS;
      const o = (py * size + pxi) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(render(size), size));
  console.log(`icons/icon${size}.png  ${fs.statSync(file).size} bytes`);
}
