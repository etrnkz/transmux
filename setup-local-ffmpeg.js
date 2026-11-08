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
    {
        url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.worker.js',
        path: 'public/ffmpeg-core.worker.js'
    },
];


// Create public directory if it doesn't exist
if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
}

async function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading ${url}...`);

        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                fs.unlink(filePath, () => {});
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }

            const file = fs.createWriteStream(filePath);
            response.pipe(file);

            file.on('finish', () => {
                file.close(() => {
                    console.log(`Downloaded: ${filePath}`);
                    resolve();
                });
            });
            file.on('error', (error) => {
                file.close(() => fs.unlink(filePath, () => {}));
                reject(error);
            });
        }).on('error', (error) => {
            fs.unlink(filePath, () => {});
            reject(error);
        });
    });
}

async function setupLocalFFmpeg() {
    console.log('Setting up local FFmpeg.wasm files...');
    
    try {
        for (const file of files) {
            await downloadFile(file.url, file.path);
        }
        
        console.log('\nFFmpeg.wasm core installed in public/:');
        console.log('   - public/ffmpeg.js');
        console.log('   - public/ffmpeg-core.js');
        console.log('   - public/ffmpeg-core.wasm');
        console.log('   - public/ffmpeg-core.worker.js');
        console.log('\nNext: npm run serve, then open http://localhost:8000');
        
    } catch (error) {
        console.error('Download failed:', error.message);
        console.log('\nNothing else in the repo bundles FFmpeg — the player needs all four files above.');
        console.log('   1. Check your internet connection or proxy');
        console.log('   2. Re-run: npm run setup-ffmpeg');
        console.log('   3. Or download the four files by hand from');
        console.log('      https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ and @ffmpeg/ffmpeg@0.11.6/dist/');
    }
}

// Run if called directly
if (require.main === module) {
    setupLocalFFmpeg();
}

module.exports = { setupLocalFFmpeg };
