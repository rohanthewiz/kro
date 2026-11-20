// KRo — k8s resources page (vanilla JS, no frameworks)

(function() {
    'use strict';

    // ===== Dark Mode =====
    // Dark is the default; the body is rendered with the `dark` class server-side.
    // Only an explicit opt-out (darkMode === 'false') switches to the light theme.
    function initDarkMode() {
        var isDark = localStorage.getItem('darkMode') !== 'false';
        document.body.classList.toggle('dark', isDark);
        var btn = document.getElementById('btn-dark-toggle');
        if (btn) btn.textContent = isDark ? '☀️' : '🌙';
    }

    window.toggleDarkMode = function() {
        document.body.classList.toggle('dark');
        var isDark = document.body.classList.contains('dark');
        localStorage.setItem('darkMode', isDark);
        var btn = document.getElementById('btn-dark-toggle');
        if (btn) btn.textContent = isDark ? '☀️' : '🌙';
    };

    // ===== Copy commit hash (version popup) =====
    // Copies the button's data-hash to the clipboard and briefly flips the icon
    // to a checkmark (via the `copied` class). Falls back to a hidden textarea +
    // execCommand when the async Clipboard API is unavailable (e.g. non-secure
    // contexts or older WebKit).
    window.kroCopyCommitHash = function(btn) {
        var hash = btn && btn.getAttribute('data-hash');
        if (!hash) return;

        function flash() {
            btn.classList.add('copied');
            setTimeout(function() { btn.classList.remove('copied'); }, 1200);
        }
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = hash;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); flash(); } catch (e) {}
            document.body.removeChild(ta);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(hash).then(flash, fallback);
        } else {
            fallback();
        }
    };

    // ===== Selection state (mirrors server cookies) =====
    var currentCtx = '';
    var currentNs = '';

    function loadContexts() {
        return fetch('/api/contexts').then(function(r) { return r.json(); }).then(renderContexts);
    }

    // resolvedContext is the context an /api/contexts answer selects: the
    // server's cookie-resolved choice, or the first context when it had none.
    function resolvedContext(data) {
        return data.current || ((data.contexts && data.contexts[0] && data.contexts[0].name) || '');
    }

    // renderContexts repaints the context dropdown from an /api/contexts
    // answer and returns the context that ended up selected.
    function renderContexts(data) {
        var sel = document.getElementById('ctx-select');
        sel.innerHTML = '';
        (data.contexts || []).forEach(function(c) {
            var opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            sel.appendChild(opt);
        });
        currentCtx = resolvedContext(data);
        sel.value = currentCtx;
        return currentCtx;
    }

    // ----- Pick up kubeconfig changes made outside kro -----
    // /api/contexts re-reads the kubeconfig when a file changed on disk, but
    // the page only asks on load. The usual flow is: switch to a terminal,
    // run `kind create cluster` or `aws eks update-kubeconfig`, switch back.
    // Coming back focuses the window, so that is when to ask again. In
    // KRo.app there is no address bar to reload from, so without this the
    // new context would only appear after quitting and reopening the app.
    //
    // A refresh that finds nothing new leaves the dropdown alone, so this
    // costs one small request per focus and nothing visible. When the
    // context this page shows is no longer the one the server resolves
    // (the cluster's context was deleted, e.g. by `kind delete cluster`, or
    // another tab switched clusters through the shared cookie), the page
    // follows the server: requests from this page already go to the
    // server's context, so the tables must show that context too.
    //
    // Following goes through kroSwitchTarget (a full switch) rather than
    // just reloading the namespace list. When the context cookie names a
    // deleted context, the server falls back to another context but still
    // honors the namespace cookie, which belongs to the deleted one. A
    // plain reload would show the fallback cluster with a namespace it may
    // not have (and an empty namespace dropdown). The switch rewrites both
    // cookies and lands on the cluster's own last-used namespace.
    var contextsRefreshing = false;

    function refreshContexts() {
        if (contextsRefreshing) return; // focus and visibilitychange often fire together
        var sel = document.getElementById('ctx-select');
        if (!sel) return;
        contextsRefreshing = true;
        var shown = Array.prototype.map.call(sel.options, function(o) { return o.value; }).join('\n');
        fetch('/api/contexts').then(function(r) { return r.json(); }).then(function(data) {
            var names = (data.contexts || []).map(function(c) { return c.name; }).join('\n');
            var target = resolvedContext(data);
            var switched = target !== currentCtx;
            if (names === shown && !switched) return;

            // renderContexts would move currentCtx to the target as a side
            // effect; keep the page's own value until the switch below
            // commits, so a switch that fails leaves currentCtx telling the
            // truth about what the tables show.
            var shownCtx = currentCtx;
            renderContexts(data);
            currentCtx = shownCtx;
            // The palette caches its rows until a selection change; a new
            // context is a new row, so drop that cache too.
            if (window.kroContextsChanged) window.kroContextsChanged();
            if (!switched || !target) return;
            return window.kroSwitchTarget(target, '');
        }).catch(function(err) {
            console.error('refresh contexts:', err);
        }).then(function() {
            contextsRefreshing = false;
        });
    }

    // renderNsOptions repaints the NS dropdown from a namespace list and returns
    // the namespace that ended up selected. Shared by the /api/namespaces load
    // and by kroSwitchTarget (which gets the list back in its own response, so
    // a favorite jump never needs a second fetch to redraw the dropdown).
    function renderNsOptions(list, current) {
        var sel = document.getElementById('ns-select');
        var removeBtn = document.getElementById('btn-ns-remove');
        sel.innerHTML = '';
        list = list || [];
        list.forEach(function(n) {
            var opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            sel.appendChild(opt);
        });
        if (list.length === 0) {
            var opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— click + to add —';
            opt.disabled = true;
            sel.appendChild(opt);
            sel.value = '';
            if (removeBtn) removeBtn.disabled = true;
        } else {
            sel.value = current || list[0] || '';
            if (removeBtn) removeBtn.disabled = false;
        }
        return sel.value || '';
    }

    function loadNamespaces() {
        return fetch('/api/namespaces').then(function(r) { return r.json(); }).then(function(data) {
            currentNs = renderNsOptions(data.namespaces, data.current);
            // Keep the Pod Watch namespace picker in sync if it's already built
            // — the context (and thus its namespace list) may have just changed
            // while the Watch tab is the active view.
            if (window.watchPageSelectionChanged) window.watchPageSelectionChanged();
            // Favorites bar: repaint the ★ toggle and the "current" chip.
            if (window.kroFavoritesSelectionChanged) window.kroFavoritesSelectionChanged();
            return currentNs;
        });
    }

    function showNsAddInput() {
        var input = document.getElementById('ns-add-input');
        var sel = document.getElementById('ns-select');
        sel.style.display = 'none';
        input.style.display = 'inline-block';
        input.value = '';
        input.focus();
    }
    function hideNsAddInput() {
        var input = document.getElementById('ns-add-input');
        var sel = document.getElementById('ns-select');
        input.style.display = 'none';
        sel.style.display = '';
    }

    function onAddNamespace() {
        var input = document.getElementById('ns-add-input');
        var name = input.value.trim();
        if (!name) { hideNsAddInput(); return; }
        fetch('/api/namespaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: name, select: true })
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.error) { alert('Add failed: ' + data.error); return; }
            hideNsAddInput();
            loadNamespaces().then(function() {
                document.getElementById('ns-select').value = name;
                onNamespaceChange();
            });
        }).catch(function(err) { alert('Add failed: ' + err.message); });
    }

    function onRemoveNamespace() {
        var sel = document.getElementById('ns-select');
        var name = sel.value;
        if (!name) return;
        if (!confirm('Remove "' + name + '" from this cluster?\n\n(This only unpins it from KRo — the namespace itself is not deleted.)')) {
            return;
        }
        fetch('/api/namespaces?name=' + encodeURIComponent(name), { method: 'DELETE' })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.error) { alert('Remove failed: ' + data.error); return; }
                loadNamespaces().then(reloadResources);
            }).catch(function(err) { alert('Remove failed: ' + err.message); });
    }

    function selectAndReload(body) {
        return fetch('/api/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function(r) { return r.json(); }).then(function(data) {
            currentCtx = data.context || currentCtx;
            currentNs = data.namespace || currentNs;
            updateTermTarget();
            reloadResources();
            if (window.kroFavoritesSelectionChanged) window.kroFavoritesSelectionChanged();
        });
    }

    // Switching cluster from the dropdown goes through the same one-request
    // path as a favorite chip (kroSwitchTarget with no namespace), which lands
    // on the namespace that cluster last showed, else its first pinned one,
    // else its kubeconfig default.
    //
    // The previous flow here was three requests (select context -> reload
    // namespaces -> select namespace) and left the kro_ns cookie holding the
    // *old* cluster's namespace: /api/select only writes that cookie for a
    // non-empty namespace. Unless a namespace of the same name happened to be
    // pinned in the new cluster, the NS dropdown went blank and the tables
    // showed the old namespace name looked up in the new cluster.
    function onContextChange() {
        var sel = document.getElementById('ctx-select');
        var previous = currentCtx;
        window.kroSwitchTarget(sel.value, '').then(function(data) {
            // A refused switch (unknown context) leaves the selection where
            // it was; put the dropdown back so it does not lie about it.
            if (!data) sel.value = previous;
        }).catch(function(err) {
            sel.value = previous;
            alert('Switch failed: ' + err.message);
        });
    }

    // ===== Public selection API (used by favorites.js) =====

    // kroCurrentSelection mirrors the server cookies as this page last saw them.
    window.kroCurrentSelection = function() {
        return { context: currentCtx, namespace: currentNs };
    };

    // kroSwitchTarget jumps to an arbitrary (cluster, namespace) in ONE request.
    // /api/favorites/go validates the context, pins the namespace, writes both
    // cookies and hands back the new namespace list, so we can repaint both
    // dropdowns and kick off the reload without any further round trips —
    // that's what makes a chip click / Ctrl+<n> feel instant.
    // Pass an empty ns to land on whatever that cluster last showed.
    window.kroSwitchTarget = function(ctx, ns) {
        return fetch('/api/favorites/go', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: ctx || '', namespace: ns || '' })
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.error) { alert('Switch failed: ' + data.error); return null; }

            currentCtx = data.context || currentCtx;
            currentNs = renderNsOptions(data.namespaces, data.namespace);

            var ctxSel = document.getElementById('ctx-select');
            if (ctxSel) {
                ctxSel.value = currentCtx;
                // The kubeconfig may have gained contexts since this page
                // loaded (e.g. a merge in another tab); if the option isn't
                // there the assignment above silently leaves an empty select,
                // so rebuild the list and try again.
                if (ctxSel.value !== currentCtx) {
                    loadContexts().then(function() { ctxSel.value = currentCtx; });
                }
            }

            updateTermTarget();
            reloadResources();
            if (window.watchPageSelectionChanged) window.watchPageSelectionChanged();
            if (window.kroFavoritesSelectionChanged) window.kroFavoritesSelectionChanged();
            return data;
        });
    };

    function onNamespaceChange() {
        var ns = document.getElementById('ns-select').value;
        if (!ns) return;
        selectAndReload({ namespace: ns });
    }

    // ===== Tab layout =====
    // Each tab owns a list of section slugs that should render into its panel.
    // The terminal lives in the DOM as a server-rendered child of the workloads
    // panel, so it isn't listed here. "all-pods" appears in two tabs on
    // purpose (workloads and deployments) — JS routes through the same
    // sectionBuilders entry and the duplicate is handled by collapse-by-slug.
    // workloads stays first: TAB_CONFIG[0] is the default tab and the one
    // that shows cluster warnings. The watch tab owns no resource sections —
    // its panel is the Pod Watch page, built and managed by watch.js.
    var TAB_CONFIG = [
        { id: 'workloads',   sections: ['jobs', 'all-pods'] },
        { id: 'deployments', sections: ['deployments', 'deployment-pods'] },
        { id: 'networking',  sections: ['services', 'ingresses'] },
        { id: 'storage',     sections: ['pvs', 'pvcs', 'storageclasses'] },
        { id: 'sets',        sections: ['statefulsets', 'daemonsets'] },
        { id: 'config',      sections: ['configmaps', 'secrets'] },
        { id: 'watch',       sections: [] }
    ];
    var ACTIVE_TAB_KEY = 'kro_active_tab';
    var TAB_SIDEBAR_COLLAPSED_KEY = 'kro_tab_sidebar_collapsed';

    // ----- Kinds listed on demand -----
    // The server always lists the workload kinds (Jobs, Deployments,
    // ReplicaSets, StatefulSets, DaemonSets, Pods) and Services: the pod tree
    // and the summary cards need them whichever tab is showing. The kinds
    // below are each shown by one tab and are listed only while that tab is
    // active, so a snapshot taken for the Pods tab no longer fetches every
    // Secret and ConfigMap in the namespace (data included) to count keys.
    //
    //   active tab ──► tabKinds() ──► ?kinds=configmaps,secrets ──► server
    //                                                                 │
    //   section builders ◄── treeCarries(tree, kind) ◄── tree.kinds ◄─┘
    //
    // Section slug -> the kind it renders. The kind name serves both ends: it
    // is the API resource name the server is asked for and the tree field the
    // section reads (kube.kindTable keeps the two equal).
    var SECTION_ON_DEMAND_KIND = {
        'ingresses':      'ingresses',
        'pvs':            'persistentvolumes',
        'pvcs':           'persistentvolumeclaims',
        'storageclasses': 'storageclasses',
        'configmaps':     'configmaps',
        'secrets':        'secrets'
    };

    // The tab on screen. Kept in a variable (set by switchTab) rather than
    // re-read from localStorage, which may be unavailable.
    var activeTabId = TAB_CONFIG[0].id;

    // The on-demand kinds a tab's sections render, sorted, so the joined
    // string is a stable key: tabs that need the same kinds (every tab that
    // shows only core kinds needs none) share one stream.
    function tabKinds(tabId) {
        var kinds = [];
        TAB_CONFIG.forEach(function(t) {
            if (t.id !== tabId) return;
            t.sections.forEach(function(slug) {
                var k = SECTION_ON_DEMAND_KIND[slug];
                if (k && kinds.indexOf(k) === -1) kinds.push(k);
            });
        });
        return kinds.sort();
    }

    function activeKindsKey() { return tabKinds(activeTabId).join(','); }

    // Query string for /api/resources and /sse/resources. Always sent, even
    // when empty ("?kinds=" = core kinds only): an absent parameter makes the
    // server list every kind, which it keeps for curl and for a page loaded
    // before the parameter existed.
    function kindsQuery(key) { return '?kinds=' + encodeURIComponent(key); }

    // Whether tree was listed with kind. A tree with no kinds list comes from
    // a server that predates on-demand kinds, and those listed everything.
    function treeCarries(tree, kind) {
        return !tree || !tree.kinds || tree.kinds.indexOf(kind) !== -1;
    }

    window.toggleTabSidebar = function() {
        var bar = document.getElementById('tab-sidebar');
        if (!bar) return;
        var nowCollapsed = !bar.classList.contains('collapsed');
        bar.classList.toggle('collapsed', nowCollapsed);
        if (nowCollapsed) localStorage.setItem(TAB_SIDEBAR_COLLAPSED_KEY, '1');
        else localStorage.removeItem(TAB_SIDEBAR_COLLAPSED_KEY);
        var btn = document.getElementById('tab-collapse-toggle');
        if (btn) {
            btn.setAttribute('aria-label', nowCollapsed ? 'Expand tab sidebar' : 'Collapse tab sidebar');
            btn.setAttribute('title', nowCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
        }
    };

    function initTabSidebarCollapsed() {
        if (localStorage.getItem(TAB_SIDEBAR_COLLAPSED_KEY) !== '1') return;
        var bar = document.getElementById('tab-sidebar');
        if (bar) bar.classList.add('collapsed');
        var btn = document.getElementById('tab-collapse-toggle');
        if (btn) {
            btn.setAttribute('aria-label', 'Expand tab sidebar');
            btn.setAttribute('title', 'Expand sidebar');
        }
    }

    function getActiveTab() {
        var saved = localStorage.getItem(ACTIVE_TAB_KEY);
        for (var i = 0; i < TAB_CONFIG.length; i++) {
            if (TAB_CONFIG[i].id === saved) return saved;
        }
        return TAB_CONFIG[0].id;
    }

    window.switchTab = function(id) {
        var btns = document.querySelectorAll('.tab-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', btns[i].getAttribute('data-tab') === id);
        }
        var panels = document.querySelectorAll('.tab-panel');
        for (var j = 0; j < panels.length; j++) {
            panels[j].classList.toggle('active', panels[j].getAttribute('data-tab-panel') === id);
        }
        localStorage.setItem(ACTIVE_TAB_KEY, id);
        activeTabId = id;
        // The Pod Watch page (watch.js) connects its status stream only while
        // its tab is visible; tee frames persist across switches.
        if (id === 'watch') {
            if (window.watchPageActivate) window.watchPageActivate();
        } else if (window.watchPageDeactivate) {
            window.watchPageDeactivate();
        }
        retargetResourcesStream();
    };

    // Reopen the resources stream when the active tab renders different
    // on-demand kinds than the open stream lists. Its first event is a full
    // snapshot, so the tab fills as soon as that one list round returns; no
    // one-shot fetch is needed alongside. Moving between tabs that need the
    // same kinds (Pods, Deployments, Sets, Watch) keeps the stream as it is.
    //
    // Only an open stream is retargeted. Before the first load, while paused
    // (window hidden) and while a heartbeat reconnect is pending, there is
    // none, and whatever opens it next reads the active tab itself.
    function retargetResourcesStream() {
        if (!resourcesSource || resourcesStreamKinds === activeKindsKey()) return;
        initResourcesStream();
    }

    function initTabs() {
        var btns = document.querySelectorAll('.tab-btn');
        for (var i = 0; i < btns.length; i++) {
            (function(btn) {
                btn.addEventListener('click', function() {
                    window.switchTab(btn.getAttribute('data-tab'));
                });
            })(btns[i]);
        }
        window.switchTab(getActiveTab());
        initTabSidebarCollapsed();
    }

    // ===== Resource Display =====
    //
    // Render state. A snapshot arrives every ~10s, and each one used to replace
    // every tab's markup outright, which reset whatever the user was doing:
    // expanded rows collapsed, a focused filter lost focus, a text selection
    // vanished, a click landing mid-rebuild was lost. The pieces below make a
    // background snapshot invisible unless something on screen changed:
    //
    //   snapshot ──► applyTree ──► stale scope? ── yes ──► drop
    //                    │
    //                    ├─ user mid-click / selecting text? ── yes ──► pendingTree
    //                    │                                   (rendered on release)
    //                    └─ renderTree ──► rebuildTables ──► per tab:
    //                                         HTML same as tabHtmlCache? ──► skip
    //                                         else replace, restore filter focus
    //
    // Expanded rows live in expandedRows (keyed by kind and name, so they
    // survive both a re-render and a reordering) rather than in DOM classes.
    var lastTree = null;      // tree currently on screen for this selection
    var pendingTree = null;   // newest snapshot held back by an interaction
    var tabHtmlCache = {};    // tab id -> HTML last written into its panel
    var expandedRows = {};    // row key -> true for expanded parent rows

    // force skips the interaction hold: an explicit Refresh click should show
    // its result even if some text happens to be selected.
    function applyTree(tree, force) {
        var anchor = document.getElementById('tab-sections-workloads');
        if (!anchor) return;
        if (tree.error) {
            showResourcesError(tree.error);
            return;
        }
        // A response for a selection the user has since left (a slow list
        // finishing after a namespace switch) must not paint over the new
        // one. Only enforced when both sides are known; an empty side means
        // "cannot tell", and dropping then could strand the page on Loading.
        if (tree.context && tree.namespace && currentCtx && currentNs &&
            (tree.context !== currentCtx || tree.namespace !== currentNs)) {
            return;
        }
        // A tree listed for another tab (a refresh still in flight when the
        // tab changed) lacks kinds this tab renders. Painting it would put
        // "Loading" back over rows the retargeted stream already delivered,
        // and that stream would then only tick (nothing changed on its side),
        // leaving the panel stuck. The open stream lists what this tab needs,
        // so dropping the tree loses nothing.
        var wanted = tabKinds(activeTabId);
        if (!wanted.every(function(k) { return treeCarries(tree, k); })) return;
        // The interaction hold keeps rows from changing under the user. A
        // tree bringing a kind the screen has no rows for yet (the first
        // snapshot after switching to Config, say) is let through: the panel
        // it fills shows only a Loading placeholder, and rebuildTables leaves
        // a panel whose markup is unchanged untouched, so a text selection
        // left in another tab usually survives. Holding it instead would
        // keep the new tab on Loading until that selection is released.
        var bringsKinds = !!lastTree && wanted.some(function(k) {
            return !treeCarries(lastTree, k);
        });
        if (!force && !bringsKinds && interactionActive()) {
            pendingTree = tree; // newest wins; older held snapshots are obsolete
            updateStatusTitle(); // the dot's tooltip says an update is waiting
            return;
        }
        renderTree(tree);
    }

    function renderTree(tree) {
        pendingTree = null;
        lastTree = tree;
        updateStatusTitle(); // clears any "update is waiting" note
        clearResourcesBanner();
        rebuildTables(tree);
        var totalPods = countPods(tree);
        updateSummary(
            (tree.jobs || []).length,
            (tree.deployments || []).length,
            totalPods,
            (tree.services || []).length
        );
    }

    // ----- Interaction hold -----
    // True while replacing the tables would step on the user: a mouse button
    // is down inside a resource panel (a rebuild between mousedown and mouseup
    // swaps the element under the pointer, so the click never fires), or text
    // is selected there (a rebuild destroys the selection before it can be
    // copied). Scoped to the .tab-sections containers, so a selection in the
    // terminal or a Pod Watch frame never stalls the tables.
    var tabMouseDownAt = 0; // ms timestamp of a mousedown inside a panel; 0 = up
    var MOUSE_HOLD_MAX_MS = 15000;

    function inTabSections(node) {
        while (node && node.nodeType !== 1) node = node.parentNode;
        return !!(node && node.closest && node.closest('.tab-sections'));
    }

    function interactionActive() {
        // The age cap is a failsafe: a mouseup can be missed (released
        // outside the window on some platforms), and a stuck flag would
        // otherwise freeze the tables until reload.
        if (tabMouseDownAt && Date.now() - tabMouseDownAt < MOUSE_HOLD_MAX_MS) return true;
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
        return inTabSections(sel.anchorNode);
    }

    function flushPendingTree() {
        if (pendingTree && !interactionActive()) renderTree(pendingTree);
    }

    document.addEventListener('mousedown', function(e) {
        if (inTabSections(e.target)) tabMouseDownAt = Date.now();
    }, true);
    window.addEventListener('mouseup', function() {
        if (!tabMouseDownAt) return;
        tabMouseDownAt = 0;
        // Deferred so the click this mouseup completes runs against the
        // elements it was aimed at, before any held snapshot replaces them.
        setTimeout(flushPendingTree, 0);
    }, true);
    window.addEventListener('blur', function() { tabMouseDownAt = 0; });
    document.addEventListener('selectionchange', flushPendingTree);

    // ----- Banner / errors -----
    // A failed refresh keeps the last good tables on screen under a banner
    // rather than replacing them with an error: for a blip, slightly stale
    // rows are more useful than none. Only when nothing has been rendered for
    // this selection does the error take the tables' place.
    function showResourcesError(msg) {
        if (!lastTree) {
            renderErrorAcrossTabs(msg);
            updateSummary('-', '-', '-', '-');
            return;
        }
        var el = document.getElementById('resources-banner');
        if (!el) return;
        el.textContent = '⚠ ' + msg + ' — showing the last data received (' +
            formatClock(lastGoodAt) + '); retrying.';
        el.style.display = '';
    }

    function clearResourcesBanner() {
        var el = document.getElementById('resources-banner');
        if (el) { el.style.display = 'none'; el.textContent = ''; }
    }

    function formatClock(ms) {
        if (!ms) return 'unknown time';
        return new Date(ms).toLocaleTimeString();
    }

    function renderErrorAcrossTabs(msg) {
        var safe = escapeHtml(msg);
        for (var i = 0; i < TAB_CONFIG.length; i++) {
            var el = document.getElementById('tab-sections-' + TAB_CONFIG[i].id);
            if (el) el.innerHTML = '<div class="empty-state">' + safe + '</div>';
        }
        tabHtmlCache = {}; // panels no longer hold what the cache says
    }

    function showLoadingAcrossTabs() {
        for (var i = 0; i < TAB_CONFIG.length; i++) {
            var el = document.getElementById('tab-sections-' + TAB_CONFIG[i].id);
            if (el) el.innerHTML = '<div class="loading">Loading resources</div>';
        }
        tabHtmlCache = {};
    }

    // Forget everything rendered for the previous selection. Called when the
    // cluster or namespace changes: the old rows, their expand state and any
    // held snapshot all belong to somewhere the user has left.
    function resetResourceView() {
        lastTree = null;
        pendingTree = null;
        expandedRows = {};
        lastGoodAt = 0;
        clearResourcesBanner();
        showLoadingAcrossTabs();
    }

    // The selection changed: clear the view, fetch once, (re)open the stream.
    // The one-shot fetch is kept alongside the stream on purpose. It reports
    // an HTTP error with its cause straight away, where a stream that cannot
    // connect only shows as an amber dot.
    function reloadResources() {
        resetResourceView();
        window.refreshResources();
        initResourcesStream();
    }

    // Manual refresh (the header button, and after a delete). Tables already
    // on screen stay put while the request is out, instead of flashing back
    // to "Loading"; the button dims so the click visibly registered.
    window.refreshResources = function() {
        if (!lastTree) showLoadingAcrossTabs();
        var btn = document.getElementById('btn-refresh');
        if (btn) btn.classList.add('busy');

        fetch('/api/resources' + kindsQuery(activeKindsKey()))
        .then(function(r) { return r.json(); })
        .then(function(tree) {
            if (!tree.error) noteResourcesFresh();
            applyTree(tree, true);
        })
        .catch(function(err) {
            showResourcesError('Failed to fetch resources: ' + err.message);
        })
        .then(function() { if (btn) btn.classList.remove('busy'); });
    };

    function countPods(tree) {
        var count = (tree.orphan_pods || []).length;
        (tree.jobs || []).forEach(function(j) { count += (j.children || []).length; });
        (tree.deployments || []).forEach(function(d) {
            (d.children || []).forEach(function(rs) {
                if (rs.kind === 'Pod') count++;
                else count += (rs.children || []).length;
            });
        });
        (tree.statefulsets || []).forEach(function(s) { count += (s.children || []).length; });
        (tree.daemonsets || []).forEach(function(s) { count += (s.children || []).length; });
        return count;
    }

    function updateSummary(jobs, deploys, pods, services) {
        setText('summary-jobs', jobs);
        setText('summary-deployments', deploys);
        setText('summary-pods', pods);
        setText('summary-services', services);
    }

    function setText(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    // Compute the flat "All Pods" list once per refresh. Every workload kind
    // contributes its child pods plus any orphans, sorted by name.
    //
    // Each entry is {pod, owner} rather than a bare pod: the owning controller
    // is only knowable while walking down the tree, and the Owner column is
    // what lets this single listing subsume the old separate "Pods (orphan)"
    // section — an orphan is simply a row with an empty owner.
    //
    //   jobs        -> job/<name>
    //   deployments -> rs/<name>      (or deploy/<name> for a direct child pod)
    //   statefulsets-> sts/<name>
    //   daemonsets  -> ds/<name>
    //   orphan_pods -> ''             (rendered as an em dash)
    function buildAllPods(tree) {
        var all = [];
        function add(pod, owner) { all.push({ pod: pod, owner: owner }); }

        (tree.jobs || []).forEach(function(job) {
            (job.children || []).forEach(function(p) { add(p, 'job/' + job.name); });
        });
        (tree.deployments || []).forEach(function(d) {
            (d.children || []).forEach(function(rs) {
                // A deployment child is normally a ReplicaSet, but the tree
                // hands back a bare Pod when the RS could not be resolved.
                if (rs.kind === 'Pod') { add(rs, 'deploy/' + d.name); return; }
                (rs.children || []).forEach(function(p) { add(p, 'rs/' + rs.name); });
            });
        });
        (tree.statefulsets || []).forEach(function(s) {
            (s.children || []).forEach(function(p) { add(p, 'sts/' + s.name); });
        });
        (tree.daemonsets || []).forEach(function(s) {
            (s.children || []).forEach(function(p) { add(p, 'ds/' + s.name); });
        });
        (tree.orphan_pods || []).forEach(function(p) { add(p, ''); });

        all.sort(function(a, b) { return (a.pod.name || '').localeCompare(b.pod.name || ''); });
        return all;
    }

    // Deployment-owned pods only, for the deployments tab. Same {pod, owner}
    // shape as buildAllPods so both sections share the row/filter machinery.
    function buildDeploymentPods(tree) {
        var out = [];
        (tree.deployments || []).forEach(function(d) {
            (d.children || []).forEach(function(rs) {
                if (rs.kind === 'Pod') { out.push({ pod: rs, owner: 'deploy/' + d.name }); return; }
                (rs.children || []).forEach(function(p) { out.push({ pod: p, owner: 'rs/' + rs.name }); });
            });
        });
        out.sort(function(a, b) { return (a.pod.name || '').localeCompare(b.pod.name || ''); });
        return out;
    }

    // Shared body for the two flat pod listings: filter bar, owner-aware table,
    // and the hidden "no matches" row the filter reveals.
    function podListSection(slug, title, entries, emptyText) {
        if (entries.length === 0) {
            return sectionShell(slug, title, 0,
                '<div class="table-wrapper"><div class="empty-state">' + emptyText + '</div></div>');
        }
        // The filter bar lives inside the section but outside the
        // table-wrapper, so the collapse rule has to hide it explicitly —
        // see resources.css.
        var body = podFilterBar(slug) +
            '<div class="table-wrapper"><table>' + tableHead(true) + '<tbody>';
        entries.forEach(function(e) { body += parentRow('', e.pod, false, e.owner); });
        // Placeholder row shown only when a filter matches nothing; keeping it
        // in the DOM avoids re-rendering the table on every keystroke.
        body += '<tr class="pod-filter-empty" style="display:none"><td colspan="12">' +
            '<div class="empty-state">No pods match the filter</div></td></tr>';
        body += '</tbody></table></div>';
        return sectionShell(slug, title, entries.length, body);
    }

    // ===== Pod list filters =====
    // Filter text is module state keyed by section slug, not DOM state: the
    // pod listings re-render wholesale on every refresh/SSE push, and "All
    // Pods" appears in more than one place, so applyPodFilter() restores the
    // user's query after any rebuild instead of silently clearing it.
    var POD_FILTER_SLUGS = ['all-pods', 'deployment-pods'];
    var podFilters = {};

    // The bar's markup deliberately carries no filter state (no value="",
    // no "filtering" class): applyPodFilter() sets both on the live elements
    // after every rebuild. Baking the query into the HTML would make each
    // keystroke change the tab's markup, defeating the unchanged-tab check in
    // rebuildTables and forcing a rebuild on the next snapshot.
    function podFilterBar(slug) {
        return '<div class="pod-filter-bar">' +
            '<span class="pod-filter-icon">\u2315</span>' +
            '<input type="text" class="pod-filter-input" placeholder="Filter pods by name or owner\u2026  ( / )" ' +
            'oninput="onPodFilterInput(\'' + slug + '\', this.value)" ' +
            'onkeydown="if (event.key === \'Escape\') { onPodFilterInput(\'' + slug + '\', \'\'); this.blur(); }">' +
            '<button type="button" class="pod-filter-clear" title="Clear filter (Esc)" ' +
            'onclick="onPodFilterInput(\'' + slug + '\', \'\')">\u00d7</button>' +
            '</div>';
    }

    window.onPodFilterInput = function(slug, value) {
        podFilters[slug] = value || '';
        applyPodFilter(slug);
    };

    // Hide/show rows in every rendered instance of a pod listing and keep the
    // header count in sync ("matched / total" while filtering). Matching is a
    // case-insensitive substring test over the pod name and its owner — cheap
    // enough per keystroke at these row counts, and matching the owner is what
    // makes "rs/foo" or a bare owner-less pod findable now that orphans live in
    // the same table.
    function applyPodFilter(slug) {
        var slugs = slug ? [slug] : POD_FILTER_SLUGS;
        slugs.forEach(function(sl) {
            var q = (podFilters[sl] || '').trim().toLowerCase();
            var sections = document.querySelectorAll('[data-section="' + sl + '"]');
            for (var i = 0; i < sections.length; i++) {
                var sec = sections[i];

                // Re-sync sibling inputs (a mirror in another tab, or one just
                // recreated by a rebuild) without clobbering the caret of the
                // input currently being typed in.
                var inputs = sec.querySelectorAll('.pod-filter-input');
                for (var k = 0; k < inputs.length; k++) {
                    if (inputs[k] !== document.activeElement && inputs[k].value !== q0(sl)) {
                        inputs[k].value = q0(sl);
                    }
                }
                var bar = sec.querySelector('.pod-filter-bar');
                if (bar) bar.classList.toggle('filtering', q.length > 0);

                var rows = sec.querySelectorAll('tbody tr');
                var total = 0, shown = 0;
                for (var j = 0; j < rows.length; j++) {
                    var row = rows[j];
                    if (row.className.indexOf('pod-filter-empty') !== -1) continue;
                    total++;
                    var nameCell = row.querySelector('.resource-name');
                    var ownerCell = row.querySelector('.resource-owner');
                    var hay = ((nameCell ? nameCell.textContent : '') + ' ' +
                               (ownerCell ? ownerCell.textContent : '')).toLowerCase();
                    var match = !q || hay.indexOf(q) !== -1;
                    row.style.display = match ? '' : 'none';
                    if (match) shown++;
                }

                var emptyRow = sec.querySelector('.pod-filter-empty');
                if (emptyRow) emptyRow.style.display = (total > 0 && shown === 0) ? '' : 'none';

                var count = sec.querySelector('.section-count');
                if (count) count.textContent = q ? (shown + ' / ' + total) : total;
            }
        });
    }

    // Raw (untrimmed) filter text for a slug — what the input should display.
    function q0(slug) { return podFilters[slug] || ''; }

    // SECTION_BUILDERS maps a section slug to the function that renders its
    // HTML. Builders are invoked per-tab; when a section appears in two tabs
    // (e.g. "all-pods" in workloads and deployments) we render twice but the
    // collapse state is keyed only by slug, so the two stay in sync.
    var SECTION_BUILDERS = {
        'jobs': function(ctx) {
            return sectionHierarchical('jobs', 'Jobs', ctx.tree.jobs || [], 'job');
        },
        'all-pods': function(ctx) {
            // Orphans are part of this list (owner column shows an em dash),
            // which is why no tab mounts 'pods-orphan' any more.
            return podListSection('all-pods', 'All Pods', ctx.allPods, 'No pods found');
        },
        'deployment-pods': function(ctx) {
            return podListSection('deployment-pods', 'Deployment Pods', ctx.deploymentPods,
                'No deployment pods found');
        },
        // Retained but unmounted: "Pods (orphan)" was folded into All Pods via
        // the Owner column. Kept here in case a tab wants the isolated view
        // back — add 'pods-orphan' to that tab's sections in TAB_CONFIG.
        'pods-orphan': function(ctx) {
            var orphans = ctx.tree.orphan_pods || [];
            if (orphans.length === 0) return '';
            var body = '<div class="table-wrapper"><table>' + tableHead() + '<tbody>';
            orphans.forEach(function(pod) { body += parentRow('', pod, false); });
            body += '</tbody></table></div>';
            return sectionShell('pods-orphan', 'Pods (orphan)', orphans.length, body);
        },
        'deployments': function(ctx) {
            return sectionDeployments(ctx.tree.deployments || []);
        },
        'statefulsets': function(ctx) {
            return sectionHierarchical('statefulsets', 'StatefulSets', ctx.tree.statefulsets || [], 'sts');
        },
        'daemonsets': function(ctx) {
            return sectionHierarchical('daemonsets', 'DaemonSets', ctx.tree.daemonsets || [], 'ds');
        },
        'services': function(ctx) {
            return flatSection('services', 'Services', ctx.tree.services || []);
        },
        // The sections below render on-demand kinds (SECTION_ON_DEMAND_KIND):
        // a tree listed for another tab does not carry them.
        'ingresses': function(ctx) {
            return onDemandSection(ctx, 'ingresses', 'Ingresses');
        },
        'pvs': function(ctx) {
            return onDemandSection(ctx, 'pvs', 'PersistentVolumes');
        },
        'pvcs': function(ctx) {
            return onDemandSection(ctx, 'pvcs', 'PersistentVolumeClaims');
        },
        'storageclasses': function(ctx) {
            return onDemandSection(ctx, 'storageclasses', 'StorageClasses');
        },
        'configmaps': function(ctx) {
            return onDemandSection(ctx, 'configmaps', 'ConfigMaps');
        },
        'secrets': function(ctx) {
            return onDemandSection(ctx, 'secrets', 'Secrets');
        }
    };

    // A flat section for an on-demand kind. When the tree was not listed with
    // that kind, its empty field says nothing about the namespace, so the
    // section says Loading instead of "No secrets found". That is also the
    // truth: a tab showing this section has asked for the kind (switchTab
    // retargets the stream), and only hidden tabs keep the placeholder.
    function onDemandSection(ctx, slug, title) {
        var kind = SECTION_ON_DEMAND_KIND[slug];
        if (!treeCarries(ctx.tree, kind)) {
            return sectionShell(slug, title, '…',
                '<div class="table-wrapper"><div class="loading">Loading ' +
                title.toLowerCase() + '</div></div>');
        }
        return flatSection(slug, title, ctx.tree[kind] || []);
    }

    // Maps a resource kind (as it appears in a warning message) to the tab
    // that owns it, so an RBAC warning surfaces on the relevant panel instead
    // of piling every kind's warning onto the Pods view.
    var WARNING_TAB_BY_KIND = {
        'Jobs': 'workloads',
        'Pods': 'workloads',
        'Deployments': 'deployments',
        'ReplicaSets': 'deployments',
        'StatefulSets': 'sets',
        'DaemonSets': 'sets',
        'Services': 'networking',
        'Ingresses': 'networking',
        'ConfigMaps': 'config',
        'Secrets': 'config',
        'PersistentVolumes': 'storage',
        'PersistentVolumeClaims': 'storage',
        'StorageClasses': 'storage'
    };

    // Messages look like "Could not list <Kind> — check RBAC permissions".
    // Unknown kinds fall back to the first tab so nothing is silently dropped.
    function warningTabId(w) {
        var m = /Could not list (\w+)/.exec(w);
        if (m && WARNING_TAB_BY_KIND[m[1]]) return WARNING_TAB_BY_KIND[m[1]];
        return TAB_CONFIG[0].id;
    }

    function warningsBarHTML(list) {
        if (!list || list.length === 0) return '';
        var html = '<div class="warnings-bar">';
        list.forEach(function(w) {
            html += '<div class="warning-item">⚠ ' + escapeHtml(w) + '</div>';
        });
        return html + '</div>';
    }

    function rebuildTables(tree) {
        var ctx = { tree: tree, allPods: buildAllPods(tree), deploymentPods: buildDeploymentPods(tree) };

        // Group warnings by the tab whose resources they concern, so each
        // panel only shows the RBAC gaps relevant to what it renders.
        var warningsByTab = {};
        (tree.warnings || []).forEach(function(w) {
            var id = warningTabId(w);
            (warningsByTab[id] = warningsByTab[id] || []).push(w);
        });

        for (var i = 0; i < TAB_CONFIG.length; i++) {
            var tab = TAB_CONFIG[i];
            var anchor = document.getElementById('tab-sections-' + tab.id);
            if (!anchor) continue;
            var html = warningsBarHTML(warningsByTab[tab.id]);
            for (var j = 0; j < tab.sections.length; j++) {
                var builder = SECTION_BUILDERS[tab.sections[j]];
                if (builder) html += builder(ctx);
            }
            // Most snapshots change nothing a given tab shows. Comparing the
            // generated markup with what was last written is a cheap exact
            // diff, and skipping the write leaves that panel's DOM (hover,
            // focus, scroll) completely untouched.
            if (tabHtmlCache[tab.id] === html) continue;
            var focus = captureFilterFocus(anchor);
            anchor.innerHTML = html;
            tabHtmlCache[tab.id] = html;
            restoreFilterFocus(anchor, focus);
        }

        // Rebuilt sections come back with empty filter inputs and every row
        // shown; reapply the active queries (also re-syncs untouched tabs,
        // which costs little at these row counts).
        applyPodFilter();
    }

    // If the pod filter inside anchor has focus, remember which one and where
    // the caret is, so a rebuild in the middle of typing can hand both back
    // to the replacement input. Returns null when focus is elsewhere.
    function captureFilterFocus(anchor) {
        var ae = document.activeElement;
        if (!ae || !ae.classList || !ae.classList.contains('pod-filter-input') || !anchor.contains(ae)) return null;
        var sec = ae.closest('[data-section]');
        if (!sec) return null;
        return { slug: sec.getAttribute('data-section'), start: ae.selectionStart, end: ae.selectionEnd };
    }

    function restoreFilterFocus(anchor, focus) {
        if (!focus) return;
        var input = anchor.querySelector('[data-section="' + focus.slug + '"] .pod-filter-input');
        if (!input) return; // the section emptied out; nothing to refocus
        // Set the text before focusing: applyPodFilter() leaves the focused
        // input alone (so it never fights the caret), which means nothing
        // else would fill this fresh, empty element.
        input.value = q0(focus.slug);
        input.focus();
        try { input.setSelectionRange(focus.start, focus.end); } catch (_) { /* caret stays at the end */ }
    }

    // ===== Section collapse/expand =====
    // Per-section collapsed state persists in localStorage so refreshes / SSE
    // re-renders don't lose user intent. Key: kro_collapsed_<slug>.
    var COLLAPSE_KEY_PREFIX = 'kro_collapsed_';

    // Sections whose builder is kept in SECTION_BUILDERS but which no tab
    // mounts any more. Their collapse flags would otherwise sit in
    // localStorage forever, so they are dropped once per page load — but only
    // while no TAB_CONFIG entry mounts the slug, so re-mounting one (as the
    // 'pods-orphan' builder comment invites) keeps the user's flag from then
    // on. This is an explicit list rather than "any kro_collapsed_* key not in
    // TAB_CONFIG": sections outside the tabs ('terminal', rendered by
    // pages.go) share the prefix and must keep their state.
    var RETIRED_SECTION_SLUGS = ['pods-orphan'];

    (function pruneRetiredCollapseKeys() {
        try {
            RETIRED_SECTION_SLUGS.forEach(function(slug) {
                var mounted = TAB_CONFIG.some(function(t) { return t.sections.indexOf(slug) !== -1; });
                if (!mounted) localStorage.removeItem(COLLAPSE_KEY_PREFIX + slug);
            });
        } catch (_) { /* storage unavailable: nothing to prune */ }
    })();

    function isCollapsed(slug) {
        return localStorage.getItem(COLLAPSE_KEY_PREFIX + slug) === '1';
    }

    window.toggleSection = function(slug) {
        // A section may render in more than one tab (e.g. "all-pods" lives in
        // both the workloads and deployments panels). Toggle all instances so
        // collapse state stays consistent across tabs and matches the
        // localStorage flag we persist below.
        var els = document.querySelectorAll('[data-section="' + slug + '"]');
        if (!els.length) return;
        var nowCollapsed = !els[0].classList.contains('collapsed');
        for (var i = 0; i < els.length; i++) {
            els[i].classList.toggle('collapsed', nowCollapsed);
        }
        if (nowCollapsed) localStorage.setItem(COLLAPSE_KEY_PREFIX + slug, '1');
        else localStorage.removeItem(COLLAPSE_KEY_PREFIX + slug);
    };

    // sectionShell wraps a body in a collapsible section with a clickable header.
    // body should be a complete .table-wrapper (or empty-state) string.
    function sectionShell(slug, title, count, body) {
        var collapsed = isCollapsed(slug) ? ' collapsed' : '';
        return '<div class="resource-section' + collapsed + '" data-section="' + slug + '">' +
            '<div class="section-header" onclick="toggleSection(\'' + slug + '\')">' +
            '<span class="section-chevron">▸</span>' +
            '<h2>' + title + '</h2>' +
            '<span class="section-count">' + count + '</span>' +
            '</div>' + body + '</div>';
    }

    function sectionHierarchical(slug, title, items, idPrefix) {
        var body;
        if (items.length > 0) {
            body = '<div class="table-wrapper"><table>' + tableHead() + '<tbody>';
            items.forEach(function(item) {
                var parentId = rowKey(idPrefix, item);
                var hasChildren = item.children && item.children.length > 0;
                var open = hasChildren && !!expandedRows[parentId];
                body += parentRow(parentId, item, hasChildren, undefined, open);
                if (hasChildren) {
                    item.children.forEach(function(pod) {
                        body += childRow(parentId, pod, 'child-row' + (open ? ' visible' : ''));
                    });
                }
            });
            body += '</tbody></table></div>';
        } else {
            body = '<div class="table-wrapper"><div class="empty-state">No ' + title.toLowerCase() + ' found</div></div>';
        }
        return sectionShell(slug, title, items.length, body);
    }

    function sectionDeployments(deploys) {
        var body;
        if (deploys.length > 0) {
            body = '<div class="table-wrapper"><table>' + tableHead() + '<tbody>';
            deploys.forEach(function(deploy) {
                var parentId = rowKey('deploy', deploy);
                var hasChildren = deploy.children && deploy.children.length > 0;
                var open = hasChildren && !!expandedRows[parentId];
                body += parentRow(parentId, deploy, hasChildren, undefined, open);
                if (hasChildren) {
                    deploy.children.forEach(function(rs) {
                        // Nested under the parent's key, so collapsing the
                        // Deployment can clear its ReplicaSets by prefix.
                        var rsId = rowKey(parentId, rs);
                        var rsHasChildren = rs.children && rs.children.length > 0;
                        var rsOpen = open && rsHasChildren && !!expandedRows[rsId];
                        body += childRowExpandable(parentId, rsId, rs, rsHasChildren, open, rsOpen);
                        if (rsHasChildren) {
                            rs.children.forEach(function(pod) {
                                body += childRow(rsId, pod, 'grandchild-row' + (rsOpen ? ' visible' : ''));
                            });
                        }
                    });
                }
            });
            body += '</tbody></table></div>';
        } else {
            body = '<div class="table-wrapper"><div class="empty-state">No deployments found</div></div>';
        }
        return sectionShell('deployments', 'Deployments &amp; ReplicaSets', deploys.length, body);
    }

    function flatSection(slug, title, items) {
        var body;
        if (items.length > 0) {
            body = '<div class="table-wrapper"><table>' + flatTableHead() + '<tbody>';
            items.forEach(function(it) {
                body += '<tr>' +
                    '<td class="resource-name">' + escapeHtml(it.name) + '</td>' +
                    '<td>' + kindBadge(it.kind) + '</td>' +
                    '<td>' + escapeHtml(it.status || '-') + '</td>' +
                    '<td>' + escapeHtml(it.extra || '-') + '</td>' +
                    '<td>' + escapeHtml(it.age || '-') + '</td>' +
                    '<td><button class="btn-describe" onclick="describeResource(\'' +
                        escapeHtml(it.kind) + '\', \'' + escapeAttr(it.name) + '\')">Describe</button></td>' +
                    '</tr>';
            });
            body += '</tbody></table></div>';
        } else {
            body = '<div class="table-wrapper"><div class="empty-state">No ' + title.toLowerCase() + ' found</div></div>';
        }
        return sectionShell(slug, title, items.length, body);
    }

    // withOwner adds an Owner column (used by the flat pod listings, where the
    // controller isn't implied by an enclosing parent row).
    function tableHead(withOwner) {
        return '<thead><tr>' +
            '<th></th><th>Name</th><th>Kind</th>' +
            (withOwner ? '<th>Owner</th>' : '') +
            '<th>Status</th><th>Ready / Completions</th>' +
            '<th>Age</th>' +
            '<th title="Sum of container CPU limits from the pod spec (* = from spec, not live usage)">CPU</th>' +
            '<th title="Sum of container memory limits from the pod spec (* = from spec, not live usage)">Memory</th>' +
            '<th>Node</th><th>Restarts</th><th>Actions</th>' +
            '</tr></thead>';
    }

    function flatTableHead() {
        return '<thead><tr>' +
            '<th>Name</th><th>Kind</th><th>Status</th><th>Detail</th><th>Age</th><th>Actions</th>' +
            '</tr></thead>';
    }

    function actionButtons(kind, name) {
        var btns = '<button class="btn-describe" onclick="event.stopPropagation(); describeResource(\'' +
            escapeHtml(kind) + '\', \'' + escapeAttr(name) + '\')">Describe</button>';
        if (kind === 'Pod') {
            btns += '<button class="btn-logs" onclick="event.stopPropagation(); viewLogs(\'' +
                escapeAttr(name) + '\')">Logs</button>';
            btns += '<button class="btn-metrics" onclick="event.stopPropagation(); viewMetrics(\'' +
                escapeAttr(name) + '\')">Metrics</button>';
        }
        if (kind === 'Job' || kind === 'Pod' || kind === 'Deployment' || kind === 'ReplicaSet') {
            btns += '<button class="btn-delete" onclick="event.stopPropagation(); deleteResource(\'' +
                escapeHtml(kind) + '\', \'' + escapeAttr(name) + '\')">Delete</button>';
        }
        return btns;
    }

    // rowKey names an expandable row by what it is rather than where it sits:
    // "<scope>/<Kind>:<name>". Rows used to be identified by list index
    // ("deploy-0"), so the expanded state could not survive a re-render in
    // which the list order changed, and it lived only in DOM classes that a
    // rebuild discards. Kubernetes names cannot contain quotes, slashes or
    // colons, so the key is safe inside the inline onclick below and
    // unambiguous as a prefix.
    function rowKey(scope, res) {
        return scope + '/' + (res.kind || '') + ':' + (res.name || '');
    }

    // owner is optional: pass a controller ref ('rs/foo', 'job/bar', or '' for
    // an orphan) to render the Owner column that tableHead(true) declares.
    // Leave it undefined for the hierarchical tables, which have no such column.
    // open renders the row already expanded (see expandedRows).
    function parentRow(parentId, res, hasChildren, owner, open) {
        var arrow = hasChildren
            ? '<span class="expand-arrow' + (open ? ' open' : '') + '">▶</span>'
            : '<span class="expand-arrow"></span>';
        var onclick = hasChildren ? ' onclick="toggleChildren(\'' + escapeAttr(parentId) + '\')"' : '';
        var cls = hasChildren ? 'resource-row' : '';
        var ownerCell = owner === undefined ? '' :
            '<td class="resource-owner' + (owner ? '' : ' orphan') + '">' +
            (owner ? escapeHtml(owner) : '—') + '</td>';
        return '<tr class="' + cls + '"' + onclick + '>' +
            '<td>' + arrow + '</td>' +
            '<td class="resource-name">' + escapeHtml(res.name) + '</td>' +
            '<td>' + kindBadge(res.kind) + '</td>' +
            ownerCell +
            '<td>' + statusBadge(res.status) + '</td>' +
            '<td>' + escapeHtml(res.completions || res.replicas || '-') + '</td>' +
            '<td>' + escapeHtml(res.age || '-') + '</td>' +
            '<td>' + escapeHtml(res.cpu || '-') + '</td>' +
            '<td>' + escapeHtml(res.memory || '-') + '</td>' +
            '<td>' + escapeHtml(res.node || '-') + '</td>' +
            '<td>' + (res.restarts > 0 ? res.restarts : '-') + '</td>' +
            '<td>' + actionButtons(res.kind, res.name) + '</td>' +
            '</tr>';
    }

    // rowClass carries ' visible' when the parent is expanded.
    function childRow(parentId, res, rowClass) {
        return '<tr class="' + rowClass + '" data-parent="' + escapeAttr(parentId) + '">' +
            '<td></td>' +
            '<td class="resource-name">' + escapeHtml(res.name) + '</td>' +
            '<td>' + kindBadge(res.kind) + '</td>' +
            '<td>' + statusBadge(res.status) + '</td>' +
            '<td>' + escapeHtml(res.completions || res.replicas || '-') + '</td>' +
            '<td>' + escapeHtml(res.age || '-') + '</td>' +
            '<td>' + escapeHtml(res.cpu || '-') + '</td>' +
            '<td>' + escapeHtml(res.memory || '-') + '</td>' +
            '<td>' + escapeHtml(res.node || '-') + '</td>' +
            '<td>' + (res.restarts > 0 ? res.restarts : '-') + '</td>' +
            '<td>' + actionButtons(res.kind, res.name) + '</td>' +
            '</tr>';
    }

    // visible: the owning Deployment is expanded, so this row shows.
    // open: this ReplicaSet is itself expanded, showing its pods.
    function childRowExpandable(parentId, rsId, res, hasChildren, visible, open) {
        var arrow = hasChildren
            ? '<span class="expand-arrow' + (open ? ' open' : '') + '">▶</span>'
            : '';
        var onclick = hasChildren ? ' onclick="event.stopPropagation(); toggleChildren(\'' + escapeAttr(rsId) + '\')"' : '';
        var cls = 'child-row' + (hasChildren ? ' resource-row' : '') + (visible ? ' visible' : '');
        return '<tr class="' + cls + '" data-parent="' + escapeAttr(parentId) + '"' + onclick + '>' +
            '<td>' + arrow + '</td>' +
            '<td class="resource-name">' + escapeHtml(res.name) + '</td>' +
            '<td>' + kindBadge(res.kind) + '</td>' +
            '<td>' + statusBadge(res.status) + '</td>' +
            '<td>' + escapeHtml(res.replicas || '-') + '</td>' +
            '<td>' + escapeHtml(res.age || '-') + '</td>' +
            '<td>-</td><td>-</td><td>-</td><td>-</td>' +
            '<td>' + actionButtons(res.kind, res.name) + '</td>' +
            '</tr>';
    }

    function kindBadge(kind) {
        var cls = (kind || '').toLowerCase().replace(/\s+/g, '');
        return '<span class="kind-badge ' + cls + '">' + escapeHtml(kind) + '</span>';
    }

    function statusBadge(status) {
        var cls = (status || '').toLowerCase().replace(/\s+/g, '-');
        return '<span class="status-badge ' + cls + '">' + escapeHtml(status) + '</span>';
    }

    // ===== Expand / Collapse =====
    // Flip one row's entry in expandedRows and re-render from the tree already
    // on screen. Rendering is the only code that decides which rows show, so a
    // click and a background snapshot can never disagree about it. (The
    // earlier version toggled DOM classes directly, which the next rebuild
    // threw away.) The re-render is local: no request is made, and only the
    // tab whose markup changed is rewritten.
    window.toggleChildren = function(parentId) {
        if (expandedRows[parentId]) {
            delete expandedRows[parentId];
            // Collapsing a row also collapses what is nested under it, so
            // reopening a Deployment starts with its ReplicaSets closed.
            var prefix = parentId + '/';
            for (var k in expandedRows) {
                if (k.indexOf(prefix) === 0) delete expandedRows[k];
            }
        } else {
            expandedRows[parentId] = true;
        }
        if (lastTree) rebuildTables(lastTree);
    };

    // ===== Delete =====
    window.deleteResource = function(kind, name) {
        if (!confirm('Delete ' + kind + ' "' + name + '"?\n\nThis cannot be undone.')) return;
        fetch('/api/resources', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: kind, name: name })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.error) { alert('Delete failed: ' + data.error); return; }
            refreshResources();
        })
        .catch(function(err) { alert('Delete failed: ' + err.message); });
    };

    // ===== Describe & Logs =====
    window.describeResource = function(kind, name) {
        openModal('Describe: ' + kind + '/' + name, 'Loading...');
        fetch('/api/describe?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name))
        .then(function(r) { return r.text(); })
        .then(function(text) { setModalContent(text); })
        .catch(function(err) { setModalContent('Error: ' + err.message); });
    };

    var logSource = null;
    var logSourcePod = '';

    // Server-side capture of the current Logs modal. Every line the view
    // streams is also appended to a file on the kro host, so a long-running
    // view never loses its early lines and the whole session can be
    // downloaded (⤓). The ID is minted here, once per modal open, and baked
    // into the SSE URL: EventSource auto-reconnects reuse that exact URL, and
    // the manual reconnect pill reuses the ID too, so every reconnect appends
    // to the same file rather than starting a new one. A new ID per open
    // keeps separate viewing sessions in separate files.
    var logCaptureId = '';

    function newCaptureId() {
        // crypto.randomUUID needs a secure context; a time+random ID is
        // plenty here since the server only uses it as a map key.
        return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }

    window.viewLogs = function(name) {
        closeLogStream();
        logCaptureId = newCaptureId();
        openModal('Logs: ' + name, '', { wide: true, stream: true, download: true });
        startLogStream(name);
    };

    function startLogStream(name) {
        closeLogStream();
        logSourcePod = name;
        modalLastLvl = null;
        var content = document.getElementById('modal-content');
        if (!content) return;
        setStreamStatus('reconnecting', 'Connecting…');

        setCaptureReady(null);
        logSource = new EventSource('/sse/logs?name=' + encodeURIComponent(name) +
            (logCaptureId ? '&cap=' + encodeURIComponent(logCaptureId) : ''));
        logSource.onopen = function() {
            setStreamStatus('connected', 'Connected');
        };
        // Sent once per connection when the server has the capture file
        // open; until then (or if the server couldn't open it) the
        // download button stays disabled.
        logSource.addEventListener('capture', function(e) {
            var info = null;
            try { info = JSON.parse(e.data); } catch (err) { /* ignore */ }
            setCaptureReady(info && info.path ? info.path : null);
        });
        logSource.addEventListener('log', function(e) {
            // Any log frame implies a healthy stream — flip the pill green
            // even if onopen hasn't fired yet (some browsers emit log first).
            setStreamStatus('connected', 'Connected');
            appendLogLine(content, e.data);
        });
        logSource.onerror = function() {
            // EventSource will auto-reconnect on its own; surface state so
            // the user can see (and click) when the stream is stuck.
            setStreamStatus('reconnecting', 'Reconnecting…');
            appendLogLine(content, '— disconnected, retrying —', true);
        };
    }

    function setStreamStatus(state, label) {
        var dot = document.getElementById('modal-stream-dot');
        var lbl = document.getElementById('modal-stream-label');
        if (dot) dot.className = 'log-status ' + state;
        if (lbl) lbl.textContent = label;
    }

    // Enables the modal's download button once a capture file exists, and
    // puts its on-disk path in the tooltip so it can also be found directly.
    function setCaptureReady(path) {
        var btn = document.getElementById('modal-download');
        if (!btn) return;
        btn.disabled = !path;
        btn.title = path
            ? 'Download everything this view has streamed (nothing is trimmed)\nSaved at: ' + path
            : 'Download full log (waiting for capture…)';
    }

    // The server sends Content-Disposition: attachment, so a plain anchor
    // click becomes a save — in browsers and in KRo.app's WKWebView, whose
    // download delegate saves to ~/Downloads. The response is streamed from
    // disk, so a capture of any size downloads without buffering.
    window.downloadLogCapture = function() {
        if (!logCaptureId) return;
        var a = document.createElement('a');
        a.href = '/api/logs/capture?id=' + encodeURIComponent(logCaptureId);
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    window.reconnectLogStream = function() {
        if (!logSourcePod) return;
        startLogStream(logSourcePod);
    };

    // Buffered log lines waiting for the next rAF flush. Same rationale as the
    // terminal panel: a noisy pod can deliver hundreds of SSE frames per
    // animation frame, and doing the layout/scroll/highlight work per line
    // pegs the main thread. Coalescing into one DOM update per frame keeps
    // the modal responsive even when logs are pouring in.
    var logLineBuf = [];
    var logFlushScheduled = false;
    var logContentEl = null;
    var modalLastLvl = null; // level inherited by unleveled lines (stack traces etc.)

    function appendLogLine(content, line, isMeta) {
        logContentEl = content;
        logLineBuf.push(isMeta ? '\u0000' + line : line);
        if (logFlushScheduled) return;
        logFlushScheduled = true;
        requestAnimationFrame(flushLogLines);
    }

    function flushLogLines() {
        logFlushScheduled = false;
        var content = logContentEl;
        if (!content || !logLineBuf.length) return;
        var buf = logLineBuf;
        logLineBuf = [];

        var body = content.parentNode; // .modal-body is the scroll container
        var atBottom = !body || (body.scrollHeight - body.scrollTop - body.clientHeight < 30);

        var frag = document.createDocumentFragment();
        var newSpans = [];
        for (var i = 0; i < buf.length; i++) {
            var span = document.createElement('span');
            if (buf[i].charCodeAt(0) === 0) {
                // Meta lines (e.g. disconnect notices) carry no level class so
                // they stay visible regardless of the active level filter.
                span.className = 'log-meta';
                span.textContent = buf[i].slice(1) + '\n';
            } else {
                span.innerHTML = highlightLogLine(buf[i]) + '\n';
                var lvl = highlightLogLine.lastLevel || modalLastLvl;
                if (lvl) { span.className = 'lvl-' + lvl; modalLastLvl = lvl; }
            }
            frag.appendChild(span);
            newSpans.push(span);
        }
        content.appendChild(frag);

        // If a search is active, highlight matches in newly-arrived lines and
        // refresh the count once for the whole batch. Lines hidden by the
        // level filter are skipped so the match count tracks what's visible.
        if (searchState.open && searchState.query) {
            var added = 0;
            for (var j = 0; j < newSpans.length; j++) {
                if (lineSpanHidden(newSpans[j], content)) continue;
                added += highlightMatchesIn(newSpans[j]);
            }
            if (added > 0) {
                searchState.matchCount += added;
                refreshSearchCountLabel();
            }
        }
        trimModalLog(content, body, atBottom);
        if (atBottom && body && !selectionActiveIn(content)) body.scrollTop = body.scrollHeight;
    }

    // DOM cap for the Logs modal. The server-side capture file keeps every
    // line (⤓ downloads it), so the view only needs to hold the recent past;
    // without a cap a chatty pod left open for hours grows the DOM without
    // bound and every layout/search pass slows with it.
    //
    // Trimming is batched: nothing happens until the view is LOG_MODAL_TRIM_SLACK
    // lines over the cap, then it drops back to exactly LOG_MODAL_MAX_LINES.
    // That keeps the cost (span removal plus a scroll-height read) to once per
    // ~1000 lines instead of once per animation frame.
    //
    //   children: [trim note] [oldest … newest]
    //              ▲ one meta span, created on the first trim and updated after
    var LOG_MODAL_MAX_LINES = 20000;
    var LOG_MODAL_TRIM_SLACK = 1000;

    function trimModalLog(content, body, atBottom) {
        var note = content.firstElementChild;
        if (note && !note.classList.contains('log-trim-note')) note = null;
        var lines = content.children.length - (note ? 1 : 0);
        if (lines <= LOG_MODAL_MAX_LINES + LOG_MODAL_TRIM_SLACK) return;
        // A live selection would be destroyed (or silently re-anchored) by
        // removing nodes it spans; defer until the user lets go. The next
        // flush after that trims the whole backlog at once.
        if (selectionActiveIn(content)) return;

        var over = lines - LOG_MODAL_MAX_LINES;
        var first = note ? 1 : 0;

        // Search bookkeeping: matches inside removed lines leave the count.
        // Groups are keyed by data-mi (one logical match may span several
        // <mark>s); if the current match goes, navigation restarts at the top.
        var removedIds = Object.create(null), removedGroups = 0, currentGone = false;
        var heightBefore = (!atBottom && body) ? body.scrollHeight : 0;
        for (var i = 0; i < over; i++) {
            var span = content.children[first];
            var marks = span.getElementsByTagName('mark');
            for (var j = 0; j < marks.length; j++) {
                var id = marks[j].getAttribute('data-mi');
                if (id !== null && !removedIds[id]) { removedIds[id] = true; removedGroups++; }
                if (marks[j].classList.contains('current')) currentGone = true;
            }
            content.removeChild(span);
        }
        if (removedGroups && searchState.query) {
            searchState.matchCount = Math.max(0, searchState.matchCount - removedGroups);
            searchState.currentIndex = currentGone ? 0 : Math.max(0, searchState.currentIndex - removedGroups);
            refreshSearchCountLabel();
        }

        if (!note) {
            note = document.createElement('span');
            note.className = 'log-meta log-trim-note';
            note.dataset.trimmed = '0';
            content.insertBefore(note, content.firstChild);
        }
        var total = (parseInt(note.dataset.trimmed, 10) || 0) + over;
        note.dataset.trimmed = String(total);
        note.textContent = '— ' + total.toLocaleString() + ' earlier lines trimmed from this view; ⤓ downloads the full capture —\n';

        // A reader scrolled up into the history would otherwise see the text
        // jump by the height just removed; shift scrollTop to compensate.
        // (Following the tail needs nothing: the caller re-pins to bottom.)
        if (heightBefore && body) {
            body.scrollTop = Math.max(0, body.scrollTop - (heightBefore - body.scrollHeight));
        }
    }

    // Map any recognized level token onto the five filter buckets. Covers the
    // full words, logrus's 4-char console truncations (DEBU/ERRO/FATA/...),
    // and 3-char short forms (Deb/Inf/Wrn/Err/Ftl).
    var LEVEL_BUCKETS = {
        trace: 'deb', trac: 'deb', trc: 'deb',
        debug: 'deb', debu: 'deb', deb: 'deb', dbg: 'deb',
        info: 'inf', inf: 'inf',
        warn: 'wrn', warning: 'wrn', wrn: 'wrn',
        error: 'err', erro: 'err', err: 'err',
        fatal: 'ftl', fata: 'ftl', ftl: 'ftl', panic: 'ftl', pani: 'ftl'
    };
    // Bucket -> canonical CSS suffix for the existing .log-level-* colors.
    var LEVEL_CANON = { deb: 'debug', inf: 'info', wrn: 'warn', err: 'error', ftl: 'fatal' };

    function levelTokenClass(tok) {
        var b = LEVEL_BUCKETS[tok.toLowerCase()];
        return 'log-level log-level-' + (b ? LEVEL_CANON[b] : tok.toLowerCase());
    }

    // Colorize a single log line. Handles two styles seen in pod logs:
    //   structured Go logs:  time="..." level=info msg="..."
    //   legacy/python logs:  INFO -- 05/01/2026 ... 'string' 'string'
    // Levels get conventional colors, dates/times are green, positive numbers
    // cyan, negatives orange, true/false get the same cyan/orange treatment,
    // and on error-level lines msg="..." is highlighted in maroon.
    //
    // As a side effect, the first level token found is recorded (as a filter
    // bucket: deb/inf/wrn/err/ftl) in highlightLogLine.lastLevel — null when
    // the line has no recognizable level. Callers use it to tag lines for
    // level filtering; the level regex runs anyway, so this costs nothing.
    function highlightLogLine(line) {
        var escaped = escapeHtml(line);
        var detected = null;
        var isError = /\blevel=(error|err|fatal)\b/i.test(line) ||
                      /"level"\s*:\s*"(error|err|fatal)"/i.test(line) ||
                      /\b(ERROR|FATAL)\b/.test(line);

        // logrus/zerolog JSON lines ({"level":"error","msg":"...",...}) need
        // their own pass — the logfmt regex below only recognizes key=value and
        // bare level tokens, so JSON level/keys would never be colorized. Allow
        // a leading "[container] " prefix (kro tags multi-container pod lines
        // with it) before the opening brace; the global replace below leaves
        // the prefix untouched, so no extra bookkeeping is needed.
        var trimmed = (line || '').replace(/^\s+/, '');
        if (/^(?:\[[^\]]*\]\s*)?\{/.test(trimmed) && /&quot;[\w.\-]+&quot;\s*:/.test(escaped)) {
            // value := quoted string | number | true/false/null
            var jsonRe = /(&quot;[\w.\-]+&quot;)(\s*:\s*)(&quot;(?:[^&]|&(?!quot;))*?&quot;|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;
            var jsonOut = escaped.replace(jsonRe, function(m, keyTok, sep, val) {
                var keyName = keyTok.replace(/&quot;/g, '');
                var keyHtml = '<span class="log-key">' + keyTok + '</span>';
                var valHtml;
                if (val === 'true' || val === 'false') {
                    valHtml = '<span class="log-bool log-bool-' + val + '">' + val + '</span>';
                } else if (val === 'null') {
                    valHtml = val;
                } else if (/^-\d/.test(val)) {
                    valHtml = '<span class="log-num-neg">' + val + '</span>';
                } else if (/^\d/.test(val)) {
                    valHtml = '<span class="log-num">' + val + '</span>';
                } else {
                    // quoted string value — strip the &quot; wrappers (6 chars each)
                    var inner = val.slice(6, -6);
                    if (keyName === 'level') {
                        if (!detected) detected = LEVEL_BUCKETS[inner.toLowerCase()] || null;
                        valHtml = '<span class="' + levelTokenClass(inner) + '">' + val + '</span>';
                    } else if (isError && (keyName === 'msg' || keyName === 'error' || keyName === 'err')) {
                        valHtml = '<span class="log-msg-err">' + val + '</span>';
                    } else {
                        valHtml = highlightInner(val);
                    }
                }
                return keyHtml + sep + valHtml;
            });
            highlightLogLine.lastLevel = detected;
            return jsonOut;
        }

        // Order matters: date/time alts come before bare numbers so a date's
        // digit groups aren't picked off as standalone numbers, and longer
        // level tokens come before their prefixes (ERROR before ERRO/ERR).
        var re = new RegExp([
            '\\bmsg=(&quot;.*?&quot;)',                                                // 1: msg val (only used when isError)
            '(\\w+)=(?=&quot;)',                                                       // 2: key before quoted value
            '\\blevel=([A-Za-z]+)',                                                    // 3: unquoted level value
            '\\b(INFO|INF|Inf|WARN(?:ING)?|WRN|Wrn|ERROR|ERRO|ERR|Err|' +              // 4: bare level token
                'DEBUG|DEBU|DEB|Deb|FATAL|FATA|FTL|Ftl|TRACE|TRAC|PANIC|PANI)\\b',
            '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?',
            '\\d{2}/\\d{2}/\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2}(?:\\s*[AP]M)?',
            '\\d{4}-\\d{2}-\\d{2}',
            '\\d{2}/\\d{2}/\\d{4}',
            '\\d{1,2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:\\s*[AP]M)?',
            '\\b(true|false)\\b',                                                      // 5: bool
            '(?<![\\w-])-?\\b\\d+(?:\\.\\d+)?\\b',                                     // (no group) numbers; lookbehind keeps hash/UUID segments (e.g. ...5c29-4700-8fc8) from reading as negatives
        ].join('|'), 'g');

        var out = escaped.replace(re, function(m, msgVal, key, lvlVal, bareLvl, boolVal) {
            if (msgVal !== undefined) {
                if (isError) return '<span class="log-msg-err">msg=' + msgVal + '</span>';
                return '<span class="log-key">msg</span>=' + highlightInner(msgVal);
            }
            if (key !== undefined) return '<span class="log-key">' + key + '</span>=';
            if (lvlVal) {
                if (!detected) detected = LEVEL_BUCKETS[lvlVal.toLowerCase()] || null;
                return '<span class="log-key">level</span>=<span class="' + levelTokenClass(lvlVal) + '">' + lvlVal + '</span>';
            }
            if (bareLvl) {
                if (!detected) detected = LEVEL_BUCKETS[bareLvl.toLowerCase()] || null;
                return '<span class="' + levelTokenClass(bareLvl) + '">' + bareLvl + '</span>';
            }
            if (boolVal !== undefined) return '<span class="log-bool log-bool-' + boolVal + '">' + boolVal + '</span>';
            // Whatever remains is a date/time or number — disambiguate by content.
            if (/^-/.test(m)) return '<span class="log-num-neg">' + m + '</span>';
            if (/^\d+(?:\.\d+)?$/.test(m)) return '<span class="log-num">' + m + '</span>';
            return '<span class="log-time">' + m + '</span>';
        });
        highlightLogLine.lastLevel = detected;
        return out;
    }

    // Re-highlight just the inner tokens (dates, numbers, booleans) of an
    // already-captured quoted value — used when we consumed the whole msg=
    // chunk on a non-error line and still want to colorize what's inside.
    function highlightInner(s) {
        var re = new RegExp([
            '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?',
            '\\d{2}/\\d{2}/\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2}(?:\\s*[AP]M)?',
            '\\d{4}-\\d{2}-\\d{2}',
            '\\d{2}/\\d{2}/\\d{4}',
            '\\d{1,2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:\\s*[AP]M)?',
            '\\b(true|false)\\b',
            '(?<![\\w-])-?\\b\\d+(?:\\.\\d+)?\\b',
        ].join('|'), 'g');
        return s.replace(re, function(m, boolVal) {
            if (boolVal !== undefined) return '<span class="log-bool log-bool-' + boolVal + '">' + boolVal + '</span>';
            if (/^-/.test(m)) return '<span class="log-num-neg">' + m + '</span>';
            if (/^\d+(?:\.\d+)?$/.test(m)) return '<span class="log-num">' + m + '</span>';
            return '<span class="log-time">' + m + '</span>';
        });
    }

    // Shared with watch.js (the Pod Watch modal) so its console frames get
    // the same log colorization. highlightLogLine HTML-escapes internally.
    window.kroHighlight = highlightLogLine;

    // True when the user has a non-collapsed text selection anchored inside
    // el. Streaming panes check this before autoscrolling or trimming old
    // lines — either one destroys an in-progress selection, making it
    // impossible to copy from a busy stream.
    function selectionActiveIn(el) {
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
        var n = sel.anchorNode;
        return !!(n && el && el.contains(n));
    }
    window.kroSelActive = selectionActiveIn;

    // ===== Log level filter =====
    // Each line span is tagged lvl-<bucket> at render time; hiding a level is
    // just toggling hide-<bucket> on the scroll container, so the filter is
    // pure CSS — no re-render, no per-line work on toggle. The hidden set is
    // persisted and seeds every new viewer (modal and watch frames alike);
    // toggles act on their own view only.
    var LVL_FILTER_KEY = 'kro_log_lvl_hidden';
    var FILTER_LEVELS = ['deb', 'inf', 'wrn', 'err', 'ftl'];
    var FILTER_LABELS = { deb: 'Deb', inf: 'Inf', wrn: 'Wrn', err: 'Err', ftl: 'Ftl' };

    function getHiddenLevels() {
        var out = {};
        try {
            var arr = JSON.parse(localStorage.getItem(LVL_FILTER_KEY) || '[]');
            for (var i = 0; i < arr.length; i++) {
                if (FILTER_LEVELS.indexOf(arr[i]) >= 0) out[arr[i]] = true;
            }
        } catch (_) {}
        return out;
    }

    function saveHiddenLevel(lvl, hidden) {
        var h = getHiddenLevels();
        if (hidden) h[lvl] = true; else delete h[lvl];
        var arr = [];
        for (var k in h) arr.push(k);
        localStorage.setItem(LVL_FILTER_KEY, JSON.stringify(arr));
    }

    function levelButtonsHTML(hidden) {
        var html = '';
        for (var i = 0; i < FILTER_LEVELS.length; i++) {
            var l = FILTER_LEVELS[i];
            html += '<button type="button" class="log-lvl-btn lvlb-' + l + (hidden[l] ? ' off' : '') +
                '" data-lvl="' + l + '" title="Show/hide ' + FILTER_LABELS[l] + ' lines">' +
                FILTER_LABELS[l] + '</button>';
        }
        return html;
    }

    function applyHiddenLevels(el, hidden) {
        for (var i = 0; i < FILTER_LEVELS.length; i++) {
            el.classList.toggle('hide-' + FILTER_LEVELS[i], !!hidden[FILTER_LEVELS[i]]);
        }
    }

    // Wire a button group (event delegation, so innerHTML refreshes are fine)
    // to filter contentEl. onChange runs after the container class flips.
    function wireLevelButtons(btnsEl, contentEl, onChange) {
        btnsEl.addEventListener('click', function(e) {
            var btn = e.target.closest('button[data-lvl]');
            if (!btn) return;
            var lvl = btn.dataset.lvl;
            var hidden = !btn.classList.contains('off');
            btn.classList.toggle('off', hidden);
            contentEl.classList.toggle('hide-' + lvl, hidden);
            saveHiddenLevel(lvl, hidden);
            if (onChange) onChange();
        });
    }

    // True when the line span is suppressed by the active level filter of its
    // container. Pure string checks — no layout read.
    function lineSpanHidden(span, content) {
        var m = /(?:^|\s)lvl-([a-z]+)/.exec(span.className);
        return !!m && content.classList.contains('hide-' + m[1]);
    }

    // Shared with watch.js so console frames get the same level filtering.
    window.kroLogFilter = {
        getHidden: getHiddenLevels,
        buttonsHTML: levelButtonsHTML,
        apply: applyHiddenLevels,
        wire: wireLevelButtons
    };

    function closeLogStream() {
        if (logSource) {
            logSource.close();
            logSource = null;
        }
        // Drop any pending lines so they don't bleed into a new pod's modal
        // (closeLogStream runs both when the modal closes and when the user
        // switches pods via startLogStream).
        logLineBuf = [];
        logContentEl = null;
    }

    // ===== Pod Metrics (CPU + memory live chart) =====
    // Polls /sse/metrics every 10s (server-side cadence). Underlying
    // metrics-server typically scrapes at ~15s, so values will step.
    var metricsSource = null;
    var metricsState = {
        pod: '',
        samples: [],          // ring buffer of {ts, cpu_m, mem_bytes, containers:[{name,cpu_m,mem_bytes}]}
        maxSamples: 60,       // ~10 minutes at 10s
        containerColors: {},  // name -> hex
        nextColorIdx: 0
    };
    var METRIC_PALETTE = [
        '#4ea1ff', '#ff8a4e', '#7ad27a', '#d97aff',
        '#ffd24e', '#4ed2c2', '#ff6e8a', '#9aa9ff'
    ];

    window.viewMetrics = function(name) {
        closeMetricsStream();
        metricsState.pod = name;
        metricsState.samples = [];
        metricsState.containerColors = {};
        metricsState.nextColorIdx = 0;
        openModal('Metrics: ' + name, '', { stream: true });
        var el = document.getElementById('modal-content');
        if (el) el.innerHTML = renderMetricsShell();
        startMetricsStream(name);
    };

    function renderMetricsShell() {
        return '<div class="metrics-panel">' +
            '<div class="metrics-hint">Live usage from metrics-server. Metrics-server typically scrapes every ~15s, so values may step.</div>' +
            '<section class="metrics-chart">' +
                '<header><h3>Memory</h3><span id="metrics-mem-current" class="metrics-current">—</span></header>' +
                '<svg id="metrics-mem-svg" class="metrics-svg" preserveAspectRatio="none" viewBox="0 0 600 120"></svg>' +
                '<div id="metrics-mem-axis" class="metrics-axis"></div>' +
            '</section>' +
            '<section class="metrics-chart">' +
                '<header><h3>CPU</h3><span id="metrics-cpu-current" class="metrics-current">—</span></header>' +
                '<svg id="metrics-cpu-svg" class="metrics-svg" preserveAspectRatio="none" viewBox="0 0 600 120"></svg>' +
                '<div id="metrics-cpu-axis" class="metrics-axis"></div>' +
            '</section>' +
            '<div id="metrics-legend" class="metrics-legend"></div>' +
            '<div id="metrics-status" class="metrics-status"></div>' +
        '</div>';
    }

    function startMetricsStream(name) {
        closeMetricsStream();
        setStreamStatus('reconnecting', 'Connecting…');
        metricsSource = new EventSource('/sse/metrics?name=' + encodeURIComponent(name));
        metricsSource.onopen = function() { setStreamStatus('connected', 'Connected'); };
        metricsSource.addEventListener('metrics', function(e) {
            setStreamStatus('connected', 'Connected');
            try {
                var sample = JSON.parse(e.data);
                pushMetricsSample(sample);
                renderMetrics();
            } catch (err) { /* ignore parse errors */ }
        });
        metricsSource.addEventListener('error', function(e) {
            // Server-sent error event (not the EventSource onerror)
            var msg = '';
            try { msg = (JSON.parse(e.data || '{}').error) || ''; } catch (_) {}
            var statusEl = document.getElementById('metrics-status');
            if (statusEl && msg) statusEl.textContent = msg;
        });
        metricsSource.onerror = function() {
            setStreamStatus('reconnecting', 'Reconnecting…');
        };
    }

    function closeMetricsStream() {
        if (metricsSource) {
            metricsSource.close();
            metricsSource = null;
        }
    }

    function pushMetricsSample(sample) {
        // Make sure each container has a stable color across samples
        (sample.containers || []).forEach(function(c) {
            if (!metricsState.containerColors[c.name]) {
                metricsState.containerColors[c.name] =
                    METRIC_PALETTE[metricsState.nextColorIdx % METRIC_PALETTE.length];
                metricsState.nextColorIdx++;
            }
        });
        metricsState.samples.push(sample);
        if (metricsState.samples.length > metricsState.maxSamples) {
            metricsState.samples.shift();
        }
    }

    function renderMetrics() {
        var samples = metricsState.samples;
        if (!samples.length) return;
        var last = samples[samples.length - 1];

        // Headlines
        var memCur = document.getElementById('metrics-mem-current');
        if (memCur) memCur.textContent = formatBytes(last.mem_bytes);
        var cpuCur = document.getElementById('metrics-cpu-current');
        if (cpuCur) cpuCur.textContent = last.cpu_m + ' mCPU';

        // Build per-container series (sparse — only containers we've seen)
        var seriesNames = Object.keys(metricsState.containerColors);
        seriesNames.sort();

        // Memory chart
        drawChart('metrics-mem-svg', samples, seriesNames, function(s) { return s.mem_bytes; },
            function(c) { return c.mem_bytes; });
        var memAxis = document.getElementById('metrics-mem-axis');
        if (memAxis) memAxis.textContent = '0 — ' + formatBytes(maxOf(samples, 'mem_bytes'));

        // CPU chart
        drawChart('metrics-cpu-svg', samples, seriesNames, function(s) { return s.cpu_m; },
            function(c) { return c.cpu_m; });
        var cpuAxis = document.getElementById('metrics-cpu-axis');
        if (cpuAxis) cpuAxis.textContent = '0 — ' + maxOf(samples, 'cpu_m') + ' mCPU';

        // Legend
        var legend = document.getElementById('metrics-legend');
        if (legend) {
            var parts = ['<span class="metrics-legend-item"><span class="metrics-swatch total"></span>total</span>'];
            seriesNames.forEach(function(name) {
                parts.push('<span class="metrics-legend-item"><span class="metrics-swatch" style="background:' +
                    metricsState.containerColors[name] + '"></span>' + escapeHtml(name) + '</span>');
            });
            legend.innerHTML = parts.join('');
        }
    }

    function maxOf(samples, key) {
        var m = 0;
        samples.forEach(function(s) { if (s[key] > m) m = s[key]; });
        return m;
    }

    // drawChart paints a per-container line plus a thicker total line into the
    // target SVG. Y-scales to the per-window max with 10% headroom; X is
    // proportional to sample index (visually equal spacing).
    function drawChart(svgId, samples, seriesNames, totalFn, containerFn) {
        var svg = document.getElementById(svgId);
        if (!svg) return;
        var W = 600, H = 120, padY = 6;
        var n = samples.length;
        var maxVal = 0;
        samples.forEach(function(s) {
            if (totalFn(s) > maxVal) maxVal = totalFn(s);
        });
        if (maxVal <= 0) maxVal = 1;
        maxVal = maxVal * 1.1;

        var xAt = function(i) {
            if (n <= 1) return W;
            return Math.round((i / (n - 1)) * W);
        };
        var yAt = function(v) {
            return Math.round(H - padY - (v / maxVal) * (H - 2 * padY));
        };

        var pieces = [];
        // Per-container lines (drawn first, thinner)
        seriesNames.forEach(function(cname) {
            var color = metricsState.containerColors[cname];
            var d = '';
            samples.forEach(function(s, i) {
                var c = (s.containers || []).find(function(x) { return x.name === cname; });
                var v = c ? containerFn(c) : 0;
                d += (i === 0 ? 'M' : 'L') + xAt(i) + ',' + yAt(v) + ' ';
            });
            pieces.push('<path d="' + d.trim() + '" fill="none" stroke="' + color + '" stroke-width="1.2" opacity="0.85"/>');
        });
        // Total line (thicker, on top)
        var dt = '';
        samples.forEach(function(s, i) {
            dt += (i === 0 ? 'M' : 'L') + xAt(i) + ',' + yAt(totalFn(s)) + ' ';
        });
        pieces.push('<path d="' + dt.trim() + '" fill="none" stroke="#e6e6e6" stroke-width="2"/>');
        // Last-point dot for the total
        if (n > 0) {
            var lx = xAt(n - 1), ly = yAt(totalFn(samples[n - 1]));
            pieces.push('<circle cx="' + lx + '" cy="' + ly + '" r="2.5" fill="#e6e6e6"/>');
        }
        svg.innerHTML = pieces.join('');
    }

    // Mirror of formatBytes in the Go side — used for memory headlines.
    function formatBytes(b) {
        if (b == null) return '—';
        var mi = 1024 * 1024, gi = 1024 * 1024 * 1024;
        if (b >= gi) return (b / gi).toFixed(1) + ' GiB';
        if (b >= mi) return Math.round(b / mi) + ' MiB';
        if (b >= 1024) return Math.round(b / 1024) + ' KiB';
        return b + ' B';
    }

    // ===== Log search =====
    // In-modal find for streaming logs. Matches are wrapped with
    // <mark class="log-match">; the active match also gets .current.
    // Highlighting is layered on top of the colorized log spans by walking
    // text nodes — splitting them so existing color spans stay intact.
    var searchState = {
        open: false,
        query: '',
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        matchCount: 0,
        currentIndex: 0,
        invalidRegex: false
    };

    // Generic regex builder (also used by watch.js frame search). Returns
    // null for an empty query, false for an invalid regex.
    function buildLogSearchRegex(query, caseSensitive, wholeWord, isRegex) {
        if (!query) return null;
        var flags = caseSensitive ? 'g' : 'gi';
        try {
            if (isRegex) {
                return new RegExp(query, flags);
            }
            var pat = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (wholeWord) pat = '\\b' + pat + '\\b';
            return new RegExp(pat, flags);
        } catch (e) {
            return false; // signal invalid regex
        }
    }

    function buildSearchRegex() {
        return buildLogSearchRegex(searchState.query, searchState.caseSensitive,
            searchState.wholeWord, searchState.regex);
    }

    function clearSearchMarks(root) {
        if (!root) return;
        var marks = root.querySelectorAll('mark.log-match');
        for (var i = 0; i < marks.length; i++) {
            var m = marks[i];
            var parent = m.parentNode;
            while (m.firstChild) parent.insertBefore(m.firstChild, m);
            parent.removeChild(m);
            parent.normalize();
        }
    }

    // Monotonic id shared by all <mark> segments of a single logical match.
    // Colorizing splits a line into many text nodes, so a match like
    // "worker.*2026" can span several of them; tagging every segment with the
    // same data-mi lets navigation and counts collapse them back into one.
    var matchSeq = 0;

    function highlightMatchesIn(root, rxOverride) {
        var rx = rxOverride || buildSearchRegex();
        if (!rx) return 0;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function(n) {
                if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
                if (n.parentNode && n.parentNode.nodeName === 'MARK') return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        // Concatenate the line's text nodes so the regex matches across the
        // colorized <span> boundaries that split a single visual line.
        var segs = [];   // { node, start, end } offsets into `joined`
        var joined = '';
        var n;
        while ((n = walker.nextNode())) {
            var t = n.nodeValue;
            segs.push({ node: n, start: joined.length, end: joined.length + t.length });
            joined += t;
        }
        if (!joined) return 0;

        rx.lastIndex = 0;
        var ranges = [];   // { s, e, id } over `joined`
        var m;
        while ((m = rx.exec(joined)) !== null) {
            if (m[0].length === 0) { rx.lastIndex++; continue; }
            ranges.push({ s: m.index, e: m.index + m[0].length, id: matchSeq++ });
        }
        if (!ranges.length) return 0;

        // Rebuild each text node independently, wrapping the portion of every
        // range that overlaps it. Offsets were captured up front, so replacing
        // one node doesn't disturb the others.
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            var text = seg.node.nodeValue;
            var frag = document.createDocumentFragment();
            var last = 0;
            for (var j = 0; j < ranges.length; j++) {
                var s = ranges[j].s, e = ranges[j].e;
                if (e <= seg.start || s >= seg.end) continue; // no overlap
                var ls = Math.max(s, seg.start) - seg.start;   // local to node
                var le = Math.min(e, seg.end) - seg.start;
                if (ls > last) frag.appendChild(document.createTextNode(text.slice(last, ls)));
                var mk = document.createElement('mark');
                mk.className = 'log-match';
                mk.setAttribute('data-mi', ranges[j].id);
                mk.textContent = text.slice(ls, le);
                frag.appendChild(mk);
                last = le;
            }
            if (!last) continue; // no range touched this node
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            seg.node.parentNode.replaceChild(frag, seg.node);
        }
        return ranges.length;
    }

    // Group <mark> segments by logical match (data-mi), in DOM order, so the
    // segments of a match that crosses colorized spans count and navigate as
    // one unit.
    function markGroups(marks) {
        var order = [], byId = Object.create(null);
        for (var i = 0; i < marks.length; i++) {
            var id = marks[i].getAttribute('data-mi');
            if (id === null) id = '_' + i;
            if (!byId[id]) { byId[id] = []; order.push(id); }
            byId[id].push(marks[i]);
        }
        return order.map(function(id) { return byId[id]; });
    }

    function refreshSearchCountLabel() {
        var el = document.getElementById('modal-search-count');
        if (!el) return;
        if (searchState.invalidRegex) {
            el.textContent = 'invalid regex';
            el.classList.add('error');
            return;
        }
        el.classList.remove('error');
        if (!searchState.query) { el.textContent = ''; return; }
        if (searchState.matchCount === 0) { el.textContent = 'no matches'; return; }
        el.textContent = (searchState.currentIndex + 1) + ' / ' + searchState.matchCount;
    }

    function runSearch() {
        var content = document.getElementById('modal-content');
        if (!content) return;
        clearSearchMarks(content);
        searchState.invalidRegex = false;
        searchState.matchCount = 0;
        searchState.currentIndex = 0;
        if (!searchState.query) {
            refreshSearchCountLabel();
            return;
        }
        var rx = buildSearchRegex();
        if (rx === false) {
            searchState.invalidRegex = true;
            refreshSearchCountLabel();
            return;
        }
        // Search line by line so lines hidden by the level filter get no
        // marks — keeps the count honest and navigation on visible matches.
        var total = 0;
        var lines = content.children;
        for (var i = 0; i < lines.length; i++) {
            if (lineSpanHidden(lines[i], content)) continue;
            // The trim note is rewritten via textContent, which would drop
            // its marks without touching the count; keep it out of search.
            if (lines[i].classList.contains('log-trim-note')) continue;
            total += highlightMatchesIn(lines[i], rx);
        }
        searchState.matchCount = total;
        refreshSearchCountLabel();
        if (searchState.matchCount > 0) navigateMatch(0, false);
    }

    function navigateMatch(delta, wrap) {
        var groups = markGroups(document.querySelectorAll('#modal-content mark.log-match'));
        if (!groups.length) return;
        var cur = -1;
        for (var i = 0; i < groups.length; i++) {
            if (groups[i][0].classList.contains('current')) { cur = i; break; }
        }
        var next;
        if (cur === -1) {
            next = delta >= 0 ? 0 : groups.length - 1;
        } else {
            next = cur + delta;
            if (wrap !== false) {
                next = ((next % groups.length) + groups.length) % groups.length;
            } else {
                next = Math.max(0, Math.min(groups.length - 1, next));
            }
            groups[cur].forEach(function(m) { m.classList.remove('current'); });
        }
        groups[next].forEach(function(m) { m.classList.add('current'); });
        groups[next][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        searchState.currentIndex = next;
        refreshSearchCountLabel();
    }

    window.toggleLogSearch = function() {
        var bar = document.getElementById('modal-search-bar');
        var btn = document.getElementById('modal-search-toggle');
        if (!bar) return;
        searchState.open = !searchState.open;
        bar.classList.toggle('active', searchState.open);
        if (btn) btn.classList.toggle('on', searchState.open);
        if (searchState.open) {
            var input = document.getElementById('modal-search-input');
            if (input) { input.focus(); input.select(); }
            runSearch();
        } else {
            clearSearchMarks(document.getElementById('modal-content'));
        }
    };

    window.onLogSearchInput = function(value) {
        searchState.query = value || '';
        runSearch();
    };

    window.toggleLogSearchOpt = function(opt) {
        var btn = document.getElementById('modal-search-' + opt);
        searchState[opt === 'case' ? 'caseSensitive' : opt === 'word' ? 'wholeWord' : 'regex'] =
            !searchState[opt === 'case' ? 'caseSensitive' : opt === 'word' ? 'wholeWord' : 'regex'];
        if (btn) btn.classList.toggle('on');
        runSearch();
    };

    window.logSearchNav = function(delta) { navigateMatch(delta, true); };

    function handleSearchKeydown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            navigateMatch(e.shiftKey ? -1 : 1, true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            window.toggleLogSearch();
        }
    }

    // Shared with watch.js so console frames get the same in-log search.
    window.kroLogSearch = {
        buildRegex: buildLogSearchRegex,
        clearMarks: clearSearchMarks,
        highlightIn: highlightMatchesIn,
        markGroups: markGroups,
        lineHidden: lineSpanHidden
    };

    function openModal(title, content, opts) {
        var overlay = document.getElementById('resource-modal-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'resource-modal-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML =
                '<div class="modal-dialog">' +
                '<div class="modal-header">' +
                '<span class="modal-title" id="modal-title"></span>' +
                '<div class="modal-header-actions">' +
                '<span class="modal-stream-status" id="modal-stream-status" onclick="reconnectLogStream()" title="Click to reconnect">' +
                    '<span class="log-status disconnected" id="modal-stream-dot"></span>' +
                    '<span class="modal-stream-label" id="modal-stream-label">Disconnected</span>' +
                '</span>' +
                '<span class="log-lvl-btns" id="modal-lvl-btns"></span>' +
                '<button class="modal-search-toggle" id="modal-search-toggle" onclick="toggleLogSearch()" title="Search (Esc to close)" aria-label="Search">' +
                    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                        '<circle cx="7" cy="7" r="5"></circle>' +
                        '<line x1="11" y1="11" x2="14.5" y2="14.5"></line>' +
                    '</svg>' +
                '</button>' +
                '<label class="modal-alpha" id="modal-alpha" title="Background opacity">' +
                    '<span class="modal-alpha-icon">◐</span>' +
                    '<input type="range" id="modal-alpha-input" min="10" max="100" step="1" oninput="setModalAlpha(this.value)">' +
                '</label>' +
                '<button class="modal-font" id="modal-font-down" onclick="adjustModalFont(-1)" title="Decrease font size">A−</button>' +
                '<button class="modal-font" id="modal-font-up" onclick="adjustModalFont(1)" title="Increase font size">A+</button>' +
                '<button class="modal-copy modal-download" id="modal-download" onclick="downloadLogCapture()" title="Download full log" disabled>⤓</button>' +
                '<button class="modal-copy" id="modal-copy" onclick="copyModalContent(this)" title="Copy to clipboard">⧉</button>' +
                '<button class="modal-close" onclick="closeModal()">&times;</button>' +
                '</div>' +
                '</div>' +
                '<div class="modal-search-bar" id="modal-search-bar">' +
                    '<input type="text" id="modal-search-input" placeholder="Search logs…" oninput="onLogSearchInput(this.value)" autocomplete="off" spellcheck="false">' +
                    '<button class="modal-search-opt" id="modal-search-case" onclick="toggleLogSearchOpt(\'case\')" title="Match case">Aa</button>' +
                    '<button class="modal-search-opt" id="modal-search-word" onclick="toggleLogSearchOpt(\'word\')" title="Whole word"><u>W</u></button>' +
                    '<button class="modal-search-opt" id="modal-search-regex" onclick="toggleLogSearchOpt(\'regex\')" title="Regular expression">.*</button>' +
                    '<span class="modal-search-count" id="modal-search-count"></span>' +
                    '<button class="modal-search-nav" onclick="logSearchNav(-1)" title="Previous match (Shift+Enter)">↑</button>' +
                    '<button class="modal-search-nav" onclick="logSearchNav(1)" title="Next match (Enter)">↓</button>' +
                    '<button class="modal-search-close" onclick="toggleLogSearch()" title="Close (Esc)">&times;</button>' +
                '</div>' +
                '<div class="modal-body">' +
                '<pre class="modal-content" id="modal-content"></pre>' +
                '</div>' +
                '</div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) closeModal();
            });
            var dialogEl = overlay.querySelector('.modal-dialog');
            attachModalDrag(dialogEl);
            attachModalResize(dialogEl);
            var searchInput = document.getElementById('modal-search-input');
            if (searchInput) searchInput.addEventListener('keydown', handleSearchKeydown);
            wireLevelButtons(
                document.getElementById('modal-lvl-btns'),
                document.getElementById('modal-content'),
                function() { if (searchState.open && searchState.query) runSearch(); });
        }
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-content').textContent = content;
        var dialog = overlay.querySelector('.modal-dialog');
        if (dialog) dialog.classList.toggle('wide', !!(opts && opts.wide));
        var statusEl = document.getElementById('modal-stream-status');
        if (statusEl) {
            statusEl.style.display = (opts && opts.stream) ? '' : 'none';
        }
        var alphaEl = document.getElementById('modal-alpha');
        if (alphaEl) {
            alphaEl.style.display = (opts && opts.wide) ? '' : 'none';
        }
        // Only the Logs view has a server-side capture to download.
        var downloadEl = document.getElementById('modal-download');
        if (downloadEl) {
            downloadEl.style.display = (opts && opts.download) ? '' : 'none';
            downloadEl.disabled = true;
        }
        var searchToggleEl = document.getElementById('modal-search-toggle');
        if (searchToggleEl) {
            searchToggleEl.style.display = (opts && opts.stream) ? '' : 'none';
            searchToggleEl.classList.remove('on');
        }
        var lvlBtnsEl = document.getElementById('modal-lvl-btns');
        if (lvlBtnsEl) {
            lvlBtnsEl.style.display = (opts && opts.stream) ? '' : 'none';
            if (opts && opts.stream) {
                var hiddenLvls = getHiddenLevels();
                lvlBtnsEl.innerHTML = levelButtonsHTML(hiddenLvls);
                applyHiddenLevels(document.getElementById('modal-content'), hiddenLvls);
            }
        }
        var searchBarEl = document.getElementById('modal-search-bar');
        if (searchBarEl) searchBarEl.classList.remove('active');
        var searchInputReset = document.getElementById('modal-search-input');
        if (searchInputReset) searchInputReset.value = '';
        ['modal-search-case', 'modal-search-word', 'modal-search-regex'].forEach(function(id) {
            var b = document.getElementById(id);
            if (b) b.classList.remove('on');
        });
        var searchCountReset = document.getElementById('modal-search-count');
        if (searchCountReset) { searchCountReset.textContent = ''; searchCountReset.classList.remove('error'); }
        searchState.open = false;
        searchState.query = '';
        searchState.caseSensitive = false;
        searchState.wholeWord = false;
        searchState.regex = false;
        searchState.matchCount = 0;
        searchState.currentIndex = 0;
        searchState.invalidRegex = false;
        if (opts && opts.stream) setStreamStatus('reconnecting', 'Connecting…');
        applyModalFontSize();
        applyModalAlpha();
        resetModalDrag();
        overlay.classList.add('active');
    }

    // ===== Drag =====
    // Allows the user to grab the modal header and drag the dialog around the
    // viewport. The overlay flex-centers the dialog, so we shift via transform
    // — accumulating delta into modalDragX/Y across separate drags. Reset on
    // each openModal so a fresh popup re-centers.
    var modalDragX = 0, modalDragY = 0;
    function resetModalDrag() {
        modalDragX = 0;
        modalDragY = 0;
        var dialog = document.querySelector('#resource-modal-overlay .modal-dialog');
        if (dialog) {
            dialog.style.transform = '';
            dialog.style.width = '';
            dialog.style.height = '';
        }
    }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function attachModalDrag(dialog) {
        if (!dialog) return;
        var header = dialog.querySelector('.modal-header');
        if (!header) return;
        var dragging = false;
        var startX = 0, startY = 0;
        var baseX = 0, baseY = 0;

        header.addEventListener('mousedown', function(e) {
            // Skip drags initiated on interactive controls in the header.
            if (e.target.closest('button, input, .modal-stream-status, label')) return;
            if (e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            baseX = modalDragX;
            baseY = modalDragY;
            header.classList.add('dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            modalDragX = baseX + (e.clientX - startX);
            modalDragY = baseY + (e.clientY - startY);
            dialog.style.transform = 'translate(' + modalDragX + 'px, ' + modalDragY + 'px)';
        });

        document.addEventListener('mouseup', function() {
            if (!dragging) return;
            dragging = false;
            header.classList.remove('dragging');
        });
    }

    // ===== Resize =====
    // Builds five edge/corner handles on the dialog (no top handle — the
    // header owns the top edge as a drag handle). The dialog is flex-centered
    // by the overlay and shifted via translate; on resize we adjust both the
    // size and the translate so the opposite edge stays visually anchored.
    function attachModalResize(dialog) {
        if (!dialog) return;
        var specs = [
            { cls: 'right',  xs:  1, ys: 0 },
            { cls: 'left',   xs: -1, ys: 0 },
            { cls: 'bottom', xs:  0, ys: 1 },
            { cls: 'br',     xs:  1, ys: 1 },
            { cls: 'bl',     xs: -1, ys: 1 }
        ];
        specs.forEach(function(s) {
            var handle = document.createElement('div');
            handle.className = 'modal-resize ' + s.cls;
            dialog.appendChild(handle);

            var resizing = false;
            var startX = 0, startY = 0, startW = 0, startH = 0, startTX = 0, startTY = 0;

            handle.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                resizing = true;
                var rect = dialog.getBoundingClientRect();
                startX = e.clientX;
                startY = e.clientY;
                startW = rect.width;
                startH = rect.height;
                startTX = modalDragX;
                startTY = modalDragY;
                e.preventDefault();
                e.stopPropagation();
            });

            document.addEventListener('mousemove', function(e) {
                if (!resizing) return;
                var dx = e.clientX - startX;
                var dy = e.clientY - startY;
                var maxW = window.innerWidth * 0.98;
                var maxH = window.innerHeight * 0.98;
                var newW = clamp(startW + s.xs * dx, 360, maxW);
                var newH = clamp(startH + s.ys * dy, 220, maxH);
                if (s.xs !== 0) dialog.style.width = newW + 'px';
                if (s.ys !== 0) dialog.style.height = newH + 'px';
                modalDragX = startTX + s.xs * (newW - startW) / 2;
                modalDragY = startTY + s.ys * (newH - startH) / 2;
                dialog.style.transform = 'translate(' + modalDragX + 'px, ' + modalDragY + 'px)';
            });

            document.addEventListener('mouseup', function() { resizing = false; });
        });
    }

    var MODAL_FONT_KEY = 'kro_modal_font_px';
    var MODAL_FONT_MIN = 9;
    var MODAL_FONT_MAX = 22;
    var MODAL_FONT_DEFAULT = 12; // matches CSS .modal-content default (~0.78rem)

    function getModalFontSize() {
        var v = parseInt(localStorage.getItem(MODAL_FONT_KEY), 10);
        if (isNaN(v)) return MODAL_FONT_DEFAULT;
        return Math.max(MODAL_FONT_MIN, Math.min(MODAL_FONT_MAX, v));
    }

    function applyModalFontSize() {
        var el = document.getElementById('modal-content');
        if (el) el.style.fontSize = getModalFontSize() + 'px';
    }

    window.adjustModalFont = function(delta) {
        var size = getModalFontSize() + delta;
        size = Math.max(MODAL_FONT_MIN, Math.min(MODAL_FONT_MAX, size));
        localStorage.setItem(MODAL_FONT_KEY, String(size));
        applyModalFontSize();
    };

    var MODAL_ALPHA_KEY = 'kro_modal_alpha';
    var MODAL_ALPHA_MIN = 10;
    var MODAL_ALPHA_DEFAULT = 60;

    function getModalAlpha() {
        var v = parseInt(localStorage.getItem(MODAL_ALPHA_KEY), 10);
        if (isNaN(v)) return MODAL_ALPHA_DEFAULT;
        return Math.max(MODAL_ALPHA_MIN, Math.min(100, v));
    }

    function applyModalAlpha() {
        var dialog = document.querySelector('#resource-modal-overlay .modal-dialog');
        var alpha = getModalAlpha();
        if (dialog) dialog.style.setProperty('--modal-alpha', (alpha / 100).toFixed(2));
        var input = document.getElementById('modal-alpha-input');
        if (input) input.value = String(alpha);
    }

    window.setModalAlpha = function(val) {
        var v = Math.max(MODAL_ALPHA_MIN, Math.min(100, parseInt(val, 10) || MODAL_ALPHA_DEFAULT));
        localStorage.setItem(MODAL_ALPHA_KEY, String(v));
        applyModalAlpha();
    };

    function setModalContent(text) {
        var el = document.getElementById('modal-content');
        if (el) el.textContent = text;
    }

    window.copyModalContent = function(btn) {
        var el = document.getElementById('modal-content');
        if (!el) return;
        navigator.clipboard.writeText(el.textContent).then(function() {
            var orig = btn.textContent;
            btn.textContent = '✓';
            setTimeout(function() { btn.textContent = orig; }, 1200);
        });
    };

    window.closeModal = function() {
        closeLogStream();
        closeMetricsStream();
        var overlay = document.getElementById('resource-modal-overlay');
        if (overlay) overlay.classList.remove('active');
    };

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeModal();
    });

    // "/" focuses the pod filter of the tab on screen — the usual
    // search-focus key in web UIs. Only a bare "/" outside any text field
    // counts, so it never steals the character from the terminal, a search
    // box, or the quick switcher; and it stays inert while a modal is open.
    // The pod listings re-render wholesale and "All Pods" exists in more than
    // one tab, so the target is looked up at keypress time: the first
    // .pod-filter-input with a layout box, i.e. in the visible tab and not in
    // a collapsed section. With none on screen (Pod Watch page, collapsed
    // section) the key is left alone.
    document.addEventListener('keydown', function(e) {
        if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
                   ae.tagName === 'SELECT' || ae.isContentEditable)) return;
        var overlay = document.getElementById('resource-modal-overlay');
        if (overlay && overlay.classList.contains('active')) return;
        var inputs = document.querySelectorAll('.pod-filter-input');
        for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].offsetParent === null) continue; // hidden tab or collapsed section
            e.preventDefault(); // keep the "/" itself out of the box
            inputs[i].focus();
            inputs[i].select(); // typing replaces an old query; arrows keep it
            return;
        }
    });

    // ===== Helpers =====
    function escapeHtml(str) {
        if (!str && str !== 0) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }

    // ===== SSE =====
    // /sse/resources event types (see web/sse.go):
    //   resources_snapshot  the full tree, sent when it differs from the last
    //   resources_tick      "checked, nothing changed" (no payload to parse)
    //   resources_error     {"error": "..."}: the cluster could not be listed
    // Every one of them proves the stream is alive and feeds the watchdog.
    var HEARTBEAT_TIMEOUT_MS = 60000;
    var resourcesSource = null;
    var resourcesStreamKinds = null; // activeKindsKey() the open stream was opened with
    var resourcesHeartbeatTimer = null;
    var resourcesStatus = null;
    var lastGoodAt = 0; // ms timestamp of the last successful check of the cluster

    function setStatus(state) {
        if (!resourcesStatus) return;
        resourcesStatus.className = 'log-status ' + state;
        updateStatusTitle(state);
    }

    // The dot's tooltip says what the color means and how fresh the page is.
    function updateStatusTitle(state) {
        if (!resourcesStatus) return;
        state = state || (resourcesStatus.className.replace('log-status', '').trim());
        var label = { connected: 'Live', reconnecting: 'Reconnecting…',
                      disconnected: 'Not connected', paused: 'Paused while the window is hidden' }[state] || state;
        resourcesStatus.title = label + (lastGoodAt ? ' — last checked ' + formatClock(lastGoodAt) : '') +
            (pendingTree ? '. An update is waiting; it is applied when the text selection is released.' : '');
    }

    function noteResourcesFresh() {
        lastGoodAt = Date.now();
        updateStatusTitle();
    }

    function resetHeartbeat() {
        clearTimeout(resourcesHeartbeatTimer);
        resourcesHeartbeatTimer = setTimeout(function() {
            closeResourcesStream();
            setStatus('reconnecting');
            setTimeout(initResourcesStream, 1000);
        }, HEARTBEAT_TIMEOUT_MS);
    }

    function closeResourcesStream() {
        clearTimeout(resourcesHeartbeatTimer);
        if (resourcesSource) {
            resourcesSource.close();
            resourcesSource = null;
        }
    }

    function initResourcesStream() {
        closeResourcesStream();
        // While the window is hidden the stream stays closed (see the
        // visibility handling below); becoming visible reopens it.
        if (document.hidden) { setStatus('paused'); return; }

        // The kinds are fixed for the life of the connection (EventSource's
        // own reconnects reuse this URL); switchTab opens a new stream when
        // the active tab needs different ones.
        var kinds = activeKindsKey();
        var source = new EventSource('/sse/resources' + kindsQuery(kinds));
        resourcesSource = source;
        resourcesStreamKinds = kinds;

        source.addEventListener('resources_snapshot', function(e) {
            if (source !== resourcesSource) return; // a superseded stream's straggler
            resetHeartbeat();
            setStatus('connected');
            try {
                var tree = JSON.parse(e.data);
                noteResourcesFresh();
                applyTree(tree);
            } catch (err) { /* malformed frame: wait for the next */ }
        });
        source.addEventListener('resources_tick', function() {
            if (source !== resourcesSource) return;
            resetHeartbeat();
            setStatus('connected');
            noteResourcesFresh();
            // The cluster answered and nothing changed, so whatever is on
            // screen is current again: drop a banner left by an earlier error.
            if (lastTree) clearResourcesBanner();
        });
        source.addEventListener('resources_error', function(e) {
            if (source !== resourcesSource) return;
            resetHeartbeat(); // kro is alive; it is the cluster that is not answering
            var msg = 'cluster unavailable';
            try { msg = JSON.parse(e.data).error || msg; } catch (err) { /* keep default */ }
            showResourcesError(msg);
        });

        source.onopen = function() {
            if (source !== resourcesSource) return;
            setStatus('connected');
            resetHeartbeat();
        };
        source.onerror = function() {
            if (source !== resourcesSource) return;
            setStatus('reconnecting');
        };
    }

    // ----- Pause while hidden -----
    // A hidden window (minimized, another Space, KRo.app in the background for
    // days) has nobody to show snapshots to, but the server would keep listing
    // the namespace's resources every 10s on its behalf. Closing the stream stops
    // that: the server's producer ends with the connection. A short grace
    // period keeps a quick Cmd+Tab away and back from tearing it down.
    // Only this stream is paused. Logs, Pod Watch and terminal streams are
    // capturing output and must keep running unattended.
    var HIDDEN_GRACE_MS = 20000;
    var hiddenTimer = null;

    document.addEventListener('visibilitychange', function() {
        clearTimeout(hiddenTimer);
        if (document.hidden) {
            hiddenTimer = setTimeout(function() {
                if (!document.hidden) return;
                closeResourcesStream();
                setStatus('paused');
            }, HIDDEN_GRACE_MS);
            return;
        }
        // Visible again. If the stream was closed, reopen it; its first event
        // is a full snapshot, so the tables catch up without a manual refresh.
        if (!resourcesSource) initResourcesStream();
        refreshContexts();
    });

    // Window focus covers the Cmd+Tab case, where the window never stops
    // being visible (a terminal beside it, or on another monitor), so
    // visibilitychange does not fire. Focus events from elements inside the
    // page do not reach a bubble-phase listener on window, but check the
    // target anyway so a stray one can't trigger a refresh per click.
    window.addEventListener('focus', function(e) {
        if (e.target === window) refreshContexts();
    });

    // ===== Terminal =====
    // A small kubectl-only terminal that sits above the resource sections.
    // The Go server runs `kubectl --context=<ctx> --namespace=<ns> <args...>`
    // and streams stdout/stderr over /sse/term. The visible "editor" is a
    // transparent textarea overlaid on a syntax-highlighting <pre> so the
    // caret is native (click anywhere to position) while the rendered text is
    // colorized. History is persisted to localStorage so it survives reloads.
    var TERM_HISTORY_KEY = 'kro_term_history';
    var TERM_HISTORY_MAX = 200;
    var termHistory = [];
    var termHistoryIdx = -1;     // -1 means "at the live draft, not in history"
    var termDraft = '';          // text saved when navigating into history
    var termRunning = false;
    var termSource = null;
    var termActiveBlock = null;  // { cmd, outEl, exitEl, stdoutSpan, stderrSpan }
    var termInput = null;
    var termHighlight = null;
    var termBlocks = null;

    // Per-(context, namespace) terminal state. Blocks are stored as live DOM
    // nodes (detached when off-screen), so search controllers and styles ride
    // along with them. We cancel any running command before switching keys, so
    // detached blocks never receive further output.
    var termStateByKey = {};
    var termCurrentKey = null;

    // Cap on output spans (one per stdout/stderr line) kept per namespace
    // terminal. Each append trims the oldest spans down to this limit; empty
    // non-active blocks are then dropped so the scrollback doesn't fill up
    // with bare command/exit headers.
    var TERM_MAX_OUTPUT_LINES = 5000;

    function loadTermHistory() {
        try {
            var raw = localStorage.getItem(TERM_HISTORY_KEY);
            if (raw) termHistory = JSON.parse(raw) || [];
        } catch (_) { termHistory = []; }
    }
    function saveTermHistory() {
        try { localStorage.setItem(TERM_HISTORY_KEY, JSON.stringify(termHistory.slice(-TERM_HISTORY_MAX))); }
        catch (_) {}
    }
    function pushTermHistory(cmd) {
        if (!cmd) return;
        if (termHistory.length && termHistory[termHistory.length - 1] === cmd) return;
        termHistory.push(cmd);
        if (termHistory.length > TERM_HISTORY_MAX) termHistory = termHistory.slice(-TERM_HISTORY_MAX);
        saveTermHistory();
    }

    // Token classes:
    //   verb       — first arg in the command (get/describe/logs/apply/...)
    //   flag       — --foo or -x (possibly with =value)
    //   string     — single/double-quoted literal
    //   number     — bare numeric literal
    //   sep        — `--` end-of-flags marker
    //   resource   — second arg (kind-ish, pods/deploy/svc/...) — colored softer
    var TERM_VERB_RX = /^(get|describe|logs|apply|delete|create|edit|exec|run|scale|rollout|expose|port-forward|cp|top|drain|cordon|uncordon|taint|label|annotate|patch|replace|set|config|wait|auth|api-resources|api-versions|cluster-info|completion|explain|version|debug|attach|proxy|diff|kustomize|certificate|alpha|plugin|events)$/;

    // highlightTermLine returns colorized HTML for a single line of input.
    // It's intentionally rough — kubectl's surface is large; this picks off
    // the easy wins (flags, quoted strings, the verb, end-of-flags marker)
    // without trying to be a full parser.
    function highlightTermLine(line, isFirstLine) {
        if (!line) return '';
        var out = '';
        var i = 0;
        var sawNonWS = false;
        var sawVerb = false;
        while (i < line.length) {
            var ch = line[i];
            // whitespace
            if (ch === ' ' || ch === '\t') {
                var ws = '';
                while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { ws += line[i]; i++; }
                out += ws;
                continue;
            }
            // comment to end-of-line
            if (ch === '#') {
                out += '<span class="tk-comment">' + escapeHtml(line.slice(i)) + '</span>';
                break;
            }
            // quoted string
            if (ch === '"' || ch === "'") {
                var q = ch;
                var start = i;
                i++;
                while (i < line.length && line[i] !== q) {
                    if (line[i] === '\\' && i + 1 < line.length) i++;
                    i++;
                }
                if (i < line.length) i++; // consume closing quote
                out += '<span class="tk-string">' + escapeHtml(line.slice(start, i)) + '</span>';
                sawNonWS = true;
                continue;
            }
            // flag (-x or --foo, possibly =value)
            if (ch === '-' && (i + 1 < line.length) && line[i + 1] !== ' ') {
                var fStart = i;
                while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '=') i++;
                var flag = line.slice(fStart, i);
                if (flag === '--') {
                    out += '<span class="tk-sep">--</span>';
                } else {
                    out += '<span class="tk-flag">' + escapeHtml(flag) + '</span>';
                }
                if (i < line.length && line[i] === '=') {
                    out += '=';
                    i++;
                    // value: may be quoted or bare
                    if (i < line.length && (line[i] === '"' || line[i] === "'")) continue; // loop picks up quote
                    var vStart = i;
                    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
                    out += '<span class="tk-string">' + escapeHtml(line.slice(vStart, i)) + '</span>';
                }
                sawNonWS = true;
                continue;
            }
            // bare token
            var tStart = i;
            while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
            var tok = line.slice(tStart, i);
            if (!sawVerb && isFirstLine && TERM_VERB_RX.test(tok)) {
                out += '<span class="tk-verb">' + escapeHtml(tok) + '</span>';
                sawVerb = true;
            } else if (/^-?\d+(\.\d+)?$/.test(tok)) {
                out += '<span class="tk-number">' + escapeHtml(tok) + '</span>';
            } else if (sawVerb && sawNonWS === false) {
                // (won't actually hit — sawNonWS would be true after the verb)
                out += escapeHtml(tok);
            } else if (sawVerb) {
                out += '<span class="tk-resource">' + escapeHtml(tok) + '</span>';
                sawVerb = false; // only first arg after verb gets resource color
            } else {
                out += escapeHtml(tok);
            }
            sawNonWS = true;
        }
        return out;
    }

    function refreshTermHighlight() {
        if (!termInput || !termHighlight) return;
        var text = termInput.value;
        var lines = text.split('\n');
        var html = '';
        for (var i = 0; i < lines.length; i++) {
            if (i > 0) html += '\n';
            html += highlightTermLine(lines[i], i === 0);
        }
        // Trailing newline needs a non-empty span or browsers collapse the
        // last visual row, leaving the caret hovering on nothing visible.
        if (text.endsWith('\n')) html += ' ';
        termHighlight.innerHTML = html;
    }

    function autosizeTermInput() {
        if (!termInput) return;
        termInput.style.height = 'auto';
        var h = Math.min(termInput.scrollHeight, 220);
        termInput.style.height = h + 'px';
        if (termHighlight) termHighlight.style.height = h + 'px';
    }

    function updateTermTarget() {
        var el = document.getElementById('term-target');
        if (el) el.textContent = (currentCtx || '?') + ' / ' + (currentNs || '?');
        termSwitchTo(termKey());
    }

    function termKey() {
        return (currentCtx || '') + '::' + (currentNs || '');
    }

    // Swap the visible blocks to match the (ctx, ns) selection. Current blocks
    // are detached (not destroyed) and parked under the previous key so they
    // come back exactly as they were when the user returns. Any running
    // command is canceled before swapping — the active block keeps its place
    // in its origin namespace with a "canceled" pill.
    function termSwitchTo(newKey) {
        if (!termBlocks) { termCurrentKey = newKey; return; }
        if (termCurrentKey === newKey) return;

        if (termRunning) window.termCancel();

        if (termCurrentKey !== null) {
            var saved = [];
            var n = termBlocks.firstChild;
            while (n) {
                var next = n.nextSibling;
                if (n.nodeType === 1 && !(n.classList && n.classList.contains('term-empty'))) {
                    saved.push(n);
                }
                termBlocks.removeChild(n);
                n = next;
            }
            termStateByKey[termCurrentKey] = { blocks: saved };
        }

        termBlocks.innerHTML = '';
        var st = termStateByKey[newKey];
        if (st && st.blocks.length) {
            for (var i = 0; i < st.blocks.length; i++) {
                termBlocks.appendChild(st.blocks[i]);
            }
            termBlocks.scrollTop = termBlocks.scrollHeight;
        } else {
            termBlocks.innerHTML = '<div class="term-empty">kubectl output appears here. Try: get pods</div>';
        }

        termCurrentKey = newKey;
    }

    // Enforce the per-namespace output cap. Spans are kept in DOM order, so
    // dropping from the front always removes the oldest output. After trimming
    // we sweep blocks that have lost all their output (except the active one
    // and the last block, which is the most recent context the user sees).
    function termTrimToLimit() {
        if (!termBlocks) return;
        var spans = termBlocks.querySelectorAll('.term-block-out > span');
        var over = spans.length - TERM_MAX_OUTPUT_LINES;
        for (var i = 0; i < over; i++) spans[i].remove();
        if (over <= 0) return;

        var blocks = termBlocks.querySelectorAll('.term-block');
        var lastIdx = blocks.length - 1;
        for (var b = 0; b < blocks.length; b++) {
            if (b === lastIdx) continue;
            var blk = blocks[b];
            if (termActiveBlock && blk === termActiveBlock.el) continue;
            var out = blk.querySelector('.term-block-out');
            if (out && out.childNodes.length === 0) blk.remove();
        }
    }

    // Per-block toolbar: search toggle, font −/+, copy. Sits on the same line as
    // the command. SVG search icon mirrors the modal's so the action is obvious.
    var TERM_BLK_TOOLBAR_HTML =
        '<span class="term-blk-tools">' +
            '<button type="button" class="term-blk-btn term-blk-search-toggle" data-act="search" title="Search output (Ctrl+F)" aria-label="Search output">' +
                '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<circle cx="7" cy="7" r="5"></circle><line x1="11" y1="11" x2="14.5" y2="14.5"></line>' +
                '</svg>' +
            '</button>' +
            '<button type="button" class="term-blk-btn" data-act="font-down" title="Smaller text">A−</button>' +
            '<button type="button" class="term-blk-btn" data-act="font-up" title="Larger text">A+</button>' +
            '<button type="button" class="term-blk-btn" data-act="copy" title="Copy output">⧉</button>' +
        '</span>';

    // The browser's native `resize: vertical` handle writes an inline `height`
    // style on .term-block-out when the user drags it. Watch for that and tag
    // the parent block so the last-child auto-fill CSS stops growing it back —
    // manual resize wins. Font/size changes touch other style properties, not
    // height, so they don't trip this.
    function watchTermBlockManualResize(blockEl, outEl) {
        if (typeof MutationObserver === 'undefined') return;
        var obs = new MutationObserver(function() {
            if (outEl.style.height) {
                blockEl.classList.add('user-resized');
                obs.disconnect();
            }
        });
        obs.observe(outEl, { attributes: true, attributeFilter: ['style'] });
    }

    function termAppendBlock(cmd) {
        if (!termBlocks) return null;
        var empty = termBlocks.querySelector('.term-empty');
        if (empty) empty.remove();

        var block = document.createElement('div');
        block.className = 'term-block';

        var cmdRow = document.createElement('div');
        cmdRow.className = 'term-block-cmd';
        cmdRow.innerHTML =
            '<span class="term-fold" title="Fold/unfold output">▾</span>' +
            '<span class="term-prompt-mini">$ kubectl</span>' +
            '<span class="term-cmd-text" title="' + escapeHtml(cmd) + '">' + highlightTermLine(cmd, true) + '</span>' +
            '<span class="term-exit running">running…<button type="button" class="term-exit-abort" title="Abort this command" aria-label="Abort">×</button></span>' +
            TERM_BLK_TOOLBAR_HTML;
        block.appendChild(cmdRow);

        var out = document.createElement('pre');
        out.className = 'term-block-out';
        block.appendChild(out);

        watchTermBlockManualResize(block, out);

        termBlocks.appendChild(block);
        termBlocks.scrollTop = termBlocks.scrollHeight;

        applyTermBlockFont(out);

        return {
            cmd: cmd,
            el: block,
            cmdRow: cmdRow,
            outEl: out,
            exitEl: cmdRow.querySelector('.term-exit'),
            searchCtl: null,
            // Pending output lines waiting for the next rAF flush. High-rate
            // streams (kubectl logs on a noisy pod) deliver hundreds of SSE
            // events per frame; coalescing them into one DOM update keeps the
            // main thread responsive and avoids the "page unresponsive" prompt.
            outBuf: [],
            flushScheduled: false
        };
    }

    // Click handlers (delegated on .term-blocks): fold chevron, search toggle,
    // font −/+, copy. Works for blocks added later via SSE.
    function onTermBlockClick(e) {
        var t = e.target;
        if (!t || !t.closest) return;

        var fold = t.closest('.term-fold');
        if (fold) {
            var fblock = fold.closest('.term-block');
            if (fblock) fblock.classList.toggle('folded');
            return;
        }

        var abort = t.closest('.term-exit-abort');
        if (abort) {
            e.stopPropagation();
            window.termCancel();
            return;
        }

        var btn = t.closest('.term-blk-btn');
        if (!btn) return;
        var blockEl = btn.closest('.term-block');
        if (!blockEl) return;
        var act = btn.getAttribute('data-act');
        if (act === 'search') {
            var ctl = ensureBlockSearch(blockEl);
            if (ctl) ctl.toggle();
        } else if (act === 'font-down') {
            adjustTermBlockFont(-1);
        } else if (act === 'font-up') {
            adjustTermBlockFont(1);
        } else if (act === 'copy') {
            copyBlockOutput(blockEl, btn);
        }
    }

    function copyBlockOutput(blockEl, btn) {
        var out = blockEl.querySelector('.term-block-out');
        if (!out) return;
        var orig = btn.innerHTML;
        navigator.clipboard.writeText(out.textContent || '').then(function() {
            btn.innerHTML = '✓';
            setTimeout(function() { btn.innerHTML = orig; }, 900);
        }).catch(function() {
            btn.innerHTML = '!';
            setTimeout(function() { btn.innerHTML = orig; }, 900);
        });
    }

    // ----- Per-block font size (persisted globally for all blocks) -----
    var TERM_FONT_KEY = 'kro_term_block_font_px';
    var TERM_FONT_MIN = 9, TERM_FONT_MAX = 22, TERM_FONT_DEFAULT = 12;

    function getTermBlockFont() {
        var v = parseInt(localStorage.getItem(TERM_FONT_KEY), 10);
        if (isNaN(v)) return TERM_FONT_DEFAULT;
        return Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, v));
    }
    function applyTermBlockFont(el) {
        if (el) el.style.fontSize = getTermBlockFont() + 'px';
    }
    function adjustTermBlockFont(delta) {
        var s = Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, getTermBlockFont() + delta));
        localStorage.setItem(TERM_FONT_KEY, String(s));
        var outs = (termBlocks || document).querySelectorAll('.term-block-out');
        for (var i = 0; i < outs.length; i++) outs[i].style.fontSize = s + 'px';
    }

    // ----- Per-block search controller (lazy) -----
    // Stored on the block DOM element via a WeakMap-like data attribute so SSE
    // appends can find the controller and incrementally highlight new lines.
    var blockSearchByEl = new WeakMap();

    function ensureBlockSearch(blockEl) {
        var existing = blockSearchByEl.get(blockEl);
        if (existing) return existing;

        var outEl = blockEl.querySelector('.term-block-out');
        if (!outEl) return null;

        var bar = document.createElement('div');
        bar.className = 'term-blk-search';
        bar.innerHTML =
            '<input type="text" class="term-blk-search-input" placeholder="Find in output…" autocomplete="off" spellcheck="false">' +
            '<button type="button" class="term-blk-search-opt" data-opt="case" title="Match case">Aa</button>' +
            '<button type="button" class="term-blk-search-opt" data-opt="word" title="Whole word"><u>W</u></button>' +
            '<button type="button" class="term-blk-search-opt" data-opt="regex" title="Regular expression">.*</button>' +
            '<span class="term-blk-search-count"></span>' +
            '<button type="button" class="term-blk-search-nav" data-nav="-1" title="Previous (Shift+Enter)">↑</button>' +
            '<button type="button" class="term-blk-search-nav" data-nav="1" title="Next (Enter)">↓</button>' +
            '<button type="button" class="term-blk-search-close" title="Close (Esc)">×</button>';
        blockEl.insertBefore(bar, outEl);

        var input = bar.querySelector('.term-blk-search-input');
        var countEl = bar.querySelector('.term-blk-search-count');
        var st = { open: false, query: '', caseSensitive: false, wholeWord: false, regex: false, matchCount: 0, currentIndex: 0, invalidRegex: false };

        function buildRx() {
            return buildLogSearchRegex(st.query, st.caseSensitive, st.wholeWord, st.regex);
        }
        function refreshCount() {
            if (st.invalidRegex) { countEl.textContent = 'invalid regex'; countEl.classList.add('error'); return; }
            countEl.classList.remove('error');
            if (!st.query) { countEl.textContent = ''; return; }
            if (st.matchCount === 0) { countEl.textContent = 'no matches'; return; }
            countEl.textContent = (st.currentIndex + 1) + ' / ' + st.matchCount;
        }
        function navigate(delta, wrap) {
            var groups = markGroups(outEl.querySelectorAll('mark.log-match'));
            if (!groups.length) return;
            var cur = -1;
            for (var i = 0; i < groups.length; i++) {
                if (groups[i][0].classList.contains('current')) { cur = i; break; }
            }
            var nx;
            if (cur === -1) nx = delta >= 0 ? 0 : groups.length - 1;
            else {
                nx = cur + delta;
                if (wrap !== false) nx = ((nx % groups.length) + groups.length) % groups.length;
                else nx = Math.max(0, Math.min(groups.length - 1, nx));
                groups[cur].forEach(function(m) { m.classList.remove('current'); });
            }
            groups[nx].forEach(function(m) { m.classList.add('current'); });
            groups[nx][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
            st.currentIndex = nx;
            refreshCount();
        }
        function run() {
            clearSearchMarks(outEl);
            st.invalidRegex = false; st.matchCount = 0; st.currentIndex = 0;
            if (!st.query) { refreshCount(); return; }
            var rx = buildRx();
            if (rx === false) { st.invalidRegex = true; refreshCount(); return; }
            st.matchCount = highlightMatchesIn(outEl, rx);
            refreshCount();
            if (st.matchCount > 0) navigate(0, false);
        }

        input.addEventListener('input', function() { st.query = input.value || ''; run(); });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); navigate(e.shiftKey ? -1 : 1, true); }
            else if (e.key === 'Escape') { e.preventDefault(); ctl.close(); }
        });
        var optBtns = bar.querySelectorAll('.term-blk-search-opt');
        for (var i = 0; i < optBtns.length; i++) {
            (function(b) {
                b.addEventListener('click', function() {
                    var k = b.getAttribute('data-opt');
                    var prop = k === 'case' ? 'caseSensitive' : k === 'word' ? 'wholeWord' : 'regex';
                    st[prop] = !st[prop];
                    b.classList.toggle('on', st[prop]);
                    run();
                });
            })(optBtns[i]);
        }
        var navBtns = bar.querySelectorAll('.term-blk-search-nav');
        for (var j = 0; j < navBtns.length; j++) {
            (function(b) {
                b.addEventListener('click', function() { navigate(parseInt(b.getAttribute('data-nav'), 10), true); });
            })(navBtns[j]);
        }
        bar.querySelector('.term-blk-search-close').addEventListener('click', function() { ctl.close(); });

        var toggleBtn = blockEl.querySelector('.term-blk-search-toggle');
        var ctl = {
            open: function() {
                st.open = true;
                bar.classList.add('active');
                if (toggleBtn) toggleBtn.classList.add('on');
                input.focus(); input.select();
                run();
            },
            close: function() {
                st.open = false;
                bar.classList.remove('active');
                if (toggleBtn) toggleBtn.classList.remove('on');
                clearSearchMarks(outEl);
            },
            toggle: function() { st.open ? ctl.close() : ctl.open(); },
            isOpen: function() { return st.open; },
            onAppend: function(scope) {
                if (!st.open || !st.query) return;
                var rx = buildRx();
                if (!rx || rx === false) return;
                var added = highlightMatchesIn(scope || outEl, rx);
                if (added > 0) { st.matchCount += added; refreshCount(); }
            }
        };
        blockSearchByEl.set(blockEl, ctl);
        return ctl;
    }

    // Buffers a single output line and schedules a coalesced flush. The actual
    // DOM work happens in flushTermBlockOutput on the next animation frame, so
    // a burst of SSE events from `kubectl logs` only pays one layout/trim cost
    // per frame instead of one per line.
    function termAppendOutput(block, kind, line) {
        if (!block) return;
        block.outBuf.push(kind, line || '');
        if (block.flushScheduled) return;
        block.flushScheduled = true;
        requestAnimationFrame(function() { flushTermBlockOutput(block); });
    }

    function flushTermBlockOutput(block) {
        block.flushScheduled = false;
        var buf = block.outBuf;
        if (!buf.length) return;
        block.outBuf = [];

        var out = block.outEl;
        var atBottom = (out.scrollHeight - out.scrollTop - out.clientHeight) < 30;

        var frag = document.createDocumentFragment();
        var newSpans = [];
        for (var i = 0; i < buf.length; i += 2) {
            var kind = buf[i];
            var line = buf[i + 1];
            var span = document.createElement('span');
            if (kind === 'stderr') span.className = 'term-stderr';
            else if (kind === 'info') span.className = 'term-info';
            span.innerHTML = highlightLogLine(line) + '\n';
            frag.appendChild(span);
            newSpans.push(span);
        }
        out.appendChild(frag);

        var ctl = blockSearchByEl.get(block.el);
        if (ctl) {
            for (var j = 0; j < newSpans.length; j++) ctl.onAppend(newSpans[j]);
        }
        // Trimming or autoscrolling would wipe a selection the user is trying
        // to copy; hold both while one is active anywhere in the terminal.
        var holdForSelection = selectionActiveIn(termBlocks);
        if (!holdForSelection) termTrimToLimit();
        if (atBottom && !holdForSelection) out.scrollTop = out.scrollHeight;
    }

    function termFinalize(block, exitCode, canceled) {
        if (!block) return;
        var ex = block.exitEl;
        if (!ex) return;
        ex.classList.remove('running');
        if (canceled) {
            ex.classList.add('canceled');
            ex.textContent = 'canceled';
        } else if (exitCode === 0) {
            ex.classList.add('ok');
            ex.textContent = 'exit 0';
        } else {
            ex.classList.add('bad');
            ex.textContent = 'exit ' + exitCode;
        }
        if (!canceled && termBlocks && block.el) {
            var siblings = termBlocks.querySelectorAll('.term-block');
            for (var i = 0; i < siblings.length; i++) {
                if (siblings[i] !== block.el) siblings[i].classList.add('folded');
            }
        }
    }

    function termClose() {
        if (termSource) {
            try { termSource.close(); } catch (_) {}
            termSource = null;
        }
    }

    window.termCancel = function() {
        if (!termRunning) return;
        termClose();
        if (termActiveBlock) flushTermBlockOutput(termActiveBlock);
        termFinalize(termActiveBlock, 130, true);
        termActiveBlock = null;
        termSetRunning(false);
    };

    window.termClear = function() {
        if (!termBlocks) return;
        termBlocks.innerHTML = '<div class="term-empty">kubectl output appears here. Try: get pods</div>';
    };

    function termSetRunning(running) {
        termRunning = running;
        var runBtn = document.getElementById('term-run');
        var cancelBtn = document.getElementById('term-cancel');
        if (runBtn) runBtn.disabled = running;
        if (cancelBtn) cancelBtn.classList.toggle('active', running);
        if (termInput) termInput.readOnly = running;
    }

    window.termRun = function() {
        if (termRunning || !termInput) return;
        var cmd = termInput.value.trim();
        if (!cmd) return;

        // If the terminal section is collapsed, expand it so the user sees output.
        var section = document.querySelector('[data-section="terminal"]');
        if (section && section.classList.contains('collapsed')) {
            window.toggleSection('terminal');
        }

        pushTermHistory(cmd);
        termHistoryIdx = -1;
        termDraft = '';

        termActiveBlock = termAppendBlock(cmd);
        termSetRunning(true);

        // Clear the editor for the next command.
        termInput.value = '';
        refreshTermHighlight();
        autosizeTermInput();

        termClose();
        termSource = new EventSource('/sse/term?cmd=' + encodeURIComponent(cmd));
        var block = termActiveBlock;

        termSource.addEventListener('stdout', function(e) { termAppendOutput(block, 'stdout', e.data); });
        termSource.addEventListener('stderr', function(e) { termAppendOutput(block, 'stderr', e.data); });
        termSource.addEventListener('done', function(e) {
            var code = parseInt(e.data, 10);
            if (isNaN(code)) code = -1;
            // Drain any buffered output so the exit pill never lands before
            // the last few lines do.
            flushTermBlockOutput(block);
            termFinalize(block, code, false);
            termActiveBlock = null;
            termSetRunning(false);
            termClose();
        });
        termSource.onerror = function() {
            // Never let EventSource retry here. /sse/term starts kubectl when
            // the request arrives, so a reconnect to the same URL does not
            // resume the output: it runs the command a second time. For
            // `rollout restart`, `delete`, `scale` or `apply`, that is a
            // second mutation the user never asked for. Close the source,
            // which also cancels the process server-side if it is still
            // running, and say what happened; re-running is the user's call.
            if (!termRunning) { termClose(); return; }
            termAppendOutput(block, 'stderr',
                '(connection to kro lost; the command was not re-run. Its outcome is unknown, check before repeating it.)');
            flushTermBlockOutput(block);
            termFinalize(block, -1, false);
            // There is no exit code to report; say so instead of "exit -1".
            if (block && block.exitEl) block.exitEl.textContent = 'connection lost';
            termActiveBlock = null;
            termSetRunning(false);
            termClose();
        };
    };

    function navigateTermHistory(direction) {
        if (!termInput || termHistory.length === 0) return false;
        if (termHistoryIdx === -1 && direction < 0) {
            termDraft = termInput.value;
            termHistoryIdx = termHistory.length - 1;
        } else if (termHistoryIdx === -1 && direction > 0) {
            return false;
        } else {
            var next = termHistoryIdx + direction;
            if (next < 0) next = 0;
            if (next >= termHistory.length) {
                termHistoryIdx = -1;
                termInput.value = termDraft;
                refreshTermHighlight();
                autosizeTermInput();
                // Move caret to end
                termInput.selectionStart = termInput.selectionEnd = termInput.value.length;
                return true;
            }
            termHistoryIdx = next;
        }
        termInput.value = termHistory[termHistoryIdx] || '';
        refreshTermHighlight();
        autosizeTermInput();
        termInput.selectionStart = termInput.selectionEnd = termInput.value.length;
        return true;
    }

    function caretOnFirstLine(el) {
        var v = el.value;
        var s = el.selectionStart;
        return v.indexOf('\n') === -1 || s <= v.indexOf('\n');
    }
    function caretOnLastLine(el) {
        var v = el.value;
        var s = el.selectionStart;
        return v.lastIndexOf('\n') === -1 || s > v.lastIndexOf('\n');
    }

    // If text is selected inside the terminal output pane (not in the input
    // itself), return it. Otherwise return ''. Used by Ctrl/Cmd+Enter to
    // splice a selected pod/resource name into the command input.
    function getTermBlocksSelection() {
        if (!termBlocks) return '';
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
        var text = sel.toString();
        if (!text) return '';
        var anchor = sel.anchorNode;
        var focus = sel.focusNode;
        if (!anchor || !focus) return '';
        if (!termBlocks.contains(anchor) || !termBlocks.contains(focus)) return '';
        return text;
    }

    function insertIntoTermInput(text) {
        if (!termInput || !text) return;
        var v = termInput.value;
        var start = termInput.selectionStart;
        var end = termInput.selectionEnd;
        var needsSpace = start > 0 && !/\s/.test(v.charAt(start - 1));
        var insert = (needsSpace ? ' ' : '') + text;
        termInput.value = v.slice(0, start) + insert + v.slice(end);
        var caret = start + insert.length;
        termInput.selectionStart = termInput.selectionEnd = caret;
        refreshTermHighlight();
        autosizeTermInput();
        // Drop the page selection so the next Enter just runs the command.
        var s = window.getSelection ? window.getSelection() : null;
        if (s && s.removeAllRanges) s.removeAllRanges();
    }

    // Document-level handler so the shortcut works even when focus has left
    // the input (which it has, right after you drag-select output text).
    function onDocTermInsertKey(e) {
        if (e.key !== 'Enter') return;
        if (e.shiftKey || e.altKey) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        var picked = getTermBlocksSelection();
        if (!picked) return;
        e.preventDefault();
        e.stopPropagation();
        insertIntoTermInput(picked);
        if (termInput) termInput.focus();
    }

    function onTermKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            window.termRun();
            return;
        }
        if (e.key === 'Escape') {
            if (termRunning) { e.preventDefault(); window.termCancel(); }
            return;
        }
        if (e.key === 'ArrowUp' && caretOnFirstLine(termInput)) {
            if (navigateTermHistory(-1)) e.preventDefault();
            return;
        }
        if (e.key === 'ArrowDown' && caretOnLastLine(termInput)) {
            if (navigateTermHistory(1)) e.preventDefault();
            return;
        }
        if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            window.termClear();
            return;
        }
    }

    function onTermInput() {
        // Any manual edit invalidates the "browsing history" state.
        if (termHistoryIdx !== -1) {
            termHistoryIdx = -1;
            termDraft = '';
        }
        refreshTermHighlight();
        autosizeTermInput();
    }

    function onTermScroll() {
        // Keep the highlight overlay scrolled in sync with the textarea so
        // long lines align even when the user scrolls horizontally inside it.
        if (termHighlight && termInput) {
            termHighlight.scrollTop = termInput.scrollTop;
            termHighlight.scrollLeft = termInput.scrollLeft;
        }
    }

    // Splitter that lets the user drag to resize the .term-blocks pane.
    // Height persists across reloads in localStorage under TERM_HEIGHT_KEY.
    var TERM_HEIGHT_KEY = 'kro_term_height';
    var TERM_HEIGHT_MIN = 80;

    function termHeightMax() {
        // Cap at most of the viewport so the user can't drag the pane offscreen.
        return Math.max(TERM_HEIGHT_MIN + 40, Math.floor(window.innerHeight * 0.8));
    }

    function applyTermHeight(h) {
        if (!termBlocks) return;
        h = Math.max(TERM_HEIGHT_MIN, Math.min(termHeightMax(), Math.round(h)));
        termBlocks.style.height = h + 'px';
        return h;
    }

    function initTermResizer() {
        var resizer = document.getElementById('term-resizer');
        if (!resizer || !termBlocks) return;

        var saved = parseInt(localStorage.getItem(TERM_HEIGHT_KEY), 10);
        if (saved > 0) applyTermHeight(saved);

        var dragging = false;
        var startY = 0;
        var startH = 0;

        function onMove(e) {
            if (!dragging) return;
            var y = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
            var dy = y - startY;
            applyTermHeight(startH + dy);
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            resizer.classList.remove('dragging');
            document.body.classList.remove('term-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            var h = parseInt(termBlocks.style.height, 10);
            if (h > 0) localStorage.setItem(TERM_HEIGHT_KEY, String(h));
        }
        function onDown(e) {
            dragging = true;
            startY = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
            startH = termBlocks.getBoundingClientRect().height;
            resizer.classList.add('dragging');
            document.body.classList.add('term-resizing');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
            e.preventDefault();
        }
        resizer.addEventListener('mousedown', onDown);
        resizer.addEventListener('touchstart', onDown, { passive: false });

        // Double-click resets to the default height.
        resizer.addEventListener('dblclick', function() {
            termBlocks.style.height = '';
            localStorage.removeItem(TERM_HEIGHT_KEY);
        });
    }

    // ----- Right-click menu on selected output text -----
    // When the user selects text inside any .term-block-out and right-clicks,
    // we suppress the browser menu and show a tiny menu of actions targeting
    // the input editor. selectionchange also lights up a soft border around
    // the editor so the user can see that a selection is "ready to use".
    var termCtxMenu = null;
    var termSelectionText = '';

    function ensureTermCtxMenu() {
        if (termCtxMenu) return termCtxMenu;
        var m = document.createElement('div');
        m.className = 'term-ctx-menu';
        m.innerHTML =
            '<button type="button" data-act="insert">Insert into command</button>' +
            '<button type="button" data-act="copy">Copy</button>' +
            '<button type="button" data-act="copy-label">Copy as <code>-l label=…</code></button>';
        m.addEventListener('click', onTermCtxMenuClick);
        // Stop mousedown inside menu from collapsing the selection before the click fires.
        m.addEventListener('mousedown', function(e) { e.preventDefault(); });
        document.body.appendChild(m);
        termCtxMenu = m;
        return m;
    }

    function showTermCtxMenu(x, y) {
        var m = ensureTermCtxMenu();
        m.style.left = x + 'px';
        m.style.top = y + 'px';
        m.classList.add('open');
        // Reposition if it overflows the viewport.
        var r = m.getBoundingClientRect();
        var nx = x, ny = y;
        if (r.right > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - r.width - 4);
        if (r.bottom > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
        if (nx !== x) m.style.left = nx + 'px';
        if (ny !== y) m.style.top = ny + 'px';
    }

    function hideTermCtxMenu() {
        if (termCtxMenu) termCtxMenu.classList.remove('open');
    }

    function insertIntoTermInput(text) {
        if (!termInput || !text) return;
        termInput.focus();
        var v = termInput.value;
        var s = termInput.selectionStart;
        var e = termInput.selectionEnd;
        var prefix = (s > 0 && !/\s$/.test(v.slice(0, s))) ? ' ' : '';
        var ins = prefix + text;
        termInput.value = v.slice(0, s) + ins + v.slice(e);
        var caret = s + ins.length;
        termInput.selectionStart = termInput.selectionEnd = caret;
        refreshTermHighlight();
        autosizeTermInput();
    }

    function onTermCtxMenuClick(e) {
        var btn = e.target.closest && e.target.closest('button');
        if (!btn) return;
        var sel = termSelectionText;
        var act = btn.getAttribute('data-act');
        if (act === 'insert') {
            insertIntoTermInput(sel);
        } else if (act === 'copy') {
            if (sel) navigator.clipboard.writeText(sel).catch(function(){});
        } else if (act === 'copy-label') {
            if (sel) navigator.clipboard.writeText('-l label=' + sel).catch(function(){});
        }
        hideTermCtxMenu();
    }

    function selectionInsideBlockOut(sel) {
        if (!sel || sel.isCollapsed) return false;
        var n = sel.anchorNode;
        if (!n) return false;
        var el = n.nodeType === 1 ? n : n.parentElement;
        return !!(el && el.closest && el.closest('.term-block-out'));
    }

    function onTermBlockContextMenu(e) {
        var sel = window.getSelection();
        if (!selectionInsideBlockOut(sel)) return; // fall through to native menu
        var text = sel.toString();
        if (!text) return;
        termSelectionText = text;
        e.preventDefault();
        showTermCtxMenu(e.clientX, e.clientY);
    }

    function onTermSelectionChange() {
        var sel = window.getSelection();
        var has = selectionInsideBlockOut(sel) && !!sel.toString();
        var editor = document.querySelector('.term-editor');
        if (editor) editor.classList.toggle('has-output-selection', has);
    }

    function onDocClickForCtxMenu(e) {
        if (!termCtxMenu || !termCtxMenu.classList.contains('open')) return;
        if (!termCtxMenu.contains(e.target)) hideTermCtxMenu();
    }

    function initTerminal() {
        termInput = document.getElementById('term-input');
        termHighlight = document.getElementById('term-highlight');
        termBlocks = document.getElementById('term-blocks');
        if (!termInput || !termHighlight || !termBlocks) return;

        loadTermHistory();
        updateTermTarget();

        // Restore expanded/collapsed state from localStorage (default: collapsed).
        var section = document.getElementById('term-section');
        if (section && !isCollapsed('terminal')) {
            section.classList.remove('collapsed');
        }

        termInput.addEventListener('keydown', onTermKeydown);
        termInput.addEventListener('input', onTermInput);
        termInput.addEventListener('scroll', onTermScroll);
        // Sync overlay when the textarea is focused/clicked too — handles
        // browsers that don't fire 'scroll' on every caret move.
        termInput.addEventListener('click', onTermScroll);
        termInput.addEventListener('keyup', onTermScroll);

        initTermResizer();
        termBlocks.addEventListener('click', onTermBlockClick);
        termBlocks.addEventListener('contextmenu', onTermBlockContextMenu);

        document.addEventListener('selectionchange', onTermSelectionChange);
        document.addEventListener('mousedown', onDocClickForCtxMenu);
        // Capture phase so we intercept before the textarea's plain-Enter
        // handler would run (and before any other Enter listeners).
        document.addEventListener('keydown', onDocTermInsertKey, true);
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') hideTermCtxMenu();
        });
        window.addEventListener('scroll', hideTermCtxMenu, true);

        refreshTermHighlight();
        autosizeTermInput();
    }

    // ===== Kubeconfig merge =====
    window.promptMergeKubeconfig = function() {
        var input = document.getElementById('kubeconfig-merge-input');
        if (input) input.click();
    };

    function onKubeconfigSelected(ev) {
        var input = ev.target;
        var file = input.files && input.files[0];
        if (!file) return;
        var msg = 'Merge "' + file.name + '" into your kubeconfig?\n\n' +
            'The existing file will be backed up with a timestamped suffix.';
        if (!confirm(msg)) { input.value = ''; return; }

        var btn = document.getElementById('btn-kubeconfig-merge');
        var prevLabel = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Merging…'; }

        var form = new FormData();
        form.append('file', file);
        fetch('/api/kubeconfig/merge', { method: 'POST', body: form })
            .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }); })
            .then(function(res) {
                if (!res.ok || res.body.error) {
                    alert('Merge failed: ' + (res.body.error || 'unknown error'));
                    return;
                }
                var note = 'Merged into ' + res.body.primary;
                if (res.body.backup) note += '\nBackup: ' + res.body.backup;
                alert(note);
                // Reload contexts dropdown so the new entries appear immediately.
                loadContexts().then(function() {
                    return loadNamespaces();
                }).then(function() {
                    updateTermTarget();
                    reloadResources();
                });
            })
            .catch(function(err) { alert('Merge failed: ' + err.message); })
            .finally(function() {
                input.value = '';
                if (btn) { btn.disabled = false; btn.textContent = prevLabel; }
            });
    }

    // ===== Init =====
    document.addEventListener('DOMContentLoaded', function() {
        initDarkMode();
        resourcesStatus = document.getElementById('resources-sse-status');

        document.getElementById('ctx-select').addEventListener('change', onContextChange);
        document.getElementById('ns-select').addEventListener('change', onNamespaceChange);
        document.getElementById('btn-ns-add').addEventListener('click', showNsAddInput);
        document.getElementById('btn-ns-remove').addEventListener('click', onRemoveNamespace);
        var mergeInput = document.getElementById('kubeconfig-merge-input');
        if (mergeInput) mergeInput.addEventListener('change', onKubeconfigSelected);
        var addInput = document.getElementById('ns-add-input');
        addInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); onAddNamespace(); }
            else if (e.key === 'Escape') { e.preventDefault(); hideNsAddInput(); }
        });
        addInput.addEventListener('blur', function() {
            // Defer so button-clicks (Add) get processed first
            setTimeout(function() {
                if (document.activeElement !== addInput) hideNsAddInput();
            }, 100);
        });

        initTabs();
        initTerminal();

        // Initial bootstrap: load contexts → namespaces → resources → SSE.
        loadContexts().then(function() {
            return loadNamespaces();
        }).then(function() {
            updateTermTarget();
            reloadResources();
        });
    });
})();
