// Enhanced FFmpeg Web Worker with proper worker-compatible loading
let ffmpeg = null;
let isFFmpegAvailable = false;

// Strategy 1: Try local files with proper worker context
async function loadFFmpegLocal() {
    try {
        console.log('Attempting to load local FFmpeg files...');
        // Import the local FFmpeg script
        importScripts('./public/ffmpeg.js');
        
        // Check if FFmpeg is available in the global scope
        if (typeof self.FFmpeg !== 'undefined') {
            console.log('Local FFmpeg loaded successfully');
            return { 
                FFmpeg: self.FFmpeg, 
                coreURL: './public/ffmpeg-core.js',
                wasmURL: './public/ffmpeg-core.wasm',
                local: true 
            };
        }
        
        // Also check for FFmpegWASM namespace
        if (typeof self.FFmpegWASM !== 'undefined' && self.FFmpegWASM.FFmpeg) {
            console.log('Local FFmpeg (WASM namespace) loaded successfully');
            return { 
                FFmpeg: self.FFmpegWASM.FFmpeg, 
                coreURL: './public/ffmpeg-core.js',
                wasmURL: './public/ffmpeg-core.wasm',
                local: true 
            };
        }
    } catch (error) {
        console.warn('Local FFmpeg loading failed:', error);
    }
    return null;
}

// Strategy 2: Use a simpler, worker-compatible approach
async function loadFFmpegSimple() {
    const cdnUrls = [
        'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js'
    ];
    
    for (const url of cdnUrls) {
        try {
            console.log(`Attempting simple load from: ${url}`);
            importScripts(url);
            
            // Check various possible global names
            const possibleNames = ['FFmpeg', 'createFFmpeg', 'FFmpegWASM'];
            
            for (const name of possibleNames) {
                if (typeof self[name] !== 'undefined') {
                    console.log(`Simple FFmpeg loaded successfully as ${name}`);
                    return { 
                        FFmpeg: self[name], 
                        coreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
                        wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm',
                        simple: true 
                    };
                }
            }
        } catch (error) {
            console.warn(`Simple load failed from ${url}:`, error);
        }
    }
    return null;
}

// Strategy 3: Use a lightweight alternative for basic conversions
function createFallbackConverter() {
    return {
        load: async () => {
            console.log('Using fallback converter');
            return true;
        },
        writeFile: async (name, data) => {
            self.fallbackFiles = self.fallbackFiles || {};
            self.fallbackFiles[name] = data;
        },
        exec: async (args) => {
            console.log('Fallback exec:', args);
            
            // Simulate conversion progress
            const steps = [10, 25, 50, 75, 90, 100];
            for (let i = 0; i < steps.length; i++) {
                await new Promise(resolve => setTimeout(resolve, 200));
                self.postMessage({
                    type: 'PROGRESS',
                    progress: {
                        progress: steps[i],
                        status: `Processing... (${steps[i]}%)`,
                        current_time: 0,
                        duration: 0
                    }
                });
            }
        },
        readFile: async (name) => {
            const inputData = self.fallbackFiles && self.fallbackFiles[Object.keys(self.fallbackFiles)[0]];
            return inputData || new Uint8Array(0);
        },
        deleteFile: async (name) => {
            if (self.fallbackFiles) {
                delete self.fallbackFiles[name];
            }
        },
        on: (event, callback) => {
            // Mock event system for compatibility
        }
    };
}

// Main loading function with worker-safe strategies
async function loadFFmpegWASM() {
    console.log('Starting FFmpeg loading with worker-safe strategies...');
    
    // Strategy 1: Local files (if available)
    let result = await loadFFmpegLocal();
    if (result) {
        return result;
    }
    
    // Strategy 2: Simple CDN approach
    result = await loadFFmpegSimple();
    if (result) {
        return result;
    }
    
    // Strategy 3: Fallback converter
    console.warn('FFmpeg.wasm not available, using fallback converter');
    return { 
        FFmpeg: createFallbackConverter, 
        fallback: true,
        coreURL: null,
        wasmURL: null
    };
}

// Initialize FFmpeg with worker-safe loading
async function initFFmpeg() {
    if (!ffmpeg) {
        try {
            const loadResult = await loadFFmpegWASM();
            
            if (!loadResult) {
                throw new Error('All FFmpeg loading strategies failed');
            }
            
            const { FFmpeg, fallback, coreURL, wasmURL, simple } = loadResult;
            
            if (fallback) {
                // Use fallback converter
                ffmpeg = FFmpeg();
                isFFmpegAvailable = false;
                console.log('Using fallback converter');
            } else {
                // Use real FFmpeg
                if (simple || typeof FFmpeg === 'function') {
                    // For older versions that use createFFmpeg pattern
                    ffmpeg = typeof FFmpeg === 'function' ? FFmpeg() : new FFmpeg();
                } else {
                    ffmpeg = new FFmpeg();
                }
                
                isFFmpegAvailable = true;
                
                // Set up logging (if supported)
                if (ffmpeg.on) {
                    ffmpeg.on('log', ({ message }) => {
                        console.log('FFmpeg:', message);
                    });
                    
                    // Set up progress reporting (if supported)
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
                }
                
                // Load with proper core URLs (if needed)
                if (ffmpeg.load && coreURL && wasmURL) {
                    try {
                        await ffmpeg.load({
                            coreURL: coreURL,
                            wasmURL: wasmURL,
                        });
                        console.log('FFmpeg loaded with core files');
                    } catch (loadError) {
                        console.warn('FFmpeg core loading failed, trying without:', loadError);
                        // Try loading without specific URLs
                        if (ffmpeg.load) {
                            await ffmpeg.load();
                        }
                    }
                } else if (ffmpeg.load) {
                    await ffmpeg.load();
                }
                
                console.log('Real FFmpeg initialized successfully');
            }
            
        } catch (error) {
            console.error('Failed to initialize FFmpeg:', error);
            // Create a minimal fallback
            ffmpeg = createFallbackConverter();
            isFFmpegAvailable = false;
            console.log('Using emergency fallback converter');
        }
    }
    return ffmpeg;
}

// Enhanced conversion with better format support
async function convertVideoStreaming(file) {
    try {
        const ffmpegInstance = await initFFmpeg();
        
        if (isFFmpegAvailable) {
            return await convertWithRealFFmpeg(file, ffmpegInstance);
        } else {
            return await convertWithAdvancedFallback(file);
        }
    } catch (error) {
        console.error('Video conversion error:', error);
        self.postMessage({
            type: 'ERROR',
            message: 'Video conversion failed: ' + error.message
        });
    }
}

// Real FFmpeg conversion
async function convertWithRealFFmpeg(file, ffmpegInstance) {
    const chunkSize = 1024 * 1024; // 1MB chunks
    const totalSize = file.size;
    let processedSize = 0;
    
    // Read file in chunks
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
                progress: (processedSize / totalSize) * 30,
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
    
    await ffmpegInstance.writeFile(inputFileName, combinedArray);
    
    self.postMessage({
        type: 'PROGRESS',
        progress: {
            progress: 40,
            status: 'Starting conversion...',
            current_time: 0,
            duration: 0
        }
    });
    
    // Convert with optimized settings
    await ffmpegInstance.exec([
        '-i', inputFileName,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=-2:720',
        '-r', '30',
        outputFileName
    ]);
    
    const outputData = await ffmpegInstance.readFile(outputFileName);
    const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    
    await ffmpegInstance.deleteFile(inputFileName);
    await ffmpegInstance.deleteFile(outputFileName);
    
    self.postMessage({
        type: 'VIDEO_READY',
        url: url,
        size: outputData.length
    });
}

// Advanced fallback with better format detection
async function convertWithAdvancedFallback(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const nativeFormats = ['mp4', 'webm', 'ogg', 'mov'];
    const convertibleFormats = ['avi', 'mkv', 'wmv', 'flv'];
    
    if (nativeFormats.includes(extension)) {
        // Direct playback for supported formats
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
        
    } else if (convertibleFormats.includes(extension)) {
        // Show helpful message for formats that need conversion
        self.postMessage({
            type: 'ERROR',
            message: `${extension.toUpperCase()} format requires FFmpeg.wasm for conversion. FFmpeg failed to load - please check your internet connection or try with MP4/WebM files. You can also try refreshing the page.`
        });
        
    } else {
        // Unknown format
        self.postMessage({
            type: 'ERROR',
            message: `Unsupported format: ${extension.toUpperCase()}. Supported formats: MP4, WebM, OGG (direct playback) or MKV, AVI, WMV, FLV (requires FFmpeg conversion).`
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
                    const loadResult = await loadFFmpegWASM();
                    if (loadResult && !loadResult.fallback) {
                        self.postMessage({
                            type: 'FFMPEG_TEST_RESULT',
                            message: 'FFmpeg.wasm loaded successfully'
                        });
                    } else {
                        self.postMessage({
                            type: 'FFMPEG_TEST_RESULT',
                            message: 'Using fallback converter (FFmpeg.wasm not available)'
                        });
                    }
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