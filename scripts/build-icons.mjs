#!/usr/bin/env node
/**
 * Draw the home-screen icons.
 *
 *   node scripts/build-icons.mjs
 *
 * Why not an emoji in an SVG, as before? Because a phone adding a page to its
 * home screen does not use the favicon. Android reads the icons out of the web
 * manifest and will not fetch a `data:` URI for them; iOS ignores the manifest
 * entirely and looks for `apple-touch-icon`, which has to be a PNG. Between
 * them that means real image files, at real URLs, in a real raster format —
 * so they are drawn here and committed, like the seed files.
 *
 * There is no image library in this project and no build step, so the shapes
 * are drawn a pixel at a time and the PNG is encoded by hand. Three-times
 * supersampling gives the edges something to stand on.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [13, 17, 23];        // the app's dark surface, in both themes
const WHITE = [255, 255, 255];
const YOLK = [245, 179, 1];

// ---------------------------------------------------------------------------
// Shapes. Every coordinate is a fraction of the icon's width, so one drawing
// serves 180px and 512px alike.
// ---------------------------------------------------------------------------

// Each shape carries what it is as well as how to test a point, so the SVG and
// the PNG are two renderings of one description rather than two drawings that
// can drift apart.
function rect(x0, y0, x1, y1, r = 0) {
  const hit = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    if (!r) return true;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  hit.spec = { kind: 'rect', x0, y0, x1, y1, r };
  return hit;
}

function circle(cx, cy, r) {
  const hit = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  hit.spec = { kind: 'circle', cx, cy, r };
  return hit;
}

/**
 * A bed, seen from the side: headboard, mattress, pillow, two feet.
 *
 * Everything sits inside the middle 70% because Android may mask the icon into
 * a circle, and a bed with its feet cropped off is a sofa.
 */
const BED = [
  { color: WHITE, shape: rect(0.16, 0.32, 0.24, 0.70, 0.03) },   // headboard
  { color: WHITE, shape: rect(0.16, 0.52, 0.84, 0.66, 0.05) },   // mattress
  { color: WHITE, shape: rect(0.27, 0.41, 0.46, 0.52, 0.04) },   // pillow
  { color: WHITE, shape: rect(0.16, 0.66, 0.24, 0.76, 0.02) },   // near foot
  { color: WHITE, shape: rect(0.76, 0.66, 0.84, 0.76, 0.02) },   // far foot
];

/** A fried egg: what the breakfast round is actually about. */
const EGG = [
  { color: WHITE, shape: circle(0.46, 0.47, 0.235) },
  { color: WHITE, shape: circle(0.62, 0.58, 0.185) },
  { color: YOLK, shape: circle(0.45, 0.46, 0.105) },
];

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const SUPERSAMPLE = 3;

function draw(size, shapes) {
  const px = Buffer.alloc(size * size * 3);
  const step = 1 / (size * SUPERSAMPLE);

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (pxi + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          // Last shape wins, so the yolk sits on top of the white.
          let colour = BG;
          for (const { color, shape } of shapes) if (shape(x, y)) colour = color;
          r += colour[0]; g += colour[1]; b += colour[2];
        }
      }

      const n = SUPERSAMPLE * SUPERSAMPLE;
      const at = (py * size + pxi) * 3;
      px[at] = Math.round(r / n);
      px[at + 1] = Math.round(g / n);
      px[at + 2] = Math.round(b / n);
    }
  }

  return px;
}

// ---------------------------------------------------------------------------
// PNG, written out by hand: signature, IHDR, IDAT, IEND.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  // 10-12: deflate, adaptive filtering, no interlace — all zero.

  // One filter byte per row, and no filtering: these are flat colours, which
  // deflate handles well enough that a smarter filter would buy nothing.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The same drawing as SVG, for the browser tab, where it stays sharp.
// ---------------------------------------------------------------------------

function svg(shapes) {
  const parts = shapes.map(({ color, shape }) => {
    const spec = shape.spec;
    const fill = `rgb(${color.join(',')})`;
    return spec.kind === 'circle'
      ? `<circle cx="${spec.cx * 512}" cy="${spec.cy * 512}" r="${spec.r * 512}" fill="${fill}"/>`
      : `<rect x="${spec.x0 * 512}" y="${spec.y0 * 512}" width="${(spec.x1 - spec.x0) * 512}"`
        + ` height="${(spec.y1 - spec.y0) * 512}" rx="${spec.r * 512}" fill="${fill}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">`
    + `<rect width="512" height="512" fill="rgb(${BG.join(',')})"/>`
    + parts.join('')
    + '</svg>\n';
}

const SIZES = [
  ['apple-touch-icon', 180],
  ['icon-192', 192],
  ['icon-512', 512],
];

const ICONS = [
  { suffix: '', shapes: EGG, label: 'breakfast' },
  { suffix: '.housekeeping', shapes: BED, label: 'housekeeping' },
];

let written = 0;
for (const { suffix, shapes, label } of ICONS) {
  for (const [name, size] of SIZES) {
    const file = join(PUBLIC, `${name}${suffix}.png`);
    writeFileSync(file, png(size, draw(size, shapes)));
    written += 1;
    console.log(`${label} ${size}×${size} → ${file.replace(PUBLIC, 'public')}`);
  }
  const file = join(PUBLIC, `icon${suffix}.svg`);
  writeFileSync(file, svg(shapes));
  written += 1;
  console.log(`${label} svg → ${file.replace(PUBLIC, 'public')}`);
}

console.log(`\n${written} files written.`);
