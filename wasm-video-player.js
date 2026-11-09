/**
 * wasm-video-player
 *
 * Embeds a self-contained video player that plays AVI/MKV/WMV/FLV (and anything
 * else the browser cannot decode natively) by transcoding with FFmpeg.wasm as it
 * plays, then exports a real MP4.
 *
 * Everything host-specific is injected, so this works from a subdirectory or
 * from a completely different origin:
 *
 *   const player = createPlayer({
 *     container:   document.querySelector('#player'),
 *     workerUrl:   '/vendor/wasm-video-player/ffmpeg-worker.js',
 *     coreBaseUrl: '/vendor/wasm-video-player/public'   // holds ffmpeg.js + core
 *   });
 *
 * The page must be cross-origin isolated for the engine to load:
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * See quick-start.html for a complete working page.
 */

/** Containers the browser can decode itself — no worker needed. */
const NATIVE_PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogg', 'ogv']);

const LANG = {
    eng: 'English', en: 'English', fra: 'French', fre: 'French', fr: 'French',
    deu: 'German', ger: 'German', de: 'German', spa: 'Spanish', es: 'Spanish',
    ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese',
    kor: 'Korean', ko: 'Korean', zho: 'Chinese', chi: 'Chinese', zh: 'Chinese',
    rus: 'Russian', ru: 'Russian', por: 'Portuguese', pt: 'Portuguese',
    ara: 'Arabic', ar: 'Arabic', hin: 'Hindi', hi: 'Hindi', tha: 'Thai', th: 'Thai',
    vie: 'Vietnamese', vi: 'Vietnamese', nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
    pol: 'Polish', pl: 'Polish', tur: 'Turkish', tr: 'Turkish',
    swe: 'Swedish', sv: 'Swedish', ukr: 'Ukrainian', uk: 'Ukrainian'
};

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Human label for a probed audio track, e.g. "English · stereo · default". */
function describeAudioTrack(track, i) {
    const bits = [];
    bits.push(track && track.lang ? (LANG[track.lang] || track.lang.toUpperCase()) : `Track ${i + 1}`);
    if (track && track.channels) bits.push(track.channels);
    if (track && track.isDefault) bits.push('default');
    return bits.join(' · ');
}

/**
 * Build the worker URL, folding the core location into the query string. The
 * worker reads these synchronously at startup, so there is no race between its
 * automatic FFmpeg load and the configuration arriving.
 */
function buildWorkerUrl(workerUrl, coreBaseUrl) {
    const url = new URL(workerUrl, document.baseURI);
    if (coreBaseUrl) {
        url.searchParams.set('coreBase', new URL(coreBaseUrl, document.baseURI).href);
    }
    return url.href;
}

/**
 * Create a player.
 *
 * @param {object} options
 * @param {Element} options.container         Where to mount the UI. Required.
 * @param {HTMLVideoElement} [options.videoEl] Existing <video> to drive.
 * @param {string|URL}  [options.workerUrl]   Path to ffmpeg-worker.js.
 * @param {string|URL}  [options.coreBaseUrl] Directory holding ffmpeg.js and the
 *                                            ffmpeg-core files. Defaults to the
 *                                            worker's own ./public sibling.
 * @param {string} [options.fileInputId]      id for the hidden file input.
 * @param {string} [options.title]            Heading text; '' hides the header.
 * @param {string} [options.subtitle]         Secondary heading text.
 * @param {boolean} [options.showLog=true]    Show the telemetry panel.
 * @param {boolean} [options.showExport=true] Show the Export MP4 button.
 * @returns {object} player API
 */
export function createPlayer(options = {}) {
    const container = options.container;
    if (!container) {
        throw new Error('createPlayer: options.container is required');
    }

    const workerUrl = options.workerUrl || './ffmpeg-worker.js';
    const coreBaseUrl = options.coreBaseUrl || null;
    const resolvedWorkerUrl = buildWorkerUrl(workerUrl, coreBaseUrl);
    const showLog = options.showLog !== false;
    const showExport = options.showExport !== false;
    const uid = 'wvp' + Math.random().toString(36).slice(2, 8);

    // ---- instance state -------------------------------------------------
    let worker = null;
    let currentVideoUrl = null;
    let convertedVideoUrl = null;
    let currentPreviewUrl = null;
    let isPlayingPreview = false;
    let currentFile = null;

    let activeMediaSource = null;
    let activeMediaSourceUrl = null;
    let activeSourceBuffer = null;
    let chunkQueue = [];
    let isAppendingChunk = false;
    let isExporting = false;
    let pendingExportUrl = null;
    let subtitleTrackUrl = null;
    let isFastCopyExport = false;

    let audioTracks = [];
    let selectedAudioTrack = 0;

    // True while a conversion/export/stream is actually running in the worker.
    // Only then is it worth paying the core reload to interrupt it — ffmpeg-core
    // cannot abort a running exec, so terminating the worker is the only way.
    let workerBusy = false;
    let destroyed = false;

    const listeners = { status: [], log: [], progress: [], ready: [], error: [] };

    // ---- UI construction ------------------------------------------------
    const ui = {};

    function el(tag, className, attrs) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        }
        return node;
    }

    function buildShell() {
        const root = el('div', 'wvp-root');

        const hasHeader = options.title !== '';
        if (hasHeader) {
            const header = el('header', 'wvp-header');
            const group = el('div', 'wvp-header-group');
            const h1 = el('h1', 'wvp-title');
            h1.textContent = options.title || 'WASM Video Player';
            group.appendChild(h1);
            if (options.subtitle !== '') {
                const sub = el('span', 'wvp-subtitle');
                sub.textContent = options.subtitle || 'Real-time WebAssembly demuxing & live playback';
                group.appendChild(sub);
            }
            const pill = el('div', 'wvp-pill-status', { id: `${uid}-ffmpegStatus` });
            const dot = el('span', 'wvp-status-dot');
            const text = el('span');
            text.id = `${uid}-ffmpegStatusText`;
            text.textContent = 'Initializing FFmpeg.wasm...';
            pill.append(dot, text);
            ui.ffmpegPill = pill;
            ui.ffmpegPillText = text;
            header.append(group, pill);
            root.appendChild(header);
        }

        const status = el('div', 'wvp-status', { role: 'status', 'aria-live': 'polite' });
        ui.status = status;
        root.appendChild(status);

        const stage = el('div', 'wvp-stage');

        // Empty state / dropzone
        const upload = el('div', 'wvp-upload', {
            role: 'button',
            tabindex: '0',
            'aria-label': 'Drop a video file here, or press Enter to choose a file'
        });
        const iconBox = el('div', 'wvp-upload-icon');
        iconBox.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
        const uploadTitle = el('div', 'wvp-upload-title');
        uploadTitle.textContent = 'Drop video file to play';
        const uploadSub = el('div', 'wvp-upload-sub');
        uploadSub.textContent = 'Immediate live streaming for AVI, MKV, MP4, WebM, MOV';
        const chooseBtn = el('button', 'wvp-btn wvp-upload-btn', { type: 'button' });
        chooseBtn.textContent = 'Choose file';
        const input = el('input', 'wvp-file-input', { type: 'file', accept: 'video/*' });
        input.id = options.fileInputId || `${uid}-fileInput`;
        const formats = el('div', 'wvp-formats');
        for (const f of ['AVI', 'MKV', 'MP4', 'MOV', 'WEBM']) {
            const pill = el('span', 'wvp-pill');
            pill.textContent = f;
            formats.appendChild(pill);
        }
        upload.append(iconBox, uploadTitle, uploadSub, chooseBtn, input, formats);
        ui.upload = upload;
        ui.fileInput = input;

        // Video + controls
        const videoContainer = el('div', 'wvp-video-container');
        let video = options.videoEl || null;
        if (!video) {
            video = el('video', 'wvp-video', { controls: '', playsinline: '' });
        }
        video.classList.add('wvp-video');
        ui.video = video;

        const toolbar = el('div', 'wvp-toolbar');
        const groupLeft = el('div', 'wvp-group');

        const subtitleBtn = el('button', 'wvp-btn', {
            type: 'button',
            disabled: '',
            title: 'Load a video to check for subtitles'
        });
        subtitleBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h3"/><path d="M14 15h3"/><path d="M7 11h10"/></svg><span>Subtitles</span>';
        ui.subtitleBtn = subtitleBtn;

        const audioSelect = el('select', 'wvp-select wvp-track-select', {
            'aria-label': 'Audio track'
        });
        ui.audioSelect = audioSelect;

        const rateSelect = el('select', 'wvp-select wvp-rate-select', {
            'aria-label': 'Playback speed',
            disabled: '',
            title: 'Load a video to change playback speed'
        });
        for (const r of ['0.5', '0.75', '1', '1.25', '1.5', '2']) {
            const opt = el('option');
            opt.value = r;
            opt.textContent = r + '×';
            if (r === '1') opt.selected = true;
            rateSelect.appendChild(opt);
        }
        ui.rateSelect = rateSelect;

        groupLeft.append(subtitleBtn, audioSelect, rateSelect);

        if (showExport) {
            const exportBtn = el('button', 'wvp-btn', { type: 'button' });
            exportBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Export MP4</span>';
            ui.exportBtn = exportBtn;
            groupLeft.appendChild(exportBtn);
        }

        const groupRight = el('div', 'wvp-group');
        const resetBtn = el('button', 'wvp-btn', { type: 'button' });
        resetBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>Reset</span>';
        ui.resetBtn = resetBtn;
        groupRight.appendChild(resetBtn);

        toolbar.append(groupLeft, groupRight);
        videoContainer.append(video, toolbar);

        stage.append(upload, videoContainer);
        root.appendChild(stage);
        ui.videoContainer = videoContainer;

        // Progress
        const progress = el('div', 'wvp-progress');
        const meta = el('div', 'wvp-progress-meta');
        const progressText = el('span');
        progressText.textContent = 'Processing...';
        const progressPct = el('span');
        progressPct.textContent = '0%';
        meta.append(progressText, progressPct);
        const bar = el('div', 'wvp-progress-bar');
        const fill = el('div', 'wvp-progress-fill');
        bar.appendChild(fill);
        progress.append(meta, bar);
        ui.progress = progress;
        ui.progressText = progressText;
        ui.progressPct = progressPct;
        ui.progressFill = fill;
        root.appendChild(progress);

        // Telemetry
        if (showLog) {
            const logSection = el('div', 'wvp-log-section');
            const logHeader = el('div', 'wvp-log-header');
            const logTitle = el('span');
            logTitle.textContent = 'FFmpeg Telemetry';
            const clearBtn = el('button', 'wvp-btn', { type: 'button' });
            clearBtn.textContent = 'Clear';
            logHeader.append(logTitle, clearBtn);
            const panel = el('div', 'wvp-log-panel', {
                role: 'log',
                'aria-live': 'polite',
                'aria-label': 'FFmpeg telemetry output'
            });
            const entries = el('div');
            entries.innerHTML = '<div class="wvp-log-entry"><span class="wvp-log-time">[--:--:--]</span><span>Awaiting FFmpeg output...</span></div>';
            panel.appendChild(entries);
            logSection.append(logHeader, panel);
            root.appendChild(logSection);
            ui.logEntries = entries;
            ui.clearLogBtn = clearBtn;
        }

        container.appendChild(root);
        ui.root = root;
    }

    // ---- logging / status ----------------------------------------------
    function emit(name, payload) {
        for (const fn of listeners[name]) {
            try { fn(payload); } catch (_) { /* a bad listener must not break playback */ }
        }
    }

    function appendLog(message, level = 'info') {
        emit('log', { message, level });
        const entries = ui.logEntries;
        if (!entries) return;
        if (entries.children.length === 1 && entries.children[0].textContent.includes('Awaiting FFmpeg output...')) {
            entries.innerHTML = '';
        }
        const div = document.createElement('div');
        div.className = `wvp-log-entry wvp-log-${level}`;
        const time = new Date().toLocaleTimeString();
        div.innerHTML = `<span class="wvp-log-time">[${time}]</span><span>${escapeHtml(message)}</span>`;
        entries.appendChild(div);
        entries.parentElement.scrollTop = entries.parentElement.scrollHeight;
        while (entries.children.length > 300) entries.removeChild(entries.firstChild);
    }

    function clearLog() {
        if (!ui.logEntries) return;
        ui.logEntries.innerHTML = '<div class="wvp-log-entry"><span class="wvp-log-time">[--:--:--]</span><span>Awaiting FFmpeg output...</span></div>';
    }

    function showStatus(msg, type = 'info') {
        emit('status', { message: msg, type });
        if (!ui.status) return;
        ui.status.textContent = msg;
        ui.status.className = `wvp-status ${type}`;
    }

    function showProgress() {
        if (!ui.progress) return;
        ui.progress.style.display = 'block';
        ui.progressFill.style.width = '0%';
        ui.progressText.textContent = 'Starting...';
        ui.progressPct.textContent = '0%';
    }

    function hideProgress() {
        if (ui.progress) ui.progress.style.display = 'none';
    }

    function updateProgress(data) {
        emit('progress', data);
        if (!ui.progress) return;
        const p = Math.round(data.progress || 0);
        ui.progressFill.style.width = p + '%';
        ui.progressText.textContent = (data.status || 'Processing...');
        ui.progressPct.textContent = p + '%';
        if (p >= 100) setTimeout(hideProgress, 1500);
    }

    function showVideoContainer() {
        ui.upload.style.display = 'none';
        ui.videoContainer.style.display = 'block';
    }

    // ---- worker lifecycle ----------------------------------------------
    function spawnWorker() {
        const w = new Worker(resolvedWorkerUrl);
        attachWorkerHandlers(w);
        worker = w;
        return w;
    }

    function attachWorkerHandlers(w) {
        w.onmessage = handleWorkerMessage;
        w.onerror = (err) => appendLog(`Worker error: ${err.message || err}`, 'error');
    }

    // Terminate the worker mid-exec and start a fresh one. The new worker starts
    // with a clean queue, so nothing from the abandoned job can post a result
    // into the new session.
    function interruptWorker() {
        const stale = worker;
        workerBusy = false;
        worker = null;
        try { if (stale) stale.terminate(); } catch (_) {}
        spawnWorker();
        appendLog('Restarted FFmpeg worker to interrupt the running job', 'info');
    }

    // ---- MediaSource pipeline ------------------------------------------
    function cleanupMediaSource() {
        if (activeMediaSource && activeMediaSource.readyState === 'open') {
            try { activeMediaSource.endOfStream(); } catch (_) {}
        }
        if (activeMediaSourceUrl) {
            try { URL.revokeObjectURL(activeMediaSourceUrl); } catch (_) {}
            activeMediaSourceUrl = null;
        }
        activeMediaSource = null;
        activeSourceBuffer = null;
        chunkQueue = [];
        isAppendingChunk = false;
    }

    function processNextChunk() {
        if (!activeSourceBuffer || isAppendingChunk || activeSourceBuffer.updating || chunkQueue.length === 0) {
            return;
        }
        isAppendingChunk = true;
        const next = chunkQueue.shift();
        try {
            activeSourceBuffer.appendBuffer(next);
        } catch (err) {
            isAppendingChunk = false;
            appendLog('Stream buffer append error: ' + err.message, 'warn');
        }
    }

    // ---- worker messages -----------------------------------------------
    function handleWorkerMessage(event) {
        const msg = event.data;
        if (!msg || !msg.type) return;
        const data = msg.data || {};

        switch (msg.type) {
            case 'FFLOG':
                appendLog(data.message || '', 'info');
                break;
            case 'LOG':
                appendLog(data.message || '', data.level || 'info');
                break;
            case 'WORKER_READY':
                appendLog('FFmpeg worker ready', 'success');
                if (ui.ffmpegPillText) {
                    ui.ffmpegPillText.textContent = 'FFmpeg.wasm loaded — full conversion available';
                    ui.ffmpegPill.className = 'wvp-pill-status wvp-pill-success';
                }
                emit('ready', data);
                break;
            case 'PROGRESS':
                workerBusy = true;
                updateProgress(data);
                break;
            case 'AUDIO_TRACKS':
                setAudioTracks(data.tracks || [], data.selected);
                break;
            case 'STREAM_START': {
                workerBusy = true;
                cleanupMediaSource();
                showVideoContainer();

                const video = ui.video;
                activeMediaSource = new MediaSource();
                activeMediaSourceUrl = URL.createObjectURL(activeMediaSource);
                video.src = activeMediaSourceUrl;

                activeMediaSource.onsourceopen = () => {
                    try {
                        const mime = data.mime || 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
                        activeSourceBuffer = activeMediaSource.addSourceBuffer(mime);
                        activeSourceBuffer.mode = 'sequence';

                        activeSourceBuffer.onupdateend = () => {
                            isAppendingChunk = false;
                            if (video.paused && video.currentTime === 0) {
                                video.play().catch(() => {});
                            }
                            processNextChunk();
                        };

                        processNextChunk();
                    } catch (e) {
                        appendLog('MediaSource init error: ' + e.message, 'error');
                    }
                };

                showStatus('Live streaming started — playing video as it converts', 'info');
                appendLog(`Live stream initialized (${(data.duration || 0).toFixed(1)}s total)`, 'info');
                break;
            }
            case 'STREAM_CHUNK':
                if (data.chunk) {
                    chunkQueue.push(data.chunk);
                    processNextChunk();

                    const video = ui.video;
                    if (data.index === 0) {
                        showStatus('Live stream playing — buffering remaining video in background', 'success');
                        appendLog('First stream segment buffered — playback started', 'success');
                        video.play().catch(() => {});
                    }
                }
                break;
            case 'STREAM_END': {
                workerBusy = false;
                showStatus(data.note || 'Entire video converted and ready', 'success');
                appendLog(data.note || 'Successfully converted video and buffered all streams', 'success');

                // The buffered chunks are a valid MSE timeline but not a valid
                // single MP4 file, so export re-encodes from the source instead.
                // Bind the interval to *this* MediaSource so a reset or a newer
                // stream cannot have its buffer closed by a stale timer.
                const ms = activeMediaSource;
                const waitAppend = setInterval(() => {
                    if (activeMediaSource !== ms) { clearInterval(waitAppend); return; }
                    if (chunkQueue.length === 0 && (!activeSourceBuffer || !activeSourceBuffer.updating)) {
                        clearInterval(waitAppend);
                        try { ms.endOfStream(); } catch (_) {}
                    }
                }, 100);
                setTimeout(() => clearInterval(waitAppend), 60000);
                break;
            }
            case 'VIDEO_READY':
                workerBusy = false;
                if (data.url) {
                    const video = ui.video;
                    showVideoContainer();

                    if (data.isPreview) {
                        isPlayingPreview = true;
                        currentPreviewUrl = data.url;
                        showStatus(data.note || 'Streaming preview ready', 'info');
                        appendLog(data.note || 'Streaming preview ready', 'success');

                        video.src = data.url;
                        video.load();
                        video.play().catch(() => {});
                    } else {
                        // A remuxed MP4 blob is a complete file, so export can reuse it directly.
                        convertedVideoUrl = data.url;
                        isFastCopyExport = true;
                        showStatus(data.note || 'Successfully converted', 'success');
                        appendLog(data.note || 'Successfully converted video', 'success');

                        if (isPlayingPreview) {
                            const savedTime = video.currentTime || 0;
                            const wasPaused = video.paused;
                            isPlayingPreview = false;

                            video.src = data.url;
                            video.addEventListener('loadedmetadata', function onMeta() {
                                video.removeEventListener('loadedmetadata', onMeta);
                                try {
                                    if (savedTime > 0 && savedTime < video.duration) {
                                        video.currentTime = savedTime;
                                    }
                                } catch (e) { /* seeking is best-effort */ }
                                if (!wasPaused) {
                                    video.play().catch(() => {});
                                }
                            }, { once: true });

                            appendLog(`Seamlessly transitioned to full video at ${savedTime.toFixed(1)}s`, 'success');

                            if (currentPreviewUrl) {
                                setTimeout(() => {
                                    try { URL.revokeObjectURL(currentPreviewUrl); } catch (e) {}
                                    currentPreviewUrl = null;
                                }, 2000);
                            }
                        } else {
                            video.src = data.url;
                            video.load();
                            video.play().catch(() => {});
                        }
                    }
                }
                break;
            case 'SUBTITLES_READY':
                loadSubtitles(data.subtitles);
                break;
            case 'EXPORT_STATUS':
                isExporting = true;
                workerBusy = true;
                showProgress();
                if (typeof data.progress === 'number') {
                    updateProgress({ progress: data.progress, status: data.message });
                } else {
                    ui.progressText.textContent = data.message || 'Exporting...';
                    ui.progressFill.style.width = '0%';
                    ui.progressPct.textContent = '0%';
                }
                appendLog(data.message || 'Exporting...', 'info');
                break;
            case 'EXPORT_READY':
                isExporting = false;
                workerBusy = false;
                hideProgress();
                if (pendingExportUrl) { try { URL.revokeObjectURL(pendingExportUrl); } catch (_) {} }
                pendingExportUrl = data.url;
                showStatus(data.note || 'MP4 export ready', 'success');
                appendLog(data.note || 'MP4 export ready', 'success');
                triggerDownload(data.url);
                break;
            case 'ERROR':
                isExporting = false;
                workerBusy = false;
                showStatus(data.message || 'Processing error', 'error');
                appendLog('Error: ' + (data.message || 'Unknown'), 'error');
                hideProgress();
                emit('error', data);
                break;
            case 'TEST_RESPONSE':
                appendLog('Worker test: ' + (data.message || 'OK'), 'success');
                break;
            default:
                appendLog(`Unknown message: ${msg.type}`, 'warn');
        }
    }

    // ---- subtitles ------------------------------------------------------
    function loadSubtitles(subtitlesData) {
        const video = ui.video;
        video.querySelectorAll('track').forEach(t => t.remove());
        if (subtitleTrackUrl) { try { URL.revokeObjectURL(subtitleTrackUrl); } catch (_) {} }
        subtitleTrackUrl = null;

        if (!subtitlesData || !subtitlesData.found || !subtitlesData.vtt) {
            const reason = (subtitlesData && subtitlesData.reason) || 'No subtitle stream in this file';
            appendLog(`No subtitles: ${reason}`, 'info');
            setSubtitleButtonState(false);
            return;
        }

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = 'Extracted subtitles';
        track.srclang = subtitlesData.language || 'en';
        track.default = true;
        subtitleTrackUrl = URL.createObjectURL(new Blob([subtitlesData.vtt], { type: 'text/vtt' }));
        track.src = subtitleTrackUrl;
        video.appendChild(track);
        setSubtitleButtonState(true);
        appendLog('Subtitles extracted and loaded', 'success');
    }

    function setSubtitleButtonState(available) {
        if (!ui.subtitleBtn) return;
        ui.subtitleBtn.disabled = !available;
        ui.subtitleBtn.title = available ? 'Toggle subtitles' : 'This file has no subtitles';
    }

    // The rate control only makes sense once something is loaded, so it follows
    // the same enable/disable rhythm as the subtitle button.
    function setRateControlState(enabled) {
        if (!ui.rateSelect) return;
        ui.rateSelect.disabled = !enabled;
        ui.rateSelect.title = enabled ? 'Playback speed' : 'Load a video to change playback speed';
        if (!enabled) {
            ui.rateSelect.value = '1';
            ui.video.defaultPlaybackRate = 1;
            ui.video.playbackRate = 1;
        }
    }

    // Rate is a property of the <video> element, so it survives chunk appends.
    // defaultPlaybackRate is set too because load() (used on every source swap
    // and MediaSource hand-off) resets playbackRate from it.
    function setPlaybackRate(value) {
        const rate = parseFloat(value);
        if (!Number.isFinite(rate) || rate <= 0) return;
        ui.video.defaultPlaybackRate = rate;
        ui.video.playbackRate = rate;
        if (ui.rateSelect) ui.rateSelect.value = String(rate);
        appendLog(`Playback speed set to ${rate}×`, 'info');
    }

    // ---- audio tracks ---------------------------------------------------
    // Only surfaces the picker when a file genuinely has a choice to make, so
    // single-track files keep the toolbar exactly as it was.
    function setAudioTracks(tracks, selected) {
        if (!ui.audioSelect) return;

        audioTracks = Array.isArray(tracks) ? tracks : [];
        selectedAudioTrack = Number.isInteger(selected) && selected >= 0 ? selected : 0;

        ui.audioSelect.innerHTML = '';
        if (audioTracks.length < 2) {
            ui.audioSelect.style.display = 'none';
            ui.audioSelect.disabled = true;
            return;
        }

        audioTracks.forEach((track, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = describeAudioTrack(track, i);
            if (i === selectedAudioTrack) opt.selected = true;
            ui.audioSelect.appendChild(opt);
        });
        ui.audioSelect.disabled = false;
        ui.audioSelect.style.display = 'inline-flex';
    }

    function resetAudioTracks() {
        audioTracks = [];
        selectedAudioTrack = 0;
        if (ui.audioSelect) {
            ui.audioSelect.innerHTML = '';
            ui.audioSelect.style.display = 'none';
            ui.audioSelect.disabled = true;
        }
    }

    // Switching tracks re-runs the pipeline from the same source file with a
    // different audio map, which is the only way to change the encoded audio in
    // the streamed/remuxed output.
    function selectAudioTrack(value) {
        const index = parseInt(value, 10);
        if (!currentFile || !worker || !Number.isInteger(index)) return;
        if (index === selectedAudioTrack) return;

        selectedAudioTrack = index;
        appendLog(`Switching to audio track ${index + 1} (${describeAudioTrack(audioTracks[index], index)})`, 'info');
        showStatus(`Switching audio to ${describeAudioTrack(audioTracks[index], index)}...`, 'info');

        cleanupMediaSource();
        if (convertedVideoUrl) {
            try { URL.revokeObjectURL(convertedVideoUrl); } catch (_) {}
            convertedVideoUrl = null;
        }
        isFastCopyExport = false;

        showProgress();
        workerBusy = true;
        try {
            worker.postMessage({ type: 'PROCESS_VIDEO', file: currentFile, audioTrack: index });
        } catch (e) {
            workerBusy = false;
            appendLog('Audio switch failed: ' + e.message, 'error');
            hideProgress();
        }
    }

    function toggleSubtitles() {
        const tracks = ui.video.textTracks;
        if (tracks.length > 0) {
            const t = tracks[0];
            t.mode = t.mode === 'showing' ? 'hidden' : 'showing';
            showStatus(`Subtitles ${t.mode === 'showing' ? 'enabled' : 'disabled'}`, 'info');
        } else {
            showStatus('No subtitles in this file', 'info');
        }
    }

    // ---- load / export / reset ------------------------------------------
    function handleFiles(files) {
        if (!files || !files.length || destroyed) return;
        const file = files[0];
        const ext = file.name.split('.').pop().toLowerCase();
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);

        appendLog(`File: ${file.name} (${sizeMB} MB, ${ext.toUpperCase()})`, 'info');

        // Supersede any conversion still running for the previous file. If one is
        // mid-exec it cannot be interrupted by a message, so restart the worker
        // instead of letting the new file queue behind it.
        if (worker) {
            if (workerBusy) {
                interruptWorker();
            } else {
                try { worker.postMessage({ type: 'CANCEL' }); } catch (_) {}
            }
        }

        currentFile = file;
        isExporting = false;
        workerBusy = false;

        const video = ui.video;
        cleanupMediaSource();
        if (pendingExportUrl) { URL.revokeObjectURL(pendingExportUrl); pendingExportUrl = null; }
        if (subtitleTrackUrl) { URL.revokeObjectURL(subtitleTrackUrl); subtitleTrackUrl = null; }
        video.querySelectorAll('track').forEach(t => t.remove());
        setSubtitleButtonState(false);
        resetAudioTracks();
        setRateControlState(true);
        isFastCopyExport = false;
        if (currentPreviewUrl) { URL.revokeObjectURL(currentPreviewUrl); currentPreviewUrl = null; }
        if (currentVideoUrl) { URL.revokeObjectURL(currentVideoUrl); currentVideoUrl = null; }
        if (convertedVideoUrl) { URL.revokeObjectURL(convertedVideoUrl); convertedVideoUrl = null; }

        // Containers the browser can decode itself. Everything else (AVI, MKV,
        // WMV, FLV) must wait for the worker: pointing <video> at one of those
        // just paints a broken player with MEDIA_ERR_SRC_NOT_SUPPORTED until the
        // conversion lands.
        showVideoContainer();
        if (NATIVE_PLAYABLE.has(ext)) {
            const directUrl = URL.createObjectURL(file);
            currentVideoUrl = directUrl;
            video.src = directUrl;
            video.load();
            video.play().catch(() => {});
            showStatus(`Playing ${file.name} — converting in background...`, 'info');
        } else if (ext === 'avi') {
            showStatus(`Connecting live streaming engine for ${file.name}...`, 'info');
        } else {
            showStatus(`Reading ${file.name} — checking for an instant remux...`, 'info');
        }

        if (worker) {
            showProgress();
            workerBusy = true;
            appendLog('Starting FFmpeg conversion pipeline...', 'info');
            try {
                worker.postMessage({ type: 'PROCESS_VIDEO', file, audioTrack: selectedAudioTrack });
                worker.postMessage({ type: 'EXTRACT_SUBTITLES', file });
            } catch (e) {
                workerBusy = false;
                appendLog('Worker post failed: ' + e.message, 'error');
                hideProgress();
            }
        } else {
            appendLog('Worker not ready yet — direct playback only', 'warn');
            hideProgress();
        }
    }

    function triggerDownload(url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = (currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'video') + '.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function exportVideo() {
        if (!currentFile) {
            showStatus('Load a video first', 'error');
            return;
        }

        // Streamed playback was assembled from fMP4 chunks, which are not a valid
        // standalone file. Render a real MP4 from the source instead.
        const needsRender = !convertedVideoUrl;
        if (!needsRender && isFastCopyExport) {
            triggerDownload(convertedVideoUrl);
            appendLog('Download started', 'success');
            showStatus('Exporting original-quality MP4', 'success');
            return;
        }

        if (isExporting) {
            showStatus('Export already in progress', 'info');
            return;
        }

        if (!worker) {
            showStatus('FFmpeg still loading — try again in a moment', 'info');
            return;
        }

        isExporting = true;
        appendLog('Rendering MP4 for export...', 'info');
        showProgress();
        ui.progressText.textContent = 'Preparing MP4 export...';
        worker.postMessage({ type: 'EXPORT_VIDEO', file: currentFile, audioTrack: selectedAudioTrack });
    }

    function reset() {
        // Interrupt for real if something is encoding right now: a soft CANCEL
        // only makes the job unwind between ffmpeg.run() calls, so a long export
        // would keep the core busy and the next file would queue behind it.
        // Terminating the worker is the only true abort.
        if (worker && workerBusy) {
            interruptWorker();
        } else if (worker) {
            try { worker.postMessage({ type: 'CANCEL' }); } catch (_) {}
        }
        isExporting = false;
        workerBusy = false;
        cleanupMediaSource();

        const video = ui.video;
        video.pause();
        video.removeAttribute('src');
        video.load();

        ui.videoContainer.style.display = 'none';
        ui.upload.style.display = 'flex';
        ui.fileInput.value = '';
        isPlayingPreview = false;
        setSubtitleButtonState(false);
        resetAudioTracks();
        setRateControlState(false);

        if (subtitleTrackUrl) { try { URL.revokeObjectURL(subtitleTrackUrl); } catch (_) {} subtitleTrackUrl = null; }
        if (pendingExportUrl) { try { URL.revokeObjectURL(pendingExportUrl); } catch (_) {} pendingExportUrl = null; }
        if (currentPreviewUrl) { try { URL.revokeObjectURL(currentPreviewUrl); } catch (_) {} currentPreviewUrl = null; }
        if (currentVideoUrl) { try { URL.revokeObjectURL(currentVideoUrl); } catch (_) {} currentVideoUrl = null; }
        if (convertedVideoUrl) { try { URL.revokeObjectURL(convertedVideoUrl); } catch (_) {} convertedVideoUrl = null; }

        currentFile = null;
        isFastCopyExport = false;
        hideProgress();
        showStatus('Player reset', 'info');
    }

    // ---- wiring ---------------------------------------------------------
    function start() {
        buildShell();

        ui.upload.addEventListener('dragover', (e) => {
            e.preventDefault();
            ui.upload.classList.add('wvp-dragover');
        });
        ui.upload.addEventListener('dragleave', () => ui.upload.classList.remove('wvp-dragover'));
        ui.upload.addEventListener('drop', (e) => {
            e.preventDefault();
            ui.upload.classList.remove('wvp-dragover');
            handleFiles(e.dataTransfer.files);
        });
        ui.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

        // The whole dropzone is a button: click or Enter/Space opens the picker.
        // The inner "Choose file" button is excluded so it does not double-fire.
        ui.upload.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            ui.fileInput.click();
        });
        ui.upload.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                ui.fileInput.click();
            }
        });

        ui.subtitleBtn.addEventListener('click', toggleSubtitles);
        ui.audioSelect.addEventListener('change', (e) => selectAudioTrack(e.target.value));
        ui.rateSelect.addEventListener('change', (e) => setPlaybackRate(e.target.value));
        ui.resetBtn.addEventListener('click', reset);
        if (ui.exportBtn) ui.exportBtn.addEventListener('click', exportVideo);
        if (ui.clearLogBtn) ui.clearLogBtn.addEventListener('click', clearLog);

        if (typeof SharedArrayBuffer === 'undefined') {
            appendLog('SharedArrayBuffer not available — single-threaded mode active', 'warn');
        }

        spawnWorker();
        appendLog('Application initialized successfully', 'success');
    }

    start();

    // ---- public API -----------------------------------------------------
    return {
        /** Play a File (or a FileList's first entry). */
        loadFile: (fileOrList) => handleFiles(fileOrList && fileOrList.length !== undefined ? fileOrList : [fileOrList]),
        reset,
        exportVideo,
        setPlaybackRate,
        selectAudioTrack,
        toggleSubtitles,
        clearLog,
        /** Current state, useful for host UI. */
        getState: () => ({
            file: currentFile,
            audioTracks: audioTracks.slice(),
            selectedAudioTrack,
            busy: workerBusy,
            isExporting,
            hasConvertedFile: Boolean(convertedVideoUrl)
        }),
        /** Subscribe to 'status' | 'log' | 'progress' | 'ready' | 'error'. */
        on: (name, fn) => {
            if (listeners[name]) listeners[name].push(fn);
            return () => {
                const arr = listeners[name];
                if (arr) {
                    const i = arr.indexOf(fn);
                    if (i >= 0) arr.splice(i, 1);
                }
            };
        },
        /** Tear down the worker and remove the generated UI. */
        destroy() {
            destroyed = true;
            try { if (worker) worker.terminate(); } catch (_) {}
            worker = null;
            cleanupMediaSource();
            if (subtitleTrackUrl) { try { URL.revokeObjectURL(subtitleTrackUrl); } catch (_) {} }
            if (pendingExportUrl) { try { URL.revokeObjectURL(pendingExportUrl); } catch (_) {} }
            if (currentPreviewUrl) { try { URL.revokeObjectURL(currentPreviewUrl); } catch (_) {} }
            if (currentVideoUrl) { try { URL.revokeObjectURL(currentVideoUrl); } catch (_) {} }
            if (convertedVideoUrl) { try { URL.revokeObjectURL(convertedVideoUrl); } catch (_) {} }
            if (ui.root && ui.root.parentElement) ui.root.parentElement.removeChild(ui.root);
        },
        /** Resolved URLs, for debugging an embedding. */
        urls: { worker: resolvedWorkerUrl, coreBase: coreBaseUrl },
        /**
         * The generated DOM nodes, for hosts that need to reference them
         * (stable ids, custom controls, instrumentation). Keys are internal
         * names; they are not a stability contract beyond the common ones:
         * root, video, status, upload, videoContainer, progress.
         */
        ui
    };
}

export default createPlayer;
