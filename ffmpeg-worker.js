// FFmpeg Web Worker for video processing
importScripts('https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/umd/ffmpeg.js');

const { FFmpeg } = FFmpegWASM;
let ffmpeg = null;

// Initialize FFmpeg
async function initFFmpeg() {
    if (!ffmpeg) {
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
        
        try {
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

// Convert video to MP4 format
async function convertVideo(file) {
    try {
        const ffmpegInstance = await initFFmpeg();
        
        // Read file as array buffer
        const arrayBuffer = await file.arrayBuffer();
        const inputFileName = file.name;
        const outputFileName = 'output.mp4';
        
        // Write input file to FFmpeg filesystem
        await ffmpegInstance.writeFile(inputFileName, new Uint8Array(arrayBuffer));
        
        // Get file info first
        await ffmpegInstance.exec(['-i', inputFileName]);
        
        // Convert to MP4 with web-optimized settings
        await ffmpegInstance.exec([
            '-i', inputFileName,
            '-c:v', 'libx264',           // H.264 video codec
            '-preset', 'fast',           // Encoding speed vs compression
            '-crf', '23',                // Quality (lower = better quality)
            '-c:a', 'aac',               // AAC audio codec
            '-b:a', '128k',              // Audio bitrate
            '-movflags', '+faststart',   // Web optimization
            '-pix_fmt', 'yuv420p',       // Pixel format for compatibility
            outputFileName
        ]);
        
        // Read the output file
        const outputData = await ffmpegInstance.readFile(outputFileName);
        
        // Create blob URL for the converted video
        const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        // Clean up FFmpeg filesystem
        await ffmpegInstance.deleteFile(inputFileName);
        await ffmpegInstance.deleteFile(outputFileName);
        
        self.postMessage({
            type: 'VIDEO_READY',
            url: url,
            size: outputData.length
        });
        
    } catch (error) {
        console.error('Video conversion error:', error);
        self.postMessage({
            type: 'ERROR',
            message: 'Video conversion failed: ' + error.message
        });
    }
}

// Extract subtitles from video
async function extractSubtitles(file) {
    try {
        const ffmpegInstance = await initFFmpeg();
        
        const arrayBuffer = await file.arrayBuffer();
        const inputFileName = file.name;
        const subtitleFileName = 'subtitles.vtt';
        
        await ffmpegInstance.writeFile(inputFileName, new Uint8Array(arrayBuffer));
        
        // Try to extract subtitles in VTT format
        try {
            await ffmpegInstance.exec([
                '-i', inputFileName,
                '-map', '0:s:0',  // Select first subtitle stream
                '-c:s', 'webvtt', // Convert to WebVTT
                subtitleFileName
            ]);
            
            const subtitleData = await ffmpegInstance.readFile(subtitleFileName);
            const subtitleText = new TextDecoder().decode(subtitleData);
            
            self.postMessage({
                type: 'SUBTITLES_READY',
                subtitles: {
                    vtt: subtitleText,
                    language: 'en',
                    format: 'webvtt'
                }
            });
            
            await ffmpegInstance.deleteFile(subtitleFileName);
            
        } catch (subtitleError) {
            // No subtitles found or extraction failed
            console.log('No subtitles found in video');
            self.postMessage({
                type: 'SUBTITLES_READY',
                subtitles: {
                    vtt: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nNo subtitles available\n',
                    language: 'en',
                    format: 'webvtt'
                }
            });
        }
        
        await ffmpegInstance.deleteFile(inputFileName);
        
    } catch (error) {
        console.error('Subtitle extraction error:', error);
        self.postMessage({
            type: 'ERROR',
            message: 'Subtitle extraction failed: ' + error.message
        });
    }
}

// Handle messages from main thread
self.onmessage = async function(e) {
    const { type, file } = e.data;
    
    try {
        switch (type) {
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