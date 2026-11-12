/**
 * WebCodecs hardware-encoder helper for ffmpeg-worker.js.
 *
 * The FFmpeg worker is a *classic* worker (it uses importScripts), so this file
 * is loaded the same way and hangs its API off `self.WebCodecsEncoder`.
 *
 * Why this exists at all:
 *   ffmpeg.wasm cannot reach the platform's hardware video encoder — the core
 *   is a WebAssembly build of libx264 and friends, so every encode burns CPU.
 *   The browser *does* expose a hardware H.264 encoder through WebCodecs
 *   (`VideoEncoder`), which is what this module drives. FFmpeg still does the
 *   decoding (to rawvideo) and the muxing; only the H.264 encode itself moves
 *   to the GPU.
 *
 * Everything here is best-effort: any missing API, unsupported codec or thrown
 * error is reported back to the caller so the worker can fall back to the
 * libx264 path instead of failing the conversion.
 */

(function (global) {
    'use strict';

    /**
     * H.264 codec strings to try, most preferred first.
     *
     * The first entry is the same string the player already advertises in its
     * MediaSource mime type (`avc1.42E01E`), so in the common case the muxed
     * fragment is bit-compatible with what the browser was told to expect and
     * the SourceBuffer needs no codec change at all. The higher profiles are
     * only reached when the source is larger than baseline level 3.0 allows.
     */
    const CANDIDATES = [
        { codec: 'avc1.42E01E', profile: 'Baseline 3.0' },
        { codec: 'avc1.4d001f', profile: 'Main 3.1' },
        { codec: 'avc1.640028', profile: 'High 4.0' }
    ];

    /** WebCodecs is only present in a secure context and only in some browsers. */
    function isAvailable() {
        return typeof global.VideoEncoder !== 'undefined' &&
            typeof global.VideoFrame !== 'undefined';
    }

    /**
     * Find the first candidate codec the platform can actually encode at the
     * requested size. Returns null when the hardware path is not usable.
     *
     * @param {number} width
     * @param {number} height
     * @param {number} framerate
     * @param {number} bitrate
     * @returns {Promise<{codec: string, profile: string}|null>}
     */
    async function pickCodec(width, height, framerate, bitrate) {
        if (!isAvailable()) return null;
        if (!width || !height || !framerate) return null;

        for (const candidate of CANDIDATES) {
            try {
                const support = await global.VideoEncoder.isConfigSupported({
                    codec: candidate.codec,
                    width: width,
                    height: height,
                    bitrate: bitrate,
                    framerate: framerate,
                    avc: { format: 'annexb' }
                });
                if (support && support.supported) {
                    return { codec: candidate.codec, profile: candidate.profile };
                }
            } catch (_) {
                // Unsupported codec string / configuration -> try the next one.
            }
        }
        return null;
    }

    /**
     * Encode a block of raw I420 frames into an Annex B H.264 elementary stream.
     *
     * @param {object} opts
     * @param {Uint8Array} opts.raw       Raw I420 bytes, frame 0 first.
     * @param {number} opts.width
     * @param {number} opts.height
     * @param {number} opts.fps
     * @param {number} opts.frameCount    Number of complete frames in `raw`.
     * @param {string} opts.codec         Codec string from pickCodec().
     * @param {number} opts.bitrate
     * @param {number} [opts.firstFrame]  Index of the first frame (for timestamps).
     * @returns {Promise<Uint8Array>}    Annex B byte stream.
     */
    async function encodeAnnexB(opts) {
        if (!isAvailable()) throw new Error('WebCodecs is not available');

        const { raw, width, height, fps, frameCount, codec, bitrate } = opts;
        const firstFrame = opts.firstFrame || 0;
        const frameSize = Math.floor(width * height * 3 / 2);

        if (!frameSize || frameCount < 1) throw new Error('no raw frames to encode');
        if (raw.byteLength < frameSize * frameCount) throw new Error('raw buffer too small');

        const parts = [];
        let bytes = 0;
        let encoderError = null;

        const encoder = new global.VideoEncoder({
            output: (chunk) => {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                parts.push(buf);
                bytes += buf.byteLength;
            },
            error: (err) => {
                encoderError = err;
            }
        });

        try {
            encoder.configure({
                codec: codec,
                width: width,
                height: height,
                bitrate: bitrate,
                framerate: fps,
                latencyMode: 'quality',
                avc: { format: 'annexb' }
            });

            const frameDuration = Math.round(1000000 / fps);
            for (let i = 0; i < frameCount; i++) {
                const offset = i * frameSize;
                const frame = new global.VideoFrame(raw.subarray(offset, offset + frameSize), {
                    format: 'I420',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp: Math.round((firstFrame + i) * frameDuration),
                    duration: frameDuration
                });
                try {
                    // Every fMP4 fragment has to start on a keyframe.
                    encoder.encode(frame, { keyFrame: i === 0 });
                } finally {
                    frame.close();
                }
            }

            await encoder.flush();
        } finally {
            try { encoder.close(); } catch (_) {}
        }

        if (encoderError) throw encoderError;
        if (!bytes) throw new Error('hardware encoder produced no data');

        const out = new Uint8Array(bytes);
        let offset = 0;
        for (const part of parts) {
            out.set(part, offset);
            offset += part.byteLength;
        }
        return out;
    }

    global.WebCodecsEncoder = {
        CANDIDATES,
        isAvailable,
        pickCodec,
        encodeAnnexB
    };
})(typeof self !== 'undefined' ? self : this);
