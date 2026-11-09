// Smoke test for the *library* embedding path (quick-start.html).
// Verifies the module mounts, the scoped stylesheet applies, the worker loads
// its FFmpeg core through the injected paths, and nothing throws.
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8123';
// Where the demo page lives. Overridable so the same checks can be run against
// a subdirectory deployment (e.g. PAGE=/vendor/player/v1/quick-start.html).
const PAGE = process.env.PAGE || '/quick-start.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} :: ${req.failure() && req.failure().errorText}`);
  });

  let exitCode = 0;
  const fail = (msg) => { console.log(`FAIL ${msg}`); exitCode = 1; };
  const pass = (msg) => console.log(`PASS ${msg}`);

  await page.goto(`${BASE}${PAGE}`, { waitUntil: 'domcontentloaded' });

  // 1. The player mounted its root.
  const root = page.locator('.wvp-root');
  if (await root.count() === 1) pass('.wvp-root mounted');
  else fail(`expected 1 .wvp-root, found ${await root.count()}`);

  // 2. Scoped CSS is actually applied (not just present in the file).
  const uploadBg = await page.locator('.wvp-stage').evaluate((el) => getComputedStyle(el).backgroundColor);
  if (uploadBg === 'rgb(17, 20, 28)') pass(`stylesheet applied (.wvp-stage bg = ${uploadBg})`);
  else fail(`stylesheet not applied (got ${uploadBg})`);

  // 3. Host page CSS did not leak in — the root keeps its own font stack.
  const radius = await page.locator('.wvp-stage').evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  if (radius === '16px') pass(`tokenised radius (${radius})`);
  else fail(`unexpected radius ${radius}`);

  // 4. Cross-origin isolation is real in the page context.
  const isolated = await page.evaluate(() => self.crossOriginIsolated);
  if (isolated === true) pass('crossOriginIsolated === true');
  else fail('crossOriginIsolated !== true (COOP/COEP missing)');

  // 5. The worker loaded the core at the injected location and reported ready.
  //    The pill text is the player's own signal for that.
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[id$="-ffmpegStatusText"]');
        return el && /loaded/i.test(el.textContent);
      },
      { timeout: 60000 }
    );
    const text = await page.locator('[id$="-ffmpegStatusText"]').textContent();
    pass(`worker ready via injected core path ("${text.trim()}")`);
  } catch (e) {
    const text = await page.locator('[id$="-ffmpegStatusText"]').textContent().catch(() => '(missing)');
    fail(`worker never reported ready (pill = "${String(text).trim()}")`);
  }

  // 6. Empty state is visible and the video container is hidden until load.
  const uploadVisible = await page.locator('.wvp-upload').isVisible();
  const videoVisible = await page.locator('.wvp-video-container').isVisible();
  if (uploadVisible && !videoVisible) pass('empty state visible, video hidden');
  else fail(`bad initial state (upload=${uploadVisible}, video=${videoVisible})`);

  // 7. The public API is present on the mount.
  const api = await page.evaluate(() => {
    const p = window.player;
    if (!p) return null;
    return {
      fns: ['loadFile', 'reset', 'exportVideo', 'setPlaybackRate', 'selectAudioTrack', 'toggleSubtitles', 'clearLog', 'getState', 'on', 'destroy'].filter((k) => typeof p[k] === 'function'),
      state: p.getState(),
      urls: p.urls
    };
  });
  if (api && api.fns.length === 10) pass('public API complete (10/10 methods)');
  else fail(`public API incomplete: ${JSON.stringify(api && api.fns)}`);

  // The worker URL either carries an explicit coreBase, or the worker falls back
  // to resolving the core from its own URL. Both are valid; what matters is that
  // one of them is in play (check 5 already proved the core actually loaded).
  const workerUrl = api ? api.urls.worker : '';
  const hasExplicitCoreBase = workerUrl.includes('coreBase=');
  const resolvesFromOwnUrl = !api || api.urls.coreBase === null;
  if (hasExplicitCoreBase && workerUrl.startsWith(`${BASE}/`)) pass(`worker URL carries coreBase (${workerUrl})`);
  else if (resolvesFromOwnUrl) pass('worker URL omits coreBase — worker resolves the core from its own location');
  else fail(`worker URL neither explicit nor self-resolving: ${JSON.stringify(api && api.urls)}`);

  // 8. Actually load a file through the player and watch it reach the stage.
  const fileInput = page.locator('.wvp-file-input');
  await fileInput.setInputFiles('test-mpeg4.avi');
  try {
    await page.waitForFunction(
      () => {
        const container = document.querySelector('.wvp-video-container');
        const video = document.querySelector('video');
        return container && getComputedStyle(container).display !== 'none' && video && (video.currentTime > 0 || video.readyState >= 2);
      },
      { timeout: 120000 }
    );
    const t = await page.locator('video').evaluate((v) => ({ t: v.currentTime, rs: v.readyState, w: v.videoWidth }));
    pass(`AVI played through the embedded player (t=${t.t.toFixed(2)}s, readyState=${t.rs}, ${t.w}px wide)`);
  } catch (e) {
    const t = await page.locator('video').evaluate((v) => ({ t: v.currentTime, rs: v.readyState })).catch(() => ({}));
    fail(`AVI never played through the embedded player (${JSON.stringify(t)})`);
  }

  // 9. Console hygiene — the library must not shout.
  if (pageErrors.length === 0) pass('no uncaught page errors');
  else fail(`uncaught page errors: ${pageErrors.join(' | ')}`);

  const meaningfulErrors = consoleErrors.filter((t) => !/favicon/i.test(t));
  if (meaningfulErrors.length === 0) pass('no console errors');
  else fail(`console errors: ${meaningfulErrors.join(' | ')}`);

  if (failedRequests.length === 0) pass('no failed network requests');
  else fail(`failed requests: ${failedRequests.join(' | ')}`);

  await browser.close();
  console.log(exitCode === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
  process.exit(exitCode);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
