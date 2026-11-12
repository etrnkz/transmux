# transmux

In-browser video player that plays containers browsers cannot open natively (AVI, MKV) using client-side **FFmpeg.wasm** and **WebCodecs GPU acceleration** — starting playback before conversion finishes.

No server transcoding, no uploads: the media file never leaves the user's device.

## Install

```bash
npm install transmux
```

## Usage

```js
import { createPlayer } from 'transmux';
import 'transmux/stylesheet';

const player = createPlayer({
  container:   document.getElementById('player'),
  workerUrl:   '/vendor/transmux/ffmpeg-worker.js',
  coreBaseUrl: '/vendor/transmux/public'
});
```

You can also import it directly in standard HTML via script tags without a bundler:

```html
<link rel="stylesheet" href="./wasm-video-player.css">
<div id="player"></div>

<script type="module">
  import { createPlayer } from './wasm-video-player.js';

  const player = createPlayer({
    container:   document.getElementById('player'),
    workerUrl:   './ffmpeg-worker.js',
    coreBaseUrl: './public'
  });
</script>
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `container` | — | **Required.** DOM element to mount the player into. |
| `videoEl` | generated | Existing `<video>` element to control instead of creating one. |
| `workerUrl` | `./ffmpeg-worker.js` | Worker path (resolved against `document.baseURI`). |
| `coreBaseUrl` | `./public` | Directory hosting `ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`, and `ffmpeg-core.worker.js`. |
| `fileInputId` | generated | ID attribute for the file input element. |
| `title` | `transmux` | Header title text. Set to `''` to hide header. |
| `subtitle` | `In-browser video remuxing and live playback` | Header subtitle text. |
| `showLog` | `true` | Display the conversion log panel. |
| `showExport` | `true` | Display the Export MP4 button. |
| `threads` | auto (up to 5) | Number of parallel worker threads for chunk encoding. Set `1` for single-thread. |
| `gpu` | `'auto'` | Hardware acceleration: `'auto'` prefers WebCodecs GPU encoding, `'on'` requires it, `'off'` uses CPU libx264. |

## API

```js
player.loadFile(file)            // Load and play a File or Blob
player.reset()                   // Cancel current work and return to upload stage
player.exportVideo()             // Export complete MP4 as a download
player.setPlaybackRate(rate)     // Set playback speed (0.5 to 2.0)
player.selectAudioTrack(index)   // Switch audio track
player.toggleSubtitles()         // Toggle subtitle visibility
player.clearLog()                // Clear telemetry log
player.getState()                // Current state: { file, audioTracks, busy, isExporting, ... }
player.on(event, fn)             // Listen to 'status' | 'log' | 'progress' | 'ready' | 'error'
player.destroy()                 // Clean up worker, MediaSource, and DOM
player.ui                        // Access DOM nodes (root, video, status, upload, etc.)
```

## Browser Requirements

Browsers require cross-origin isolation headers to enable `SharedArrayBuffer` for WebAssembly threads:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## License

MIT
