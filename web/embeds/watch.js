// Pod Watch modal: starts a server-side watch of the selected namespace that
// auto-streams logs of newly created pods to files in the background, lists
// those streams with per-stream controls (tee to console, export/download,
// pause/resume, stop), and shows up to two teed streams in side-by-side
// console frames, each with a copy-to-clipboard button. Teeing an
// already-ended stream replays the last <console buffer> lines of its file.
// Background streams are server-owned: closing this modal or reloading the
// page never interrupts capture; reopening rebuilds the list from
// /api/watch/status. Tee frames are client-local and reset on reload.
(function() {
    'use strict';

    var MAX_TEE_FRAMES = 2;

    // ===== Console frame buffer setting (gear popover) =====
    var WATCH_BUF_KEY = 'kro_watch_buf_lines';
    var WATCH_BUF_MIN = 100, WATCH_BUF_MAX = 50000, WATCH_BUF_DEFAULT = 2000;

    function getWatchBufLines() {
        var v = parseInt(localStorage.getItem(WATCH_BUF_KEY), 10);
        if (isNaN(v)) return WATCH_BUF_DEFAULT;
        return Math.max(WATCH_BUF_MIN, Math.min(WATCH_BUF_MAX, v));
    }

    function setWatchBufLines(v) {
        v = Math.max(WATCH_BUF_MIN, Math.min(WATCH_BUF_MAX, parseInt(v, 10) || WATCH_BUF_DEFAULT));
        localStorage.setItem(WATCH_BUF_KEY, String(v));
        for (var key in frames) trimFrame(frames[key]);
        return v;
    }

    // ===== State =====
    var overlay = null;       // modal overlay element (built once)
    var statusSSE = null;     // EventSource /sse/watch (open only while modal is)
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

    // ===== Modal shell =====
    function buildModal() {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'watch-overlay';
        overlay.innerHTML =
            '<div class="modal-dialog wide watch-dialog">' +
                '<div class="modal-header" id="watch-drag-handle">' +
                    '<span class="modal-title">Pod Watch</span>' +
                    '<span class="watch-title-sub" id="watch-title-sub"></span>' +
                    '<span class="watch-sse-dot" id="watch-sse-dot" title="Status event stream"></span>' +
                    '<span style="flex:1"></span>' +
                    '<button type="button" class="watch-gear" id="watch-gear" title="Watch settings">⚙</button>' +
                    '<button type="button" class="modal-close" id="watch-close" title="Close (background streams keep running)">×</button>' +
                '</div>' +
                '<div class="watch-settings-pop" id="watch-settings">' +
                    '<label for="watch-buf-input">Console buffer (lines per frame)</label>' +
                    '<input type="number" id="watch-buf-input" min="' + WATCH_BUF_MIN + '" max="' + WATCH_BUF_MAX + '" step="100">' +
                    '<div class="watch-settings-hint">' + WATCH_BUF_MIN + '–' + WATCH_BUF_MAX +
                        '. Oldest lines are dropped from the frame; the full log is always in the file.</div>' +
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
                    '<span class="watch-count" id="watch-count"></span>' +
                    '<span class="watch-notice" id="watch-notice"></span>' +
                '</div>' +
                '<div class="watch-stream-list" id="watch-stream-list"></div>' +
                '<div class="watch-frames empty" id="watch-frames"></div>' +
                '<div class="watch-frames-placeholder" id="watch-frames-ph">' +
                    'Tee a stream to the console to view it here (up to ' + MAX_TEE_FRAMES + ' frames)' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        document.getElementById('watch-close').addEventListener('click', closeWatchModal);
        document.getElementById('watch-start').addEventListener('click', watchStart);
        document.getElementById('watch-gear').addEventListener('click', toggleSettings);
        document.getElementById('watch-stream-list').addEventListener('click', onListClick);
        document.getElementById('watch-clean-btn').addEventListener('click', cleanupLogs);

        var bufInput = document.getElementById('watch-buf-input');
        bufInput.addEventListener('change', function() {
            bufInput.value = setWatchBufLines(bufInput.value);
        });

        overlay.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeWatchModal();
        });

        attachDrag();
    }

    // Minimal drag: shift the dialog via transform, anchored to the header.
    function attachDrag() {
        var handle = document.getElementById('watch-drag-handle');
        var dialog = overlay.querySelector('.watch-dialog');
        var startX = 0, startY = 0, baseX = 0, baseY = 0;

        function onMove(e) {
            var dx = e.clientX - startX, dy = e.clientY - startY;
            dialog.style.transform = 'translate(' + (baseX + dx) + 'px,' + (baseY + dy) + 'px)';
        }
        function onUp() {
            handle.classList.remove('dragging');
            var m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(dialog.style.transform || '');
            if (m) { baseX = parseFloat(m[1]); baseY = parseFloat(m[2]); }
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        handle.addEventListener('mousedown', function(e) {
            if (e.target.closest('button')) return;
            e.preventDefault();
            startX = e.clientX; startY = e.clientY;
            handle.classList.add('dragging');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    window.openWatchModal = function() {
        if (!overlay) buildModal();
        var sel = currentSelection();
        document.getElementById('watch-title-sub').textContent =
            sel.context && sel.namespace ? sel.context + ' / ' + sel.namespace : '';
        document.getElementById('watch-buf-input').value = getWatchBufLines();
        overlay.classList.add('active');
        fetchWatchStatus();
        connectStatusSSE();
    };

    function closeWatchModal() {
        if (!overlay) return;
        overlay.classList.remove('active');
        document.getElementById('watch-settings').classList.remove('active');
        disconnectStatusSSE();
        // Tee frames are foreground-only; background capture continues.
        for (var key in frames) removeFrame(frames[key], true);
        frames = {};
        renderFramesVisibility();
    }

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
        if (Object.keys(frames).length >= MAX_TEE_FRAMES) {
            showNotice('Max ' + MAX_TEE_FRAMES + ' console frames — close one first');
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
            scheduled: false
        };
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
        var any = Object.keys(frames).length > 0;
        framesEl.classList.toggle('empty', !any);
        ph.classList.toggle('hidden', any);
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
