// Self document polyfill for Webpack 5 bundle in WorkerGlobalScope
self.document = { baseURI: self.location.href };

let ffmpeg = null;
let isLoaded = false;
let fetchFileFunc = null;
let createFFmpegFunc = null;

// Where the FFmpeg.wasm assets live. Defaults are resolved from this worker's
// own URL, so the player works when served from a subdirectory instead of only
// from the site root. Any value can be overridden with a query parameter on the
// worker URL (e.g. `ffmpeg-worker.js?coreBase=https://cdn.example/ffmpeg`),
// which is how the player factory injects a cross-origin/CDN location. Reading
// them here — synchronously, at module evaluation — means the config is in place
// before the automatic loadFFmpeg() call at the bottom of this file, so there is
// no startup race between "worker ready" and "paths configured".
const CONFIG = (function resolveConfig() {
  const params = new URL(self.location.href).searchParams;
  const trim = (s) => String(s).replace(/\/+$/, '');
  // ./public/ sits next to this worker in this repo; overridable for packaging.
  const defaultBase = trim(new URL('./public', self.location.href).href);
  const base = trim(params.get('coreBase') || defaultBase);

  // How many chunk-encoding workers may be used in total (the primary worker
  // counts as one). 1 keeps the historical single-worker behaviour.
  const threads = Math.max(1, parseInt(params.get('threads') || '1', 10) || 1);

  // 'auto' | 'on' | 'off' — whether the WebCodecs hardware encoder may be used.
  const gpuParam = String(params.get('gpu') || 'auto').toLowerCase();
  const gpu = (gpuParam === 'on' || gpuParam === 'off') ? gpuParam : 'auto';

  // 'primary' drives the conversion; 'chunk' is a satellite worker that only
  // encodes individual stream chunks.
  const roleParam = String(params.get('role') || 'primary').toLowerCase();
  const role = roleParam === 'chunk' ? 'chunk' : 'primary';

  return {
    // The ffmpeg.wasm wrapper (importScripts). Separate knob because a host may
    // keep the wrapper local while pulling the 24 MB core from a CDN.
    ffmpegJs: params.get('ffmpegJs') || base + '/ffmpeg.js',
    corePath: params.get('corePath') || base + '/ffmpeg-core.js',
    wasmPath: params.get('wasmPath') || base + '/ffmpeg-core.wasm',
    workerPath: params.get('workerPath') || base + '/ffmpeg-core.worker.js',
    // The WebCodecs helper. It ships next to this worker, so it is resolved
    // from the worker's own URL rather than from the core base (the core may
    // live on a CDN while this script stays local).
    encoderJs: params.get('encoderJs') || new URL('./webcodecs-encoder.js', self.location.href).href,
    threads,
    gpu,
    role
  };
})();

function post(type, data, transfer) {
  try { self.postMessage({ type, data }, transfer || []); } catch (e) {}
}

const defaultLogger = ({ message }) => {
  // Satellite workers stay quiet: four extra cores would otherwise flood the
  // telemetry panel with their own FFmpeg chatter.
  if (message && CONFIG.role === 'primary') {
    post('FFLOG', { message: `[FFmpeg] ${message}` });
  }
};

// Resolved once the core finished loading *or* failed to load. Jobs wait on it
// so a freshly spawned/reloaded worker can be handed work immediately instead
// of answering "FFmpeg not loaded" during its ~1.5s startup.
let markReady = () => {};
let readyPromise = Promise.resolve();
function resetReady() {
  readyPromise = new Promise((resolve) => { markReady = resolve; });
}

// Sequential task queue to prevent concurrent ffmpeg.run() calls
let taskQueue = Promise.resolve();
function enqueueTask(taskFn) {
  taskQueue = taskQueue
    .then(() => readyPromise)
    .then(taskFn)
    .catch(err => {
      post('ERROR', { message: `Task failed: ${err.message || err}` });
    });
  return taskQueue;
}

// Monotonic job token. Bumped by CANCEL and by every new job, so any running
// conversion notices it has been superseded and unwinds at its next checkpoint.
let jobSerial = 0;
function isCancelled(token) {
  return token !== jobSerial;
}

// ---------------------------------------------------------------------------
// Acceleration knobs
// ---------------------------------------------------------------------------

// --- Feature A: WebCodecs hardware encode ---------------------------------
// The hardware path dumps the decoded chunk to rawvideo, feeds it to the
// platform's H.264 encoder and muxes the result back. The raw buffer is by far
// the biggest object in the pipeline (width * height * 1.5 bytes per frame),
// so the path is bounded in three ways:
//   * resolution  — anything larger than 720p is left to libx264;
//   * raw bytes   — a single rawvideo dump may not exceed GPU_MAX_RAW_BYTES;
//   * chunk size  — the chunk length is shortened so the dump fits the budget.
const GPU_MAX_WIDTH = 1280;
const GPU_MAX_HEIGHT = 720;
const GPU_MAX_RAW_BYTES = 64 * 1024 * 1024;
const GPU_MIN_CHUNK_SECONDS = 1;

// --- Feature B: parallel chunk encoding -----------------------------------
// Every extra worker needs its own copy of the source file in its own MEMFS,
// so the source is duplicated N times in RAM. Copying a multi-gigabyte file
// into four workers is not acceptable, therefore extra workers are only used
// for inputs up to MAX_PARALLEL_INPUT_BYTES, and the total amount of duplicated
// input is capped by MAX_PARALLEL_TOTAL_BYTES.
const MAX_PARALLEL_INPUT_BYTES = 64 * 1024 * 1024;   // per worker copy
const MAX_PARALLEL_TOTAL_BYTES = 192 * 1024 * 1024;  // across all worker copies

// Rough target bitrate for the hardware encoder, derived from the picture
// size. Kept in the same ballpark as the libx264 CRF 26 path so switching
// encoders does not change the size of the produced chunks by an order of
// magnitude.
function gpuBitrate(width, height, fps) {
  const raw = (width || 0) * (height || 0) * (fps || 0) * 0.03;
  return Math.round(Math.min(6000000, Math.max(300000, raw || 800000)));
}

// How many raw frames fit into the rawvideo memory budget.
function gpuFramesPerDump(width, height) {
  const frameSize = Math.floor((width * height * 3) / 2);
  if (!frameSize) return 0;
  return Math.max(1, Math.floor(GPU_MAX_RAW_BYTES / frameSize));
}

// The WebCodecs helper is a classic script, so it is pulled in with
// importScripts just like the ffmpeg.wasm wrapper.
let encoderHelper = null;
function loadEncoderHelper() {
  if (encoderHelper) return encoderHelper;
  try {
    importScripts(CONFIG.encoderJs);
  } catch (err) {
    post('LOG', { message: `WebCodecs helper unavailable: ${err.message}`, level: 'warn' });
    return null;
  }
  encoderHelper = self.WebCodecsEncoder || null;
  return encoderHelper;
}

// True when the platform exposes a usable hardware video encoder.
function webCodecsAvailable() {
  const helper = loadEncoderHelper();
  if (!helper || !helper.isAvailable()) return false;
  return true;
}

async function loadFFmpeg() {
  try {
    post('LOG', { message: 'Loading FFmpeg.wasm from local files...', level: 'info' });

    importScripts(CONFIG.ffmpegJs);

    if (self.FFmpeg && self.FFmpeg.createFFmpeg) {
      createFFmpegFunc = self.FFmpeg.createFFmpeg;
      fetchFileFunc = self.FFmpeg.fetchFile;
    } else if (typeof FFmpeg !== 'undefined' && FFmpeg.createFFmpeg) {
      createFFmpegFunc = FFmpeg.createFFmpeg;
      fetchFileFunc = FFmpeg.fetchFile;
    } else if (typeof createFFmpeg !== 'undefined') {
      createFFmpegFunc = createFFmpeg;
      fetchFileFunc = fetchFile;
    } else {
      throw new Error('FFmpeg constructor not found after importScripts');
    }

    if (!fetchFileFunc) {
      fetchFileFunc = (file) => file.arrayBuffer().then(buf => new Uint8Array(buf));
    }

    const corePath = CONFIG.corePath;
    const wasmPath = CONFIG.wasmPath;
    const workerPath = CONFIG.workerPath;

    ffmpeg = createFFmpegFunc({
      // Satellites stay quiet on the console; the primary keeps the full log.
      log: CONFIG.role === 'primary',
      corePath,
      wasmPath,
      workerPath
    });

    ffmpeg.setLogger(defaultLogger);

    await ffmpeg.load();
    isLoaded = true;
    markReady(true);

    post('LOG', { message: 'FFmpeg.wasm loaded successfully!', level: 'success' });
    post('WORKER_READY', { message: 'FFmpeg worker ready for conversions' });

  } catch (err) {
    markReady(false);
    post('LOG', { message: `FFmpeg load failed: ${err.message}`, level: 'error' });
    post('ERROR', { message: `FFmpeg initialization failed: ${err.message}` });
  }
}

// FFmpeg.wasm has no abort, so interrupting a running exec is done by the page
// terminating this worker and spawning a fresh one (see resetPlayer). A new
// worker re-runs this module body, so resetReady()/loadFFmpeg() below is all the
// core state that needs restoring.

// ffmpeg's audio map is indexed among audio streams, not overall streams, so
// track 1 means "the second audio stream" regardless of where video/subs sit.
const DEFAULT_AUDIO_TRACK = 0;

function audioMapArgs(track) {
  const i = Number.isInteger(track) && track >= 0 ? track : DEFAULT_AUDIO_TRACK;
  // `?` makes the map optional, so a file with no audio streams still converts
  // instead of dying on "Stream map '0:a:N' matches no streams".
  return ['-map', '0:v:0', '-map', `0:a:${i}?`];
}

// Chunk duration is a latency/memory trade: small chunks start playback sooner,
// long videos need bigger chunks so the per-chunk encoder setup does not
// dominate. Also clamp by bitrate so a high-bitrate source cannot produce
// multi-megabyte chunks that stall the MediaSource queue.
const MAX_CHUNK_BYTES = 12 * 1024 * 1024;
function chooseChunkSeconds(duration, sizeBytes) {
  const base = duration <= 60 ? 6 : duration <= 300 ? 10 : duration <= 1800 ? 15 : 20;
  const bytesPerSecond = duration > 0 && sizeBytes > 0 ? sizeBytes / duration : 0;
  if (bytesPerSecond > 0) {
    const cap = Math.floor(MAX_CHUNK_BYTES / bytesPerSecond);
    if (cap >= 2 && cap < base) return cap;
  }
  return base;
}

// One `ffmpeg -i` call buys codec, duration and the audio track list. Everything
// downstream (fast remux, streaming, export) reads from this, and the UI gets
// the track list before any encoding starts.
async function probeMedia(inputName) {
  const info = { isH264: false, duration: 0, audioTracks: [], width: 0, height: 0, fps: 0 };

  const probeLogger = ({ message }) => {
    if (!message) return;
    // `ffmpeg -i <file>` with no output always "fails"; that line is expected noise
    if (/Conversion failed!|At least one output file must be specified/i.test(message)) return;

    if (/Stream #.*Video:.*(h264|avc1)/i.test(message)) info.isH264 = true;

    const dur = message.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (dur) {
      info.duration = parseInt(dur[1]) * 3600 + parseInt(dur[2]) * 60 + parseFloat(dur[3]);
    }

    // Picture size and frame rate, needed by the WebCodecs path (it has to
    // know the exact I420 frame geometry). The two values are matched
    // separately because ffmpeg puts an optional bitrate field between the
    // resolution and the frame rate:
    //   "..., yuv420p, 320x240 [SAR 1:1 DAR 4:3], 215 kb/s, 15 fps, ..."
    const size = message.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
    if (size) {
      info.width = parseInt(size[1], 10) || 0;
      info.height = parseInt(size[2], 10) || 0;
    }
    const rate = message.match(/Video:.*?,\s*([\d.]+(?:\/\d+)?)\s+fps/);
    if (rate) {
      const raw = rate[1] || '';
      if (raw.indexOf('/') >= 0) {
        const parts = raw.split('/');
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        info.fps = den ? num / den : 0;
      } else {
        info.fps = parseFloat(raw) || 0;
      }
    }

    const audio = message.match(/Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\(([^)]+)\))?: Audio: ([^,\s]+)(.*)$/);
    if (audio) {
      const rest = audio[4] || '';
      const channels = rest.match(/\b(mono|stereo|quad|5\.1|7\.1)\b/);
      info.audioTracks.push({
        index: info.audioTracks.length,
        streamIndex: parseInt(audio[1]),
        lang: (audio[2] || '').toLowerCase() || null,
        codec: audio[3],
        channels: channels ? channels[1] : null,
        isDefault: /\(default\)/.test(rest)
      });
    }
  };

  ffmpeg.setLogger(probeLogger);
  try { await ffmpeg.run('-i', inputName); } catch (_) {}
  ffmpeg.setLogger(defaultLogger);

  return info;
}

// Picks the track to encode: what the user asked for if it still exists,
// otherwise the first track. null means "this file has no audio".
function resolveAudioTrack(tracks, requested) {
  if (!tracks || tracks.length === 0) return null;
  if (Number.isInteger(requested) && requested >= 0 && requested < tracks.length) return requested;
  return DEFAULT_AUDIO_TRACK;
}

// ---------------------------------------------------------------------------
// Chunk encoding
// ---------------------------------------------------------------------------
//
// A "chunk" is one fMP4 fragment of the progressive stream. Two encoders can
// produce it:
//
//   wasm      — one ffmpeg run does decode + libx264 + AAC + mux (the
//               historical path, always available).
//   webcodecs — FFmpeg decodes to rawvideo, the platform's hardware H.264
//               encoder encodes it, FFmpeg muxes the result (see
//               encodeChunkGpu). Falls back to `wasm` on any problem.

/**
 * Encode one stream chunk with libx264 inside FFmpeg.wasm.
 * This is the original path and stays byte-for-byte compatible with it.
 */
async function encodeChunkWasm(ctx) {
  const { ffmpeg: ff, inputName, outputName, startSec, durSec, audioTrack } = ctx;

  await ff.run(
    '-ss', String(startSec),
    '-t', String(durSec),
    '-i', inputName,
    ...audioMapArgs(audioTrack),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '26',
    '-c:a', 'aac',
    '-b:a', '96k',
    // Presentation timestamps must not restart at 0 in every segment, or the
    // sequence-mode timeline gets discontinuities on longer videos.
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-pix_fmt', 'yuv420p',
    outputName
  );

  const data = ff.FS('readFile', outputName);
  try { ff.FS('unlink', outputName); } catch (_) {}
  return data;
}

/**
 * Encode one stream chunk with the platform's hardware H.264 encoder.
 *
 * Steps: decode to rawvideo -> VideoEncoder -> Annex B elementary stream ->
 * mux with the (still wasm-encoded) AAC audio into a fragmented MP4.
 *
 * Throws on any problem; the caller falls back to encodeChunkWasm().
 */
async function encodeChunkGpu(ctx) {
  const {
    ffmpeg: ff, inputName, outputName, startSec, durSec, audioTrack,
    width, height, fps, codec, bitrate, id
  } = ctx;

  const helper = loadEncoderHelper();
  if (!helper || !helper.isAvailable()) throw new Error('WebCodecs is not available');
  if (!width || !height || !fps) throw new Error('missing picture geometry');
  if (width % 2 || height % 2) throw new Error('odd picture size is not I420 compatible');

  const frameSize = Math.floor((width * height * 3) / 2);
  const rawName = `raw_${id}.raw`;
  const videoName = `v_${id}.h264`;

  try {
    // 1. Decode to rawvideo. FFmpeg stays on the CPU here — there is no GPU
    //    decoder inside ffmpeg.wasm.
    await ff.run(
      '-ss', String(startSec),
      '-t', String(durSec),
      '-i', inputName,
      '-map', '0:v:0',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-y', rawName
    );

    const raw = ff.FS('readFile', rawName);
    try { ff.FS('unlink', rawName); } catch (_) {}

    const frameCount = Math.floor(raw.byteLength / frameSize);
    if (frameCount < 1) {
      throw new Error(`raw frame size mismatch (${raw.byteLength} bytes for ${width}x${height})`);
    }

    // 2. Hardware encode. A chunk may be longer than the raw budget allows, so
    //    the dump is encoded in slices; every slice starts with a keyframe and
    //    all slices share the same SPS/PPS, which makes the concatenated
    //    Annex B stream a valid elementary stream.
    const framesPerSlice = gpuFramesPerDump(width, height);
    const parts = [];
    for (let first = 0; first < frameCount; first += framesPerSlice) {
      const count = Math.min(framesPerSlice, frameCount - first);
      parts.push(await helper.encodeAnnexB({
        raw,
        width,
        height,
        fps,
        frameCount: count,
        codec,
        bitrate,
        firstFrame: first
      }));
    }

    let total = 0;
    for (const part of parts) total += part.byteLength;
    const annexb = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      annexb.set(part, offset);
      offset += part.byteLength;
    }

    // 3. Hand the elementary stream back to FFmpeg for muxing.
    ff.FS('writeFile', videoName, annexb);

    // 4. Mux video + audio into one fragmented MP4 chunk.
    //
    // The raw H.264 elementary stream carries no timestamps. Feeding it straight
    // into the mp4 muxer produced a chunk whose video `trun` had no per-sample
    // durations ("Timestamps are unset in a packet for stream 0"), and Chrome's
    // MediaSource rejected that chunk even though the same bytes played fine as
    // a standalone file.
    //
    // So the video goes through MPEG-TS first: the mpegts muxer stamps real
    // timestamps from its own clock, and the second pass then writes explicit
    // per-sample durations into the `trun` box — the same shape the libx264
    // path produces. That pass is stream copy, so there is no re-encode.
    //
    // The audio is encoded to AAC *inside* the same command, straight from the
    // source file. An earlier version encoded the audio to ADTS in a separate
    // run and converted it with `-bsf:a aac_adtstoasc`; the `esds` that
    // produced was not recognised by Chrome, which rejected the whole init
    // segment with "Initialization segment misses expected aac track".
    // Letting ffmpeg mux the AAC itself writes the canonical `esds`.
    const tsName = `v_${id}.ts`;
    await ff.run(
      '-r', String(fps),
      '-i', videoName,
      '-c', 'copy',
      '-f', 'mpegts',
      '-y', tsName
    );

    const hasAudio = audioTrack !== null && audioTrack !== undefined;
    const muxArgs = ['-i', tsName];
    if (hasAudio) {
      // Second input: the original file, cut to this chunk's window, so the
      // audio can be re-encoded and muxed next to the hardware video.
      muxArgs.push('-ss', String(startSec), '-t', String(durSec), '-i', inputName);
    }
    muxArgs.push('-map', '0:v:0');
    if (hasAudio) muxArgs.push('-map', `1:a:${audioTrack}`);
    muxArgs.push('-c:v', 'copy');
    if (hasAudio) muxArgs.push('-c:a', 'aac', '-b:a', '96k');
    muxArgs.push(
      '-f', 'mp4',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-avoid_negative_ts', 'make_zero',
      '-y', outputName
    );
    await ff.run(...muxArgs);

    const data = ff.FS('readFile', outputName);
    if (!data || data.byteLength < 1000) throw new Error('hardware mux produced no data');
    return data;
  } finally {
    try { ff.FS('unlink', rawName); } catch (_) {}
    try { ff.FS('unlink', videoName); } catch (_) {}
    try { ff.FS('unlink', `v_${id}.ts`); } catch (_) {}
  }
}

/**
 * Encode one chunk, preferring the hardware encoder when it is usable and
 * silently falling back to libx264 otherwise. Never throws for a missing or
 * broken hardware encoder — playback must not regress.
 */
async function encodeChunk(ctx) {
  const { gpuMode, token } = ctx;

  if (gpuMode !== 'off' && ctx.codec) {
    try {
      const started = Date.now();
      const data = await encodeChunkGpu(ctx);
      if (isCancelled(token)) return null;
      return { data, encoder: 'webcodecs', gpuMs: Date.now() - started };
    } catch (err) {
      post('FFLOG', { message: `Hardware encoder unavailable (${err.message || err}) — using libx264` });
    }
  }

  const started = Date.now();
  const data = await encodeChunkWasm(ctx);
  if (isCancelled(token)) return null;
  return { data, encoder: 'wasm', gpuMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Satellite worker pool (parallel chunk encoding)
// ---------------------------------------------------------------------------
//
// ffmpeg.wasm's pthread core deadlocks in this environment, so real
// parallelism is obtained by running several *independent* FFmpeg cores, one
// per worker, and letting them encode different chunks of the same file at the
// same time. The page owns the satellite workers (it creates them and hands
// the primary worker a MessagePort to each of them), which keeps their
// lifetime tied to the player's and makes cancelling them trivial.

const POOL_CONNECT_TIMEOUT = 30000;

let poolWorkers = [];        // [{ port, ready, busy }]
let poolConnectResolve = null;
let poolConnectPromise = null;
let poolFile = null;
let pipeline = null;         // active chunk pipeline (see runChunkPipeline)

// Wake up whoever is waiting for a chunk to come back from a satellite.
let signalWaiters = [];
function notifySignal() {
  const waiters = signalWaiters;
  signalWaiters = [];
  for (const waiter of waiters) {
    try { waiter(); } catch (_) {}
  }
}
function waitForSignal(token, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (timeoutId) clearTimeout(timeoutId);
      resolve();
    };
    signalWaiters.push(finish);
    const poll = setInterval(() => { if (isCancelled(token)) finish(); }, 50);
    const timeoutId = timeoutMs ? setTimeout(finish, timeoutMs) : null;
  });
}

// Copy a Uint8Array into a standalone ArrayBuffer. FFmpeg.wasm's readFile
// can hand back a view into the wasm heap (a SharedArrayBuffer when the core
// is built with pthreads), which must never be posted or transferred.
function toArrayBuffer(view) {
  if (!view) return new ArrayBuffer(0);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}

/**
 * Ask the page for `count` satellite workers. Resolves with the connected
 * ports, or null when the page could not provide them.
 */
function requestPool(count, file) {
  if (!count) return Promise.resolve(null);
  if (poolConnectPromise) return poolConnectPromise;
  poolFile = file;
  poolConnectPromise = new Promise((resolve) => {
    poolConnectResolve = resolve;
    post('POOL_REQUEST', { count });
    setTimeout(() => {
      if (poolConnectResolve) {
        const r = poolConnectResolve;
        poolConnectResolve = null;
        r(null);
      }
    }, POOL_CONNECT_TIMEOUT);
  });
  return poolConnectPromise;
}

// The page handed over the MessagePorts of the satellite workers.
function onPoolConnect(ports) {
  if (!Array.isArray(ports) || !ports.length) {
    if (poolConnectResolve) {
      const r = poolConnectResolve;
      poolConnectResolve = null;
      r(null);
    }
    return;
  }

  poolWorkers = ports.map((port) => {
    const worker = { port, ready: false, busy: false };
    port.onmessage = (e) => handlePoolMessage(worker, e.data);
    if (port.start) port.start();
    return worker;
  });

  // Give every satellite the source file; it writes it into its own MEMFS.
  for (const worker of poolWorkers) {
    try {
      worker.port.postMessage({ type: 'CHUNK_INIT', file: poolFile });
    } catch (_) {}
  }

  if (poolConnectResolve) {
    const r = poolConnectResolve;
    poolConnectResolve = null;
    r(poolWorkers);
  }
}

function handlePoolMessage(worker, msg) {
  if (!msg) return;

  if (msg.type === 'CHUNK_READY') {
    // The satellite booted its own FFmpeg core and holds the source file.
    worker.ready = true;
    return;
  }

  if (msg.type === 'CHUNK_RESULT') {
    worker.busy = false;
    if (pipeline) {
      pipeline.store(msg.index, {
        chunk: msg.chunk,
        encoder: msg.encoder,
        ms: msg.ms,
        startedAt: msg.startedAt,
        finishedAt: msg.finishedAt
      });
    }
    notifySignal();
    return;
  }

  if (msg.type === 'CHUNK_ERROR') {
    worker.busy = false;
    if (pipeline) pipeline.store(msg.index, null, msg.message);
    notifySignal();
  }
}

// Tell the satellites to stop, and drop the connections.
function cancelPool() {
  for (const worker of poolWorkers) {
    try { worker.port.postMessage({ type: 'CHUNK_CANCEL' }); } catch (_) {}
  }
  releasePool();
}

function releasePool() {
  for (const worker of poolWorkers) {
    try { worker.port.close(); } catch (_) {}
  }
  poolWorkers = [];
}

/**
 * How many satellite workers may be used for this file.
 * Returns 0 when the source is too large to duplicate safely.
 */
function poolSizeFor(file, totalChunks) {
  const requested = Math.max(0, CONFIG.threads - 1);   // the primary counts as one
  if (!requested || totalChunks <= 1) return 0;

  const size = file.size || 0;
  if (size > MAX_PARALLEL_INPUT_BYTES) {
    post('FFLOG', {
      message: `Source is ${(size / 1048576).toFixed(1)} MB — parallel encoding disabled ` +
        `(limit ${MAX_PARALLEL_INPUT_BYTES / 1048576} MB per worker copy)`
    });
    return 0;
  }

  // Every worker holds its own copy of the source in its own MEMFS.
  const copies = Math.floor(MAX_PARALLEL_TOTAL_BYTES / Math.max(1, size));
  const affordable = Math.max(1, copies - 1);           // minus the primary's copy
  const size2 = Math.min(requested, affordable, totalChunks - 1);
  if (size2 < 1) return 0;
  return size2;
}

/**
 * Encode every chunk of the stream, using the satellites when they are worth
 * it, and emit the finished chunks strictly in order.
 *
 * Returns false when the job was cancelled.
 */
async function runChunkPipeline(opts) {
  const { chunkContext, totalChunks, token, reportProgress } = opts;

  const results = new Map();
  const failedChunks = [];
  let nextEmit = 0;
  let nextToTake = 0;
  let doneResolve = null;

  const emitInOrder = () => {
    while (results.has(nextEmit)) {
      const result = results.get(nextEmit);
      results.delete(nextEmit);
      const buffer = result.chunk;
      post('STREAM_CHUNK', {
        index: nextEmit,
        totalChunks,
        chunk: buffer,
        encoder: result.encoder,
        ms: result.ms,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt
      }, [buffer]);
      reportProgress(nextEmit);
      nextEmit++;
    }
    if (nextEmit >= totalChunks && doneResolve) {
      const r = doneResolve;
      doneResolve = null;
      r(true);
    }
  };

  pipeline = {
    store(index, result, error) {
      if (error) {
        // The satellite failed on this chunk; the primary encodes it instead.
        failedChunks.push(index);
      } else {
        results.set(index, result);
      }
      // A satellite result has to go through the same ordered emit as the
      // chunks the primary encodes itself.
      emitInOrder();
    }
  };

  const allDone = new Promise((resolve) => { doneResolve = resolve; });

  try {
    // The first chunk is always encoded by the primary so playback can start
    // immediately, while the satellites are still booting.
    const firstCtx = chunkContext(0);
    const firstStarted = Date.now();
    const first = await encodeChunk(firstCtx);
    if (!first) return false;
    results.set(0, {
      chunk: toArrayBuffer(first.data),
      encoder: first.encoder,
      ms: Date.now() - firstStarted,
      startedAt: firstStarted,
      finishedAt: Date.now()
    });
    emitInOrder();

    const chunkMs = Date.now() - firstStarted;
    const remaining = totalChunks - 1;
    if (poolWorkers.length && remaining > 0) {
      post('FFLOG', {
        message: `Encoding ${totalChunks} chunks across up to ${poolWorkers.length + 1} workers ` +
          `(${(chunkMs / 1000).toFixed(2)}s per chunk on this worker)`
      });
    }

    while (nextEmit < totalChunks) {
      if (isCancelled(token)) return false;

      // A satellite that failed on a chunk must be covered by the primary.
      if (failedChunks.length) {
        const failedIndex = failedChunks.shift();
        const ctx = chunkContext(failedIndex);
        const started = Date.now();
        const res = await encodeChunk(ctx);
        if (!res) return false;
        results.set(failedIndex, {
          chunk: toArrayBuffer(res.data),
          encoder: res.encoder,
          ms: Date.now() - started,
          startedAt: started,
          finishedAt: Date.now()
        });
        emitInOrder();
        continue;
      }

      const index = nextToTake++;
      if (index >= totalChunks) {
        // Everything is in flight — wait for the next satellite result.
        await waitForSignal(token);
        continue;
      }

      // Hand the chunk to a satellite whenever one is up and idle. The
      // satellites join as soon as they finished booting their own core, so
      // short jobs never pay for them and long ones speed up immediately.
      const worker = poolWorkers.find((w) => w.ready && !w.busy);
      if (worker) {
        const ctx = chunkContext(index);
        worker.busy = true;
        try {
          worker.port.postMessage({
            type: 'CHUNK_ENCODE',
            index,
            startSec: ctx.startSec,
            durSec: ctx.durSec,
            audioTrack: ctx.audioTrack,
            width: ctx.width,
            height: ctx.height,
            fps: ctx.fps,
            codec: ctx.codec,
            bitrate: ctx.bitrate,
            gpuMode: ctx.gpuMode
          });
        } catch (err) {
          worker.busy = false;
          failedChunks.push(index);
        }
        continue;
      }

      const ctx = chunkContext(index);
      const started = Date.now();
      const res = await encodeChunk(ctx);
      if (!res) return false;
      results.set(index, {
        chunk: toArrayBuffer(res.data),
        encoder: res.encoder,
        ms: Date.now() - started,
        startedAt: started,
        finishedAt: Date.now()
      });
      emitInOrder();
    }

    await allDone;
    return true;
  } finally {
    pipeline = null;
  }
}

async function convertVideo(file, token, requestedTrack) {
  if (!isLoaded || !ffmpeg) {
    post('ERROR', { message: 'FFmpeg not loaded' });
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase() || 'avi';
  const id = Date.now();
  const inputName = `input_${id}.${ext}`;
  const copyOutputName = `copy_${id}.mp4`;
  const outputMime = 'video/mp4';

  try {
    post('FFLOG', { message: `Processing ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...` });
    post('PROGRESS', { progress: 5, status: 'Reading file into memory...', current_time: 0, duration: 0 });

    const data = await fetchFileFunc(file);
    ffmpeg.FS('writeFile', inputName, data);

    if (isCancelled(token)) {
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
      return;
    }

    // STEP 0: probe codec, duration and audio tracks in one pass
    post('PROGRESS', { progress: 10, status: 'Analyzing video stream & duration...', current_time: 0, duration: 0 });

    const info = await probeMedia(inputName);
    const isH264 = info.isH264;

    // If duration could not be determined, assume at least 15s
    let duration = info.duration;
    if (!duration || duration <= 0) {
      duration = 30;
    }

    const selectedAudio = resolveAudioTrack(info.audioTracks, requestedTrack);
    post('AUDIO_TRACKS', {
      tracks: info.audioTracks,
      selected: selectedAudio === null ? -1 : selectedAudio,
      originalFormat: ext
    });


    if (isCancelled(token)) {
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
      return;
    }

    // Ask the page for satellite workers *before* the first chunk is encoded,
    // so their (slow) FFmpeg core boot overlaps with the primary work. Only
    // non-H.264 files need them — the fast copy path below never streams.
    if (!isH264) {
      const estimatedChunks = Math.max(1, Math.ceil(duration / chooseChunkSeconds(duration, file.size)));
      const wanted = poolSizeFor(file, estimatedChunks);
      if (wanted > 0) {
        post('FFLOG', { message: `Preparing ${wanted} parallel encoding worker(s)...` });
        requestPool(wanted, file);
      }
    }

    // STEP 1: Fast Copy (< 0.5s) if stream is already H.264
    if (isH264) {      post('PROGRESS', { progress: 30, status: 'H.264 video detected — applying instant fast copy...', current_time: 0, duration });
      post('FFLOG', { message: 'H.264 video detected. Copying video stream directly into MP4 container...' });

      try {
        await ffmpeg.run(
          '-i', inputName,
          ...audioMapArgs(selectedAudio),
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          copyOutputName
        );

        const copyData = ffmpeg.FS('readFile', copyOutputName);
        if (copyData && copyData.length > 1000) {
          const blob = new Blob([copyData.buffer], { type: outputMime });
          const url = URL.createObjectURL(blob);

          try { ffmpeg.FS('unlink', inputName); } catch (e) {}
          try { ffmpeg.FS('unlink', copyOutputName); } catch (e) {}

          if (isCancelled(token)) {
            URL.revokeObjectURL(url);
            return;
          }

          post('PROGRESS', { progress: 100, status: 'Fast copy complete.', current_time: 0, duration });
          post('VIDEO_READY', {
            url,
            size: copyData.length,
            format: 'mp4',
            converted: true,
            isFastCopy: true,
            encoder: 'copy',
            originalFormat: ext,
            note: `Instant fast-remux complete for ${file.name} (${(copyData.length / 1024 / 1024).toFixed(2)} MB) — Successfully converted`
          });
          post('FFLOG', { message: `Fast copy complete in < 1 second. Output: ${(copyData.length / 1024 / 1024).toFixed(2)} MB` });
          return;
        }
      } catch (copyErr) {
        post('FFLOG', { message: 'Fast copy encountered container error, falling back to progressive streaming...' });
        try { ffmpeg.FS('unlink', copyOutputName); } catch (e) {}
      }
    }

    // STEP 2: Live Progressive Streaming via MediaSource (fMP4 chunks)
    //
    // Two decisions are made here:
    //  * the chunk length — the hardware path needs the rawvideo dump of a
    //    chunk to fit into GPU_MAX_RAW_BYTES, so high resolutions shorten the
    //    chunks instead of blowing up the memory budget;
    //  * the encoder — WebCodecs when it is available and supports the picture
    //    size, libx264 otherwise.
    let chunkSize = chooseChunkSeconds(duration, file.size);

    const gpuMode = CONFIG.gpu;
    let gpuCodec = null;      // { codec, profile }
    let gpuReason = '';

    if (gpuMode !== 'off') {
      const helper = loadEncoderHelper();
      if (!helper || !helper.isAvailable()) {
        gpuReason = 'WebCodecs is not available in this browser';
      } else if (!info.width || !info.height || !info.fps) {
        gpuReason = 'picture size or frame rate could not be determined';
      } else if (info.width > GPU_MAX_WIDTH || info.height > GPU_MAX_HEIGHT) {
        gpuReason = `picture is larger than ${GPU_MAX_WIDTH}x${GPU_MAX_HEIGHT}`;
      } else if (info.width % 2 || info.height % 2) {
        gpuReason = 'odd picture size is not I420 compatible';
      } else {
        const bitrate = gpuBitrate(info.width, info.height, info.fps);
        const framesPerSecond = info.fps;
        const bytesPerSecond = Math.floor(info.width * info.height * 3 / 2) * framesPerSecond;
        const affordable = bytesPerSecond > 0
          ? Math.floor(GPU_MAX_RAW_BYTES / bytesPerSecond)
          : GPU_MIN_CHUNK_SECONDS;

        if (affordable < GPU_MIN_CHUNK_SECONDS) {
          gpuReason = 'a single raw frame exceeds the raw memory budget';
        } else {
          gpuCodec = await helper.pickCodec(info.width, info.height, framesPerSecond, bitrate);
          if (!gpuCodec) {
            gpuReason = `no hardware H.264 codec supports ${info.width}x${info.height}`;
          } else {
            // Keep the rawvideo dump inside the memory budget.
            chunkSize = Math.max(GPU_MIN_CHUNK_SECONDS, Math.min(chunkSize, affordable));
          }
        }
      }

      if (gpuMode === 'on' && !gpuCodec) {
        post('ERROR', {
          message: `Hardware encoding was requested but is unavailable: ${gpuReason || 'unknown reason'}`
        });
        try { ffmpeg.FS('unlink', inputName); } catch (_) {}
        return;
      }
    }

    const effectiveGpuMode = gpuCodec ? gpuMode : 'off';
    const codecString = gpuCodec ? gpuCodec.codec : 'avc1.42E01E';

    post('FFLOG', {
      message: gpuCodec
        ? `Hardware encoder selected (${gpuCodec.codec}, ${gpuCodec.profile}) — ${info.width}x${info.height} @ ${info.fps.toFixed(2)} fps`
        : (gpuMode === 'off' ? 'Hardware encoder disabled — using libx264' : `Using libx264 (${gpuReason})`)
    });

    post('FFLOG', { message: `Starting live progressive stream (${duration.toFixed(1)}s, ${chunkSize}s chunks)...` });

    const totalChunks = Math.max(1, Math.ceil(duration / chunkSize));

    post('STREAM_START', {
      duration,
      totalChunks,
      chunkSize,
      encoder: gpuCodec ? 'webcodecs' : 'wasm',
      gpu: effectiveGpuMode,
      // Only advertise an audio codec when the file actually has one: Chrome
      // rejects an init segment that misses a track the SourceBuffer declared.
      mime: `video/mp4; codecs="${codecString}${selectedAudio !== null && selectedAudio !== undefined ? ', mp4a.40.2' : ''}"`
    });

    const chunkContext = (i) => ({
      ffmpeg,
      inputName,
      outputName: `chunk_${id}_${i}.mp4`,
      startSec: i * chunkSize,
      durSec: Math.min(chunkSize, Math.max(0.1, duration - i * chunkSize)),
      audioTrack: selectedAudio,
      width: info.width,
      height: info.height,
      fps: info.fps,
      codec: gpuCodec ? gpuCodec.codec : null,
      bitrate: gpuCodec ? gpuBitrate(info.width, info.height, info.fps) : 0,
      gpuMode: effectiveGpuMode,
      token,
      id: `${id}_${i}`
    });

    // Progress is reported for the *highest* chunk that has been emitted, so
    // the bar only ever moves forward.
    const reportProgress = (upto) => {
      const pct = Math.round(((upto + 1) / totalChunks) * 100);
      post('PROGRESS', {
        progress: pct,
        status: `Streaming live (${Math.min(duration, (upto + 1) * chunkSize).toFixed(0)}s / ${duration.toFixed(0)}s buffered)`,
        current_time: upto * chunkSize,
        duration
      });
    };

    const emitted = await runChunkPipeline({
      chunkContext,
      totalChunks,
      token,
      reportProgress
    });

    releasePool();

    try { ffmpeg.FS('unlink', inputName); } catch (_) {}

    if (isCancelled(token)) return;
    if (!emitted) {
      post('FFLOG', { message: 'Conversion cancelled — stream stopped.' });
      return;
    }

    post('PROGRESS', { progress: 100, status: 'Entire video converted and ready.', current_time: duration, duration });
    post('STREAM_END', {
      note: `Entire video converted and ready (${duration.toFixed(1)}s)`
    });
    post('FFLOG', { message: `All ${totalChunks} stream segments buffered successfully.` });

  } catch (err) {
    post('FFLOG', { message: `Conversion failed: ${err.message}` });
    post('ERROR', { message: `Conversion failed: ${err.message}` });
    try { ffmpeg.FS('unlink', inputName); } catch (e) {}
  }
}

// Full-file MP4 render, used for download when playback came from the
// chunked streaming path (concatenated fMP4 chunks are not a valid timeline).
async function exportMp4(file, token, requestedTrack) {
  if (!isLoaded || !ffmpeg) {
    post('ERROR', { message: 'FFmpeg not loaded' });
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase() || 'avi';
  const id = Date.now();
  const inputName = `exp_in_${id}.${ext}`;
  const outName = `exp_${id}.mp4`;
  const started = Date.now();

  try {
    post('EXPORT_STATUS', { message: 'Preparing MP4 export...' });

    const data = await fetchFileFunc(file);
    ffmpeg.FS('writeFile', inputName, data);

    if (isCancelled(token)) {
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
      return;
    }

    // Progress is measured against the source duration so the bar is honest.
    const info = await probeMedia(inputName);
    const duration = info.duration;
    const selectedAudio = resolveAudioTrack(info.audioTracks, requestedTrack);

    const progressLogger = ({ message }) => {
      const m = message && message.match(/time=\s*(\d+):(\d+):([\d.]+)/);
      if (!m || !duration) return;
      const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      const pct = Math.min(99, Math.round((t / duration) * 100));
      post('EXPORT_STATUS', { progress: pct, message: `Encoding MP4 for export... ${pct}%` });
    };

    // `-preset veryfast` (and veryfast only) reproduces a hard
    // `RuntimeError: function signature mismatch` inside ffmpeg-core's pthread
    // pool, which kills the whole core mid-render. `fast`/`medium`/`superfast`/
    // `ultrafast` all render correctly here, so stay on `fast` and keep an
    // ultrafast retry in case a future core build regresses differently.
    const renderArgs = (preset) => [
      '-i', inputName,
      ...audioMapArgs(selectedAudio),
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      outName
    ];

    ffmpeg.setLogger(progressLogger);
    try {
      await ffmpeg.run(...renderArgs('fast'));
    } catch (firstErr) {
      // Only a genuinely missing output is worth retrying; a real encode error
      // will fail the same way twice.
      let produced = false;
      try { produced = ffmpeg.FS('readFile', outName).length > 1000; } catch (_) {}
      if (!produced) {
        post('EXPORT_STATUS', { message: 'Retrying export with a faster preset...' });
        await ffmpeg.run(...renderArgs('ultrafast'));
      }
    }
    ffmpeg.setLogger(defaultLogger);

    const outData = ffmpeg.FS('readFile', outName);
    try { ffmpeg.FS('unlink', outName); } catch (_) {}
    try { ffmpeg.FS('unlink', inputName); } catch (_) {}

    if (isCancelled(token)) return;

    if (!outData || outData.length < 1000) {
      post('ERROR', { message: 'Export render produced no data' });
      return;
    }

    const blob = new Blob([outData.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    post('EXPORT_READY', {
      url,
      size: outData.length,
      note: `MP4 export ready (${(outData.length / 1024 / 1024).toFixed(2)} MB, ${secs}s)`
    });

  } catch (err) {
    try { ffmpeg.FS('unlink', outName); } catch (_) {}
    try { ffmpeg.FS('unlink', inputName); } catch (_) {}
    post('EXPORT_STATUS', { message: 'Export failed' });
    post('ERROR', { message: `Export failed: ${err.message}` });
  }
}

async function extractSubtitles(file, token) {
  if (!isLoaded || !ffmpeg) {
    post('SUBTITLES_READY', { subtitles: { found: false, reason: 'FFmpeg not loaded' } });
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase() || 'mkv';
  const id = Date.now();
  const inputName = `sub_input_${id}.${ext}`;
  const subName = `subs_${id}.vtt`;

  try {
    const data = await fetchFileFunc(file);
    ffmpeg.FS('writeFile', inputName, data);

    if (isCancelled(token)) {
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
      return;
    }

    // Fail fast on files with no subtitle stream instead of a doomed -map 0:s:0
    let hasSubs = false;
    const subProbeLogger = ({ message }) => {
      if (message && /Stream #.*: Subtitle:/i.test(message)) hasSubs = true;
    };
    ffmpeg.setLogger(subProbeLogger);
    try { await ffmpeg.run('-i', inputName); } catch (_) {}
    ffmpeg.setLogger(defaultLogger);

    if (!hasSubs) {
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
      post('SUBTITLES_READY', { subtitles: { found: false, reason: 'No subtitle stream in this file' } });
      return;
    }

    await ffmpeg.run('-i', inputName, '-map', '0:s:0', '-c:s', 'webvtt', subName);
    const subData = ffmpeg.FS('readFile', subName);
    const text = new TextDecoder().decode(subData);

    try { ffmpeg.FS('unlink', subName); } catch (_) {}
    try { ffmpeg.FS('unlink', inputName); } catch (_) {}

    if (isCancelled(token)) return;

    if (!text.trim() || !text.includes('WEBVTT')) {
      post('SUBTITLES_READY', { subtitles: { found: false, reason: 'Subtitle stream produced no cues' } });
      return;
    }

    post('SUBTITLES_READY', { subtitles: { found: true, vtt: text, language: 'en', format: 'webvtt', demo: false } });

  } catch (e) {
    try { ffmpeg.FS('unlink', subName); } catch (_) {}
    try { ffmpeg.FS('unlink', inputName); } catch (_) {}
    post('SUBTITLES_READY', { subtitles: { found: false, reason: e.message || 'Subtitle extraction failed' } });
  }
}

// ---------------------------------------------------------------------------
// Satellite ("chunk") worker
// ---------------------------------------------------------------------------
//
// A satellite worker owns its own FFmpeg core and nothing but a slice of the
// job: it receives the source file once, then encodes the chunks the primary
// worker hands to it. It never drives the conversion itself.

let chunkPort = null;
let chunkInputName = null;
let chunkCancelled = false;

function attachChunkPort(port) {
  chunkPort = port;
  port.onmessage = (e) => handleChunkPortMessage(e.data);
  if (port.start) port.start();
}

async function handleChunkPortMessage(msg) {
  if (!msg) return;

  if (msg.type === 'CHUNK_INIT') {
    try {
      // The satellite may receive this before its own core finished loading.
      await readyPromise;
      if (!isLoaded || !ffmpeg) throw new Error('FFmpeg not loaded');
      const file = msg.file;
      const ext = (file && file.name ? file.name.split('.').pop() : 'avi').toLowerCase() || 'avi';
      chunkInputName = `sat_in_${Date.now()}.${ext}`;
      const data = await fetchFileFunc(file);
      ffmpeg.FS('writeFile', chunkInputName, data);
      if (chunkPort) chunkPort.postMessage({ type: 'CHUNK_READY' });
    } catch (err) {
      if (chunkPort) chunkPort.postMessage({ type: 'CHUNK_ERROR', index: -1, message: err.message });
    }
    return;
  }

  if (msg.type === 'CHUNK_CANCEL') {
    chunkCancelled = true;
    return;
  }

  if (msg.type === 'CHUNK_ENCODE') {
    const started = Date.now();
    try {
      if (!isLoaded || !ffmpeg) throw new Error('FFmpeg not loaded');
      if (!chunkInputName) throw new Error('source file was not initialised');
      chunkCancelled = false;

      const result = await encodeChunk({
        ffmpeg,
        inputName: chunkInputName,
        outputName: `sat_out_${Date.now()}.mp4`,
        startSec: msg.startSec,
        durSec: msg.durSec,
        audioTrack: msg.audioTrack,
        width: msg.width,
        height: msg.height,
        fps: msg.fps,
        codec: msg.codec,
        bitrate: msg.bitrate,
        gpuMode: msg.gpuMode,
        token: jobSerial,
        id: `sat_${msg.index}_${Date.now()}`
      });

      if (!result || chunkCancelled) {
        if (chunkPort) chunkPort.postMessage({ type: 'CHUNK_ERROR', index: msg.index, message: 'cancelled' });
        return;
      }

      const buffer = toArrayBuffer(result.data);
      if (chunkPort) {
        chunkPort.postMessage({
          type: 'CHUNK_RESULT',
          index: msg.index,
          chunk: buffer,
          encoder: result.encoder,
          ms: Date.now() - started,
          startedAt: started,
          finishedAt: Date.now()
        }, [buffer]);
      }
    } catch (err) {
      if (chunkPort) {
        chunkPort.postMessage({ type: 'CHUNK_ERROR', index: msg.index, message: err.message || String(err) });
      }
    }
  }
}

self.onmessage = function (e) {
  const { type, file, audioTrack } = e.data;
  try {
    switch (type) {
      case 'TEST':
        post('TEST_RESPONSE', { message: 'FFmpeg worker is functioning' });
        break;
      case 'TEST_FFMPEG':
        post('FFMPEG_TEST_RESULT', {
          message: isLoaded
            ? 'FFmpeg.wasm loaded successfully'
            : 'FFmpeg.wasm not available - Using direct playback only'
        });
        break;
      case 'POOL_PORT':
        // The page hands over the MessagePort that connects this satellite to
        // the primary worker.
        if (e.data.port) attachChunkPort(e.data.port);
        break;
      case 'POOL_CONNECT':
        // The page created the satellite workers and connected them to us.
        onPoolConnect(e.data.ports);
        break;
      case 'PROCESS_VIDEO': {
        // A new job supersedes whatever ran before it.
        const token = ++jobSerial;
        enqueueTask(() => convertVideo(file, token, audioTrack));
        break;
      }
      case 'EXTRACT_SUBTITLES': {
        // Captured now (not at run time) so loading another file cancels a
        // pending extraction instead of attaching subtitles to the wrong video.
        const token = jobSerial;
        enqueueTask(() => extractSubtitles(file, token));
        break;
      }
      case 'EXPORT_VIDEO': {
        // Same capture rule: a newer upload must abandon a queued export.
        const token = jobSerial;
        enqueueTask(() => exportMp4(file, token, audioTrack));
        break;
      }
      case 'CANCEL':
        // Invalidate the running job so it unwinds at its next checkpoint.
        // Cheap and correct for the common "load another file" case; a single
        // long ffmpeg.run() still has to finish, because ffmpeg-core has no
        // abort. Interrupting one is done by terminating this worker from the
        // page (see resetPlayer) rather than by a message that would have to
        // queue behind the exec it is meant to stop.
        jobSerial++;
        cancelPool();
        post('LOG', { message: 'Conversion cancelled', level: 'info' });
        break;
      default:
        post('LOG', { message: `Unknown message type: ${type}`, level: 'warn' });
    }
  } catch (err) {
    post('ERROR', { message: `Worker dispatch error: ${err.message}` });
  }
};

resetReady();
loadFFmpeg();
