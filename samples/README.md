# Sample media

Fixtures used by the three Playwright suites. Keep these in place — the tests reference them by
path relative to the repo root (`samples/test-*.{avi,mkv,mp4}`), so moving or renaming them
breaks `npm test`, `npm run test:streaming` and `npm run test:embed`.

| File | Container | Exercises |
|------|-----------|-----------|
| `test-sample.avi` | AVI | Baseline AVI load; the short clip the first checks reach for |
| `test-30s.avi` | AVI | Long-form progressive streaming into `MediaSource`, and reset mid-conversion |
| `test-h264.avi` | AVI (H.264) | The instant remux path — H.264 inside AVI copies without a re-encode |
| `test-mpeg4.avi` | AVI (MPEG-4) | Live progressive streaming when a remux is not possible |
| `test-sample.mkv` | Matroska (H.264) | MKV remux, and subtitle-track extraction |
| `test-hevc-ac3.mkv` | Matroska (H.265 + AC-3) | Fallback to progressive streaming for codecs a remux cannot carry |
| `test-plain.mp4` | MP4 | Not referenced by any suite; kept as a known-good control file |

Container types were confirmed from each file's magic bytes (`RIFF....AVI ` for the AVI files,
the Matroska `1A 45 DF A3` EBML header for the MKV files, and an `ftyp` box for the MP4).

These are small, deliberately awkward files — legacy containers and codec combinations a
browser cannot play natively. That is the point: they are what this player exists to handle.
