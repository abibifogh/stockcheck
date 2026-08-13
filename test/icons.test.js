import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { SITE_ASSETS, housekeepingAsset } from '../src/index.js';

/**
 * The home-screen icons.
 *
 * These matter more than their size suggests, and they fail silently. Both
 * sites serve `public/` with `not_found_handling = "single-page-application"`,
 * so a mistyped icon path does not 404 — it returns the app's HTML with a 200,
 * and the phone quietly shows a blank square or the wrong picture. Nothing at
 * runtime complains. So the checking happens here.
 */

const PUBLIC = join(import.meta.dirname, '..', 'public');
const file = (name) => join(PUBLIC, name.replace(/^\//, ''));
const read = (name) => readFileSync(file(name));

/** Width and height out of a PNG's IHDR, and proof that it is a PNG at all. */
function pngSize(buf) {
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'not a PNG',
  );
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const MANIFESTS = ['/manifest.webmanifest', '/manifest.housekeeping.webmanifest'];

test('every icon a manifest names is a real file of the size it claims', () => {
  for (const name of MANIFESTS) {
    const manifest = JSON.parse(read(name).toString());
    assert.ok(manifest.icons.length, `${name} has no icons`);

    for (const icon of manifest.icons) {
      // A phone will not fetch a data: URI for a home-screen icon, which is
      // exactly how this went wrong the first time.
      assert.ok(icon.src.startsWith('/'), `${name}: ${icon.src} is not a file`);
      assert.ok(existsSync(file(icon.src)), `${name}: ${icon.src} does not exist`);

      if (icon.type === 'image/png') {
        const { width, height } = pngSize(read(icon.src));
        assert.equal(`${width}x${height}`, icon.sizes,
          `${icon.src} is ${width}x${height} but claims ${icon.sizes}`);
      }
    }
  }
});

test('a manifest offers the PNG sizes Android installs from', () => {
  for (const name of MANIFESTS) {
    const sizes = JSON.parse(read(name).toString()).icons
      .filter((i) => i.type === 'image/png')
      .map((i) => i.sizes);
    assert.ok(sizes.includes('192x192'), `${name} has no 192px icon`);
    assert.ok(sizes.includes('512x512'), `${name} has no 512px icon`);
  }
});

test('the two sites do not share an icon', () => {
  // The whole bug was one site wearing the other's face. Whatever the
  // housekeeping manifest points at must be a housekeeping file.
  const hk = JSON.parse(read('/manifest.housekeeping.webmanifest').toString());
  for (const icon of hk.icons) {
    assert.match(icon.src, /\.housekeeping\./, `${icon.src} is the breakfast icon`);
  }

  const breakfast = JSON.parse(read('/manifest.webmanifest').toString());
  for (const icon of breakfast.icons) {
    assert.doesNotMatch(icon.src, /\.housekeeping\./);
  }
});

test('every file the page links to exists', () => {
  const html = read('/index.html').toString();
  const linked = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);

  assert.ok(linked.includes('/apple-touch-icon.png'), 'iOS needs an apple-touch-icon');
  assert.ok(linked.includes('/manifest.webmanifest'));

  for (const path of linked) {
    assert.ok(existsSync(file(path)), `index.html links to ${path}, which does not exist`);
  }
});

test('the housekeeping site has its own version of every swapped file', () => {
  for (const path of SITE_ASSETS) {
    assert.ok(existsSync(file(path)), `${path} is missing`);
    const swapped = housekeepingAsset(path);
    assert.ok(existsSync(file(swapped)), `${swapped} is missing`);
    assert.notEqual(read(path).toString('base64'), read(swapped).toString('base64'),
      `${path} and ${swapped} are the same file, so the swap achieves nothing`);
  }
});

test('the swap keeps the extension, which is what decides the content type', () => {
  assert.equal(housekeepingAsset('/icon-192.png'), '/icon-192.housekeeping.png');
  assert.equal(housekeepingAsset('/manifest.webmanifest'), '/manifest.housekeeping.webmanifest');
  assert.equal(housekeepingAsset('/icon.svg'), '/icon.housekeeping.svg');
});

test('the housekeeping deployment routes those paths through the Worker', () => {
  // The swap above only happens if the request reaches the Worker at all.
  const toml = readFileSync(join(import.meta.dirname, '..', 'wrangler.housekeeping.toml'), 'utf8');
  for (const path of SITE_ASSETS) {
    assert.ok(toml.includes(`"${path}"`),
      `${path} is swapped in code but not listed in run_worker_first`);
  }
});

test('the breakfast deployment is left alone', () => {
  // It serves the plain files straight from the asset store, as it always has.
  const toml = readFileSync(join(import.meta.dirname, '..', 'wrangler.toml'), 'utf8');
  assert.match(toml, /run_worker_first\s*=\s*\["\/api\/\*"\]/);
});
