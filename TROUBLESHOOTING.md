# Troubleshooting

## "FFmpeg initialization failed" / the status pill never leaves "Initializing"

The page could not load the FFmpeg core. Work through these in order.

1. **Serve over HTTP with the bundled server.** `python -m http.server` does not send
   `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, so the page is not
   cross-origin isolated, `SharedArrayBuffer` is undefined, and the pthread core cannot start.
   Use `npm run serve` (or `python server.py 8000`).
2. **Check `public/` is populated.** All four files must exist on the served origin:
   `ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`, `ffmpeg-core.worker.js`.
   A fresh clone has no wasm because `*.wasm` is gitignored — run `npm run setup-ffmpeg`.
3. **Check the wasm MIME type.** The server must return `application/wasm` for the `.wasm`
   file; `text/plain` or `application/octet-stream` fails streaming compilation.
   `server.py` already maps it.
4. **Never open `index.html` via `file://`.** Workers, ES modules and `SharedArrayBuffer`
   all break.

Open DevTools → Network and confirm the four requests above return 200 — not the HTML
page with a 404 underneath, which is the usual cause of
`SyntaxError: Unexpected token '<'`.

## "Worker Connection Failed"

- The worker is spawned by WASM (`src/lib.rs`) and attaches its handlers 200 ms after
  init. If you see this, check the Console for the Rust-side error first.
- `ffmpeg-worker.js` is loaded from the page origin; a stale cached copy after an edit
  shows old behaviour. Hard-reload (Ctrl+Shift+R).
- The worker needs `public/ffmpeg-core.worker.js`. Missing it gives
  `SyntaxError: Unexpected token '<'`, because the 404 resolves to `index.html`.

## Playback never starts for an AVI/MKV

- Check the status strip. "Connecting live streaming engine…" means the worker has the file
  but has not emitted its first segment yet.
- Some files have an unusable container header. The worker emits
  "Fast copy encountered container error, falling back to progressive streaming…" and retries
  via the chunked path; if that also fails the log says `Conversion failed: …`.
- A corrupt or DRM-protected file cannot be decoded. Try a different source.
- Very large files may exhaust tab memory before the first segment is produced.

## Conversion is slow

- Each segment is encoded on a single thread inside one shared FFmpeg core — expect
  roughly real-time throughput on a laptop CPU.
- The streaming path is already on `-preset ultrafast -crf 26`, the fastest useful setting.
- H.264 sources skip encoding entirely via the remux path; if a source is H.264 but still
  slow, the container header is probably confusing the codec probe.

## Export fails or produces a tiny file

- The export path renders a full MP4 with `-preset fast`. `-preset veryfast` — only that
  preset — reproduces a hard `RuntimeError: function signature mismatch` inside the pthread
  pool and kills the core mid-render. If a render produces no output the worker retries once
  with `ultrafast`.
- If the log reports "Export render produced no data" after both attempts, the source most
  likely has no decodable video stream.

## Subtitles button stays disabled

That is correct behaviour: the button only enables when the source actually contains a
subtitle stream. The log records the reason (`No subtitles: …`). Files with no subtitle
track never get a placeholder track.

## Memory issues with large files

- Streamed containers (AVI, MKV) are buffered in page memory as they convert.
- Keep test files small; close other tabs; try a lower-resolution source.

## Browser requirements

WebAssembly, Web Workers, `SharedArrayBuffer` (cross-origin isolation), HTML5 `<video>`,
`MediaSource`, and the File API. Chrome/Edge 89+, Firefox 89+.

## Reading the log

**FFmpeg Telemetry** streams the raw FFmpeg output. `Duration:` and `Stream #…` lines are the
probe; `frame= … time= …` lines are the encoder. `At least one output file must be specified`
and `Conversion failed!` after a bare `-i <file>` probe are expected noise and are filtered
out of the panel by the worker.

## Still stuck

1. Hard-reload and retry with a small MP4 first — it bypasses conversion entirely.
2. Confirm the four `public/` requests are 200 in the Network tab.
3. Run `npm test` against the running server and compare against the file you are using.
