# WASM Video Player

An in-browser video player that plays containers Chrome cannot open natively (AVI, MKV) by
converting them with real **FFmpeg.wasm** — and starts playback before the conversion finishes.

No transcoding server, no uploads: the source file never leaves the machine.

It ships two things: a standalone app (`index.html`) and the same player as an embeddable
module (`wasm-video-player.js` + `wasm-video-player.css`) you can drop into any page — see
[Using it as a library](#using-it-as-a-library).

## How it works

Every file goes through one worker (`ffmpeg-worker.js`) that runs a single serialised FFmpeg
instance, so two conversions can never fight over the core.

1. **Probe** — `ffmpeg -i <input>` parses the container once to learn the duration and whether
   the video stream is already H.264.
2. **Fast remux (H.264 sources)** — `-c:v copy -c:a aac -movflags +faststart` rewraps the
   existing H.264 stream into MP4 without re-encoding. Typically under a second, and the
   result is a complete file that can be downloaded as-is.
3. **Progressive streaming (everything else)** — the source is cut into ~6-second slices, each
   encoded to a fragmented MP4 (`-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof`,
   `-preset ultrafast -crf 26`) and appended to a `MediaSource` in `sequence` mode. Playback
   begins on the first slice; the rest buffer in the background.

For MP4/WebM/MOV the file is handed straight to `<video>` for immediate native playback while
the worker converts in the background, then playback swaps over to the converted stream
without losing the current position.

**Export MP4** always renders a real single-file MP4 from the source. Concatenated fMP4
segments are a valid MSE timeline but not a valid standalone file, so they are never offered
as a download; a fast-remuxed blob is reused directly when one exists.

**Subtitles** are extracted from the source (`-map 0:s:0 -c:s webvtt`) only when a subtitle
stream actually exists. There is no placeholder/demo track.

## Requirements

- A Chromium-based browser or Firefox with `SharedArrayBuffer` support
- Rust + `wasm-pack` (only to rebuild the WASM module)
- Python 3 for the bundled dev server

### Why the bundled server and not `python -m http.server`

`server.py` exists because the app needs four things a plain static server does not provide:

- `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers, which make the page
  cross-origin isolated so `SharedArrayBuffer` (and therefore FFmpeg's pthread core) works.
- `application/wasm` MIME type on the core binary, or streaming compilation fails.
- HTTP Range support, so a directly-played file can seek before it fully downloads.
- Threading, so the ~23 MB wasm and the video file do not block the worker's chunk requests.

It deliberately speaks **HTTP/1.0**: with HTTP/1.1 keep-alive enabled, Emscripten's synchronous
XHR for the wasm binary hangs and "loading ffmpeg-core" never completes.

## Quick start

```bash
npm install
npm run setup     # downloads the FFmpeg 0.11.x core into public/
npm run build     # wasm-pack build --target web --out-dir pkg
npm run serve     # http://localhost:8000
```

`public/` must contain `ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm` and
`ffmpeg-core.worker.js`. The wasm is large and gitignored — run `npm run setup-ffmpeg`
(or download the files by hand) after a fresh clone. All four are loaded from the local
origin; there is no CDN fallback.

## Using it as a library

`index.html` is one host for the player, not the player itself. The same engine is available
as a drop-in module: **`wasm-video-player.js`** (logic) plus **`wasm-video-player.css`**
(styling). Together they mount a complete player into any container with one call.

```html
<link rel="stylesheet" href="./wasm-video-player.css">

<div id="player"></div>

<script type="module">
  import { createPlayer } from './wasm-video-player.js';

  const player = createPlayer({
    container:   document.getElementById('player'),
    workerUrl:   './ffmpeg-worker.js',   // this repo's worker
    coreBaseUrl: './public'              // holds ffmpeg.js + the ffmpeg-core files
  });
</script>
```

`quick-start.html` is a complete working page that does exactly this and nothing else.

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `container` | — | **Required.** Element to mount into. |
| `videoEl` | created for you | Existing `<video>` element to drive instead of a new one. |
| `workerUrl` | `./ffmpeg-worker.js` | Path to the worker. Resolved against `document.baseURI`. |
| `coreBaseUrl` | worker's `./public` sibling | Directory holding `ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`, `ffmpeg-core.worker.js`. |
| `fileInputId` | generated | `id` for the hidden file input. |
| `title` | `WASM Video Player` | Heading text. `''` hides the whole header. |
| `subtitle` | `Real-time WebAssembly demuxing & live playback` | Secondary heading. |
| `showLog` | `true` | Show the FFmpeg telemetry panel. |
| `showExport` | `true` | Show the Export MP4 button. |

### API

```js
player.loadFile(file)            // File or FileList
player.reset()                   // cancel in-flight work, back to the drop stage
player.exportVideo()             // start an MP4 export; the completed file downloads automatically
player.setPlaybackRate(rate)     // 0.5 – 2, matching the built-in speed menu
player.selectAudioTrack(index)
player.toggleSubtitles()
player.clearLog()
player.getState()                // { file, audioTracks, selectedAudioTrack, busy, isExporting, hasConvertedFile }
player.on(name, fn)              // 'status' | 'log' | 'progress' | 'ready' | 'error'; returns an unsubscribe fn
player.destroy()                 // terminate the worker and remove the UI
player.urls                      // { worker, coreBase } as actually resolved — handy when an embed misbehaves
```

`exportVideo()` is fire-and-forget: it hands the rendered MP4 to the browser as a download
rather than returning a URL. Watch `on('status')` / `on('progress')` for completion, or
`getState().isExporting` to know when it is running.

### Hosting it

Three things must hold wherever the player is served from:

1. **Cross-origin isolation.** The page must send `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp`, or `SharedArrayBuffer` is unavailable and
   the FFmpeg core never loads. `server.py` already does this.
2. **The core assets must be reachable.** Point `coreBaseUrl` at wherever you copied
   `public/`, or keep the default layout (a `public/` directory next to the worker).
3. **Not necessarily the site root.** All paths are resolved from the worker's own URL, so the
   player runs unchanged from `/vendor/player/v1/` or even a different origin. Host pages that
   deliberately omit `coreBaseUrl` fall back to that self-resolution.

The stylesheet is scoped under `.wvp-root`, so it neither leaks into nor inherits from the host
page; load it and the player takes care of its own appearance.

## Using the app

1. Drop a video file on the stage, or press Enter to pick one.
2. Playback starts as soon as the first segment is ready — watch the status strip.
3. Use **Subtitles** if the file carries a subtitle track, **Export MP4** to render a
   shareable file, **Reset** to cancel in-flight work and return to the drop stage.
4. **FFmpeg Telemetry** shows the raw FFmpeg log for troubleshooting.

## Format support

| Container | Playback path | Notes |
|-----------|---------------|-------|
| MP4 / MOV | native, converted in background | Fastest; no conversion needed |
| WebM | native, converted in background | Browser-dependent audio codec |
| AVI | progressive stream | Instant remux when the video is H.264 |
| MKV | progressive stream | Instant remux when the video is H.264 |
| WMV / FLV | progressive stream | Untested containers |

Anything FFmpeg can decode but this table omits will still be streamed; the table lists what
has been exercised.

## Project structure

```
├── index.html               # Standalone host app: UI, MediaSource playback, export/subtitle wiring
├── wasm-video-player.js     # Embeddable player library — createPlayer()
├── wasm-video-player.css    # Its stylesheet, scoped under .wvp-root
├── quick-start.html         # Minimal page that embeds the library
├── ffmpeg-worker.js         # FFmpeg.wasm worker: probe, remux, chunked streaming, export
├── server.py                # COOP/COEP + Range dev server
├── src/lib.rs               # Rust/wasm-bindgen shell that spawns the worker
├── pkg/                     # wasm-pack output (gitignored, required at runtime)
├── public/                  # FFmpeg core assets (wasm is gitignored)
├── test-e2e.js              # Playwright suite: conversion, streaming, export, subtitles
├── test-streaming-e2e.js    # Playwright suite: fast remux + progressive playback
├── test-embed.js            # Playwright suite: library embedding (12 checks)
├── quick-test.html          # Environment diagnostics (isolation, SAB, MSE, wasm MIME, worker load)
└── TROUBLESHOOTING.md
```

## Tests

All three suites drive a real browser against the dev server and assert on observable state
(video element, blob bytes, MP4 atoms, DOM) rather than on log strings.

```bash
npm run serve          # in one shell
npm test               # conversion / streaming / export / subtitles / cancel / console hygiene
npm run test:streaming # fast-remux and instant-playback timings
npm run test:embed     # the library mounts, applies its CSS, loads the core, and plays
```

`test-embed.js` takes `BASE` and `PAGE` overrides, so the same checks run against a
subdirectory deployment:

```bash
BASE=http://localhost:8123 PAGE=/vendor/player/v1/quick-start.html npm run test:embed
```

The suites need Playwright resolvable from the repo (`require.resolve('playwright')` — here it
resolves via `C:/Users/user/node_modules/playwright`) and the sample media in the repo root
(`test-sample.avi`, `test-30s.avi`, `test-h264.avi`, …).

If conversion fails before any test can run, open `http://localhost:8000/quick-test.html` first — it
checks cross-origin isolation, `SharedArrayBuffer`, `MediaSource`, codec support, the wasm MIME type
and whether the worker loads, which narrows the failure to environment or code.

## Notes and limits

- Encoding is single-threaded per chunk inside a shared FFmpeg core; expect roughly real-time
  throughput on a laptop CPU, not GPU speed.
- AVI and other streamed files are held in browser memory as they convert. Multi-gigabyte
  inputs will hit the tab's memory ceiling.
- `-preset veryfast` on the export path crashes ffmpeg-core's pthread pool with
  `RuntimeError: function signature mismatch` on the pinned 0.11.x core. Export uses `fast`,
  with an `ultrafast` retry if a render produces no output.

## License

MIT
