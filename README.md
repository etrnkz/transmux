# WASM Video Player

A web-based video player built with Rust + WebAssembly that can play multiple video formats (MKV, AVI, MOV, etc.) directly in the browser using FFmpeg.wasm for conversion.

## Features

- 🎬 **Multi-format Support**: Play MKV, AVI, MOV, WMV, FLV, WebM, and MP4 files
- 🔄 **Real-time Conversion**: Convert unsupported formats to MP4 using FFmpeg.wasm
- 📝 **Subtitle Support**: Extract and display subtitles as VTT tracks
- ⚡ **Web Worker Processing**: Non-blocking video processing in background
- 🎯 **Drag & Drop**: Easy file upload with drag and drop interface
- 📱 **Responsive Design**: Works on desktop and mobile browsers

## Architecture

- **Rust + wasm-bindgen**: Core orchestration and browser API integration
- **FFmpeg.wasm**: Video decoding and format conversion
- **Web Workers**: Background processing to prevent UI freezing
- **HTML5 Video**: Native browser playback with subtitle support

## Prerequisites

- Rust (latest stable)
- wasm-pack
- Node.js (for development server)
- Modern web browser with WebAssembly support

## Installation

1. **Install Rust and wasm-pack**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   cargo install wasm-pack
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

## Building and Running

1. **Build the WebAssembly module**:
   ```bash
   npm run build
   ```

2. **Start the development server**:
   ```bash
   npm run serve
   ```

3. **Open your browser** and navigate to `http://localhost:8000`

## Usage

1. **Upload a video file** by dragging and dropping or clicking "Choose Video File"
2. **Wait for processing** - the progress bar will show conversion status
3. **Play the video** once processing is complete
4. **Toggle subtitles** if available in the original file
5. **Download the converted MP4** if needed

## Supported Formats

### Input Formats
- MKV (Matroska Video)
- AVI (Audio Video Interleave)
- MOV (QuickTime Movie)
- WMV (Windows Media Video)
- FLV (Flash Video)
- WebM
- MP4 (already supported natively)

### Output Format
- MP4 with H.264 video and AAC audio (web-optimized)

## Project Structure

```
├── src/
│   └── lib.rs              # Rust WebAssembly code
├── pkg/                    # Generated WebAssembly output
├── index.html              # Main HTML interface
├── ffmpeg-worker.js        # Web Worker for FFmpeg processing
├── package.json            # Node.js dependencies and scripts
├── Cargo.toml              # Rust dependencies
└── README.md               # This file
```

## Development

### Building for Development
```bash
npm run build
```

### Cleaning Build Artifacts
```bash
npm run clean
```

### Running Tests
```bash
cargo test
```

## Browser Compatibility

- Chrome 57+
- Firefox 52+
- Safari 11+
- Edge 16+

All browsers must support:
- WebAssembly
- Web Workers
- HTML5 Video
- File API

## Performance Notes

- **Large files**: Processing time depends on file size and complexity
- **Memory usage**: FFmpeg.wasm requires significant memory for large videos
- **Web Workers**: Processing runs in background to maintain UI responsiveness
- **Streaming**: Consider implementing streaming for very large files

## Troubleshooting

### Common Issues

1. **"Failed to load FFmpeg"**
   - Check internet connection (FFmpeg.wasm loads from CDN)
   - Ensure browser supports WebAssembly

2. **"Processing failed"**
   - File may be corrupted or use unsupported codec
   - Try with a different video file

3. **Slow processing**
   - Large files take time to process
   - Consider reducing video quality/size before upload

### Browser Console
Check the browser console for detailed error messages and FFmpeg logs.

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Roadmap

- [ ] Streaming support for large files
- [ ] Multiple subtitle track support
- [ ] Video quality selection
- [ ] Batch processing
- [ ] Custom FFmpeg parameters
- [ ] Progress persistence across page reloads