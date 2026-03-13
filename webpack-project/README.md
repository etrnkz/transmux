# FFmpeg WASM Video Player with Webpack

A modern, in-browser video player that uses FFmpeg WASM to convert video files (AVI, MKV, MOV, etc.) to MP4 for web playback. Built with Webpack for optimal bundling and performance.

## Features

- 🎬 **Universal Video Support**: Convert AVI, MKV, MOV, WMV, FLV to MP4
- 🚀 **No Server Required**: Pure client-side conversion using FFmpeg WASM
- 📦 **Webpack Bundled**: Optimized builds with automatic asset handling
- 🎯 **Drag & Drop**: Simple file upload interface
- 📊 **Real-time Progress**: Live conversion progress and FFmpeg logs
- 🎨 **Modern UI**: Beautiful, responsive design
- ⚡ **Fast Loading**: Local FFmpeg core files, no CDN dependencies

## Quick Start

### Installation

```bash
cd webpack-project
npm install
```

### Development

```bash
npm run dev
```

Open http://localhost:8080 in your browser.

### Production Build

```bash
npm run build
```

The built files will be in the `dist/` directory.

## How It Works

1. **Webpack Configuration**: Bundles the worker and copies FFmpeg core files locally
2. **Web Worker**: Runs FFmpeg WASM in a separate thread to avoid blocking the UI
3. **Local Assets**: FFmpeg core files are served locally to avoid CORS issues
4. **Automatic Conversion**: Detects video format and converts to MP4 if needed

## Project Structure

```
webpack-project/
├── src/
│   ├── index.html          # Main HTML template
│   ├── index.js            # Main application logic
│   └── worker.js           # FFmpeg Web Worker
├── webpack.config.js       # Webpack configuration
├── package.json           # Dependencies and scripts
└── README.md              # This file
```

## Supported Formats

### Input Formats (Auto-converted to MP4)
- AVI, MKV, MOV, WMV, FLV, and many more

### Native Formats (Direct playback)
- MP4, WebM, OGG

## Browser Requirements

- Modern browsers with Web Worker support
- SharedArrayBuffer support (enabled by CORS headers)
- WebAssembly support

## Technical Details

### Webpack Features Used
- **Worker Loader**: Bundles the Web Worker automatically
- **Copy Plugin**: Copies FFmpeg core files to dist
- **HTML Plugin**: Generates HTML with proper asset links
- **Dev Server**: Provides CORS headers for SharedArrayBuffer

### FFmpeg WASM Integration
- Uses `@ffmpeg/ffmpeg` and `@ffmpeg/util` packages
- Loads core files locally to avoid CORS issues
- Optimized conversion settings for web playback
- Real-time progress reporting

### Performance Optimizations
- Code splitting for vendor libraries
- Content hashing for cache busting
- Optimized FFmpeg settings (fast preset, 720p max)
- Efficient memory management in worker

## Troubleshooting

### FFmpeg fails to load
- Ensure CORS headers are properly set
- Check that ffmpeg-core files are accessible
- Verify SharedArrayBuffer support in browser

### Conversion is slow
- Large files take time to process
- Consider reducing video resolution/quality
- Use faster FFmpeg presets for development

### Memory issues
- Large video files may cause memory problems
- Consider chunked processing for very large files
- Monitor browser memory usage

## License

MIT License - feel free to use in your projects!