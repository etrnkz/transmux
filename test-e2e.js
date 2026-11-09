/**
 * E2E: conversion pipeline, chunked live streaming, MP4 export, subtitles.
 *
 * Asserts on real observable state (video element, blob bytes, DOM), never on
 * incidental copy. Run with the dev server up:  python server.py 8000
 *
 *   node test-e2e.js
 */
const { chromium } = require('C:/Users/user/.agents/skills/playwright/node_modules/playwright');
const path = require('path');

const BASE = 'http://localhost:8000/';
let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

async function waitReady(page) {
  await page.waitForFunction(
    () => document.getElementById('ffmpegStatusText')?.textContent.includes('FFmpeg.wasm loaded'),
    { timeout: 40000 }
  );
}

async function waitSettled(page, ms = 120000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById('status').textContent;
      const p = document.getElementById('progressText').textContent;
      return (
        s.includes('converted and ready') ||
        s.includes('fast-remux complete') ||
        s.includes('failed') ||
        s.includes('error') ||
        p.includes('converted and ready')
      );
    },
    { timeout: ms }
  );
  // let the tail of the queue (subtitles) finish
  await page.waitForTimeout(1500);
}

async function load(page, file) {
  await page.setInputFiles('#fileInput', path.resolve(file));
  await waitSettled(page);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));

  await page.goto(BASE);
  await waitReady(page);
  console.log('FFmpeg.wasm loaded\n');

  // ---------------------------------------------------------------- 1. AVI -> MP4
  console.log('--- 1. AVI (mpeg4) converts and plays ---');
  await load(page, 'samples/test-sample.avi');
  const avi = await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    return {
      src: v.src,
      duration: v.duration,
      error: v.error ? v.error.code : null,
      status: document.getElementById('status').textContent,
    };
  });
  check('AVI has a blob source', avi.src.startsWith('blob:'), avi.src.slice(0, 40));
  check('AVI has finite duration', Number.isFinite(avi.duration) && avi.duration > 0, String(avi.duration));
  check('AVI video element reports no error', avi.error === null, String(avi.error));

  // ------------------------------------------------- 2. Live streaming reaches MSE
  console.log('\n--- 2. Long AVI streams progressively into MediaSource ---');
  await load(page, 'samples/test-30s.avi');
  const streamed = await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    return {
      duration: v.duration,
      seekableEnd: v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null,
      error: v.error ? v.error.code : null,
    };
  });
  check(
    'streamed timeline covers the full 30s',
    streamed.seekableEnd >= 29,
    `seekable end ${streamed.seekableEnd}`
  );
  check('streamed video reports no error', streamed.error === null, String(streamed.error));

  const seek = await page.evaluate(async () => {
    const v = document.getElementById('videoPlayer');
    v.currentTime = 25;
    await new Promise((r) => setTimeout(r, 1500));
    return { t: v.currentTime, readyState: v.readyState };
  });
  check('seeking to 25s lands near 25s', Math.abs(seek.t - 25) < 2.5, `got ${seek.t.toFixed(2)}`);

  // ------------------------------------------------------------ 3. MP4 export
  console.log('\n--- 3. Export MP4 produces a valid, complete file ---');
  const exported = await page.evaluate(async () => {
    let href = null;
    const orig = HTMLAnchorElement.prototype.click;
    // The export render is async, so the anchor click happens long after
    // downloadProcessed() returns — keep the patch installed until the wait ends.
    HTMLAnchorElement.prototype.click = function () {
      href = this.href;
    };
    try {
      window.downloadProcessed();

      const deadline = Date.now() + 180000;
      while (!href && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    if (!href) return { href: null };

    const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
    const atoms = {};
    let off = 0;
    while (off + 8 <= buf.length) {
      const size = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
      const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
      if (size < 8 || off + size > buf.length) break;
      atoms[type] = (atoms[type] || 0) + 1;
      off += size;
    }

    const t = document.createElement('video');
    t.src = href;
    const ev = await new Promise((r) => {
      t.onloadedmetadata = () => r('loadedmetadata');
      t.onerror = () => r('error ' + (t.error && t.error.code));
      setTimeout(() => r('timeout'), 8000);
    });

    return {
      href: href.slice(0, 20),
      bytes: buf.length,
      atoms,
      ev,
      duration: t.duration,
      seekableEnd: t.seekable.length ? t.seekable.end(t.seekable.length - 1) : null,
    };
  });

  check('export hands over a blob url', !!exported.href);
  check('export file parses as media', exported.ev === 'loadedmetadata', exported.ev);
  check(
    'export duration covers the full 30s (not one chunk)',
    typeof exported.duration === 'number' && exported.duration >= 29,
    `duration ${exported.duration}`
  );
  check(
    'export is a single valid MP4, not concatenated fragments',
    (exported.atoms?.moov || 0) === 1 && (exported.atoms?.ftyp || 0) === 1,
    JSON.stringify(exported.atoms || null)
  );
  check('export has real payload', (exported.bytes || 0) > 100000, (exported.bytes || 0) + ' bytes');

  // --------------------------------------------------------- 4. No fake subtitles
  console.log('\n--- 4. File without subtitles does not fabricate a track ---');
  const subs = await page.evaluate(() => ({
    tracks: document.querySelectorAll('#videoPlayer track').length,
    btnDisabled: document.getElementById('subtitleBtn')?.disabled,
    log: document.getElementById('logEntries').innerText,
  }));
  check('no <track> injected for a subtitle-less file', subs.tracks === 0, String(subs.tracks));
  check('subtitles button is disabled', subs.btnDisabled === true, String(subs.btnDisabled));
  check('log states there are no subtitles', subs.log.includes('No subtitles'), subs.log.slice(-120));
  check('no "Demo subtitles" claim anywhere', !subs.log.includes('Demo subtitles'));

  // ------------------------------------- 5. Fast remux path for H.264 in AVI
  console.log('\n--- 5. H.264 inside AVI takes the instant remux path ---');
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', path.resolve('samples/test-h264.avi'));
  await waitSettled(page, 60000);
  const elapsed = Date.now() - t0;
  const fast = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    duration: document.getElementById('videoPlayer').duration,
    src: document.getElementById('videoPlayer').src,
  }));
  check('fast path reported', /fast-remux/.test(fast.status), fast.status);
  check('fast path finished quickly', elapsed < 20000, elapsed + 'ms');
  check('fast path video plays', fast.src.startsWith('blob:') && fast.duration > 0, String(fast.duration));

  // ------------------------------------- 5b. MKV is not handed to <video> raw
  console.log('\n--- 5b. MKV (H.264) also remuxes instead of failing natively ---');
  await page.setInputFiles('#fileInput', path.resolve('samples/test-sample.mkv'));
  await waitSettled(page, 60000);
  const mkv = await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    return {
      status: document.getElementById('status').textContent,
      duration: v.duration,
      error: v.error ? v.error.code : null,
      tracks: document.querySelectorAll('#videoPlayer track').length,
    };
  });
  check('MKV remuxes and plays', mkv.duration > 0 && mkv.error === null, JSON.stringify(mkv));
  check('MKV subtitle track extracted', mkv.tracks === 1, String(mkv.tracks));

  // ------------------------------------- 5c. H.265/AC-3 MKV streams
  console.log('\n--- 5c. H.265 + AC-3 MKV falls back to progressive streaming ---');
  await page.setInputFiles('#fileInput', path.resolve('samples/test-hevc-ac3.mkv'));
  await waitSettled(page, 240000);
  const hevc = await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    return {
      seekableEnd: v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null,
      error: v.error ? v.error.code : null,
    };
  });
  check('HEVC/AC-3 streams to a playable timeline', (hevc.seekableEnd || 0) > 0.5 && hevc.error === null, JSON.stringify(hevc));

  // -------------------------------------------- 6. Reset cancels in flight work
  console.log('\n--- 6. Reset stops an in-flight conversion ---');
  await page.setInputFiles('#fileInput', path.resolve('samples/test-30s.avi'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.resetPlayer());
  const afterReset = await page.evaluate(() => ({
    upload: getComputedStyle(document.getElementById('uploadArea')).display,
    status: document.getElementById('status').textContent,
  }));
  check('reset restores the upload stage', afterReset.upload === 'flex', afterReset.upload);

  await page.waitForTimeout(9000);
  const later = await page.evaluate(() => ({
    upload: getComputedStyle(document.getElementById('uploadArea')).display,
    video: getComputedStyle(document.getElementById('videoContainer')).display,
    status: document.getElementById('status').textContent,
  }));
  check('cancelled conversion does not repaint the stage', later.video === 'none', later.video);
  check('status stays at "Player reset"', later.status.includes('Player reset'), later.status);

  // ------------------------------------------------------- 7. Console hygiene
  console.log('\n--- 7. No unexpected console errors ---');
  const ignorable = /net::ERR_ABORTED|Failed to load resource.*favicon/i;
  const real = consoleErrors.filter((e) => !ignorable.test(e));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`));
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(1);
});
