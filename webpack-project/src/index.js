class VideoPlayer {
    constructor() {
        this.worker = null;
        this.currentVideoUrl = null;
        this.isInitialized = false;
        
        this.initializeElements();
        this.setupEventListeners();
        this.initializeWorker();
    }

    initializeElements() {
        this.dropZone = document.getElementById('dropZone');
        this.fileInput = document.getElementById('fileInput');
        this.status = document.getElementById('status');
        this.progressContainer = document.getElementById('progressContainer');
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.videoContainer = document.getElementById('videoContainer');
        this.videoPlayer = document.getElementById('videoPlayer');
        this.logs = document.getElementById('logs');
    }

    setupEventListeners() {
        // Drop zone events
        this.dropZone.addEventListener('click', () => {
            this.fileInput.click();
        });

        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.classList.add('dragover');
        });

        this.dropZone.addEventListener('dragleave', () => {
            this.dropZone.classList.remove('dragover');
        });

        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dropZone.classList.remove('dragover');
            this.handleFiles(e.dataTransfer.files);
        });

        // File input
        this.fileInput.addEventListener('change', (e) => {
            this.handleFiles(e.target.files);
        });

        // Video events
        this.videoPlayer.addEventListener('loadstart', () => {
            this.log('📺 Video loading started');
        });

        this.videoPlayer.addEventListener('canplay', () => {
            this.log('✅ Video ready to play', 'success');
        });

        this.videoPlayer.addEventListener('error', (e) => {
            this.log(`❌ Video playback error: ${e.message}`, 'error');
        });
    }

    async initializeWorker() {
        try {
            this.log('🔧 Starting worker initialization...');
            
            // Create worker with predictable name
            this.worker = new Worker('./ffmpeg-worker.js');
            
            this.worker.onmessage = (event) => {
                this.handleWorkerMessage(event.data);
            };

            this.worker.onerror = (error) => {
                this.log(`❌ Worker error: ${error.message || error}`, 'error');
                this.showStatus('Worker initialization failed', 'error');
            };

            // Initialize FFmpeg in worker
            this.worker.postMessage({ type: 'INITIALIZE' });

        } catch (error) {
            this.log(`❌ Failed to create worker: ${error.message}`, 'error');
            this.showStatus('Failed to initialize video processor', 'error');
        }
    }

    handleWorkerMessage(message) {
        const { type, data } = message;

        switch (type) {
            case 'LOG':
                this.log(data.message, data.type);
                break;

            case 'INITIALIZED':
                if (data.success) {
                    this.isInitialized = true;
                    this.showStatus('✅ Video processor ready! Drop video files to convert.', 'success');
                } else {
                    this.showStatus('❌ Failed to initialize video processor', 'error');
                }
                break;

            case 'PROGRESS':
                this.updateProgress(data.progress, data.status);
                break;

            case 'CONVERSION_COMPLETE':
                this.handleConversionComplete(data);
                break;

            case 'ERROR':
                this.log(`❌ ${data.message}`, 'error');
                this.showStatus(`Error: ${data.message}`, 'error');
                this.hideProgress();
                break;

            default:
                console.warn('Unknown worker message type:', type);
        }
    }

    handleFiles(files) {
        if (!files || files.length === 0) return;

        if (!this.isInitialized) {
            this.showStatus('⏳ Video processor not ready yet. Please wait...', 'info');
            return;
        }

        const file = files[0];
        const fileSize = (file.size / (1024 * 1024)).toFixed(2);
        
        this.log(`📁 Processing file: ${file.name} (${fileSize} MB)`);
        this.showStatus(`Processing ${file.name}...`, 'info');
        this.showProgress();

        // Check if file needs conversion
        const extension = file.name.split('.').pop().toLowerCase();
        const nativeFormats = ['mp4', 'webm', 'ogg'];
        
        if (nativeFormats.includes(extension)) {
            // Direct playback for supported formats
            this.log(`🎯 ${extension.toUpperCase()} format supported natively, no conversion needed`);
            this.playVideo(URL.createObjectURL(file), file.name);
        } else {
            // Convert using FFmpeg
            this.log(`🔄 Converting ${extension.toUpperCase()} to MP4...`);
            this.worker.postMessage({
                type: 'CONVERT_VIDEO',
                data: {
                    file: file,
                    outputFormat: 'mp4'
                }
            });
        }
    }

    handleConversionComplete(data) {
        this.log(`🎉 Conversion completed: ${data.originalName} → MP4`, 'success');
        this.hideProgress();
        this.playVideo(data.url, data.originalName);
        this.currentVideoUrl = data.url;
    }

    playVideo(url, filename) {
        this.videoPlayer.src = url;
        this.videoContainer.style.display = 'block';
        this.showStatus(`✅ Playing: ${filename}`, 'success');
        
        // Scroll to video
        this.videoContainer.scrollIntoView({ behavior: 'smooth' });
    }

    updateProgress(progress, status) {
        this.progressFill.style.width = `${progress}%`;
        this.progressText.textContent = `${status} - ${progress}%`;
    }

    showProgress() {
        this.progressContainer.style.display = 'block';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = 'Starting...';
    }

    hideProgress() {
        this.progressContainer.style.display = 'none';
    }

    showStatus(message, type = 'info') {
        this.status.textContent = message;
        this.status.className = `status ${type}`;
        this.status.style.display = 'block';

        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                this.status.style.display = 'none';
            }, 5000);
        }
    }

    log(message, type = 'info') {
        console.log(`[Main] ${message}`);
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry log-${type}`;
        logEntry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
        
        this.logs.appendChild(logEntry);
        this.logs.scrollTop = this.logs.scrollHeight;

        // Keep only last 100 log entries
        while (this.logs.children.length > 100) {
            this.logs.removeChild(this.logs.firstChild);
        }
    }
}

// Global functions for buttons
window.downloadVideo = function() {
    const player = window.videoPlayerInstance;
    if (player && player.currentVideoUrl) {
        const a = document.createElement('a');
        a.href = player.currentVideoUrl;
        a.download = 'converted_video.mp4';
        a.click();
        player.log('📥 Download started', 'info');
    } else {
        alert('No video available for download');
    }
};

window.resetPlayer = function() {
    const player = window.videoPlayerInstance;
    if (player) {
        player.videoPlayer.src = '';
        player.videoContainer.style.display = 'none';
        player.fileInput.value = '';
        player.currentVideoUrl = null;
        player.hideProgress();
        player.showStatus('🔄 Player reset', 'info');
        player.log('🔄 Player reset', 'info');
    }
};

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    window.videoPlayerInstance = new VideoPlayer();
});