// Simple working FFmpeg worker - no webpack complications
let ffmpeg = null;
let isLoaded = false;

// Use the exact same approach as your working ffmpeg-worker.js
async function loadFFmpeg() {
    try {
        console.log('[Worker] Loading FFmpeg...');
        
        // Try CDN first (this actually works)
        importScripts('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
        
        // Check what's available
        let createFFmpegFunc = null;
        let fetchFileFunc = null;
        
        if (typeof self.FFmpeg !== 'undefined' && self.FFmpeg.createFFmpeg) {
            createFFmpegFunc = self.FFmpeg.createFFmpeg;
            fetchFileFunc = self.FFmpeg.fetchFile;
        } else if (typeof FFmpeg !== 'undefined' && FFmpeg.createFFmpeg) {
            createFFmpegFunc = FFmpeg.createFFmpeg;
            fetchFileFunc = FFmpeg.fetchFile;
        } else if (typeof createFFmpeg !== 'undefined') {
            createFFmpegFunc = createFFmpeg;
            fetchFileFunc = fetchFile;
        } else {
            throw new Error('FFmpeg not available');
        }
        
        // Create FFmpeg instance
        ffmpeg = createFFmpegFunc({
            log: true,
            corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js'
        });
        
        // Store fetchFile
        self.fetchFileFunc = fetchFileFunc || ((file) => file.arrayBuffer().then(buffer => new Uint8Array(buffer)));
        
        // Set up callbacks
        ffmpeg.setProgress(({ ratio }) => {
            self.postMessage({
                type: 'PROGRESS',
                data: {
                    progress: Math.round(ratio * 100),
                    status: 'Converting video...'
                }
            });
        });

        ffmpeg.setLogger(({ type, message }) => {
            if (type === 'info') {
                self.postMessage({
                    type: 'LOG',
                    data: { message: `FFmpeg: ${message}`, type: 'ffmpeg' }
                });
            }
        });

        // Load FFmpeg
        await ffmpeg.load();
        
        isLoaded = true;
        console.log('[Worker] ✅ FFmpeg loaded!');
        
        self.postMessage({
            type: 'INITIALIZED',
            data: { success: true }
        });
        
        self.postMessage({
            type: 'LOG',
            data: { message: '✅ FFmpeg loaded successfully!', type: 'success' }
        });
        
    } catch (error) {
        console.error('[Worker] FFmpeg failed:', error);
        self.postMessage({
            type: 'ERROR',
            data: { message: `FFmpeg failed: ${error.message}` }
        });
        
        self.postMessage({
            type: 'LOG',
            data: { message: `❌ FFmpeg failed: ${error.message}`, type: 'error' }
        });
    }
}

async function convertVideo(file, outputFormat = 'mp4') {
    if (!isLoaded || !ffmpeg) {
        throw new Error('FFmpeg not loaded');
    }

    try {
        const inputName = file.name;
        const outputName = `output.${outputFormat}`;
        
        console.log(`[Worker] Converting: ${inputName} → ${outputName}`);
        
        self.postMessage({
            type: 'LOG',
            data: { message: `🎬 Converting: ${inputName} → ${outputName}`, type: 'info' }
        });
        
        // Get file data
        const fileData = await self.fetchFileFunc(file);
        
        // Write to FFmpeg
        ffmpeg.FS('writeFile', inputName, fileData);
        
        self.postMessage({
            type: 'PROGRESS',
            data: { progress: 20, status: 'Starting conversion...' }
        });

        // Convert
        await ffmpeg.run(
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p',
            outputName
        );

        // Read output
        const outputData = ffmpeg.FS('readFile', outputName);
        const blob = new Blob([outputData.buffer], { type: `video/${outputFormat}` });
        const url = URL.createObjectURL(blob);

        // Cleanup
        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);

        console.log(`[Worker] ✅ Done! Size: ${outputData.length} bytes`);

        self.postMessage({
            type: 'CONVERSION_COMPLETE',
            data: {
                url: url,
                size: outputData.length,
                format: outputFormat,
                originalName: inputName
            }
        });
        
        self.postMessage({
            type: 'LOG',
            data: { message: `✅ Done! Size: ${outputData.length} bytes`, type: 'success' }
        });

    } catch (error) {
        console.error('[Worker] Conversion failed:', error);
        self.postMessage({
            type: 'ERROR',
            data: { message: `Conversion failed: ${error.message}` }
        });
        
        self.postMessage({
            type: 'LOG',
            data: { message: `❌ Conversion failed: ${error.message}`, type: 'error' }
        });
    }
}

// Handle messages
self.onmessage = async function(event) {
    const { type, data } = event.data;

    try {
        switch (type) {
            case 'INITIALIZE':
                await loadFFmpeg();
                break;

            case 'CONVERT_VIDEO':
                await convertVideo(data.file, data.outputFormat);
                break;

            default:
                console.warn('[Worker] Unknown message:', type);
        }
    } catch (error) {
        console.error('[Worker] Error:', error);
        self.postMessage({
            type: 'ERROR',
            data: { message: error.message }
        });
    }
};

console.log('[Worker] Ready');