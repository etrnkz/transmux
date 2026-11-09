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

  return {
    // The ffmpeg.wasm wrapper (importScripts). Separate knob because a host may
    // keep the wrapper local while pulling the 24 MB core from a CDN.
    ffmpegJs: params.get('ffmpegJs') || base + '/ffmpeg.js',
    corePath: params.get('corePath') || base + '/ffmpeg-core.js',
    wasmPath: params.get('wasmPath') || base + '/ffmpeg-core.wasm',
    workerPath: params.get('workerPath') || base + '/ffmpeg-core.worker.js'
  };
})();

function post(type, data) {
  try { self.postMessage({ type, data }); } catch (e) {}
}

const defaultLogger = ({ message }) => {
  if (message) {
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
      log: true,
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
  const info = { isH264: false, duration: 0, audioTracks: [] };

  const probeLogger = ({ message }) => {
    if (!message) return;
    // `ffmpeg -i <file>` with no output always "fails"; that line is expected noise
    if (/Conversion failed!|At least one output file must be specified/i.test(message)) return;

    if (/Stream #.*Video:.*(h264|avc1)/i.test(message)) info.isH264 = true;

    const dur = message.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (dur) {
      info.duration = parseInt(dur[1]) * 3600 + parseInt(dur[2]) * 60 + parseFloat(dur[3]);
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

    // STEP 1: Fast Copy (< 0.5s) if stream is already H.264
    if (isH264) {
      post('PROGRESS', { progress: 30, status: 'H.264 video detected — applying instant fast copy...', current_time: 0, duration });
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
    const chunkSize = chooseChunkSeconds(duration, file.size);
    post('FFLOG', { message: `Starting live progressive stream (${duration.toFixed(1)}s, ${chunkSize}s chunks)...` });

    const totalChunks = Math.max(1, Math.ceil(duration / chunkSize));

    post('STREAM_START', {
      duration,
      totalChunks,
      chunkSize,
      mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
    });

    for (let i = 0; i < totalChunks; i++) {
      if (isCancelled(token)) {
        try { ffmpeg.FS('unlink', inputName); } catch (_) {}
        post('FFLOG', { message: 'Conversion cancelled — stream stopped.' });
        return;
      }
      const startSec = i * chunkSize;
      const chunkFile = `chunk_${id}_${i}.mp4`;

      const pct = Math.round(((i + 1) / totalChunks) * 100);
      post('PROGRESS', {
        progress: pct,
        status: `Streaming live (${Math.min(duration, (i + 1) * chunkSize).toFixed(0)}s / ${duration.toFixed(0)}s buffered)`,
        current_time: startSec,
        duration
      });

      await ffmpeg.run(
        '-ss', String(startSec),
        '-t', String(chunkSize),
        '-i', inputName,
        ...audioMapArgs(selectedAudio),
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
        chunkFile
      );

      const chunkData = ffmpeg.FS('readFile', chunkFile);
      try { ffmpeg.FS('unlink', chunkFile); } catch (_) {}

      post('STREAM_CHUNK', {
        index: i,
        totalChunks,
        chunk: chunkData.buffer
      });
    }

    try { ffmpeg.FS('unlink', inputName); } catch (_) {}

    if (isCancelled(token)) return;

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
