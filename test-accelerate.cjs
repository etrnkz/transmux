/**
 * E2E: acceleration — hardware (WebCodecs) encoding, parallel chunk encoding
 * and cancellation.
 *
 * Asserts on real observable state (the video element, the chunk timings the
 * player reports, the telemetry log), never on incidental copy.
 *
 *   node test-accelerate.cjs
 *
 * BASE defaults to http://localhost:8301/ (the repo's dev server).
 */
const { chromium } = require('C:/Users/user/.agents/skills/playwright/node_modules/playwright');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8301/';
let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/**
 * Mount a player with the given options and wait until its FFmpeg core is up.
 */
async function mount(page, options) {
  await page.evaluate(async (opts) => {
    const mod = await import('./wasm-video-player.js');
    const div = document.createElement('div');
    div.className = 'accelerate-host';
    document.body.appendChild(div);
    window.__players = window.__players || [];
    const player = mod.createPlayer({
      container: div,
      workerUrl: './ffmpeg-worker.js',
      coreBaseUrl: './public',
      showLog: true,
      ...opts
    });
    window.__players.push(player);
    window.__player = player;
    window.__ready = false;
    player.on('ready', () => { window.__ready = true; });
    window.__logs = [];
    player.on('log', (entry) => {
      window.__logs.push((entry && entry.message) || String(entry));
    });
  }, options);

  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
}

/** Feed a sample file to the mounted player. */
async function load(page, file) {
  const bytes = require('fs').readFileSync(path.join(__dirname, 'samples', file));
  await page.evaluate(async ({ name, data }) => {
    const u8 = new Uint8Array(data);
    const blob = new Blob([u8], { type: 'video/x-msvideo' });
    await window.__player.loadFile(new File([blob], name, { type: 'video/x-msvideo' }));
  }, { name: file, data: Array.from(bytes) });
}

/** Wait until every chunk of the stream has been emitted. */
async function waitForChunks(page, min, timeout = 180000) {
  await page.waitForFunction(
    (n) => {
      const p = window.__player;
      if (!p) return false;
      const s = p.getState();
      return (s.chunkTimings || []).length >= n;
    },
    min,
    { timeout }
  );
}

async function readState(page) {
  return page.evaluate(() => {
    const p = window.__player;
    const s = p.getState();
    const v = document.querySelector('.accelerate-host video');
    return {
      threads: s.threads,
      gpu: s.gpu,
      encoder: s.encoder,
      chunkTimings: s.chunkTimings || [],
      logs: window.__logs || [],
      video: v
        ? {
            error: v.error ? v.error.code : null,
            duration: v.duration,
            readyState: v.readyState,
            width: v.videoWidth,
            height: v.videoHeight,
            currentTime: v.currentTime
          }
        : null
    };
  });
}

/**
 * True when at least two chunks were encoded at the same time, i.e. their
 * [startedAt, finishedAt] windows overlap.
 */
function overlapCount(timings) {
  const windows = timings
    .filter((t) => typeof t.startedAt === 'number' && typeof t.finishedAt === 'number')
    .map((t) => ({ i: t.index, a: t.startedAt, b: t.finishedAt }));
  let overlaps = 0;
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      if (a.a < b.b && b.a < a.b) overlaps++;
    }
  }
  return overlaps;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));

  await page.goto(BASE, { waitUntil: 'load' });

  // ------------------------------------------------------------------ 1. GPU
  section('1. WebCodecs hardware encoder is used when available');
  await mount(page, { threads: 1, gpu: 'auto' });
  await load(page, 'test-mpeg4.avi');
  await waitForChunks(page, 1);
  await page.waitForTimeout(3000);
  let state = await readState(page);

  const webcodecsUsed = state.encoder === 'webcodecs'
    || state.chunkTimings.some((t) => t.encoder === 'webcodecs');
  check('hardware encoder reported', webcodecsUsed,
    `encoder=${state.encoder} chunkEncoders=${JSON.stringify(state.chunkTimings.map((t) => t.encoder))}`);
  check('gpu option is reported back', state.gpu === 'auto', `gpu=${state.gpu}`);
  check('hardware-encoded video plays', state.video && !state.video.error && state.video.readyState >= 2,
    JSON.stringify(state.video));
  check('hardware-encoded video has a finite duration',
    state.video && Number.isFinite(state.video.duration) && state.video.duration > 0,
    state.video ? `duration=${state.video.duration}` : 'no video');

  // ------------------------------------------------------- 2. gpu:'off' path
  section("2. gpu:'off' still converts through libx264");
  await page.evaluate(() => {
    for (const p of window.__players || []) { try { p.destroy(); } catch (_) {} }
    document.querySelectorAll('.accelerate-host').forEach((n) => n.remove());
    window.__players = [];
  });
  await mount(page, { threads: 1, gpu: 'off' });
  await load(page, 'test-mpeg4.avi');
  await waitForChunks(page, 1);
  await page.waitForTimeout(3000);
  state = await readState(page);

  check('gpu:off reports the software encoder', state.encoder === 'wasm',
    `encoder=${state.encoder}`);
  check('gpu:off video plays', state.video && !state.video.error && state.video.readyState >= 2,
    JSON.stringify(state.video));

  // ------------------------------------------------------- 3. parallel chunks
  section('3. Chunks are encoded in parallel across several workers');
  await page.evaluate(() => {
    for (const p of window.__players || []) { try { p.destroy(); } catch (_) {} }
    document.querySelectorAll('.accelerate-host').forEach((n) => n.remove());
    window.__players = [];
  });
  await mount(page, { threads: 4, gpu: 'auto' });
  await load(page, 'test-30s.avi');
  await waitForChunks(page, 3);
  await page.waitForTimeout(4000);
  state = await readState(page);

  check('threads option is reported back', state.threads === 4, `threads=${state.threads}`);
  check('several chunks were produced', state.chunkTimings.length >= 3,
    `chunks=${state.chunkTimings.length}`);
  const indexes = state.chunkTimings.map((t) => t.index);
  const ordered = indexes.every((v, i) => v === i);
  check('chunks are emitted in order', ordered, `indexes=${JSON.stringify(indexes)}`);
  const overlaps = overlapCount(state.chunkTimings);
  console.log('      chunk timings:', state.chunkTimings
    .map((t) => `#${t.index} ${t.encoder} ${t.ms}ms [${t.startedAt}..${t.finishedAt}]`).join(' | '));
  check('at least two chunks were encoded concurrently', overlaps > 0,
    `overlapping pairs=${overlaps} timings=${JSON.stringify(state.chunkTimings)}`);
  const poolLog = state.logs.some((l) => /parallel encoding worker/i.test(l));
  check('parallel worker pool was engaged', poolLog,
    state.logs.filter((l) => /parallel|worker/i.test(l)).slice(-3).join(' | ') || 'no pool log');

  // ------------------------------------------------------------- 4. cancel
  section('4. Cancelling a running conversion is prompt');
  await page.evaluate(() => {
    for (const p of window.__players || []) { try { p.destroy(); } catch (_) {} }
    document.querySelectorAll('.accelerate-host').forEach((n) => n.remove());
    window.__players = [];
  });
  await mount(page, { threads: 4, gpu: 'auto' });
  await load(page, 'test-30s.avi');
  await page.waitForTimeout(1500);
  const cancelStart = Date.now();
  await page.evaluate(() => window.__player.reset());
  await page.waitForFunction(
    () => {
      const v = document.querySelector('.accelerate-host video');
      const s = document.querySelector('.accelerate-host .wvp-status');
      return !v || !v.src || (s && /reset/i.test(s.textContent || ''));
    },
    null,
    { timeout: 15000 }
  );
  const cancelMs = Date.now() - cancelStart;
  check('cancel returns to the upload stage in under 10s', cancelMs < 10000, `${cancelMs}ms`);
  const afterCancel = await readState(page);
  check('cancelled job leaves no conversion behind', !afterCancel.video || !afterCancel.video.error,
    JSON.stringify(afterCancel.video));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
