// Setup script to download FFmpeg.wasm files locally
// This helps avoid CDN loading issues

const fs = require('fs');
const https = require('https');
const path = require('path');

const files = [
    {
        url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
        path: 'public/ffmpeg.js'
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
        path: 'public/ffmpeg-core.js'
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm',
        path: 'public/ffmpeg-core.wasm'
    },
];
];

// Create public directory if it doesn't exist
if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
}

async function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading ${url}...`);
        
        const file = fs.createWriteStream(filePath);
        
        https.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    console.log(`✅ Downloaded: ${filePath}`);
                    resolve();
                });
            } else {
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            }
        }).on('error', (error) => {
            fs.unlink(filePath, () => {}); // Delete partial file
            reject(error);
        });
    });
}

async function setupLocalFFmpeg() {
    console.log('🔧 Setting up local FFmpeg.wasm files...');
    
    try {
        for (const file of files) {
            await downloadFile(file.url, file.path);
        }
        
        console.log('\n✅ All FFmpeg.wasm files downloaded successfully!');
        console.log('📝 Update your worker to use local files:');
        console.log('   - ./public/ffmpeg.js');
        console.log('   - ./public/ffmpeg-core.js');
        console.log('   - ./public/ffmpeg-core.wasm');
        
    } catch (error) {
        console.error('❌ Download failed:', error.message);
        console.log('\n💡 Alternative solutions:');
        console.log('   1. Check your internet connection');
        console.log('   2. Use the fallback converter (supports MP4, WebM, OGG)');
        console.log('   3. Try a different CDN in the worker file');
    }
}

// Run if called directly
if (require.main === module) {
    setupLocalFFmpeg();
}

module.exports = { setupLocalFFmpeg };
