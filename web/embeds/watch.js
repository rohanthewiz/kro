// Pod Watch page (the "Watch" tab): starts a server-side watch of the
// selected namespace that auto-streams logs of newly created pods to files in
// the background, lists those streams with per-stream controls (tee to
// console, export/download, pause/resume, stop), and shows teed streams in a
// grid of console frames (up to a configurable count), each with in-log
// search and a copy-to-clipboard button. Teeing an already-ended stream replays the last
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

    // Upper bound of the max-streams stepper (the stepper's own value is the
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
    var maxPostTimer = null;  // debounce for max-streams stepper posts

    // Max-streams stepper: arrows step the shown value immediately; the
    // server post is debounced so a burst of clicks lands as one update.
    function bumpMaxStreams(delta) {
        var valEl = document.getElementById('watch-max-val');
        var v = Math.max(1, Math.min(getSliderMax(),
            (parseInt(valEl.textContent, 10) || 1) + delta));
        valEl.textContent = v;
        if (maxPostTimer) clearTimeout(maxPostTimer);
        maxPostTimer = setTimeout(function() {
            maxPostTimer = null;
            postJSON('/api/watch/maxstreams', { max: v })
                .then(fetchWatchStatus)
                .catch(function(err) { showNotice(err.message); });
        }, 350);
    }

    // Copy-to-clipboard icon: two overlapping rectangles.
    var COPY_SVG =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
        ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/>' +
        '<path d="M10.5 2.5h-7a1 1 0 0 0-1 1v7"/></svg>';

    // Magnifier icon for the per-frame log search toggle.
    var SEARCH_SVG =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
        ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="7" cy="7" r="5"/>' +
        '<line x1="11" y1="11" x2="14.5" y2="14.5"/></svg>';

    // Do-not-disturb icon (prohibition/no-entry sign: a diagonal slash through
    // a circle) for the per-session "no more streams" toggle. The diagonal —
    // not a horizontal bar — is what reads as "blocked" rather than "minus".
    var DND_SVG =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
        ' stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
        '<circle cx="8" cy="8" r="6.25"/>' +
        '<line x1="3.6" y1="3.6" x2="12.4" y2="12.4"/></svg>';

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

    // The global context/namespace dropdowns (shared with the Resources view).
    function currentSelection() {
        var ctxSel = document.getElementById('ctx-select');
        var nsSel = document.getElementById('ns-select');
        return {
            context: ctxSel ? ctxSel.value : '',
            namespace: nsSel ? nsSel.value : ''
        };
    }

    // The namespace the Start/Stop buttons act on: the current context plus
    // the watch page's own namespace picker, so a watch can be started for any
    // namespace without disturbing the global selection.
    function watchTarget() {
        var ctxSel = document.getElementById('ctx-select');
        var nsSel = document.getElementById('watch-ns-select');
        return {
            context: ctxSel ? ctxSel.value : '',
            namespace: nsSel ? nsSel.value : ''
        };
    }

    // Populate the watch namespace picker from the pinned namespaces of the
    // current context. Keeps the current pick if it still exists, else falls
    // back to the global namespace, else the first entry.
    function loadWatchNamespaces() {
        var sel = document.getElementById('watch-ns-select');
        if (!sel) return Promise.resolve();
        return fetch('/api/namespaces')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                var list = data.namespaces || [];
                var prev = sel.value;
                sel.innerHTML = '';
                list.forEach(function(n) {
                    var opt = document.createElement('option');
                    opt.value = n;
                    opt.textContent = n;
                    sel.appendChild(opt);
                });
                if (!list.length) {
                    var opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = '— no namespaces —';
                    opt.disabled = true;
                    sel.appendChild(opt);
                    sel.value = '';
                } else {
                    var want = (prev && list.indexOf(prev) >= 0) ? prev
                        : (data.current && list.indexOf(data.current) >= 0) ? data.current
                        : list[0];
                    sel.value = want;
                }
                renderStatus();
            })
            .catch(function() {});
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
                    '<button type="button" class="watch-settings-close" id="watch-settings-close" title="Close">×</button>' +
                    '<label for="watch-buf-input">Console buffer (lines per frame)</label>' +
                    '<input type="number" id="watch-buf-input" min="' + WATCH_BUF_MIN + '" max="' + WATCH_BUF_MAX + '" step="100">' +
                    '<div class="watch-settings-hint">' + WATCH_BUF_MIN + '–' + WATCH_BUF_MAX +
                        '. Oldest lines are dropped from the frame; the full log is always in the file.</div>' +
                    '<label for="watch-frames-input" style="margin-top:10px">Max console frames</label>' +
                    '<input type="number" id="watch-frames-input" min="' + WATCH_FRAMES_MIN + '" max="' + WATCH_FRAMES_MAX + '" step="1">' +
                    '<div class="watch-settings-hint">' + WATCH_FRAMES_MIN + '–' + WATCH_FRAMES_MAX +
                        ' teed streams shown at once below the list.</div>' +
                    '<label for="watch-slider-max" style="margin-top:10px">Max streams upper limit</label>' +
                    '<input type="number" id="watch-slider-max" min="' + WATCH_SLIDER_MAX_MIN + '" max="' + WATCH_SLIDER_MAX_MAX + '" step="1">' +
                    '<div class="watch-settings-hint">' + WATCH_SLIDER_MAX_MIN + '–' + WATCH_SLIDER_MAX_MAX +
                        '. Upper bound of the max-streams stepper.</div>' +
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
                    '<select class="watch-ns-select" id="watch-ns-select" title="Namespace to watch (independent of the current selection)"></select>' +
                    '<button type="button" class="watch-btn primary" id="watch-start">▶ Start Watch</button>' +
                    '<button type="button" class="watch-btn stop" id="watch-stop" disabled>■ Stop Watch</button>' +
                    '<span class="watch-notice" id="watch-notice"></span>' +
                    '<span class="watch-count" id="watch-count"></span>' +
                    '<span class="watch-stepper" title="Max concurrent streams">' +
                        '<span class="watch-stepper-val" id="watch-max-val"></span>' +
                        '<span class="watch-stepper-btns">' +
                            '<button type="button" id="watch-max-up" title="Raise max concurrent streams">▲</button>' +
                            '<button type="button" id="watch-max-down" title="Lower max concurrent streams">▼</button>' +
                        '</span>' +
                    '</span>' +
                    '<button type="button" class="watch-btn" id="watch-clear" title="Remove ended streams from the list (log files are kept)">✕ Clear Streams</button>' +
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
        document.getElementById('watch-stop').addEventListener('click', function() {
            var t = watchTarget();
            watchStopSession(t.context, t.namespace);
        });
        // Changing the picked namespace re-syncs the Start/Stop enable state.
        document.getElementById('watch-ns-select').addEventListener('change', renderStatus);
        document.getElementById('watch-clear').addEventListener('click', clearStreams);
        document.getElementById('watch-gear').addEventListener('click', toggleSettings);
        document.getElementById('watch-settings-close').addEventListener('click', function() {
            document.getElementById('watch-settings').classList.remove('active');
        });
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

        document.getElementById('watch-max-up').addEventListener('click', function() {
            bumpMaxStreams(1);
        });
        document.getElementById('watch-max-down').addEventListener('click', function() {
            bumpMaxStreams(-1);
        });

        var sliderMaxInput = document.getElementById('watch-slider-max');
        sliderMaxInput.addEventListener('change', function() {
            var v = setSliderMax(sliderMaxInput.value);
            sliderMaxInput.value = v;
            // Clamp the stepper display and push a lowered cap to the server.
            var valEl = document.getElementById('watch-max-val');
            if ((parseInt(valEl.textContent, 10) || 1) > v) valEl.textContent = v;
            if (lastStatus && lastStatus.maxStreams > v) {
                postJSON('/api/watch/maxstreams', { max: v })
                    .then(fetchWatchStatus)
                    .catch(function(err) { showNotice(err.message); });
            }
        });

        document.getElementById('watch-fs').addEventListener('click', function() {
            page.classList.toggle('fullscreen');
            sizeWatchPage();
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
                sizeWatchPage();
            }
        });

        initSplitter();
        renderFramesVisibility();
        window.addEventListener('resize', sizeWatchPage);
    }

    // Size the pane to fill the viewport below its on-page position. The
    // stylesheet's calc(100vh - 250px) is only a pre-JS fallback; the chrome
    // above the pane (header, summary bar) varies, so measure it instead.
    function sizeWatchPage() {
        var page = document.getElementById('watch-page');
        if (!page || !pageBuilt) return;
        // Fullscreen mode owns the height; an inline height would override it.
        if (page.classList.contains('fullscreen')) {
            page.style.height = '';
            return;
        }
        if (!page.offsetParent) return; // watch tab hidden
        var top = page.getBoundingClientRect().top + window.scrollY;
        // 20px matches the body's bottom padding.
        page.style.height = Math.max(420, window.innerHeight - top - 20) + 'px';
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
        sizeWatchPage();
        var sel = currentSelection();
        document.getElementById('watch-title-sub').textContent =
            sel.context && sel.namespace ? sel.context + ' / ' + sel.namespace : '';
        document.getElementById('watch-buf-input').value = getWatchBufLines();
        document.getElementById('watch-frames-input').value = getMaxFrames();
        document.getElementById('watch-slider-max').value = getSliderMax();
        // Refresh the namespace picker: the context may have changed while the
        // Watch tab was hidden.
        loadWatchNamespaces();
        fetchWatchStatus();
        connectStatusSSE();
    };

    // Called by resources.js (from loadNamespaces) whenever the global context
    // or its pinned-namespace list changes, so the Watch picker and title stay
    // in sync even while the Watch tab is already visible — no tab round-trip
    // needed. No-op until the page has been built.
    window.watchPageSelectionChanged = function() {
        if (!pageBuilt) return;
        var sel = currentSelection();
        var sub = document.getElementById('watch-title-sub');
        if (sub) sub.textContent =
            sel.context && sel.namespace ? sel.context + ' / ' + sel.namespace : '';
        loadWatchNamespaces();
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
        var sel = watchTarget();
        var sessions = lastStatus.sessions || [];

        document.getElementById('watch-count').textContent =
            lastStatus.activeStreams + ' / ' + lastStatus.maxStreams + ' streams';

        // Sync the max-streams stepper to the server's cap unless a local
        // change is still waiting on its debounced post.
        if (!maxPostTimer) {
            document.getElementById('watch-max-val').textContent = lastStatus.maxStreams;
        }

        // Start button: disabled when the current selection is already watched.
        var startBtn = document.getElementById('watch-start');
        var watchingCurrent = sessions.some(function(s) {
            return s.context === sel.context && s.namespace === sel.namespace;
        });
        startBtn.disabled = watchingCurrent;
        startBtn.textContent = watchingCurrent ? '▶ Watching…' : '▶ Start Watch';
        startBtn.title = watchingCurrent ? 'Already watching ' + sel.context + ' / ' + sel.namespace : '';

        // Stop button acts on the session for the current ctx/ns selection.
        var stopBtn = document.getElementById('watch-stop');
        stopBtn.disabled = !watchingCurrent;
        stopBtn.title = watchingCurrent
            ? 'Stop watching ' + sel.context + ' / ' + sel.namespace
            : 'Not watching the selected namespace';

        var list = document.getElementById('watch-stream-list');
        if (!sessions.length) {
            list.innerHTML = '<div class="watch-empty">No active watch. ' +
                'Start one to auto-capture logs of every pod created in the selected namespace.</div>';
            reconcileFrames();
            return;
        }

        // One block per session so namespaces stay visually isolated; each
        // block carries its own Stop/Clear so a session can be torn down even
        // when it isn't the current dropdown selection.
        var html = '';
        sessions.forEach(function(s) {
            var isCurrent = s.context === sel.context && s.namespace === sel.namespace;
            var sessAttrs = ' data-ctx="' + esc(s.context) + '" data-ns="' + esc(s.namespace) + '"';
            html += '<div class="watch-session' + (isCurrent ? ' current' : '') + '">' +
                '<div class="watch-session-head">' +
                    '<span class="watch-session-ns" title="' + esc(s.context + ' / ' + s.namespace) + '">' +
                        esc(s.namespace) + '</span>' +
                    '<span class="watch-session-ctx">' + esc(s.context) + '</span>' +
                    '<span style="flex:1"></span>' +
                    '<button type="button" class="watch-btn dnd' + (s.noNewStreams ? ' on' : '') +
                        '" data-act="no-new"' + sessAttrs + ' title="' + (s.noNewStreams
                            ? 'No more streams is on: new pods in this namespace are ignored (for good). Click to accept new pods again.'
                            : 'No more streams: ignore newly created pods (existing streams keep capturing)') + '">' +
                        DND_SVG + '</button>' +
                    '<button type="button" class="watch-btn" data-act="clear-session"' + sessAttrs +
                        ' title="Remove this namespace\'s ended streams (log files are kept)">✕ Clear</button>' +
                    '<button type="button" class="watch-btn stop" data-act="stop-session"' + sessAttrs +
                        ' title="Stop watching ' + esc(s.context + ' / ' + s.namespace) + '">■ Stop</button>' +
                '</div>';
            if (!s.streams || !s.streams.length) {
                html += '<div class="watch-empty">' + (s.noNewStreams
                    ? 'No more streams is on — new pods are being ignored.'
                    : 'Watching… no new pods yet. Existing pods are ignored by design.') +
                    '</div></div>';
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
            html += '</div>';
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
        syncFrameCounts();
    }

    function onListClick(e) {
        var btn = e.target.closest('button[data-act]');
        if (!btn) return;
        var act = btn.dataset.act, ctx = btn.dataset.ctx, ns = btn.dataset.ns, pod = btn.dataset.pod;
        if (act === 'tee') {
            toggleTee(ctx, ns, pod);
        } else if (act === 'export') {
            exportLog(ctx, ns, pod);
        } else if (act === 'stop-session') {
            watchStopSession(ctx, ns);
        } else if (act === 'clear-session') {
            clearStreams(ctx, ns);
        } else if (act === 'no-new') {
            toggleNoNewStreams(ctx, ns);
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
        var t = watchTarget();
        if (!t.namespace) { showNotice('Pick a namespace to watch'); return; }
        postJSON('/api/watch/start', { context: t.context, namespace: t.namespace })
            .then(fetchWatchStatus)
            .catch(function(err) { showNotice(err.message); });
    }

    // Clears ended streams. With ctx/ns it's scoped to that one session
    // (per-session Clear button); without, the toolbar button clears all.
    function clearStreams(ctx, ns) {
        var body = (ctx && ns) ? { context: ctx, namespace: ns } : {};
        postJSON('/api/watch/clear', body)
            .then(function(res) {
                showNotice(res.removed
                    ? 'Removed ' + res.removed + ' ended stream' + (res.removed === 1 ? '' : 's')
                    : 'No ended streams to remove (active streams stay until stopped)');
                fetchWatchStatus();
            })
            .catch(function(err) { showNotice(err.message); });
    }

    // Per-session do-not-disturb: while on, the server ignores pods created
    // in that namespace (no new streams); existing streams keep capturing.
    function toggleNoNewStreams(ctx, ns) {
        var on = false;
        ((lastStatus && lastStatus.sessions) || []).some(function(s) {
            if (s.context === ctx && s.namespace === ns) { on = !!s.noNewStreams; return true; }
            return false;
        });
        postJSON('/api/watch/nonew', { context: ctx, namespace: ns, noNewStreams: !on })
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
            if (frames[key]) updateFrameViewCounts(frames[key], c.errLines || 0, c.warnLines || 0);
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
                '<button type="button" class="watch-frame-search" title="Search logs (Esc to close)">' + SEARCH_SVG + '</button>' +
                '<button type="button" class="watch-frame-font" data-act="font-down" title="Decrease font size">A−</button>' +
                '<button type="button" class="watch-frame-font" data-act="font-up" title="Increase font size">A+</button>' +
                '<button type="button" class="watch-frame-copy" title="Copy buffer to clipboard">' + COPY_SVG + '</button>' +
                '<select class="watch-frame-view" title="Choose file: full log, errors only, or warnings only (errors/warnings are kept in full, never truncated)">' +
                    '<option value="all">All</option>' +
                    '<option value="errors">Errors</option>' +
                    '<option value="warnings">Warnings</option>' +
                '</select>' +
                '<button type="button" class="watch-frame-close" title="Close frame (capture continues)">×</button>' +
            '</div>' +
            '<div class="modal-search-bar watch-frame-search-bar">' +
                '<input type="text" placeholder="Search logs…" autocomplete="off" spellcheck="false">' +
                '<button type="button" class="modal-search-opt" data-opt="case" title="Match case">Aa</button>' +
                '<button type="button" class="modal-search-opt" data-opt="word" title="Whole word"><u>W</u></button>' +
                '<button type="button" class="modal-search-opt" data-opt="regex" title="Regular expression">.*</button>' +
                '<span class="modal-search-count"></span>' +
                '<button type="button" class="modal-search-nav" data-dir="-1" title="Previous match (Shift+Enter)">↑</button>' +
                '<button type="button" class="modal-search-nav" data-dir="1" title="Next match (Enter)">↓</button>' +
                '<button type="button" class="modal-search-close" title="Close (Esc)">&times;</button>' +
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
            view: 'all', // which file this frame shows: all | errors | warnings
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
            LF.wire(lvlBtns, frame.body, function() {
                if (frame.search && frame.search.open && frame.search.query) runFrameSearch(frame);
            });
        }
        wireFrameSearch(frame);
        applyWatchFrameFont(frame.body);
        el.querySelector('[data-act="font-down"]').addEventListener('click', function() { adjustWatchFrameFont(-1); });
        el.querySelector('[data-act="font-up"]').addEventListener('click', function() { adjustWatchFrameFont(1); });
        el.querySelector('.watch-frame-close').addEventListener('click', function() {
            removeFrame(frame, true);
            delete frames[key];
            renderFramesVisibility();
            renderStatus();
        });
        el.querySelector('.watch-frame-copy').addEventListener('click', function() {
            copyFrame(frame, this);
        });

        var viewSel = el.querySelector('.watch-frame-view');
        viewSel.value = frame.view;
        viewSel.addEventListener('change', function() { setFrameView(frame, this.value); });

        connectFrame(frame);
        frames[key] = frame;
        // Seed the Errors/Warnings option labels from the latest status so the
        // counts show the moment the frame opens (live ticks refine them).
        var seed = streamStatusFor(ctx, ns, pod);
        updateFrameViewCounts(frame, seed ? (seed.errLines || 0) : 0, seed ? (seed.warnLines || 0) : 0);
        renderFramesVisibility();
    }

    // Find the latest StreamStatus for a pod in the cached status payload.
    function streamStatusFor(ctx, ns, pod) {
        if (!lastStatus) return null;
        var sessions = lastStatus.sessions || [];
        for (var i = 0; i < sessions.length; i++) {
            if (sessions[i].context !== ctx || sessions[i].namespace !== ns) continue;
            var streams = sessions[i].streams || [];
            for (var j = 0; j < streams.length; j++) {
                if (streams[j].pod === pod) return streams[j];
            }
        }
        return null;
    }

    // Label the frame's view dropdown with each bucket's line count and bold
    // the ones that have any, so "Errors (3)" / "Warnings (2)" stand out and a
    // clean pod just shows plain "Errors"/"Warnings". Native <select> option
    // styling is unreliable (esp. in the macOS webview), so we also flag the
    // collapsed control when an issue view is the current selection.
    function updateFrameViewCounts(frame, errCount, warnCount) {
        var sel = frame.el.querySelector('.watch-frame-view');
        if (!sel) return;
        frame.errCount = errCount;
        frame.warnCount = warnCount;
        var opts = sel.options;
        for (var i = 0; i < opts.length; i++) {
            var v = opts[i].value;
            var n = v === 'errors' ? errCount : v === 'warnings' ? warnCount : 0;
            var base = v === 'errors' ? 'Errors' : v === 'warnings' ? 'Warnings' : 'All';
            opts[i].textContent = n > 0 ? base + ' (' + n + ')' : base;
            opts[i].classList.toggle('has-issues', n > 0);
            opts[i].style.fontWeight = n > 0 ? '700' : '';
        }
        var selN = sel.value === 'errors' ? errCount : sel.value === 'warnings' ? warnCount : 0;
        sel.classList.toggle('sel-issues', selN > 0);
    }

    // Refresh every open frame's view-dropdown counts from the cached status.
    function syncFrameCounts() {
        for (var key in frames) {
            var st = streamStatusFor(frames[key].ctx, frames[key].ns, frames[key].pod);
            if (st) updateFrameViewCounts(frames[key], st.errLines || 0, st.warnLines || 0);
        }
    }

    // (Re)open the SSE tee for the frame's current view. tail applies to the
    // full log ("all"); the errors/warnings views replay their whole companion
    // file (never truncated) and stream only that bucket's lines live.
    function connectFrame(frame) {
        if (frame.es) { frame.es.close(); frame.es = null; }
        var url = '/sse/watch-logs?context=' + encodeURIComponent(frame.ctx) +
            '&namespace=' + encodeURIComponent(frame.ns) + '&pod=' + encodeURIComponent(frame.pod) +
            '&tail=' + getWatchBufLines() + '&view=' + encodeURIComponent(frame.view);
        frame.status.textContent = 'connecting…';
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
            if (frame.es) { frame.es.close(); frame.es = null; }
        });
    }

    // Switch a frame between the full log and its errors/warnings file. The
    // body is cleared and the tee reconnected so the chosen file replays from
    // the top; capture (and the other files) keep running untouched.
    function setFrameView(frame, view) {
        if (view !== 'errors' && view !== 'warnings') view = 'all';
        if (frame.view === view) return;
        frame.view = view;
        frame.buf = [];
        frame.body.innerHTML = '';
        frame.lastLvl = null;
        applyFrameViewLock(frame);
        if (frame.search && frame.search.open) {
            frame.search.matchCount = 0;
            refreshFrameSearchCount(frame);
        }
        connectFrame(frame);
    }

    // In the Errors/Warnings views the frame shows a single-level companion
    // file, so the per-frame level filter can't meaningfully subset it: lock
    // every level button (disabled + greyed) and clear any active hide-* so the
    // whole file shows. The button naming the current view stays full-color as a
    // label. The "all" view restores the normal, interactive filter and re-
    // applies the persisted hidden set.
    function applyFrameViewLock(frame) {
        var btnsEl = frame.el.querySelector('.log-lvl-btns');
        if (!btnsEl) return;
        var LF = window.kroLogFilter;
        var locked = frame.view === 'errors' || frame.view === 'warnings';
        var current = frame.view === 'errors' ? 'err' : (frame.view === 'warnings' ? 'wrn' : '');
        btnsEl.classList.toggle('view-locked', locked);
        var btns = btnsEl.querySelectorAll('.log-lvl-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].disabled = locked;
            btns[i].classList.toggle('view-current', locked && btns[i].dataset.lvl === current);
        }
        if (LF) LF.apply(frame.body, locked ? {} : LF.getHidden());
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

    // ===== Frame font size =====
    // A−/A+ shrink/grow the log text. Persisted globally so every open frame
    // (and future ones) share one size, matching the pod-log modal's behavior.
    var WATCH_FRAME_FONT_KEY = 'kro_watch_frame_font_px';
    var WATCH_FRAME_FONT_MIN = 9, WATCH_FRAME_FONT_MAX = 22, WATCH_FRAME_FONT_DEFAULT = 11.5;

    function getWatchFrameFont() {
        var v = parseFloat(localStorage.getItem(WATCH_FRAME_FONT_KEY));
        if (isNaN(v)) return WATCH_FRAME_FONT_DEFAULT;
        return Math.max(WATCH_FRAME_FONT_MIN, Math.min(WATCH_FRAME_FONT_MAX, v));
    }
    function applyWatchFrameFont(el) {
        if (el) el.style.fontSize = getWatchFrameFont() + 'px';
    }
    function adjustWatchFrameFont(delta) {
        var s = Math.max(WATCH_FRAME_FONT_MIN, Math.min(WATCH_FRAME_FONT_MAX, getWatchFrameFont() + delta));
        localStorage.setItem(WATCH_FRAME_FONT_KEY, String(s));
        var bodies = document.querySelectorAll('#watch-frames .watch-frame-body');
        for (var i = 0; i < bodies.length; i++) bodies[i].style.fontSize = s + 'px';
    }

    // ===== Per-frame log search =====
    // Same find UX as the regular pod-log modal, but scoped to one console
    // frame with its own state. Match/highlight helpers are shared from
    // resources.js via window.kroLogSearch.
    function wireFrameSearch(frame) {
        var LS = window.kroLogSearch;
        if (!LS) return; // resources.js helpers missing; button stays inert
        frame.search = {
            open: false, query: '', caseSensitive: false, wholeWord: false,
            regex: false, matchCount: 0, currentIndex: 0, invalid: false
        };
        var el = frame.el;
        frame.searchBtn = el.querySelector('.watch-frame-search');
        frame.searchBar = el.querySelector('.watch-frame-search-bar');
        frame.searchInput = frame.searchBar.querySelector('input');
        frame.searchCount = frame.searchBar.querySelector('.modal-search-count');

        frame.searchBtn.addEventListener('click', function() { toggleFrameSearch(frame); });
        frame.searchBar.querySelector('.modal-search-close').addEventListener('click', function() {
            toggleFrameSearch(frame);
        });
        frame.searchInput.addEventListener('input', function() {
            frame.search.query = frame.searchInput.value || '';
            runFrameSearch(frame);
        });
        frame.searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateFrameMatch(frame, e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation(); // keep Esc from also exiting full screen
                toggleFrameSearch(frame);
            }
        });
        var opts = frame.searchBar.querySelectorAll('.modal-search-opt');
        for (var i = 0; i < opts.length; i++) {
            opts[i].addEventListener('click', function() {
                var key = this.dataset.opt === 'case' ? 'caseSensitive'
                    : this.dataset.opt === 'word' ? 'wholeWord' : 'regex';
                frame.search[key] = !frame.search[key];
                this.classList.toggle('on', frame.search[key]);
                runFrameSearch(frame);
            });
        }
        var navs = frame.searchBar.querySelectorAll('.modal-search-nav');
        for (var j = 0; j < navs.length; j++) {
            navs[j].addEventListener('click', function() {
                navigateFrameMatch(frame, parseInt(this.dataset.dir, 10));
            });
        }
    }

    function toggleFrameSearch(frame) {
        if (!frame.search) return;
        frame.search.open = !frame.search.open;
        frame.searchBar.classList.toggle('active', frame.search.open);
        frame.searchBtn.classList.toggle('on', frame.search.open);
        if (frame.search.open) {
            frame.searchInput.focus();
            frame.searchInput.select();
            runFrameSearch(frame);
        } else {
            window.kroLogSearch.clearMarks(frame.body);
        }
    }

    function frameSearchRegex(frame) {
        return window.kroLogSearch.buildRegex(frame.search.query,
            frame.search.caseSensitive, frame.search.wholeWord, frame.search.regex);
    }

    function refreshFrameSearchCount(frame) {
        var el = frame.searchCount;
        if (frame.search.invalid) {
            el.textContent = 'invalid regex';
            el.classList.add('error');
            return;
        }
        el.classList.remove('error');
        if (!frame.search.query) { el.textContent = ''; return; }
        if (frame.search.matchCount === 0) { el.textContent = 'no matches'; return; }
        var idx = Math.min(frame.search.currentIndex, frame.search.matchCount - 1);
        el.textContent = (idx + 1) + ' / ' + frame.search.matchCount;
    }

    function runFrameSearch(frame) {
        var LS = window.kroLogSearch;
        LS.clearMarks(frame.body);
        frame.search.invalid = false;
        frame.search.matchCount = 0;
        frame.search.currentIndex = 0;
        if (!frame.search.query) { refreshFrameSearchCount(frame); return; }
        var rx = frameSearchRegex(frame);
        if (rx === false) {
            frame.search.invalid = true;
            refreshFrameSearchCount(frame);
            return;
        }
        // Line by line so lines hidden by the level filter get no marks —
        // keeps the count honest and navigation on visible matches.
        var total = 0;
        var lines = frame.body.children;
        for (var i = 0; i < lines.length; i++) {
            if (LS.lineHidden(lines[i], frame.body)) continue;
            total += LS.highlightIn(lines[i], rx);
        }
        frame.search.matchCount = total;
        refreshFrameSearchCount(frame);
        if (total > 0) navigateFrameMatch(frame, 0);
    }

    function navigateFrameMatch(frame, delta) {
        var groups = window.kroLogSearch.markGroups(frame.body.querySelectorAll('mark.log-match'));
        if (!groups.length) return;
        var cur = -1;
        for (var i = 0; i < groups.length; i++) {
            if (groups[i][0].classList.contains('current')) { cur = i; break; }
        }
        var next;
        if (cur === -1) {
            next = delta >= 0 ? 0 : groups.length - 1;
        } else {
            next = ((cur + delta) % groups.length + groups.length) % groups.length;
            groups[cur].forEach(function(m) { m.classList.remove('current'); });
        }
        groups[next].forEach(function(m) { m.classList.add('current'); });
        groups[next][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        frame.search.currentIndex = next;
        refreshFrameSearchCount(frame);
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
        // Trimming or autoscrolling would wipe a selection the user is trying
        // to copy from this frame; hold both while one is active.
        var holdForSelection = window.kroSelActive && window.kroSelActive(body);

        var frag = document.createDocumentFragment();
        var newSpans = [];
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
            newSpans.push(span);
        }
        body.appendChild(frag);
        if (!holdForSelection) trimFrame(frame);

        // Keep an active search in step with streamed lines: mark matches in
        // the new spans, then recount from the DOM (trimming may also have
        // dropped marked lines, so an incremental count would drift).
        if (frame.search && frame.search.open && frame.search.query && !frame.search.invalid) {
            var LS = window.kroLogSearch;
            var rx = frameSearchRegex(frame);
            if (rx) {
                for (var j = 0; j < newSpans.length; j++) {
                    if (!newSpans[j].parentNode) continue; // already trimmed
                    if (LS.lineHidden(newSpans[j], body)) continue;
                    LS.highlightIn(newSpans[j], rx);
                }
                frame.search.matchCount = LS.markGroups(body.querySelectorAll('mark.log-match')).length;
                refreshFrameSearchCount(frame);
            }
        }
        if (atBottom && !holdForSelection) body.scrollTop = body.scrollHeight;
    }

    function trimFrame(frame) {
        var spans = frame.body.children;
        var over = spans.length - getWatchBufLines();
        for (var i = 0; i < over; i++) frame.body.removeChild(frame.body.firstChild);
    }
})();
