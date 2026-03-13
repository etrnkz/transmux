// Worker FFmpeg test (worker-safe)

self.onmessage = async (e) => {

    if (e.data.type !== "TEST") return;

    try {

        self.postMessage({
            type:"LOG",
            message:"Loading FFmpeg library..."
        });

        // Load FFmpeg worker-compatible build
        importScripts(
            "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js"
        );

        const { createFFmpeg } = FFmpeg;

        const ffmpeg = createFFmpeg({
            log:true,
            corePath:
            "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.6/dist/ffmpeg-core.js"
        });

        self.postMessage({
            type:"LOG",
            message:"Initializing FFmpeg..."
        });

        await ffmpeg.load();

        self.postMessage({
            type:"SUCCESS",
            message:"FFmpeg.wasm loaded successfully 🎉"
        });

    }
    catch(error){

        self.postMessage({
            type:"ERROR",
            message:"FFmpeg loading failed: "+error.message
        });

    }

};