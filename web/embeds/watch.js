// Pod Watch page (the "Watch" tab): starts a server-side watch of the
// selected namespace that auto-streams logs of newly created pods to files in
// the background, lists those streams with per-stream controls (tee to
// console, export/download, pause/resume, stop), and shows teed streams in a
// grid of console frames (up to a configurable count), each with a
// copy-to-clipboard button. Teeing an already-ended stream replays the last
// <console buffer> lines of its file. Background streams are server-owned:
// leaving this tab or reloading the page never interrupts capture; returning
// rebuilds the list from /api/watch/status. Tee frames are client-local:
// they survive tab switches but reset on reload. resources.js calls
// watchPageActivate()/watchPageDeactivate() from switchTab().
(function() {
    'use strict';

    // ===== Settings (gear popover; persisted in localStorage) =====
    var WATCH_BUF_KEY = 'kro_watch_buf_lines';
    var WATCH_BUF_MIN = 100, WATCH_BUF_MAX = 50000, WATCH_BUF_DEFAULT = 2000;

    // Max console (tee) frames open at once.
    var WATCH_FRAMES_KEY = 'kro_watch_max_frames';
    var WATCH_FRAMES_MIN = 1, WATCH_FRAMES_MAX = 12, WATCH_FRAMES_DEFAULT = 4;

    // Upper bound of the stream-count slider (the slider's own value is the
    // server-side cap, so it isn't stored here).
    var WATCH_SLIDER_MAX_KEY = 'kro_watch_slider_max';
    var WATCH_SLIDER_MAX_MIN = 5, WATCH_SLIDER_MAX_MAX = 100, WATCH_SLIDER_MAX_DEFAULT = 30;

    // Stream-list height set by the splitter, in px.
    var WATCH_SPLIT_KEY = 'kro_watch_split_px';

    function clampedSetting(key, min, max, def) {
        var v = parseInt(localStorage.getItem(key), 10);
        if (isNaN(v)) return def;
        return Math.max(min, Math.min(max, v));
    }

    function getWatchBufLines() {
        return clampedSetting(WATCH_BUF_KEY, WATCH_BUF_MIN, WATCH_BUF_MAX, WATCH_BUF_DEFAULT);
    }

    function setWatchBufLines(v) {
        v = Math.max(WATCH_BUF_MIN, Math.min(WATCH_BUF_MAX, parseInt(v, 10) || WATCH_BUF_DEFAULT));
        localStorage.setItem(WATCH_BUF_KEY, String(v));
        for (var key in frames) trimFrame(frames[key]);
        return v;
    }

    function getMaxFrames() {
        return clampedSetting(WATCH_FRAMES_KEY, WATCH_FRAMES_MIN, WATCH_FRAMES_MAX, WATCH_FRAMES_DEFAULT);
    }

    function setMaxFrames(v) {
        v = Math.max(WATCH_FRAMES_MIN, Math.min(WATCH_FRAMES_MAX, parseInt(v, 10) || WATCH_FRAMES_DEFAULT));
        localStorage.setItem(WATCH_FRAMES_KEY, String(v));
        return v;
    }

    function getSliderMax() {
        return clampedSetting(WATCH_SLIDER_MAX_KEY, WATCH_SLIDER_MAX_MIN, WATCH_SLIDER_MAX_MAX, WATCH_SLIDER_MAX_DEFAULT);
    }

    function setSliderMax(v) {
        v = Math.max(WATCH_SLIDER_MAX_MIN, Math.min(WATCH_SLIDER_MAX_MAX, parseInt(v, 10) || WATCH_SLIDER_MAX_DEFAULT));
        localStorage.setItem(WATCH_SLIDER_MAX_KEY, String(v));
        return v;
    }

    // ===== State =====
    var pageBuilt = false;    // page markup is built once, on first activation
    var statusSSE = null;     // EventSource /sse/watch (open only while the tab is)
    var lastStatus = null;    // last /api/watch/status payload
    var frames = {};          // frameKey -> {key, ctx, ns, pod, el, body, status, es, buf, scheduled}
    var noticeTimer = null;

    // Copy-to-clipboard icon: two overlapping rectangles.
    var COPY_SVG =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
        ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/>' +
        '<path d="M10.5 2.5h-7a1 1 0 0 0-1 1v7"/></svg>';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function frameKey(ctx, ns, pod) { return ctx + '\u0000' + ns + '\u0000' + pod; }

    function agoText(iso) {
        if (!iso) return '';
        var ms = Date.now() - new Date(iso).getTime();
        if (isNaN(ms) || ms < 0) return '';
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        return Math.floor(s / 3600) + 'h ago';
    }

    function currentSelection() {
        var ctxSel = document.getElementById('ctx-select');
        var nsSel = document.getElementById('ns-select');
        return {
            context: ctxSel ? ctxSel.value : '',
            namespace: nsSel ? nsSel.value : ''
        };
    }

    // ===== Page shell =====
    function buildWatchPage() {
        var page = document.getElementById('watch-page');
        if (!page) return;
        page.innerHTML =
                '<div class="watch-page-head">' +
                    '<span class="watch-page-title">Pod Watch</span>' +
                    '<span class="watch-title-sub" id="watch-title-sub"></span>' +
                    '<span class="watch-sse-dot" id="watch-sse-dot" title="Status event stream"></span>' +
                    '<span style="flex:1"></span>' +
                    '<button type="button" class="watch-gear" id="watch-fs" title="Toggle full screen">⛶</button>' +
                    '<button type="button" class="watch-gear" id="watch-gear" title="Watch settings">⚙</button>' +
                '</div>' +
                '<div class="watch-settings-pop" id="watch-settings">' +
                    '<label for="watch-buf-input">Console buffer (lines per frame)</label>' +
                    '<input type="number" id="watch-buf-input" min="' + WATCH_BUF_MIN + '" max="' + WATCH_BUF_MAX + '" step="100">' +
                    '<div class="watch-settings-hint">' + WATCH_BUF_MIN + '–' + WATCH_BUF_MAX +
                        '. Oldest lines are dropped from the frame; the full log is always in the file.</div>' +
                    '<label for="watch-frames-input" style="margin-top:10px">Max console frames</label>' +
                    '<input type="number" id="watch-frames-input" min="' + WATCH_FRAMES_MIN + '" max="' + WATCH_FRAMES_MAX + '" step="1">' +
                    '<div class="watch-settings-hint">' + WATCH_FRAMES_MIN + '–' + WATCH_FRAMES_MAX +
                        ' teed streams shown at once below the list.</div>' +
                    '<label for="watch-slider-max" style="margin-top:10px">Stream slider maximum</label>' +
                    '<input type="number" id="watch-slider-max" min="' + WATCH_SLIDER_MAX_MIN + '" max="' + WATCH_SLIDER_MAX_MAX + '" step="1">' +
                    '<div class="watch-settings-hint">' + WATCH_SLIDER_MAX_MIN + '–' + WATCH_SLIDER_MAX_MAX +
                        '. Upper bound of the max-streams slider.</div>' +
                    '<div class="watch-settings-sep"></div>' +
                    '<div class="watch-log-usage" id="watch-log-usage">log folder: …</div>' +
                    '<label for="watch-clean-days">Delete log files older than (days)</label>' +
                    '<div class="watch-clean-row">' +
                        '<input type="number" id="watch-clean-days" min="0" max="3650" step="1">' +
                        '<button type="button" class="watch-btn" id="watch-clean-btn">Clean up</button>' +
                    '</div>' +
                    '<div class="watch-settings-hint" id="watch-clean-hint">' +
                        '0 = all. Files of streams still listed above are always kept.</div>' +
                '</div>' +
                '<div class="watch-controls">' +
                    '<button type="button" class="watch-btn primary" id="watch-start">▶ Start Watch</button>' +
                    '<button type="button" class="watch-btn" id="watch-clear" title="Remove ended streams from the list (log files are kept)">✕ Clear Streams</button>' +
                    '<span class="watch-slider-wrap" title="Max concurrent streams">' +
                        '<input type="range" class="watch-slider" id="watch-max-slider" min="1" max="' + getSliderMax() + '" step="1">' +
                        '<span class="watch-slider-val" id="watch-max-val"></span>' +
                    '</span>' +
                    '<span class="watch-count" id="watch-count"></span>' +
                    '<span class="watch-notice" id="watch-notice"></span>' +
                '</div>' +
                '<div class="watch-stream-list" id="watch-stream-list"></div>' +
                '<div class="watch-splitter" id="watch-splitter" title="Drag to resize the stream list"></div>' +
                '<div class="watch-lower" id="watch-lower">' +
                    '<div class="watch-lower-head">' +
                        '<button type="button" class="watch-gear" id="watch-logs-fs" title="Toggle logs full screen">⛶</button>' +
                    '</div>' +
                    '<div class="watch-frames empty" id="watch-frames"></div>' +
                    '<div class="watch-frames-placeholder" id="watch-frames-ph"></div>' +
                '</div>';
        pageBuilt = true;

        document.getElementById('watch-start').addEventListener('click', watchStart);
        document.getElementById('watch-clear').addEventListener('click', clearStreams);
        document.getElementById('watch-gear').addEventListener('click', toggleSettings);
        document.getElementById('watch-stream-list').addEventListener('click', onListClick);
        document.getElementById('watch-clean-btn').addEventListener('click', cleanupLogs);

        var bufInput = document.getElementById('watch-buf-input');
        bufInput.addEventListener('change', function() {
            bufInput.value = setWatchBufLines(bufInput.value);
        });

        var framesInput = document.getElementById('watch-frames-input');
        framesInput.addEventListener('change', function() {
            framesInput.value = setMaxFrames(framesInput.value);
            renderFramesVisibility();
        });

        var slider = document.getElementById('watch-max-slider');
        slider.addEventListener('input', function() {
            document.getElementById('watch-max-val').textContent = slider.value;
        });
        slider.addEventListener('change', function() {
            postJSON('/api/watch/maxstreams', { max: parseInt(slider.value, 10) })
                .then(fetchWatchStatus)
                .catch(function(err) { showNotice(err.message); });
        });

        var sliderMaxInput = document.getElementById('watch-slider-max');
        sliderMaxInput.addEventListener('change', function() {
            var v = setSliderMax(sliderMaxInput.value);
            sliderMaxInput.value = v;
            slider.max = v;
            // The range input clamps its own value; push a lowered cap to the server.
            if (lastStatus && lastStatus.maxStreams > v) {
                postJSON('/api/watch/maxstreams', { max: v })
                    .then(fetchWatchStatus)
                    .catch(function(err) { showNotice(err.message); });
            }
        });

        document.getElementById('watch-fs').addEventListener('click', function() {
            page.classList.toggle('fullscreen');
        });
        document.getElementById('watch-logs-fs').addEventListener('click', function() {
            document.getElementById('watch-lower').classList.toggle('fullscreen');
        });
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape') return;
            var lower = document.getElementById('watch-lower');
            if (lower && lower.classList.contains('fullscreen')) {
                lower.classList.remove('fullscreen');
            } else if (page.classList.contains('fullscreen')) {
                page.classList.remove('fullscreen');
            }
        });

        initSplitter();
        renderFramesVisibility();
    }

    // Splitter between the stream list and the console frames: dragging sets
    // an explicit pixel height on the list (persisted across reloads),
    // replacing its default max-height cap.
    function initSplitter() {
        var sp = document.getElementById('watch-splitter');
        var list = document.getElementById('watch-stream-list');
        var page = document.getElementById('watch-page');

        function applySplit(px) {
            px = Math.max(48, Math.min(px, page.clientHeight - 220));
            list.style.height = px + 'px';
            list.style.maxHeight = 'none';
        }

        var saved = parseInt(localStorage.getItem(WATCH_SPLIT_KEY), 10);
        if (!isNaN(saved)) applySplit(saved);

        sp.addEventListener('mousedown', function(e) {
            e.preventDefault();
            var startY = e.clientY;
            var startH = list.getBoundingClientRect().height;
            function move(ev) { applySplit(startH + (ev.clientY - startY)); }
            function up() {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                document.body.classList.remove('watch-resizing');
                localStorage.setItem(WATCH_SPLIT_KEY,
                    String(Math.round(list.getBoundingClientRect().height)));
            }
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            document.body.classList.add('watch-resizing');
        });
    }

    // Called by switchTab() when the Watch tab becomes active. Builds the
    // page on first visit, then (re)connects the status stream.
    window.watchPageActivate = function() {
        if (!pageBuilt) buildWatchPage();
        if (!pageBuilt) return; // panel missing from the DOM
        var sel = currentSelection();
        document.getElementById('watch-title-sub').textContent =
            sel.context && sel.namespace ? sel.context + ' / ' + sel.namespace : '';
        document.getElementById('watch-buf-input').value = getWatchBufLines();
        document.getElementById('watch-frames-input').value = getMaxFrames();
        document.getElementById('watch-slider-max').value = getSliderMax();
        document.getElementById('watch-max-slider').max = getSliderMax();
        fetchWatchStatus();
        connectStatusSSE();
    };

    // Called by switchTab() when leaving the Watch tab. Only the status SSE
    // is dropped; tee frames keep their log streams so they're intact when
    // the user comes back. Background capture is server-owned regardless.
    window.watchPageDeactivate = function() {
        if (!pageBuilt) return;
        var pop = document.getElementById('watch-settings');
        if (pop) pop.classList.remove('active');
        disconnectStatusSSE();
    };

    function toggleSettings() {
        var pop = document.getElementById('watch-settings');
        pop.classList.toggle('active');
        if (pop.classList.contains('active')) fetchLogInfo();
    }

    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function renderLogInfo(info) {
        document.getElementById('watch-log-usage').innerHTML =
            '<span title="' + esc(info.dir) + '">log folder</span>: ' +
            info.files + ' file' + (info.files === 1 ? '' : 's') + ' · ' + fmtBytes(info.bytes) +
            (info.retentionDays > 0
                ? ' · auto-clean after ' + info.retentionDays + 'd'
                : ' · auto-clean off');
        var days = document.getElementById('watch-clean-days');
        if (days.value === '') days.value = info.retentionDays > 0 ? info.retentionDays : 7;
    }

    function fetchLogInfo() {
        fetch('/api/watch/loginfo')
            .then(function(r) { return r.json(); })
            .then(renderLogInfo)
            .catch(function(err) { showNotice('log info fetch failed: ' + err); });
    }

    function cleanupLogs() {
        var days = parseInt(document.getElementById('watch-clean-days').value, 10);
        if (isNaN(days) || days < 0) { showNotice('Enter a number of days (0 = all)'); return; }
        postJSON('/api/watch/cleanup', { days: days })
            .then(function(res) {
                showNotice('Cleanup: removed ' + res.removed + ' file' +
                    (res.removed === 1 ? '' : 's') + ' (' + fmtBytes(res.freedBytes) + ')');
                if (res.info) renderLogInfo(res.info);
            })
            .catch(function(err) { showNotice(err.message); });
    }

    function showNotice(msg) {
        var el = document.getElementById('watch-notice');
        el.textContent = msg;
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(function() { el.textContent = ''; }, 6000);
    }

    // ===== Status fetch/render =====
    function fetchWatchStatus() {
        fetch('/api/watch/status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                lastStatus = data;
                renderStatus();
            })
            .catch(function(err) { showNotice('status fetch failed: ' + err); });
    }

    function renderStatus() {
        if (!lastStatus) return;
        var sel = currentSelection();
        var sessions = lastStatus.sessions || [];

        document.getElementById('watch-count').textContent =
            lastStatus.activeStreams + ' / ' + lastStatus.maxStreams + ' streams';

        // Sync the max-streams slider to the server's cap unless the user is
        // mid-drag (the slider holds focus while being adjusted).
        var slider = document.getElementById('watch-max-slider');
        if (document.activeElement !== slider) {
            slider.value = lastStatus.maxStreams;
            document.getElementById('watch-max-val').textContent = slider.value;
        }

        // Start button: disabled when the current selection is already watched.
        var startBtn = document.getElementById('watch-start');
        var watchingCurrent = sessions.some(function(s) {
            return s.context === sel.context && s.namespace === sel.namespace;
        });
        startBtn.disabled = watchingCurrent;
        startBtn.title = watchingCurrent ? 'Already watching ' + sel.context + ' / ' + sel.namespace : '';

        var list = document.getElementById('watch-stream-list');
        if (!sessions.length) {
            list.innerHTML = '<div class="watch-empty">No active watch. ' +
                'Start one to auto-capture logs of every pod created in the selected namespace.</div>';
            reconcileFrames();
            return;
        }

        var html = '';
        sessions.forEach(function(s) {
            html += '<div class="watch-session-head">' +
                '<span>' + esc(s.context) + ' / ' + esc(s.namespace) + '</span>' +
                '<button type="button" class="watch-btn danger" data-act="stop-session" data-ctx="' +
                    esc(s.context) + '" data-ns="' + esc(s.namespace) + '">■ Stop Watch</button>' +
            '</div>';
            if (!s.streams || !s.streams.length) {
                html += '<div class="watch-empty">Watching… no new pods yet. Existing pods are ignored by design.</div>';
                return;
            }
            s.streams.forEach(function(st) {
                var key = frameKey(s.context, s.namespace, st.pod);
                var teed = !!frames[key];
                var active = st.state === 'starting' || st.state === 'running' || st.state === 'paused';
                var dataAttrs = ' data-ctx="' + esc(s.context) + '" data-ns="' + esc(s.namespace) +
                    '" data-pod="' + esc(st.pod) + '"';
                var actions = '<button type="button" class="watch-btn' + (teed ? ' tee-on' : '') +
                    '" data-act="tee"' + dataAttrs + ' title="Toggle console frame">⧉ Console</button>';
                if (st.file) {
                    actions += '<button type="button" class="watch-btn" data-act="export"' + dataAttrs +
                        ' title="Export: download the log file">⤓</button>';
                }
                if (st.state === 'paused') {
                    actions += '<button type="button" class="watch-btn" data-act="resume"' + dataAttrs + ' title="Resume capture">▶</button>';
                } else if (st.state === 'running' || st.state === 'starting') {
                    actions += '<button type="button" class="watch-btn" data-act="pause"' + dataAttrs + ' title="Pause capture (file stays open)">⏸</button>';
                }
                if (active) {
                    actions += '<button type="button" class="watch-btn danger" data-act="stop"' + dataAttrs + ' title="Stop capture and close the file">■</button>';
                } else {
                    actions += '<button type="button" class="watch-btn" data-act="remove"' + dataAttrs + ' title="Remove from list (file is kept)">✕</button>';
                }
                html += '<div class="watch-row">' +
                    '<span class="watch-badge ' + esc(st.state) + '"' +
                        (st.error ? ' title="' + esc(st.error) + '"' : '') + '>' + esc(st.state) + '</span>' +
                    '<span class="pod" title="' + esc(st.file) + '">' + esc(st.pod) + '</span>' +
                    '<span class="meta" data-count-for="' + esc(key) + '">' + st.lines + ' lines' +
                        (st.lastActivity ? ' · ' + agoText(st.lastActivity) : '') + '</span>' +
                    '<span class="actions">' + actions + '</span>' +
                '</div>';
            });
        });
        list.innerHTML = html;
        reconcileFrames();
    }

    // Close frames whose stream no longer exists (e.g. removed from the list).
    function reconcileFrames() {
        if (!lastStatus) return;
        var known = {};
        (lastStatus.sessions || []).forEach(function(s) {
            (s.streams || []).forEach(function(st) {
                known[frameKey(s.context, s.namespace, st.pod)] = true;
            });
        });
        for (var key in frames) {
            if (!known[key]) {
                removeFrame(frames[key], true);
                delete frames[key];
            }
        }
        renderFramesVisibility();
    }

    function onListClick(e) {
        var btn = e.target.closest('button[data-act]');
        if (!btn) return;
        var act = btn.dataset.act, ctx = btn.dataset.ctx, ns = btn.dataset.ns, pod = btn.dataset.pod;
        if (act === 'stop-session') {
            watchStopSession(ctx, ns);
        } else if (act === 'tee') {
            toggleTee(ctx, ns, pod);
        } else if (act === 'export') {
            exportLog(ctx, ns, pod);
        } else {
            streamAction(ctx, ns, pod, act);
        }
    }

    // ===== Actions =====
    function postJSON(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(function(r) {
            if (!r.ok) {
                return r.json().then(function(j) {
                    throw new Error(j.error || ('HTTP ' + r.status));
                }, function() { throw new Error('HTTP ' + r.status); });
            }
            return r.json();
        });
    }

    function watchStart() {
        postJSON('/api/watch/start')
            .then(fetchWatchStatus)
            .catch(function(err) { showNotice(err.message); });
    }

    function clearStreams() {
        postJSON('/api/watch/clear')
            .then(function(res) {
                showNotice(res.removed
                    ? 'Removed ' + res.removed + ' ended stream' + (res.removed === 1 ? '' : 's')
                    : 'No ended streams to remove (active streams stay until stopped)');
                fetchWatchStatus();
            })
            .catch(function(err) { showNotice(err.message); });
    }

    function watchStopSession(ctx, ns) {
        postJSON('/api/watch/stop', { context: ctx, namespace: ns })
            .then(fetchWatchStatus)
            .catch(function(err) { showNotice(err.message); });
    }

    function streamAction(ctx, ns, pod, action) {
        postJSON('/api/watch/stream', { context: ctx, namespace: ns, pod: pod, action: action })
            .then(fetchWatchStatus)
            .catch(function(err) { showNotice(err.message); });
    }

    // The server sets Content-Disposition: attachment, so a plain navigation
    // becomes a save — the browser picks the location (Downloads / dialog).
    function exportLog(ctx, ns, pod) {
        var a = document.createElement('a');
        a.href = '/api/watch/export?context=' + encodeURIComponent(ctx) +
            '&namespace=' + encodeURIComponent(ns) + '&pod=' + encodeURIComponent(pod);
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ===== Status SSE (list updates while the modal is open) =====
    function connectStatusSSE() {
        if (statusSSE) return;
        var dot = document.getElementById('watch-sse-dot');
        statusSSE = new EventSource('/sse/watch');
        statusSSE.onopen = function() { dot.classList.add('connected'); };
        statusSSE.onerror = function() { dot.classList.remove('connected'); };
        statusSSE.addEventListener('watch', function(e) {
            dot.classList.add('connected');
            var msg;
            try { msg = JSON.parse(e.data); } catch (_) { return; }
            if (msg.event === 'stream_counts') {
                patchCounts(msg.payload);
            } else if (msg.event === 'limit_reached') {
                showNotice('Stream limit (' + msg.payload.max + ') reached — skipped pod ' + msg.payload.pod);
            } else {
                // session_started/stopped, stream_added/state/removed:
                // a full refetch is cheap and keeps render logic in one place.
                fetchWatchStatus();
            }
        });
    }

    function disconnectStatusSSE() {
        if (statusSSE) { statusSSE.close(); statusSSE = null; }
        var dot = document.getElementById('watch-sse-dot');
        if (dot) dot.classList.remove('connected');
    }

    function patchCounts(payload) {
        if (!payload || !payload.streams) return;
        var list = document.getElementById('watch-stream-list');
        payload.streams.forEach(function(c) {
            var key = frameKey(payload.context, payload.namespace, c.pod);
            var els = list.querySelectorAll('.meta[data-count-for]');
            for (var i = 0; i < els.length; i++) {
                if (els[i].getAttribute('data-count-for') === key) {
                    els[i].textContent = c.lines + ' lines' +
                        (c.lastActivity ? ' · ' + agoText(c.lastActivity) : '');
                    break;
                }
            }
        });
    }

    // ===== Tee frames =====
    function toggleTee(ctx, ns, pod) {
        var key = frameKey(ctx, ns, pod);
        if (frames[key]) {
            removeFrame(frames[key], true);
            delete frames[key];
            renderFramesVisibility();
            renderStatus(); // un-highlight the tee button
            return;
        }
        if (Object.keys(frames).length >= getMaxFrames()) {
            showNotice('Max ' + getMaxFrames() + ' console frames — close one first or raise the limit in settings');
            return;
        }
        openFrame(ctx, ns, pod, key);
        renderStatus(); // highlight the tee button
    }

    function openFrame(ctx, ns, pod, key) {
        var el = document.createElement('div');
        el.className = 'watch-frame';
        el.innerHTML =
            '<div class="watch-frame-head">' +
                '<span class="pod">' + esc(pod) + '</span>' +
                '<span class="watch-frame-status">connecting…</span>' +
                '<span class="log-lvl-btns"></span>' +
                '<button type="button" class="watch-frame-copy" title="Copy buffer to clipboard">' + COPY_SVG + '</button>' +
                '<button type="button" class="watch-frame-close" title="Close frame (capture continues)">×</button>' +
            '</div>' +
            '<pre class="watch-frame-body"></pre>';
        document.getElementById('watch-frames').appendChild(el);

        var frame = {
            key: key, ctx: ctx, ns: ns, pod: pod,
            el: el,
            body: el.querySelector('.watch-frame-body'),
            status: el.querySelector('.watch-frame-status'),
            es: null,
            buf: [],
            scheduled: false,
            lastLvl: null // level inherited by unleveled lines (stack traces etc.)
        };

        // Per-frame level filter buttons (helpers live in resources.js).
        // Seeded from the persisted hidden set; toggles affect this frame only.
        var LF = window.kroLogFilter;
        if (LF) {
            var lvlBtns = el.querySelector('.log-lvl-btns');
            var hiddenLvls = LF.getHidden();
            lvlBtns.innerHTML = LF.buttonsHTML(hiddenLvls);
            LF.apply(frame.body, hiddenLvls);
            LF.wire(lvlBtns, frame.body);
        }
        el.querySelector('.watch-frame-close').addEventListener('click', function() {
            removeFrame(frame, true);
            delete frames[key];
            renderFramesVisibility();
            renderStatus();
        });
        el.querySelector('.watch-frame-copy').addEventListener('click', function() {
            copyFrame(frame, this);
        });

        // tail: for an already-ended stream the server replays the last
        // <console buffer> lines from the log file instead of the ring.
        var url = '/sse/watch-logs?context=' + encodeURIComponent(ctx) +
            '&namespace=' + encodeURIComponent(ns) + '&pod=' + encodeURIComponent(pod) +
            '&tail=' + getWatchBufLines();
        frame.es = new EventSource(url);
        frame.es.onopen = function() { frame.status.textContent = 'live'; };
        frame.es.onerror = function() { frame.status.textContent = 'reconnecting…'; };
        frame.es.addEventListener('log', function(e) {
            frame.status.textContent = 'live';
            frameAppend(frame, e.data, false);
        });
        frame.es.addEventListener('end', function() {
            frameAppend(frame, '— stream ended —', true);
            frame.status.textContent = 'ended';
            frame.es.close();
            frame.es = null;
        });

        frames[key] = frame;
        renderFramesVisibility();
    }

    // Copy the frame's visible buffer to the clipboard; swap the icon for a
    // brief ✓ / ✗ as feedback. execCommand is the fallback for contexts
    // where the async clipboard API is unavailable.
    function copyFrame(frame, btn) {
        var text = frame.body.textContent || '';
        function done(ok) {
            btn.innerHTML = ok ? '✓' : '✗';
            btn.classList.add(ok ? 'copied' : 'copy-failed');
            setTimeout(function() {
                btn.innerHTML = COPY_SVG;
                btn.classList.remove('copied', 'copy-failed');
            }, 1200);
        }
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (_) {}
            document.body.removeChild(ta);
            return ok;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function() { done(true); },
                function() { done(fallback()); });
        } else {
            done(fallback());
        }
    }

    function removeFrame(frame, detach) {
        if (frame.es) { frame.es.close(); frame.es = null; }
        frame.buf = [];
        if (detach && frame.el.parentNode) frame.el.parentNode.removeChild(frame.el);
    }

    function renderFramesVisibility() {
        var framesEl = document.getElementById('watch-frames');
        var ph = document.getElementById('watch-frames-ph');
        if (!framesEl) return;
        var n = Object.keys(frames).length;
        framesEl.classList.toggle('empty', n === 0);
        // Grid layout: 1 frame full-width, 2-4 in two columns, 5+ in three;
        // when the last row would hold a single frame it spans the full width.
        var cols = n <= 1 ? 1 : (n <= 4 ? 2 : 3);
        framesEl.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
        framesEl.classList.toggle('span-last', n > cols && n % cols === 1);
        ph.classList.toggle('hidden', n > 0);
        ph.textContent = 'Tee a stream to the console to view it here (up to ' +
            getMaxFrames() + ' frames)';
    }

    // rAF-batched append (same pattern as the log modal): lines accumulate in
    // frame.buf and flush once per animation frame, with at-bottom autoscroll
    // and trimming to the configured buffer size.
    function frameAppend(frame, line, isMarker) {
        frame.buf.push(isMarker ? '\u0000' + line : line);
        if (frame.scheduled) return;
        frame.scheduled = true;
        requestAnimationFrame(function() { flushFrame(frame); });
    }

    function flushFrame(frame) {
        frame.scheduled = false;
        if (!frame.buf.length) return;
        var buf = frame.buf;
        frame.buf = [];

        var body = frame.body;
        var atBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 30;

        var frag = document.createDocumentFragment();
        for (var i = 0; i < buf.length; i++) {
            var span = document.createElement('span');
            if (buf[i].charCodeAt(0) === 0) {
                span.className = 'watch-frame-end';
                span.textContent = buf[i].slice(1) + '\n';
            } else if (window.kroHighlight) {
                span.innerHTML = window.kroHighlight(buf[i]) + '\n';
                // Tag the line with its level bucket (detected as a free side
                // effect of colorizing) so the level filter is pure CSS.
                // Unleveled lines inherit the frame's last seen level, keeping
                // stack traces with the error that produced them.
                var lvl = window.kroHighlight.lastLevel || frame.lastLvl;
                if (lvl) { span.className = 'lvl-' + lvl; frame.lastLvl = lvl; }
            } else {
                span.textContent = buf[i] + '\n';
            }
            frag.appendChild(span);
        }
        body.appendChild(frag);
        trimFrame(frame);
        if (atBottom) body.scrollTop = body.scrollHeight;
    }

    function trimFrame(frame) {
        var spans = frame.body.children;
        var over = spans.length - getWatchBufLines();
        for (var i = 0; i < over; i++) frame.body.removeChild(frame.body.firstChild);
    }
})();
