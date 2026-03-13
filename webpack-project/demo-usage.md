# Demo Usage Guide

## Testing the FFmpeg WASM Video Player

### 1. Setup and Run

```bash
# Navigate to project directory
cd webpack-project

# Install dependencies (first time only)
npm install

# Start development server
npm run dev
```

### 2. Open in Browser

Navigate to `http://localhost:8080`

### 3. Test Video Conversion

#### Option A: Drag & Drop
1. Find an AVI, MKV, or MOV video file on your computer
2. Drag it onto the drop zone in the browser
3. Watch the conversion progress
4. Video will automatically play when conversion completes

#### Option B: File Browser
1. Click the drop zone to open file browser
2. Select a video file
3. Conversion will start automatically

### 4. Expected Behavior

#### For Native Formats (MP4, WebM, OGG):
- ✅ Immediate playback (no conversion needed)
- 📝 Log: "MP4 format supported natively, no conversion needed"

#### For Other Formats (AVI, MKV, MOV, etc.):
- 🔄 Conversion progress bar appears
- 📊 Real-time FFmpeg logs in the bottom panel
- ⏱️ Progress updates: "Analyzing video format..." → "Converting..." → "Finalizing..."
- 🎬 Video plays automatically when conversion completes
- 📥 Download button becomes available

### 5. Features to Test

#### Conversion Features:
- [ ] AVI to MP4 conversion
- [ ] MKV to MP4 conversion  
- [ ] MOV to MP4 conversion
- [ ] Progress reporting
- [ ] FFmpeg logging

#### UI Features:
- [ ] Drag and drop functionality
- [ ] File browser selection
- [ ] Video playback controls
- [ ] Download converted video
- [ ] Reset player
- [ ] Responsive design

#### Technical Features:
- [ ] Web Worker (non-blocking UI)
- [ ] Local FFmpeg core files (no CDN)
- [ ] CORS headers for SharedArrayBuffer
- [ ] Memory management
- [ ] Error handling

### 6. Performance Notes

#### File Size Recommendations:
- **Small files (< 50MB)**: Fast conversion (30 seconds - 2 minutes)
- **Medium files (50-200MB)**: Moderate conversion (2-5 minutes)
- **Large files (> 200MB)**: Slower conversion (5+ minutes)

#### Browser Requirements:
- Chrome 88+ (recommended)
- Firefox 79+
- Safari 14+
- Edge 88+

### 7. Troubleshooting

#### Common Issues:

**"FFmpeg initialization failed"**
- Check browser console for detailed errors
- Ensure CORS headers are working
- Try refreshing the page

**"Conversion failed"**
- File may be corrupted or unsupported codec
- Try a different video file
- Check FFmpeg logs for specific error

**Slow performance**
- Large files take time to process
- Close other browser tabs to free memory
- Consider using smaller test files first

**Memory errors**
- Browser may run out of memory with very large files
- Try smaller files or restart browser
- Monitor browser task manager

### 8. Production Deployment

```bash
# Build for production
npm run build

# Serve the dist/ directory with any web server
# Ensure CORS headers are configured:
# Cross-Origin-Opener-Policy: same-origin
# Cross-Origin-Embedder-Policy: require-corp
```

### 9. Sample Test Files

For testing, you can use:
- Small AVI files (< 10MB) for quick tests
- Sample MKV files from video editing software
- Screen recordings in various formats
- Downloaded video samples from archive.org

### 10. Success Indicators

✅ **Working correctly when you see:**
- "FFmpeg WASM loaded successfully!" in logs
- Progress bar during conversion
- FFmpeg command output in logs
- Converted video plays smoothly
- Download button works
- No console errors

🚨 **Issues if you see:**
- "FFmpeg initialization failed" 
- "Worker error" messages
- Blank video player
- Console errors about CORS or SharedArrayBuffer
- Conversion never completes