// test-worker-ffmpeg.js
self.onmessage = async (e) => {
    if(e.data.type !== "TEST") return;

    try {
        self.postMessage({ type:"LOG", message:"Loading FFmpeg from CDN (UMD)..." });

        // ⚡ UMD build works in worker
        importScripts("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/ffmpeg.umd.js");

        const { createFFmpeg } = FFmpeg;

        const ffmpeg = createFFmpeg({
            log: true,
            corePath: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/ffmpeg-core.js"
        });

        self.postMessage({ type:"LOG", message:"Initializing FFmpeg..." });
        await ffmpeg.load();

        self.postMessage({ type:"SUCCESS", message:"FFmpeg.wasm loaded successfully from CDN 🎉" });

    } catch(error) {
        self.postMessage({ type:"ERROR", message:"FFmpeg loading failed: " + error.message });
    }
};