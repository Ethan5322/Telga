/**
 * Build the Android launcher icons from Telga's own artwork.
 *
 * The source of truth is the founder's mark, already in the repository as the
 * web app's PWA icons:
 *
 *   apps/merchant-pos/assets/icon-512.png           the mark, full bleed
 *   apps/merchant-pos/assets/icon-maskable-512.png  the same mark, inset
 *
 * Nothing here draws or redraws the mark. `apps/merchant-pos/src/ui/logo.ts`
 * is explicit that the artwork must not be redrawn, and that applies just as
 * much to a build script: this only rescales what is already there, so the
 * Android icon and the web icon are the same picture at different sizes.
 *
 * ## Why the maskable file becomes the adaptive foreground
 *
 * Android crops an adaptive icon to whatever shape the launcher uses — circle,
 * squircle, teardrop — and only the middle 72 of 108dp is guaranteed to
 * survive. The maskable variant was drawn for exactly that rule, with the
 * figure and the letter pulled into the safe area, so it is the correct
 * source. Using the full-bleed file instead would clip the T's crossbar on a
 * round launcher.
 *
 * API 24 and 25 predate adaptive icons and use the flat mipmaps, which come
 * from the full-bleed file.
 *
 * ## Why the resizing is written out longhand
 *
 * There is no image library in this repository, and adding one to downscale a
 * handful of PNGs would be a poor trade. This decodes with Node's own zlib,
 * box filters in linear light, and re-encodes. The linear light matters:
 * averaging raw sRGB bytes would darken the teal against the dark ground, and
 * nearest-neighbour sampling would break the skeleton's ribs and the road's
 * gravel into noise at 48px.
 *
 *   node scripts/mobile/generate-icons.mjs
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ASSETS = join(ROOT, 'apps', 'merchant-pos', 'assets');
const RES = join(ROOT, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res');

// --- PNG ------------------------------------------------------------------

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit RGBA, non-interlaced PNG. That is all these assets are. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error('only 8-bit RGBA is supported (depth ' + data[8] + ', colour ' + data[9] + ')');
      }
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const target = out.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? target[x - 4] : 0;
      const b = prior === null ? 0 : prior[x];
      const c = prior === null || x < 4 ? 0 : prior[x - 4];
      let value;
      if (filter === 0) value = line[x];
      else if (filter === 1) value = line[x] + a;
      else if (filter === 2) value = line[x] + b;
      else if (filter === 3) value = line[x] + ((a + b) >> 1);
      else if (filter === 4) value = line[x] + paeth(a, b, c);
      else throw new Error('unknown PNG filter ' + filter);
      target[x] = value & 0xff;
    }
  }
  return { width, height, data: out };
}

function encodePng(size, data) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- resizing -------------------------------------------------------------

/** sRGB transfer, so averaging happens in linear light rather than on gamma. */
const toLinear = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  toLinear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fromLinear(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/**
 * Box-filter downscale. Colour is weighted by alpha so fully transparent
 * pixels cannot bleed their colour into an edge.
 */
function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = src.width / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let alphaSum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const o = (sy * src.width + sx) * 4;
          const alpha = src.data[o + 3] / 255;
          r += toLinear[src.data[o]] * alpha;
          g += toLinear[src.data[o + 1]] * alpha;
          b += toLinear[src.data[o + 2]] * alpha;
          alphaSum += alpha;
          count += 1;
        }
      }
      const o = (y * size + x) * 4;
      if (alphaSum === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      } else {
        out[o] = fromLinear(r / alphaSum);
        out[o + 1] = fromLinear(g / alphaSum);
        out[o + 2] = fromLinear(b / alphaSum);
        out[o + 3] = Math.round((alphaSum / count) * 255);
      }
    }
  }
  return out;
}

// --- output ---------------------------------------------------------------

const fullBleed = decodePng(readFileSync(join(ASSETS, 'icon-512.png')));
const maskable = decodePng(readFileSync(join(ASSETS, 'icon-maskable-512.png')));

let written = 0;
function put(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  written += 1;
}

/** Legacy launcher icons, for API 24 and 25. */
const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(LAUNCHER)) {
  const png = encodePng(size, resize(fullBleed, size));
  put(join(RES, 'mipmap-' + density, 'ic_launcher.png'), png);
  // Same art for the round variant; the launcher applies its own mask.
  put(join(RES, 'mipmap-' + density, 'ic_launcher_round.png'), png);
}

/** Adaptive foreground: 108dp, from the art drawn for the safe zone. */
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [density, size] of Object.entries(FOREGROUND)) {
  put(join(RES, 'mipmap-' + density, 'ic_launcher_foreground.png'), encodePng(size, resize(maskable, size)));
}

/** The connect screen's copy — byte-identical to the web app's 192px icon. */
put(join(ROOT, 'apps', 'mobile', 'www', 'icon.png'), readFileSync(join(ASSETS, 'icon-192.png')));

/** Splash art. Capacitor scaffolds its own logo here too. */
const SPLASH = { mdpi: 200, hdpi: 300, xhdpi: 400, xxhdpi: 600, xxxhdpi: 800 };
for (const [density, size] of Object.entries(SPLASH)) {
  const png = encodePng(size, resize(fullBleed, size));
  for (const orientation of ['port', 'land']) {
    put(join(RES, 'drawable-' + orientation + '-' + density, 'splash.png'), png);
  }
}
const splash = encodePng(400, resize(fullBleed, 400));
put(join(RES, 'drawable', 'splash.png'), splash);
put(join(RES, 'drawable-v24', 'splash.png'), splash);

/**
 * The ground colour behind the adaptive icon, sampled from the artwork's own
 * corner rather than guessed, so the two never disagree.
 */
const corner = maskable.data.subarray(0, 3);
const hex =
  '#' +
  Array.from(corner)
    .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
    .join('');

const backgroundXml = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<!--',
  '    The background layer of the adaptive launcher icon (API 26+).',
  '',
  '    Generated by scripts/mobile/generate-icons.mjs, sampled from the corner',
  '    of icon-maskable-512.png so it is the artwork own ground colour rather',
  '    than a guess. It shows only where a launcher mask extends past the',
  '    foreground art.',
  '',
  '    Do not edit by hand: npm run mobile:icons overwrites this file.',
  '-->',
  '<resources>',
  '    <color name="ic_launcher_background">' + hex + '</color>',
  '</resources>',
  '',
].join('\n');
put(join(RES, 'values', 'ic_launcher_background.xml'), Buffer.from(backgroundXml, 'utf8'));

console.log('Wrote ' + written + ' files from the Telga artwork in apps/merchant-pos/assets/.');
console.log('Adaptive icon ground colour: ' + hex + ' (sampled from the maskable art).');
