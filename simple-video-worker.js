// Simple video processing worker without external dependencies
// Handles basic video operations and format detection

let processingFile = null;

// Simulate video processing for demonstration
async function processVideoFile(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const fileSize = file.size;
    
    // Report initial progress
    self.postMessage({
        type: 'PROGRESS',
        progress: {
            progress: 0,
            status: `Processing ${file.name}...`,
            current_time: 0,
            duration: 0
        }
    });
    
    // Simulate processing steps
    const steps = [
        { progress: 10, status: 'Analyzing video file...' },
        { progress: 25, status: 'Detecting format and codecs...' },
        { progress: 40, status: 'Preparing for conversion...' },
        { progress: 60, status: 'Processing video stream...' },
        { progress: 80, status: 'Processing audio stream...' },
        { progress: 95, status: 'Finalizing output...' },
        { progress: 100, status: 'Conversion complete!' }
    ];
    
    for (const step of steps) {
        await new Promise(resolve => setTimeout(resolve, 500));
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
    
    // Handle different formats
    const nativeFormats = ['mp4', 'webm', 'ogg'];
    const convertibleFormats = ['avi', 'mkv', 'mov', 'wmv', 'flv'];
    
    if (nativeFormats.includes(extension)) {
        // Direct playback - create blob URL
        const url = URL.createObjectURL(file);
        
        self.postMessage({
            type: 'VIDEO_READY',
            url: url,
            size: fileSize,
            format: extension,
            converted: false
        });
        
    } else if (convertibleFormats.includes(extension)) {
        // Simulate conversion by creating a mock MP4
        // In a real implementation, this would use FFmpeg.wasm or server-side conversion
        
        // For demo purposes, we'll create a placeholder
        const mockMp4Data = new Uint8Array(1024); // Minimal mock data
        const blob = new Blob([mockMp4Data], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        self.postMessage({
            type: 'VIDEO_READY',
            url: url,
            size: mockMp4Data.length,
            format: 'mp4',
            converted: true,
            originalFormat: extension,
            note: 'This is a demo conversion. Real conversion requires FFmpeg.wasm.'
        });
        
    } else {
        self.postMessage({
            type: 'ERROR',
            message: `Unsupported format: ${extension.toUpperCase()}. Supported formats: MP4, WebM, OGG (direct), AVI, MKV, MOV, WMV, FLV (conversion demo).`
        });
    }
}

// Extract mock subtitles
async function extractSubtitles(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    
    // Simulate subtitle extraction
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create mock VTT subtitle
    const mockVtt = `WEBVTT

1
00:00:00.000 --> 00:00:05.000
Demo subtitle track

2
00:00:05.000 --> 00:00:10.000
This is a sample subtitle for ${file.name}

3
00:00:10.000 --> 00:00:15.000
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
                    message: 'Simple video worker is functioning'
                });
                break;
                
            case 'PROCESS_VIDEO':
                processingFile = file;
                await processVideoFile(file);
                break;
                
            case 'EXTRACT_SUBTITLES':
                await extractSubtitles(file);
                break;
                
            case 'GET_INFO':
                self.postMessage({
                    type: 'WORKER_INFO',
                    info: {
                        type: 'Simple Video Worker',
                        capabilities: ['Format detection', 'Direct playback', 'Mock conversion'],
                        supportedFormats: {
                            direct: ['mp4', 'webm', 'ogg'],
                            demo: ['avi', 'mkv', 'mov', 'wmv', 'flv']
                        },
                        ffmpegAvailable: false
                    }
                });
                break;
                
            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'ERROR',
            message: 'Processing failed: ' + error.message
        });
    }
};

// Initialize
console.log('Simple video worker initialized');
self.postMessage({
    type: 'WORKER_READY',
    message: 'Simple video worker ready'
});