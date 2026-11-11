# transmux

An in-browser video player that plays containers Chrome cannot open natively (AVI, MKV) by
converting them with real **FFmpeg.wasm** — and starts playback before the conversion finishes.

The name is the technique: remuxing a file into a streamable format without re-encoding it.

No transcoding server, no uploads: the source file never leaves the machine.

It ships one player in two shapes: an embeddable module (`wasm-video-player.js` +
`wasm-video-player.css`) you can drop into any page, and `index.html`, a host page that mounts
that same module. There is no second copy of the playback logic.

## Requirements

- A Chromium-based browser or Firefox with `SharedArrayBuffer` support
- Python 3 for the bundled dev server
- Node.js for `npm install` / `npm run setup`

No Rust toolchain is required for either shape.

## Quick start

```bash
npm install
npm run setup     # fetch the four FFmpeg core files into public/
npm run serve     # http://localhost:8000
```

`npm run setup` downloads `ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm` and
`ffmpeg-core.worker.js` from jsDelivr. The wasm is large and gitignored, so this is the one
step a fresh clone needs. All four are loaded from the local origin; there is no CDN fallback.

## Using it as a library

`index.html` is a host for the player, not the player itself. The engine is a drop-in module:
`wasm-video-player.js` (logic) plus `wasm-video-player.css` (styling). Together they mount a
complete player into any container with one call.

A consumer needs only those three files plus the four `public/` core files — no Rust toolchain,
no `pkg/`, no build step.

```bash
npm install transmux
```

```js
import { createPlayer } from 'transmux';
import 'transmux/stylesheet';

const player = createPlayer({
  container:   document.getElementById('player'),
  workerUrl:   '/vendor/transmux/ffmpeg-worker.js',
  coreBaseUrl: '/vendor/transmux/public'
});
```

You can also copy the files in and import by path — no bundler required. See
[`quick-start.html`](./quick-start.html) for a complete working page.

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `container` | — | **Required.** Element to mount into. |
| `videoEl` | created for you | Existing `<video>` element to drive instead of a new one. |
| `workerUrl` | `./ffmpeg-worker.js` | Path to the worker. Resolved against `document.baseURI`. |
| `coreBaseUrl` | worker's `./public` sibling | Directory holding the four FFmpeg core files. |
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
player.urls                      // { worker, coreBase } as actually resolved
player.ui                        // the DOM nodes the player created
```

`exportVideo()` is fire-and-forget: it hands the rendered MP4 to the browser as a download
rather than returning a URL. Watch `on('status')` / `on('progress')` for completion, or
`getState().isExporting` to know when it is running.

`player.ui` exposes the generated DOM so a host can assign its own ids, attach controls or
instrument the player without recreating the markup. `root`, `video`, `status`, `upload`,
`videoContainer` and `progress` are the stable keys; the rest are internal and may change.

### Hosting it

Three things must hold wherever the player is served from:

1. **Cross-origin isolation.** The page must send `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp`, or `SharedArrayBuffer` is unavailable and
   the FFmpeg core never loads. `server.py` already does this.
2. **The core assets must be reachable.** Point `coreBaseUrl` at wherever you copied
   `public/`, or keep the default layout (a `public/` directory next to the worker).
3. **Not necessarily the site root.** All paths are resolved from the worker's own URL, so the
   player runs unchanged from `/vendor/player/v1/` or even a different origin.

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

## License

MIT
