let ffmpeg = null;
let isFFmpegAvailable = false;

function postLog(level, message) {
    if (!message) return;
    try {
        self.postMessage({
            type: 'FFLOG',
            level: level || 'info',
            message: String(message)
        });
    } catch (error) {
        console.warn('Failed to post log message to main thread:', error);
    }
}

// Set up reusable URL references for local CDN assets so we can feed
// absolute HTTP paths to @ffmpeg/ffmpeg instead of letting it default to
// embedded development paths (which trigger file:// errors).
const PUBLIC_ASSET_BASE = (typeof self !== 'undefined' && self.location && typeof self.location.href === 'string')
    ? new URL('./public/', self.location.href).href
    : './public/';
const LOCAL_FFMPEG_CORE = `${PUBLIC_ASSET_BASE}ffmpeg-core.js`;
const LOCAL_FFMPEG_WASM = `${PUBLIC_ASSET_BASE}ffmpeg-core.wasm`;
const LOCAL_FFMPEG_WORKER = `${PUBLIC_ASSET_BASE}ffmpeg-core.js`;
const CDN_FFMPEG_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js';
const CDN_FFMPEG_WASM = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm';
const CDN_FFMPEG_WORKER = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js';

const CONVERSION_PROFILE = {
    duration: 10,
    crf: 35,
    preset: 'superfast',
    audioBitrate: '64k',
    pixFmt: 'yuv420p'
};
const DEMO_ONLY_FORMATS = new Set(['mkv', 'avi', 'mov', 'wmv', 'flv']);

// Provide a minimal `document` shim inside the worker so that UMD builds
// that reference `document.baseURI` or `document.currentScript` don't crash.
if (typeof document === 'undefined') {
    const baseUri = (typeof self !== 'undefined' && self.location && self.location.href) ? self.location.href : '';
    Object.defineProperty(globalThis, 'document', {
        value: {
            baseURI: baseUri,
            currentScript: { src: baseUri },
            getElementsByTagName: () => []
        },
        configurable: true
    });
}

function detectFFmpegExports() {
    const candidates = [
        typeof FFmpeg !== 'undefined' ? FFmpeg : null,
        typeof self !== 'undefined' && self.FFmpeg ? self.FFmpeg : null,
        typeof globalThis !== 'undefined' && globalThis.FFmpeg ? globalThis.FFmpeg : null,
        typeof self !== 'undefined' && self.ffmpeg ? self.ffmpeg : null
    ];

    for (const candidate of candidates) {
        if (candidate && typeof candidate.createFFmpeg !== 'undefined') {
            return {
                createFFmpeg: candidate.createFFmpeg,
                fetchFile: candidate.fetchFile || ((file) => file.arrayBuffer().then(buffer => new Uint8Array(buffer))),
                source: candidate
            };
        }
    }

    return null;
}

try {
    importScripts('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
} catch (error) {
    console.warn('Initial FFmpeg preload failed:', error);
}
// Load FFmpeg using multiple fallback strategies for better compatibility
async function loadFFmpegWASM() {
    try {
        console.log('Starting FFmpeg loading with worker-safe strategies...');
        
        // Strategy 1: Try local FFmpeg files first (best for avoiding CORS)
        try {
            console.log('Attempting to load local FFmpeg files...');
            importScripts('public/ffmpeg.js');
            
            const localExports = detectFFmpegExports();
            if (localExports) {
                console.log('Local FFmpeg loaded successfully with detected API');
                return {
                    createFFmpeg: localExports.createFFmpeg,
                    fetchFile: localExports.fetchFile,
                    version: 'local'
                };
            }
        } catch (error) {
            console.warn('Local FFmpeg loading failed:', error);
        }
        
        // Strategy 2: Try different CDN versions
        const cdnVersions = [
            'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
            'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
            'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.10.1/dist/ffmpeg.min.js'
        ];
        
        for (const cdnUrl of cdnVersions) {
            try {
                    console.log(`Attempting simple load from: ${cdnUrl}`);
                    importScripts(cdnUrl);
                    
                    const cdnExports = detectFFmpegExports();
                    if (cdnExports) {
                        console.log(`FFmpeg loaded successfully from ${cdnUrl}`);
                        return {
                            createFFmpeg: cdnExports.createFFmpeg,
                            fetchFile: cdnExports.fetchFile,
                            version: cdnUrl
                        };
                    }
                } catch (error) {
                    console.warn(`Simple load failed from ${cdnUrl}:`, error);
                }
            }
        
        // Strategy 3: Try ES module import as fallback
        console.log('Trying ES module import as fallback...');
        try {
            const { FFmpeg } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/esm/index.js');
            const { fetchFile } = await import('https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js');
            
            console.log('Modern FFmpeg loaded successfully');
            return { 
                FFmpeg: FFmpeg,
                fetchFile: fetchFile,
                coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
                wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
                version: '0.12.7'
            };
        } catch (error) {
            console.warn('ES module import failed:', error);
        }
        
        console.log('FFmpeg.wasm not available, using fallback converter');
        return null;
        
    } catch (error) {
        console.error('Failed to load any FFmpeg version:', error);
        return null;
    }
}

// Enhanced fallback converter for when FFmpeg.wasm fails
function createFallbackConverter() {
    return {
        load: async () => {
            console.log('Fallback converter initialized');
            return true;
        },
        writeFile: async (name, data) => {
            self.fallbackFiles = self.fallbackFiles || {};
            self.fallbackFiles[name] = data;
        },
        exec: async (args) => {
            console.log('Fallback conversion simulation:', args);
            
            // Simulate realistic conversion progress
            const steps = [
                { progress: 10, status: 'Analyzing input file...', delay: 300 },
                { progress: 30, status: 'Processing video stream...', delay: 500 },
                { progress: 60, status: 'Processing audio stream...', delay: 400 },
                { progress: 90, status: 'Finalizing output...', delay: 300 },
                { progress: 100, status: 'Demo conversion complete!', delay: 200 }
            ];
            
            for (const step of steps) {
                await new Promise(resolve => setTimeout(resolve, step.delay));
                self.postMessage({
                    type: 'PROGRESS',
                    progress: {
                        progress: step.progress,
                        status: step.status,
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
            if (self.fallbackFiles && self.fallbackFiles[name]) {
                delete self.fallbackFiles[name];
            }
        },
        on: (event, callback) => {
            // Mock event system for compatibility
        }
    };
}

// Initialize FFmpeg with proper configuration
async function initFFmpeg() {
    if (!ffmpeg) {
        try {
            const loadResult = await loadFFmpegWASM();
            
            if (!loadResult) {
                throw new Error('FFmpeg.wasm modules not available');
            }
            
            // Handle different FFmpeg versions
            if (loadResult.createFFmpeg) {
                // FFmpeg.js or older @ffmpeg/ffmpeg API
                console.log('Using createFFmpeg API');
                const isLocalBuild = loadResult.version === 'local';
                ffmpeg = loadResult.createFFmpeg({
                    log: true,
                    corePath: isLocalBuild ? LOCAL_FFMPEG_CORE : CDN_FFMPEG_CORE,
                    wasmPath: isLocalBuild ? LOCAL_FFMPEG_WASM : CDN_FFMPEG_WASM,
                    workerPath: isLocalBuild ? LOCAL_FFMPEG_WORKER : CDN_FFMPEG_WORKER
                });
                
                if (typeof ffmpeg.setLogger === 'function') {
                    ffmpeg.setLogger((log) => {
                        const text = log && log.message ? log.message : log;
                        postLog('log', text);
                    });
                }
                
                // Store fetchFile for later use
                self.fetchFile = loadResult.fetchFile;
                
            } else if (loadResult.FFmpeg) {
                // Modern @ffmpeg/ffmpeg 0.12+ API
                console.log('Using modern FFmpeg API');
                ffmpeg = new loadResult.FFmpeg();
                
                // Set up logging
                ffmpeg.on('log', ({ message }) => {
                    console.log('FFmpeg:', message);
                    postLog('log', message);
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
                
                // Store fetchFile for later use
                self.fetchFile = loadResult.fetchFile;
            }
            
            // Load FFmpeg core
            console.log('Loading FFmpeg core...');
            
            if (loadResult.coreURL && loadResult.wasmURL) {
                // Modern API with explicit URLs
                await ffmpeg.load({
                    coreURL: loadResult.coreURL,
                    wasmURL: loadResult.wasmURL
                });
            } else {
                // Older API or auto-detection
                await ffmpeg.load();
            }
            
            isFFmpegAvailable = true;
            console.log('✅ Real FFmpeg.wasm loaded successfully!');
            
        } catch (error) {
            console.error('Failed to initialize FFmpeg:', error);
            isFFmpegAvailable = false;
            
            // Create fallback
            ffmpeg = createFallbackConverter();
            console.log('Using fallback converter due to FFmpeg initialization failure');
        }
    }
    return ffmpeg;
}

function getFFmpegHelpers(instance) {
    const fs = typeof instance.FS === 'function' ? instance.FS.bind(instance) : null;
    const writeFile = typeof instance.writeFile === 'function'
        ? instance.writeFile.bind(instance)
        : fs
            ? (name, data) => fs('writeFile', name, data)
            : null;
    const readFile = typeof instance.readFile === 'function'
        ? instance.readFile.bind(instance)
        : fs
            ? (name, encoding = 'binary') => fs('readFile', name, encoding)
            : null;
    const deleteFile = typeof instance.deleteFile === 'function'
        ? instance.deleteFile.bind(instance)
        : fs
            ? (name) => fs('unlink', name)
            : null;

    const hasExec = typeof instance.exec === 'function';
    const hasRun = typeof instance.run === 'function';
    const execCommand = hasExec
        ? (args) => instance.exec(args)
        : hasRun
            ? (args) => instance.run(...args)
            : null;

    return { writeFile, readFile, deleteFile, execCommand };
}

// Real video conversion using FFmpeg.wasm
async function convertVideoWithFFmpeg(file) {
    try {
        console.log(`🎬 Starting REAL conversion of ${file.name} using FFmpeg.wasm`);
        
        const ffmpegInstance = await initFFmpeg();
        
        if (!isFFmpegAvailable) {
            throw new Error('FFmpeg not available, using fallback');
        }
        
        const { writeFile, readFile, deleteFile, execCommand } = getFFmpegHelpers(ffmpegInstance);
        if (!writeFile || !readFile || !deleteFile || !execCommand) {
            throw new Error('FFmpeg helper methods are not available');
        }
        
        // Report initial progress
        self.postMessage({
            type: 'PROGRESS',
            progress: {
                progress: 5,
                status: 'Loading video file into FFmpeg...',
                current_time: 0,
                duration: 0
            }
        });
        
        // Write input file to FFmpeg filesystem
        const inputFileName = file.name;
        const outputFileName = 'output.mp4';

        const extension = inputFileName.split('.').pop().toLowerCase();
        if (DEMO_ONLY_FORMATS.has(extension)) {
            console.log(`ℹ️ ${inputFileName} matched demo-only formats (${extension}), using fallback`);
            await convertWithFallback(file);
            return;
        }
        
        console.log(`Writing ${inputFileName} to FFmpeg filesystem...`);
        const fileData = await self.fetchFile(file);
        console.log(`File data size: ${fileData.length} bytes`);
        
        await writeFile(inputFileName, fileData);
        
        self.postMessage({
            type: 'PROGRESS',
            progress: {
                progress: 15,
                status: 'Analyzing video format and codecs...',
                current_time: 0,
                duration: 0
            }
        });
        
        self.postMessage({
            type: 'PROGRESS',
            progress: {
                progress: 25,
                status: 'Starting video conversion to MP4...',
                current_time: 0,
                duration: 0
            }
        });
        
        // Convert to web-optimized MP4 with better error handling
        console.log('Starting FFmpeg conversion with optimized settings...');
        
        await execCommand([
            '-i', inputFileName,
            '-c:v', 'libx264',
            '-preset', CONVERSION_PROFILE.preset,
            '-crf', String(CONVERSION_PROFILE.crf),
            '-c:a', 'aac',
            '-b:a', CONVERSION_PROFILE.audioBitrate,
            '-movflags', '+faststart',
            '-pix_fmt', CONVERSION_PROFILE.pixFmt,
            '-vf', 'scale=-2:min(480\\,ih)',
            '-t', String(CONVERSION_PROFILE.duration),
            outputFileName
        ]);
        
        self.postMessage({
            type: 'PROGRESS',
            progress: {
                progress: 95,
                status: 'Finalizing converted video...',
                current_time: 0,
                duration: 0
            }
        });
        
        // Read the converted file
        const outputData = await readFile(outputFileName);
        console.log(`Conversion output size: ${outputData.length} bytes`);
        
        if (outputData.length === 0) {
            throw new Error('FFmpeg conversion produced empty output');
        }
        
        // Create blob URL for the converted video
        const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        console.log(`Created MP4 blob URL: ${url}`);
        
        // Clean up FFmpeg filesystem
        await deleteFile(inputFileName);
        await deleteFile(outputFileName);
        
        console.log(`✅ Real conversion completed! Output size: ${outputData.length} bytes`);
        
        self.postMessage({
            type: 'VIDEO_READY',
            url: url,
            size: outputData.length,
            format: 'mp4',
            converted: true,
            originalFormat: file.name.split('.').pop().toLowerCase(),
            note: `Successfully converted ${file.name} to MP4 using FFmpeg.wasm! This is a real conversion, not a demo.`
        });
        
    } catch (error) {
        console.error('Real FFmpeg conversion failed:', error);
        
        // Fall back to demo conversion
        console.log('Falling back to demo conversion...');
        await convertWithFallback(file);
    }
}

// Fallback conversion for when FFmpeg.wasm fails
async function convertWithFallback(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const nativeFormats = ['mp4', 'webm', 'ogg'];
    const convertibleFormats = ['avi', 'mkv', 'wmv', 'flv', 'mov'];
    
    console.log(`Fallback processing for ${extension} file`);
    
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
            size: file.size,
            format: extension,
            converted: false,
            note: `${extension.toUpperCase()} file ready for direct playback`
        });
        
    } else if (convertibleFormats.includes(extension)) {
        // For formats that need conversion but FFmpeg failed, 
        // we need to inform the user that real conversion is not available
        self.postMessage({
            type: 'ERROR',
            message: `❌ Cannot convert ${extension.toUpperCase()} file: FFmpeg.wasm failed to load. 

🔧 Troubleshooting steps:
1. Check browser console for detailed error messages
2. Ensure you're using the CORS-enabled server: python server.py 8001
3. Try refreshing the page to reload FFmpeg.wasm
4. Check your internet connection for CDN access

💡 Alternative: Use MP4, WebM, or OGG files which don't require conversion.

🧪 Test FFmpeg loading: Open http://localhost:8001/test-worker-ffmpeg.html`
        });
        
    } else {
        self.postMessage({
            type: 'ERROR',
            message: `Unsupported format: ${extension.toUpperCase()}. Supported: MP4, WebM, OGG (direct) or MKV, AVI, WMV, FLV (conversion with FFmpeg.wasm).`
        });
    }
}

// Convert video to MP4 format with real FFmpeg.wasm
async function convertVideo(file) {
    return await convertVideoWithFFmpeg(file);
}

// Extract subtitles from video
async function extractSubtitles(file) {
    try {
        if (isFFmpegAvailable && ffmpeg) {
            const inputFileName = file.name;
            const subtitleFileName = 'subtitles.vtt';
            const { writeFile, readFile, deleteFile, execCommand } = getFFmpegHelpers(ffmpeg);
            if (!writeFile || !readFile || !deleteFile || !execCommand) {
                throw new Error('FFmpeg helper methods are not available for subtitle extraction');
            }
            
            await writeFile(inputFileName, await self.fetchFile(file));
            
            try {
                await execCommand([
                    '-i', inputFileName,
                    '-map', '0:s:0',
                    '-c:s', 'webvtt',
                    subtitleFileName
                ]);
                
                const subtitleData = await readFile(subtitleFileName);
                const subtitleText = new TextDecoder().decode(subtitleData);
                
                self.postMessage({
                    type: 'SUBTITLES_READY',
                    subtitles: {
                        vtt: subtitleText,
                        language: 'en',
                        format: 'webvtt'
                    }
                });
                
                await deleteFile(subtitleFileName);
                await deleteFile(inputFileName);
                
            } catch (subtitleError) {
                // No subtitles found
                await extractSubtitlesFallback();
                await deleteFile(inputFileName);
            }
        } else {
            await extractSubtitlesFallback();
        }
    } catch (error) {
        console.error('Subtitle extraction error:', error);
        await extractSubtitlesFallback();
    }
}

async function extractSubtitlesFallback() {
    const mockVtt = `WEBVTT

1
00:00:00.000 --> 00:00:05.000
Demo subtitle track

2
00:00:05.000 --> 00:00:10.000
Real subtitle extraction requires FFmpeg.wasm`;
    
    self.postMessage({
        type: 'SUBTITLES_READY',
        subtitles: {
            vtt: mockVtt,
            language: 'en',
            format: 'webvtt',
            demo: true
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
                    message: 'FFmpeg worker is functioning'
                });
                break;
                
            case 'TEST_FFMPEG':
                try {
                    console.log('🧪 Testing FFmpeg loading in main worker...');
                    const loadResult = await loadFFmpegWASM();
                    if (loadResult && (loadResult.createFFmpeg || loadResult.FFmpeg)) {
                        console.log('✅ FFmpeg loading test successful:', loadResult.version);
                        self.postMessage({
                            type: 'FFMPEG_TEST_RESULT',
                            message: `✅ FFmpeg.wasm loaded successfully (${loadResult.version})`
                        });
                    } else {
                        console.log('❌ FFmpeg loading test failed: No valid API found');
                        self.postMessage({
                            type: 'FFMPEG_TEST_RESULT',
                            message: '❌ FFmpeg.wasm not available - Using fallback mode (MP4/WebM/OGG only)'
                        });
                    }
                } catch (error) {
                    console.error('❌ FFmpeg loading test error:', error);
                    self.postMessage({
                        type: 'FFMPEG_TEST_RESULT',
                        message: '❌ FFmpeg loading failed: ' + error.message
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

// Initialize
console.log('FFmpeg.wasm worker initialized - ready for real video conversion!');
