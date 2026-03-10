# 🔧 Troubleshooting Guide

## Common Issues and Solutions

### 1. "Format mkv requires FFmpeg.wasm which failed to load"

This error occurs when FFmpeg.wasm cannot be loaded from CDN sources.

#### Solutions (in order of preference):

**Option A: Use Local FFmpeg Files (Recommended)**
```bash
# Download FFmpeg files locally for better reliability
npm run setup-ffmpeg

# Then rebuild and serve
npm run build
npm run serve
```

**Option B: Check Internet Connection**
- Ensure you have a stable internet connection
- Try refreshing the page
- Check if your firewall/antivirus is blocking CDN requests

**Option C: Use Supported Formats**
- Upload MP4, WebM, or OGG files (work without FFmpeg)
- These formats play directly in the browser

**Option D: Manual FFmpeg Setup**
1. Create a `public` folder in your project
2. Download these files manually:
   - [ffmpeg.js](https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/umd/ffmpeg.js)
   - [ffmpeg-core.js](https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd/ffmpeg-core.js)
   - [ffmpeg-core.wasm](https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd/ffmpeg-core.wasm)
3. Place them in the `public` folder
4. Restart the server

### 2. "Worker Connection Failed"

#### Solutions:
- Make sure you're serving the files via HTTP server (not file://)
- Check browser console for detailed error messages
- Try the test page: `http://localhost:8000/test-streaming.html`

### 3. Video Processing is Slow

#### Optimizations:
- Use smaller video files for testing
- The player automatically scales videos to 720p max
- Large files are processed in chunks to prevent memory issues

### 4. Browser Compatibility Issues

#### Requirements:
- WebAssembly support (Chrome 57+, Firefox 52+, Safari 11+, Edge 16+)
- Web Workers support
- HTML5 Video support
- File API support

#### Solutions:
- Update your browser to the latest version
- Try a different browser
- Check if WebAssembly is enabled in browser settings

### 5. CORS Errors

#### Solutions:
- Always use `npm run serve` or another HTTP server
- Never open `index.html` directly in browser (file:// protocol)
- If using a different server, ensure it serves all file types correctly

### 6. Memory Issues with Large Files

#### Solutions:
- The player uses chunked processing for files > 50MB
- If browser crashes, try smaller files first
- Close other browser tabs to free memory
- Consider using a more powerful device for very large files

## Testing and Debugging

### Test Worker Connection
```javascript
// Open browser console and run:
const worker = new Worker('./ffmpeg-worker.js');
worker.postMessage({ type: 'TEST' });
worker.onmessage = (e) => console.log('Worker response:', e.data);
```

### Test FFmpeg Loading
Visit the test page: `http://localhost:8000/test-streaming.html`

### Check Console Logs
1. Open browser Developer Tools (F12)
2. Go to Console tab
3. Look for error messages or warnings
4. Check Network tab for failed requests

## Format Support Matrix

| Format | Direct Playback | Requires FFmpeg | Notes |
|--------|----------------|-----------------|-------|
| MP4    | ✅ Yes         | ❌ No          | Best compatibility |
| WebM   | ✅ Yes         | ❌ No          | Good for web |
| OGG    | ✅ Yes         | ❌ No          | Open source |
| MKV    | ❌ No          | ✅ Yes         | Needs conversion |
| AVI    | ❌ No          | ✅ Yes         | Needs conversion |
| MOV    | ⚠️ Maybe       | ⚠️ Maybe       | Browser dependent |
| WMV    | ❌ No          | ✅ Yes         | Needs conversion |
| FLV    | ❌ No          | ✅ Yes         | Needs conversion |

## Performance Tips

1. **Use MP4 when possible** - No conversion needed
2. **Keep files under 100MB** - Better performance
3. **Close other applications** - Free up system memory
4. **Use modern browsers** - Better WebAssembly performance
5. **Stable internet** - For CDN-based FFmpeg loading

## Getting Help

If you're still having issues:

1. Check the browser console for error messages
2. Try the test page for diagnostics
3. Test with a small MP4 file first
4. Ensure you're using a supported browser
5. Check your internet connection

## Advanced Configuration

### Custom FFmpeg Settings
Edit `ffmpeg-worker.js` to modify conversion parameters:
```javascript
// Example: Higher quality settings
await ffmpegInstance.exec([
    '-i', inputFileName,
    '-c:v', 'libx264',
    '-preset', 'slow',      // Better quality, slower
    '-crf', '18',           // Higher quality
    '-c:a', 'aac',
    '-b:a', '128k',
    outputFileName
]);
```

### Local Development
For development without internet:
1. Run `npm run setup-ffmpeg` once
2. All FFmpeg files will be cached locally
3. No internet needed for subsequent runs