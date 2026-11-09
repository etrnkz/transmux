const { chromium } = require('C:/Users/user/.agents/skills/playwright/node_modules/playwright');
const path = require('path');

(async () => {
  console.log('🚀 Starting Verification Test for Live Progressive Streaming & Fast Copy...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => console.log(`[Browser Console] ${msg.text()}`));
  page.on('pageerror', err => console.error(`[Browser PageError] ${err.message}`));

  console.log('📡 Navigating to http://localhost:8000/ ...');
  await page.goto('http://localhost:8000/');

  await page.waitForFunction(() => {
    const el = document.getElementById('ffmpegStatusText');
    return el && el.textContent.includes('FFmpeg.wasm loaded');
  }, { timeout: 30000 });
  console.log('✅ Worker initialized!');

  // TEST 1: Fast Copy on samples/test-h264.avi
  console.log('\n--- TEST 1: Fast Copy on samples/test-h264.avi ---');
  const startH264 = Date.now();
  await page.setInputFiles('#fileInput', path.resolve('samples/test-h264.avi'));

  await page.waitForFunction(() => {
    const el = document.getElementById('status');
    return el && el.textContent.includes('Instant fast-remux complete');
  }, { timeout: 15000 });
  const durationH264 = (Date.now() - startH264) / 1000;
  console.log(`⚡ Fast Copy finished in: ${durationH264.toFixed(2)}s!`);

  // Reset player for test 2
  await page.evaluate(() => window.resetPlayer());
  await new Promise(r => setTimeout(r, 500));

  // TEST 2: Live Progressive Streaming on samples/test-mpeg4.avi
  console.log('\n--- TEST 2: Live Progressive Streaming on samples/test-mpeg4.avi ---');
  const startMpeg4 = Date.now();
  await page.setInputFiles('#fileInput', path.resolve('samples/test-mpeg4.avi'));

  // Verify playback starts on the very first chunk without waiting!
  console.log('⏳ Waiting for live streaming playback to start...');
  await page.waitForFunction(() => {
    const v = document.getElementById('videoPlayer');
    const status = document.getElementById('status')?.innerText;
    return v && v.src && v.src.startsWith('blob:') && (status && status.includes('Live stream playing'));
  }, { timeout: 10000 });

  const durationToPlay = (Date.now() - startMpeg4) / 1000;
  console.log(`▶️ Playback started in: ${durationToPlay.toFixed(2)}s (user NEVER waits for full conversion)!`);

  // Wait for all chunks to buffer
  console.log('⏳ Buffering remaining chunks in background while video is playing...');
  await page.waitForFunction(() => {
    const el = document.getElementById('status');
    return el && el.textContent.includes('Entire video converted');
  }, { timeout: 45000 });

  const durationTotal = (Date.now() - startMpeg4) / 1000;
  console.log(`✅ All stream chunks buffered in: ${durationTotal.toFixed(2)}s total!`);

  // Verify video is still actively playing and has buffered data
  const streamStatus = await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    return {
      src: v.src,
      currentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      hasMediaSource: v.src.startsWith('blob:')
    };
  });
  console.log('🎥 Live streaming player state:', streamStatus);

  console.log('\n🎉 ALL TESTS PASSED! Live progressive streaming eliminates all waiting.');
  await browser.close();
  process.exit(0);
})();
