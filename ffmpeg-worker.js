// FFmpeg Web Worker for video processing with streaming support
let ffmpeg = null;

// Dynamically load FFmpeg.wasm with fallback URLs using importScripts
async function loadFFmpegWASM() {
    const cdnUrls = [
        'https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/umd/ffmpeg.js',
        'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.7/dist/umd/ffmpeg.js'
    ];
    
    for (const url of cdnUrls) {
        try {
            console.log(`Attempting to load FFmpeg from: ${url}`);
            importScripts(url);
            
            if (typeof FFmpegWASM !== 'undefined') {
                console.log('FFmpeg loaded successfully');
                return true;
            }
        } catch (error) {
            console.warn(`Failed to load from ${url}:`, error);
        }
    }
    
    // Fallback: Use a simpler implementation without FFmpeg.wasm
    console.warn('FFmpeg.wasm not available, using fallback implementation');
    return false;
}

// Initialize FFmpeg with streaming support
async function initFFmpeg() {
    if (!ffmpeg) {
        try {
            const loaded = await loadFFmpegWASM();
            if (!loaded) {
                throw new Error('FFmpeg.wasm not available');
            }
            
            const { FFmpeg } = FFmpegWASM;
            ffmpeg = new FFmpeg();
            
            // Set up logging
            ffmpeg.on('log', ({ message }) => {
                console.log('FFmpeg:', message);
            });
            
            // Set up progress reporting
            ffmpeg.on('progress', ({ progress, time }) => {
                self.postMessage({
                    type: 'PROGRESS',
                    progress: {
                        progress: progress * 100,
                        status: 'Converting video...',
                        current_time: time,
                        duration: 0
                    }
                });
            });
            
            await ffmpeg.load({
                coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd/ffmpeg-core.js',
                wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd/ffmpeg-core.wasm',
            });
            
            console.log('FFmpeg loaded successfully');
        } catch (error) {
            console.error('Failed to load FFmpeg:', error);
            throw error;
        }
    }
    return ffmpeg;
}

// Streaming video converter with chunked processing
async function convertVideoStreaming(file) {
    try {
        // Check if we can use FFmpeg.wasm
        let useFFmpeg = true;
        try {
            await initFFmpeg();
        } catch (error) {
            console.warn('FFmpeg not available, using fallback conversion');
            useFFmpeg = false;
        }
        
        if (useFFmpeg && ffmpeg) {
            return await convertWithFFmpeg(file);
        } else {
            return await convertWithFallback(file);
        }
    } catch (error) {
        console.error('Video conversion error:', error);
        self.postMessage({
            type: 'ERROR',
            message: 'Video conversion failed: ' + error.message
        });
    }
}

// FFmpeg.wasm conversion with chunked processing
async function convertWithFFmpeg(file) {
    const chunkSize = 1024 * 1024; // 1MB chunks
    const totalSize = file.size;
    let processedSize = 0;
    
    // Read file in chunks for better memory management
    const chunks = [];
    const reader = new FileReader();
    
    for (let start = 0; start < totalSize; start += chunkSize) {
        const end = Math.min(start + chunkSize, totalSize);
        const chunk = file.slice(start, end);
        
        const arrayBuffer = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(chunk);
        });
        
        chunks.push(new Uint8Array(arrayBuffer));
        processedSize += arrayBuffer.byteLength;
        
        // Report loading progress
        self.postMessage({
            type: 'PROGRESS',
            progress: {
                progress: (processedSize / totalSize) * 30, // 30% for loading
                status: 'Loading video file...',
                current_time: 0,
                duration: 0
            }
        });
    }
    
    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combinedArray = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of chunks) {
        combinedArray.set(chunk, offset);
        offset += chunk.length;
    }
    
    const inputFileName = file.name;
    const outputFileName = 'output.mp4';
    
    // Write to FFmpeg filesystem
    await ffmpeg.writeFile(inputFileName, combinedArray);
    
    self.postMessage({
        type: 'PROGRESS',
        progress: {
            progress: 40,
            status: 'Starting conversion...',
            current_time: 0,
            duration: 0
        }
    });
    
    // Convert with optimized settings for web streaming
    await ffmpeg.exec([
        '-i', inputFileName,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',      // Faster encoding
        '-crf', '28',                // Balanced quality/size
        '-c:a', 'aac',
        '-b:a', '96k',               // Lower audio bitrate
        '-movflags', '+faststart',   // Web optimization
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=-2:720',       // Scale to 720p max
        '-r', '30',                  // 30fps max
        outputFileName
    ]);
    
    // Read output in chunks
    const outputData = await ffmpeg.readFile(outputFileName);
    
    // Create blob URL
    const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    
    // Clean up
    await ffmpeg.deleteFile(inputFileName);
    await ffmpeg.deleteFile(outputFileName);
    
    self.postMessage({
        type: 'VIDEO_READY',
        url: url,
        size: outputData.length
    });
}

// Fallback conversion for when FFmpeg.wasm is not available
async function convertWithFallback(file) {
    // For formats that browsers can handle natively, just pass through
    const supportedFormats = ['mp4', 'webm', 'ogg'];
    const extension = file.name.split('.').pop().toLowerCase();
    
    if (supportedFormats.includes(extension)) {
        // Create blob URL directly
        const url = URL.createObjectURL(file);
        
        self.postMessage({
            type: 'PROGRESS',
            progress: {
                progress: 100,
                status: 'Video ready (no conversion needed)',
                current_time: 0,
                duration: 0
            }
        });
        
        self.postMessage({
            type: 'VIDEO_READY',
            url: url,
            size: file.size
        });
    } else {
        // For unsupported formats, show error with helpful message
        self.postMessage({
            type: 'ERROR',
            message: `Format ${extension} requires FFmpeg.wasm which failed to load. Please try with MP4, WebM, or OGG files, or check your internet connection.`
        });
    }
}

// Convert video to MP4 format with streaming
async function convertVideo(file) {
    return await convertVideoStreaming(file);
}

// Extract subtitles from video with fallback
async function extractSubtitles(file) {
    try {
        let useFFmpeg = true;
        try {
            await initFFmpeg();
        } catch (error) {
            console.warn('FFmpeg not available for subtitle extraction');
            useFFmpeg = false;
        }
        
        if (useFFmpeg && ffmpeg) {
            return await extractWithFFmpeg(file);
        } else {
            return await extractSubtitlesFallback(file);
        }
    } catch (error) {
        console.error('Subtitle extraction error:', error);
        self.postMessage({
            type: 'ERROR',
            message: 'Subtitle extraction failed: ' + error.message
        });
    }
}

async function extractWithFFmpeg(file) {
    const arrayBuffer = await file.arrayBuffer();
    const inputFileName = file.name;
    const subtitleFileName = 'subtitles.vtt';
    
    await ffmpeg.writeFile(inputFileName, new Uint8Array(arrayBuffer));
    
    try {
        await ffmpeg.exec([
            '-i', inputFileName,
            '-map', '0:s:0',
            '-c:s', 'webvtt',
            subtitleFileName
        ]);
        
        const subtitleData = await ffmpeg.readFile(subtitleFileName);
        const subtitleText = new TextDecoder().decode(subtitleData);
        
        self.postMessage({
            type: 'SUBTITLES_READY',
            subtitles: {
                vtt: subtitleText,
                language: 'en',
                format: 'webvtt'
            }
        });
        
        await ffmpeg.deleteFile(subtitleFileName);
    } catch (subtitleError) {
        await extractSubtitlesFallback(file);
    }
    
    await ffmpeg.deleteFile(inputFileName);
}

async function extractSubtitlesFallback(file) {
    // Provide default subtitle when extraction fails
    console.log('No subtitles found or extraction failed, providing default');
    self.postMessage({
        type: 'SUBTITLES_READY',
        subtitles: {
            vtt: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nNo subtitles available\n',
            language: 'en',
            format: 'webvtt'
        }
    });
}

// Handle messages from main thread
self.onmessage = async function(e) {
    const { type, file } = e.data;
    
    try {
        switch (type) {
            case 'TEST':
                self.postMessage({
                    type: 'TEST_RESPONSE',
                    message: 'Worker is functioning'
                });
                break;
                
            case 'TEST_FFMPEG':
                try {
                    const loaded = await loadFFmpegWASM();
                    self.postMessage({
                        type: 'FFMPEG_TEST_RESULT',
                        message: loaded ? 'FFmpeg loaded successfully' : 'FFmpeg fallback mode'
                    });
                } catch (error) {
                    self.postMessage({
                        type: 'FFMPEG_TEST_RESULT',
                        message: 'FFmpeg loading failed: ' + error.message
                    });
                }
                break;
                
            case 'PROCESS_VIDEO':
                await convertVideo(file);
                break;
                
            case 'EXTRACT_SUBTITLES':
                await extractSubtitles(file);
                break;
                
            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'ERROR',
            message: error.message
        });
    }
};