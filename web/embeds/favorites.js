/* Favorites — saved Cluster/Namespace destinations with three access paths:

     ★ header toggle      star / unstar the current selection
     chip bar             click to switch, drag to reorder, dbl-click to rename;
                          focused chip: ←/→ move focus, Alt+←/→ reorder,
                          Enter/Space switch, F2 rename
     Ctrl+1 … Ctrl+9      jump to the Nth chip from anywhere
     Cmd/Ctrl+K           quick switcher over every known destination, plus an
                          on-demand "Browse all namespaces" of one cluster

   All three drive window.kroSwitchTarget() (defined in resources.js), which
   posts one request to /api/favorites/go and repaints the header from the
   response — no chained fetches on the hot path.

   The favorites list itself is server-owned (state.json). Every mutation here
   sends the change and re-renders from the response body rather than from
   local optimism, so two open tabs converge instead of drifting. The one
   exception is drag-reorder, which repaints locally first (a drag that visibly
   snaps back before the round trip completes feels broken) and reconciles when
   the response lands. */
(function() {
    'use strict';

    var favorites = [];                              // ordered, server-owned
    var current = { context: '', namespace: '' };    // mirrors the header
    var targets = [];                                // palette rows, from /api/targets
    var paletteRows = [];                            // currently filtered+rendered rows
    var paletteIdx = 0;
    var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

    // Namespace lists fetched from a cluster by the palette's "Browse all
    // namespaces" row, keyed by context name. /api/targets deliberately makes
    // no cluster calls (so the palette opens instantly), which means it only
    // knows pinned namespaces; this is the opt-in way to see the rest.
    //   { names: [...], at: ms }   loaded
    //   { loading: true }          request in flight
    //   { error: '...', at: ms }   last attempt failed (choosing the row retries)
    // A loaded list is reused for CLUSTER_NS_TTL_MS, then the row offers to
    // fetch again; namespaces change rarely, and typing cluster/namespace
    // still reaches one created in between.
    var clusterNs = {};
    var CLUSTER_NS_TTL_MS = 5 * 60 * 1000;

    var MAX_HOTKEYS = 9;      // Ctrl+1..Ctrl+9
    var MAX_PALETTE_ROWS = 60; // cap the DOM built per keystroke

    function esc(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function favIndex(ctx, ns) {
        for (var i = 0; i < favorites.length; i++) {
            if (favorites[i].context === ctx && favorites[i].namespace === ns) return i;
        }
        return -1;
    }

    function isCurrent(f) {
        return f.context === current.context && f.namespace === current.namespace;
    }

    function readSelection() {
        if (window.kroCurrentSelection) {
            var sel = window.kroCurrentSelection();
            if (sel) current = { context: sel.context || '', namespace: sel.namespace || '' };
        }
        return current;
    }

    // ===== Server calls =====

    // Every favorites endpoint answers with the same payload shape, so a single
    // applier keeps the UI in lockstep with the file on disk.
    function applyPayload(data) {
        if (!data) return;
        if (data.error) { alert('Favorites: ' + data.error); return; }
        if (Array.isArray(data.favorites)) favorites = data.favorites;
        if (data.context) current.context = data.context;
        if (data.namespace) current.namespace = data.namespace;
        // The pinned-namespace set may have moved under the palette.
        targets = [];
        render();
    }

    function postJSON(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(function(r) { return r.json(); });
    }

    function loadFavorites() {
        return fetch('/api/favorites')
            .then(function(r) { return r.json(); })
            .then(applyPayload)
            .catch(function(err) { console.error('load favorites:', err); });
    }

    function addFavorite(ctx, ns, label) {
        return postJSON('/api/favorites', { context: ctx, namespace: ns, label: label || '' })
            .then(applyPayload)
            .catch(function(err) { alert('Could not save favorite: ' + err.message); });
    }

    function removeFavorite(ctx, ns) {
        var q = '?context=' + encodeURIComponent(ctx) + '&namespace=' + encodeURIComponent(ns);
        return fetch('/api/favorites' + q, { method: 'DELETE' })
            .then(function(r) { return r.json(); })
            .then(applyPayload)
            .catch(function(err) { alert('Could not remove favorite: ' + err.message); });
    }

    function renameFavorite(ctx, ns, label) {
        return postJSON('/api/favorites/label', { context: ctx, namespace: ns, label: label })
            .then(applyPayload)
            .catch(function(err) { alert('Could not rename favorite: ' + err.message); });
    }

    function persistOrder() {
        return postJSON('/api/favorites/reorder', {
            favorites: favorites.map(function(f) {
                return { context: f.context, namespace: f.namespace };
            })
        }).then(applyPayload).catch(function(err) {
            // Server said no — pull the authoritative order back so the chips
            // don't keep showing an order that was never saved.
            console.error('reorder:', err);
            loadFavorites();
        });
    }

    // ===== Chip bar =====

    function chipHTML(f, idx) {
        var hotkey = idx < MAX_HOTKEYS
            ? '<span class="fav-chip-badge">' + (idx + 1) + '</span>' : '';
        var body = f.label
            ? '<span class="fav-chip-label">' + esc(f.label) + '</span>'
            : '<span class="fav-chip-ctx">' + esc(f.context) + '</span>' +
              '<span class="fav-chip-sep">/</span>' +
              '<span class="fav-chip-ns">' + esc(f.namespace) + '</span>';

        var tip = f.context + ' / ' + f.namespace +
            (idx < MAX_HOTKEYS ? '  (Ctrl+' + (idx + 1) + ')' : '') +
            '\ndouble-click or F2 to rename · drag or ' + (isMac ? '⌥' : 'Alt+') +
            '←/→ to reorder';

        // tabindex/role make the chip reachable and operable from the
        // keyboard (see onChipsKeydown); it is a span only so the × button
        // can nest inside it, which a <button> may not contain.
        return '<span class="fav-chip' + (isCurrent(f) ? ' current' : '') + '"' +
            ' draggable="true" tabindex="0" role="button" data-idx="' + idx + '"' +
            ' data-ctx="' + esc(f.context) + '" data-ns="' + esc(f.namespace) + '"' +
            ' title="' + esc(tip) + '">' +
            hotkey + body +
            '<button type="button" class="fav-chip-x" title="Remove favorite">×</button>' +
            '</span>';
    }

    // Identity (context + namespace) of the chip that should keep keyboard
    // focus across a re-render. The chip bar is rebuilt via innerHTML on every
    // change — including the server's reply to a reorder — which would
    // otherwise drop focus to <body> mid-way through a series of Alt+→ moves.
    // Identity rather than index, because a reorder is exactly what moves it.
    function favKey(ctx, ns) { return ctx + '\n' + ns; }

    function renderChips() {
        var host = document.getElementById('fav-chips');
        if (!host) return;

        var ae = document.activeElement;
        var focusKey = (ae && ae.classList && ae.classList.contains('fav-chip') && host.contains(ae))
            ? favKey(ae.dataset.ctx, ae.dataset.ns) : null;

        if (!favorites.length) {
            host.innerHTML = '<span class="fav-empty">Star a Cluster / NS above to pin it here</span>';
            return;
        }
        host.innerHTML = favorites.map(chipHTML).join('');
        if (focusKey) focusChipByKey(focusKey);
    }

    function focusChipByKey(key) {
        var chips = document.querySelectorAll('#fav-chips .fav-chip');
        for (var i = 0; i < chips.length; i++) {
            if (favKey(chips[i].dataset.ctx, chips[i].dataset.ns) === key) {
                chips[i].focus();
                return;
            }
        }
    }

    function renderStar() {
        var btn = document.getElementById('btn-fav-toggle');
        if (!btn) return;
        var on = favIndex(current.context, current.namespace) >= 0;
        btn.classList.toggle('on', on);
        btn.textContent = on ? '★' : '☆';
        btn.title = on
            ? 'Unstar ' + current.context + ' / ' + current.namespace
            : 'Save ' + (current.context || 'this cluster') + ' / ' +
              (current.namespace || 'namespace') + ' as a favorite';
    }

    function render() {
        readSelection();
        renderChips();
        renderStar();
    }

    function onToggleStar() {
        readSelection();
        if (!current.context || !current.namespace) return;
        if (favIndex(current.context, current.namespace) >= 0) {
            removeFavorite(current.context, current.namespace);
        } else {
            addFavorite(current.context, current.namespace, '');
        }
    }

    // Switch to the chip/target and give the header a brief flash, so a jump
    // fired by a hotkey (eyes elsewhere) still registers visually.
    function goTo(ctx, ns) {
        if (!window.kroSwitchTarget) return;
        window.kroSwitchTarget(ctx, ns);
        var bar = document.querySelector('.header-selectors');
        if (bar) {
            bar.classList.remove('fav-flash');
            void bar.offsetWidth; // restart the animation
            bar.classList.add('fav-flash');
            setTimeout(function() { bar.classList.remove('fav-flash'); }, 600);
        }
    }

    function chipFromEvent(e) {
        var el = e.target.closest ? e.target.closest('.fav-chip') : null;
        return el;
    }

    function onChipsClick(e) {
        var chip = chipFromEvent(e);
        if (!chip) return;
        if (e.target.classList.contains('fav-chip-x')) {
            e.stopPropagation();
            removeFavorite(chip.dataset.ctx, chip.dataset.ns);
            return;
        }
        goTo(chip.dataset.ctx, chip.dataset.ns);
    }

    function onChipsDblClick(e) {
        var chip = chipFromEvent(e);
        if (!chip) return;
        var idx = parseInt(chip.dataset.idx, 10);
        var f = favorites[idx];
        if (!f) return;
        var next = prompt(
            'Label for ' + f.context + ' / ' + f.namespace + '\n(leave blank to show cluster / namespace)',
            f.label || '');
        if (next === null) return; // cancelled
        renameFavorite(f.context, f.namespace, next.trim());
    }

    // --- keyboard: focus, switch, rename, reorder ---
    //
    // The keyboard counterpart of click / dbl-click / drag on a focused chip:
    //   ← / →          move focus to the previous / next chip
    //   Alt+← / Alt+→  move the chip one slot (Option on macOS), wrapping is
    //                  deliberately not done — an end chip just stays put
    //   Enter / Space  switch to it
    //   F2             rename it
    // Only keys whose target is the chip itself are handled: the nested ×
    // button keeps its native Enter/Space → click → remove behaviour.
    function onChipsKeydown(e) {
        var chip = e.target;
        if (!chip.classList || !chip.classList.contains('fav-chip')) return;
        var idx = parseInt(chip.dataset.idx, 10);
        if (e.metaKey || e.ctrlKey) return; // leave Ctrl+digit, Cmd+K etc. to the globals

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            var dir = e.key === 'ArrowLeft' ? -1 : 1;
            var to = idx + dir;
            if (to < 0 || to >= favorites.length) return;
            if (e.altKey) {
                moveFavorite(idx, to);
            } else {
                var chips = document.querySelectorAll('#fav-chips .fav-chip');
                if (chips[to]) chips[to].focus();
            }
            return;
        }
        if (e.altKey || e.shiftKey) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); // Space would otherwise scroll the page
            goTo(chip.dataset.ctx, chip.dataset.ns);
        } else if (e.key === 'F2') {
            e.preventDefault();
            onChipsDblClick(e); // same prompt; it resolves the chip from e.target
        }
    }

    // moveFavorite moves the favorite at index from to index to (adjacent
    // slots in practice), repaints, and persists — the same local-first then
    // reconcile path a drop takes. renderChips carries focus along with the
    // moved chip because it tracks focus by identity.
    function moveFavorite(from, to) {
        var moved = favorites.splice(from, 1)[0];
        favorites.splice(to, 0, moved);
        renderChips();
        persistOrder();
    }

    // --- drag to reorder ---
    var dragIdx = -1;

    function clearDropMarks() {
        var chips = document.querySelectorAll('.fav-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.remove('drop-before', 'drop-after', 'dragging');
        }
    }

    function onDragStart(e) {
        var chip = chipFromEvent(e);
        if (!chip) return;
        dragIdx = parseInt(chip.dataset.idx, 10);
        chip.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            // Firefox refuses to start a drag without payload.
            try { e.dataTransfer.setData('text/plain', String(dragIdx)); } catch (err) {}
        }
    }

    function onDragOver(e) {
        if (dragIdx < 0) return;
        var chip = chipFromEvent(e);
        if (!chip) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var rect = chip.getBoundingClientRect();
        var after = (e.clientX - rect.left) > rect.width / 2;
        chip.classList.toggle('drop-before', !after);
        chip.classList.toggle('drop-after', after);
    }

    function onDragLeave(e) {
        var chip = chipFromEvent(e);
        if (chip) chip.classList.remove('drop-before', 'drop-after');
    }

    function onDrop(e) {
        if (dragIdx < 0) return;
        var chip = chipFromEvent(e);
        if (!chip) return;
        e.preventDefault();

        var overIdx = parseInt(chip.dataset.idx, 10);
        var rect = chip.getBoundingClientRect();
        var after = (e.clientX - rect.left) > rect.width / 2;
        var insertAt = after ? overIdx + 1 : overIdx;

        var moved = favorites[dragIdx];
        favorites.splice(dragIdx, 1);
        // Removing the dragged chip shifts everything to its right one slot
        // left, so a drop target past it needs the same correction.
        if (dragIdx < insertAt) insertAt--;
        favorites.splice(insertAt, 0, moved);

        dragIdx = -1;
        clearDropMarks();
        renderChips();   // paint the new order immediately…
        persistOrder();  // …then confirm it with the server
    }

    function onDragEnd() {
        dragIdx = -1;
        clearDropMarks();
    }

    // ===== Quick switcher =====

    function loadTargets() {
        if (targets.length) return Promise.resolve(targets);
        return fetch('/api/targets')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                targets = data.targets || [];
                return targets;
            })
            .catch(function(err) { console.error('load targets:', err); return []; });
    }

    function paletteOpen() {
        var ov = document.getElementById('fav-palette-overlay');
        return !!ov && ov.classList.contains('active');
    }

    function openPalette() {
        var ov = document.getElementById('fav-palette-overlay');
        var input = document.getElementById('fav-palette-input');
        if (!ov || !input) return;
        ov.classList.add('active');
        input.value = '';
        paletteIdx = 0;
        renderPalette('');            // paint the unfiltered list from cache…
        loadTargets().then(function() {
            if (paletteOpen()) renderPalette(input.value);  // …then with fresh data
        });
        input.focus();
    }

    function closePalette() {
        var ov = document.getElementById('fav-palette-overlay');
        if (ov) ov.classList.remove('active');
    }

    // matchAt returns the index of needle in haystack (case-insensitive), or -1.
    function matchAt(haystack, needle) {
        return haystack.toLowerCase().indexOf(needle);
    }

    // markup wraps the matched run in <mark>, escaping around it.
    function markup(text, needle) {
        if (!needle) return esc(text);
        var i = matchAt(text, needle);
        if (i < 0) return esc(text);
        return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + needle.length)) +
            '</mark>' + esc(text.slice(i + needle.length));
    }

    /* filterTargets ranks destinations for a query.

       Terms are whitespace-separated and ALL must match somewhere in
       "context/namespace" (or the favorite's label) — so "prod pay" finds
       prod-us/payments regardless of which half each word lands in. A "/" in
       the query is treated as the ctx/ns boundary for scoring only: the left
       side is preferred against the context, the right against the namespace.

       Score is lower-is-better: server rank (favorite < pinned < default)
       dominates, then how early the query matched, then string length. */
    function filterTargets(query) {
        var q = (query || '').trim().toLowerCase();
        var terms = q ? q.split(/\s+/) : [];
        var slash = q.indexOf('/');
        var ctxQ = slash >= 0 ? q.slice(0, slash).trim() : '';
        var nsQ = slash >= 0 ? q.slice(slash + 1).trim() : '';

        var rows = [];
        paletteTargets().forEach(function(t) {
            var combined = (t.context + '/' + t.namespace + ' ' + (t.label || '')).toLowerCase();
            var score = t.rank * 1000;
            var ok = true;

            if (slash >= 0) {
                // Explicit ctx/ns form: each side is checked against its own field.
                if (ctxQ && matchAt(t.context, ctxQ) < 0) ok = false;
                if (ok && nsQ && matchAt(t.namespace, nsQ) < 0) ok = false;
                if (ok) {
                    score += (ctxQ ? matchAt(t.context, ctxQ) : 0) +
                             (nsQ ? matchAt(t.namespace, nsQ) : 0);
                }
            } else {
                for (var i = 0; i < terms.length; i++) {
                    var at = combined.indexOf(terms[i]);
                    if (at < 0) { ok = false; break; }
                    score += at;
                }
            }
            if (!ok) return;

            score += combined.length / 100;   // tie-break: prefer the shorter name
            if (t.context === current.context && t.namespace === current.namespace) {
                score += 500;                 // where we already are is the least useful row
            }
            rows.push({ t: t, score: score });
        });

        rows.sort(function(a, b) { return a.score - b.score; });
        var out = rows.slice(0, MAX_PALETTE_ROWS).map(function(r) { return r.t; });

        // Typing an explicit cluster/namespace that isn't in the list yet is a
        // legitimate destination — offer it as an ad-hoc row. Switching to it
        // pins the namespace server-side, so it becomes a normal row next time.
        if (nsQ) {
            // Suppress the ad-hoc row when a listed namespace already contains
            // what was typed — mid-typing ("stg/brand" on the way to
            // "brand-new") would otherwise add a bogus row under the real one.
            var already = out.some(function(t) { return t.namespace.toLowerCase().indexOf(nsQ) >= 0; });
            if (!already) {
                var ctxs = [];
                if (ctxQ) {
                    targets.forEach(function(t) {
                        if (ctxs.indexOf(t.context) < 0 && matchAt(t.context, ctxQ) >= 0) {
                            ctxs.push(t.context);
                        }
                    });
                    ctxs = ctxs.slice(0, 3);
                } else if (current.context) {
                    ctxs = [current.context];
                }
                ctxs.forEach(function(cx) {
                    out.push({ context: cx, namespace: nsQ, rank: 3, adhoc: true });
                });
            }
        }
        return out;
    }

    // paletteTargets is the row source for filterTargets: the local targets
    // from /api/targets, plus any fresh cluster-listed namespaces (see
    // clusterNs) not already among them. Listed rows rank 3, below pinned
    // ones, and carry listed:true so they are tagged "not pinned". Choosing
    // one goes through goTo → /api/favorites/go, which pins it like any jump.
    function paletteTargets() {
        var now = Date.now();
        var out = targets.slice();
        var seen = Object.create(null);
        targets.forEach(function(t) { seen[t.context + '\n' + t.namespace] = true; });
        Object.keys(clusterNs).forEach(function(cx) {
            var e = clusterNs[cx];
            if (!e.names || now - e.at > CLUSTER_NS_TTL_MS) return;
            e.names.forEach(function(ns) {
                if (seen[cx + '\n' + ns]) return;
                seen[cx + '\n' + ns] = true;
                out.push({ context: cx, namespace: ns, rank: 3, listed: true });
            });
        });
        return out;
    }

    // browseRowFor picks the context the "Browse all namespaces" row would
    // list, or returns null when that list is already loaded and fresh. The
    // context comes from the query's cluster half when it names exactly one
    // known context (an exact name wins over several prefix matches);
    // otherwise it is the current context.
    function browseRowFor(query) {
        var q = (query || '').trim().toLowerCase();
        var slash = q.indexOf('/');
        var cx = current.context;
        if (slash > 0) {
            var ctxQ = q.slice(0, slash).trim();
            var hits = [];
            targets.forEach(function(t) {
                if (hits.indexOf(t.context) < 0 && matchAt(t.context, ctxQ) >= 0) hits.push(t.context);
            });
            var exact = hits.filter(function(h) { return h.toLowerCase() === ctxQ; });
            if (exact.length === 1) cx = exact[0];
            else if (hits.length === 1) cx = hits[0];
        }
        if (!cx) return null;
        var e = clusterNs[cx];
        if (e && e.names && Date.now() - e.at <= CLUSTER_NS_TTL_MS) return null;
        return { browse: true, context: cx, state: e || null };
    }

    function browseRowHTML(t, i) {
        var st = t.state, text, tag = 'cluster call';
        if (st && st.loading) {
            text = 'Listing namespaces in <b>' + esc(t.context) + '</b>…';
            tag = '';
        } else if (st && st.error) {
            text = 'Couldn\'t list namespaces in <b>' + esc(t.context) + '</b>: ' + esc(st.error);
            tag = 'retry';
        } else {
            text = 'Browse all namespaces in <b>' + esc(t.context) + '</b>';
        }
        return '<div class="fav-palette-row fav-palette-browse' + (st && st.error ? ' error' : '') +
            (i === paletteIdx ? ' active' : '') + '" role="option" data-idx="' + i + '">' +
            '<span class="fav-palette-star">⋯</span>' +
            '<span class="fav-palette-browse-text">' + text + '</span>' +
            (tag ? '<span class="fav-palette-tag">' + tag + '</span>' : '') +
            '</div>';
    }

    // browseNamespaces fetches one context's full namespace list for the
    // palette and repaints it in place (the palette stays open, so the user
    // can keep typing to narrow the now-larger list).
    function browseNamespaces(cx) {
        var e = clusterNs[cx];
        if (e && e.loading) return;
        clusterNs[cx] = { loading: true };
        repaintPalette();
        fetch('/api/targets/namespaces?context=' + encodeURIComponent(cx))
            .then(function(r) {
                return r.json().then(function(d) { return { ok: r.ok, status: r.status, d: d || {} }; },
                    function() { return { ok: false, status: r.status, d: {} }; });
            })
            .then(function(res) {
                if (!res.ok || res.d.error) {
                    clusterNs[cx] = { error: res.d.error || ('HTTP ' + res.status), at: Date.now() };
                } else {
                    clusterNs[cx] = { names: res.d.namespaces || [], at: Date.now() };
                }
            })
            .catch(function(err) {
                clusterNs[cx] = { error: err.message || 'request failed', at: Date.now() };
            })
            .then(repaintPalette);
    }

    // Re-render the open palette from its current query, keeping keyboard
    // focus in the input (a mouse click on a row would otherwise leave focus
    // on <body>, and ↑↓/Enter would stop working).
    function repaintPalette() {
        if (!paletteOpen()) return;
        var input = document.getElementById('fav-palette-input');
        renderPalette(input ? input.value : '');
        if (input && document.activeElement !== input) input.focus();
    }

    function renderPalette(query) {
        var list = document.getElementById('fav-palette-list');
        if (!list) return;
        var matches = filterTargets(query);
        var browse = browseRowFor(query);
        // The browse row is always last and is not ranked with the matches;
        // it is still a normal row for ↑↓ / Enter / click (see choosePalette).
        paletteRows = browse ? matches.concat([browse]) : matches;
        if (paletteIdx >= paletteRows.length) paletteIdx = 0;

        if (!matches.length) {
            list.innerHTML = '<div class="fav-palette-empty">No cluster / namespace matches' +
                ' — type <b>cluster/namespace</b> to jump to one that isn\'t pinned yet</div>' +
                (browse ? browseRowHTML(browse, 0) : '');
            return;
        }

        var q = (query || '').trim().toLowerCase();
        var slash = q.indexOf('/');
        var ctxNeedle = slash >= 0 ? q.slice(0, slash).trim() : q.split(/\s+/)[0] || '';
        var nsNeedle = slash >= 0 ? q.slice(slash + 1).trim() : ctxNeedle;

        list.innerHTML = paletteRows.map(function(t, i) {
            if (t.browse) return browseRowHTML(t, i);
            var tag = (t.adhoc || t.listed) ? 'not pinned' : (t.favorite ? '' : (t.rank === 2 ? 'default' : ''));
            return '<div class="fav-palette-row' + (i === paletteIdx ? ' active' : '') + '"' +
                ' role="option" data-idx="' + i + '">' +
                '<span class="fav-palette-star">' + (t.favorite ? '★' : '') + '</span>' +
                '<span class="fav-palette-ctx">' + markup(t.context, ctxNeedle) + '</span>' +
                '<span class="fav-palette-sep">/</span>' +
                '<span class="fav-palette-ns">' + markup(t.namespace, nsNeedle) + '</span>' +
                (t.label ? '<span class="fav-palette-sep">·</span><span>' + esc(t.label) + '</span>' : '') +
                (tag ? '<span class="fav-palette-tag">' + esc(tag) + '</span>' : '') +
                '</div>';
        }).join('');
    }

    function movePalette(delta) {
        if (!paletteRows.length) return;
        paletteIdx = (paletteIdx + delta + paletteRows.length) % paletteRows.length;
        var rows = document.querySelectorAll('.fav-palette-row');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.toggle('active', i === paletteIdx);
        }
        if (rows[paletteIdx]) rows[paletteIdx].scrollIntoView({ block: 'nearest' });
    }

    function choosePalette(idx) {
        var t = paletteRows[idx];
        if (!t) return;
        if (t.browse) { browseNamespaces(t.context); return; } // stays open
        closePalette();
        goTo(t.context, t.namespace);
    }

    function onPaletteKeydown(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); choosePalette(paletteIdx); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
    }

    // ===== Global hotkeys =====

    // Skip hotkeys while the user is typing somewhere — except the palette
    // opener, which should work from any field (that's the point of it).
    function inTextField(el) {
        if (!el) return false;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function onGlobalKeydown(e) {
        // Cmd+K (mac) / Ctrl+K — open the quick switcher.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (paletteOpen()) closePalette(); else openPalette();
            return;
        }
        if (paletteOpen()) return; // the palette input owns the keyboard while open

        // Ctrl+1..9 — jump to the Nth favorite. Ctrl (not Cmd) on every
        // platform: macOS browsers bind Cmd+<digit> to tab switching, and the
        // KRo.app WKWebView shell inherits enough of that to be unreliable.
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code || '')) {
            var n = parseInt((e.code || '').slice(5), 10);
            var f = favorites[n - 1];
            if (!f) return;          // no favorite in that slot: leave the key alone
            e.preventDefault();
            goTo(f.context, f.namespace);
            return;
        }

        // Ctrl+Shift+D — star/unstar the current selection without the mouse.
        if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
            if (inTextField(document.activeElement)) return;
            e.preventDefault();
            onToggleStar();
        }
    }

    // ===== Wiring =====

    // resources.js calls this after every selection change (dropdowns, chips,
    // hotkeys, palette) so the ★ and the highlighted chip stay truthful.
    window.kroFavoritesSelectionChanged = function() {
        // A switch can pin a namespace that wasn't in the palette's cached
        // target list (jumping to an ad-hoc cluster/namespace does exactly
        // that), so drop the cache and let the next open refetch. /api/targets
        // is built from the kubeconfig + state file with no cluster calls, so
        // refetching costs nothing worth caching around.
        targets = [];
        render();
    };

    document.addEventListener('DOMContentLoaded', function() {
        var star = document.getElementById('btn-fav-toggle');
        if (star) star.addEventListener('click', onToggleStar);

        var chips = document.getElementById('fav-chips');
        if (chips) {
            chips.addEventListener('click', onChipsClick);
            chips.addEventListener('dblclick', onChipsDblClick);
            chips.addEventListener('keydown', onChipsKeydown);
            chips.addEventListener('dragstart', onDragStart);
            chips.addEventListener('dragover', onDragOver);
            chips.addEventListener('dragleave', onDragLeave);
            chips.addEventListener('drop', onDrop);
            chips.addEventListener('dragend', onDragEnd);
        }

        var launch = document.getElementById('btn-fav-switcher');
        if (launch) launch.addEventListener('click', openPalette);
        var keys = document.getElementById('fav-switch-keys');
        if (keys && isMac) keys.textContent = '⌘ K';

        var input = document.getElementById('fav-palette-input');
        if (input) {
            input.addEventListener('keydown', onPaletteKeydown);
            input.addEventListener('input', function() { paletteIdx = 0; renderPalette(input.value); });
        }

        var list = document.getElementById('fav-palette-list');
        if (list) {
            list.addEventListener('click', function(e) {
                var row = e.target.closest ? e.target.closest('.fav-palette-row') : null;
                if (row) choosePalette(parseInt(row.dataset.idx, 10));
            });
            // Keep the mouse and the ↑↓ cursor pointing at the same row, so
            // Enter never fires on a row the pointer isn't over.
            list.addEventListener('mousemove', function(e) {
                var row = e.target.closest ? e.target.closest('.fav-palette-row') : null;
                if (!row) return;
                var idx = parseInt(row.dataset.idx, 10);
                if (idx !== paletteIdx) movePalette(idx - paletteIdx);
            });
        }

        var overlay = document.getElementById('fav-palette-overlay');
        if (overlay) {
            overlay.addEventListener('mousedown', function(e) {
                if (e.target === overlay) closePalette();  // click-outside closes
            });
        }

        document.addEventListener('keydown', onGlobalKeydown);

        loadFavorites();
    });
})();
