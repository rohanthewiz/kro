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

    // ===== Selection state (mirrors server cookies) =====
    var currentCtx = '';
    var currentNs = '';

    function loadContexts() {
        return fetch('/api/contexts').then(function(r) { return r.json(); }).then(function(data) {
            var sel = document.getElementById('ctx-select');
            sel.innerHTML = '';
            (data.contexts || []).forEach(function(c) {
                var opt = document.createElement('option');
                opt.value = c.name;
                opt.textContent = c.name;
                sel.appendChild(opt);
            });
            currentCtx = data.current || ((data.contexts && data.contexts[0] && data.contexts[0].name) || '');
            sel.value = currentCtx;
            return currentCtx;
        });
    }

    function loadNamespaces() {
        return fetch('/api/namespaces').then(function(r) { return r.json(); }).then(function(data) {
            var sel = document.getElementById('ns-select');
            var removeBtn = document.getElementById('btn-ns-remove');
            sel.innerHTML = '';
            var list = data.namespaces || [];
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
                removeBtn.disabled = true;
            } else {
                sel.value = data.current || list[0] || '';
                removeBtn.disabled = false;
            }
            currentNs = sel.value || '';
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
                loadNamespaces().then(function() {
                    refreshResources();
                    initResourcesStream();
                });
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
            refreshResources();
            initResourcesStream();
        });
    }

    function onContextChange() {
        var ctx = document.getElementById('ctx-select').value;
        currentCtx = ctx;
        // Clear ns cookie by sending empty namespace AFTER setting context, then reload ns list.
        fetch('/api/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: ctx, namespace: '' })
        }).then(function(r) { return r.json(); }).then(function() {
            loadNamespaces().then(function() {
                // Persist whatever default the new context surfaced.
                var ns = currentNs || document.getElementById('ns-select').value;
                if (ns) {
                    fetch('/api/select', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ namespace: ns })
                    });
                }
                updateTermTarget();
                refreshResources();
                initResourcesStream();
            });
        });
    }

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
        { id: 'workloads',   sections: ['jobs', 'all-pods', 'pods-orphan'] },
        { id: 'deployments', sections: ['deployments', 'all-pods'] },
        { id: 'networking',  sections: ['services', 'ingresses'] },
        { id: 'storage',     sections: ['pvs', 'pvcs', 'storageclasses'] },
        { id: 'sets',        sections: ['statefulsets', 'daemonsets'] },
        { id: 'config',      sections: ['configmaps', 'secrets'] },
        { id: 'watch',       sections: [] }
    ];
    var ACTIVE_TAB_KEY = 'kro_active_tab';
    var TAB_SIDEBAR_COLLAPSED_KEY = 'kro_tab_sidebar_collapsed';

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
        // The Pod Watch page (watch.js) connects its status stream only while
        // its tab is visible; tee frames persist across switches.
        if (id === 'watch') {
            if (window.watchPageActivate) window.watchPageActivate();
        } else if (window.watchPageDeactivate) {
            window.watchPageDeactivate();
        }
    };

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
    function applyTree(tree) {
        var anchor = document.getElementById('tab-sections-workloads');
        if (!anchor) return;
        if (tree.error) {
            renderErrorAcrossTabs(tree.error);
            updateSummary(0, 0, 0, 0);
            return;
        }
        rebuildTables(tree);
        var totalPods = countPods(tree);
        updateSummary(
            (tree.jobs || []).length,
            (tree.deployments || []).length,
            totalPods,
            (tree.services || []).length
        );
    }

    function renderErrorAcrossTabs(msg) {
        var safe = escapeHtml(msg);
        for (var i = 0; i < TAB_CONFIG.length; i++) {
            var el = document.getElementById('tab-sections-' + TAB_CONFIG[i].id);
            if (el) el.innerHTML = '<div class="empty-state">' + safe + '</div>';
        }
    }

    window.refreshResources = function() {
        for (var i = 0; i < TAB_CONFIG.length; i++) {
            var el = document.getElementById('tab-sections-' + TAB_CONFIG[i].id);
            if (el) el.innerHTML = '<div class="loading">Loading resources</div>';
        }

        fetch('/api/resources')
        .then(function(r) { return r.json(); })
        .then(applyTree)
        .catch(function(err) {
            renderErrorAcrossTabs('Failed to fetch resources: ' + err.message);
        });
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

    // Compute the flat "All Pods" list once per refresh — every workload kind
    // contributes its child pods plus any orphans, sorted by name.
    function buildAllPods(tree) {
        var all = [];
        (tree.jobs || []).forEach(function(job) { (job.children || []).forEach(function(p) { all.push(p); }); });
        (tree.deployments || []).forEach(function(d) { (d.children || []).forEach(function(rs) { (rs.children || []).forEach(function(p) { all.push(p); }); }); });
        (tree.statefulsets || []).forEach(function(s) { (s.children || []).forEach(function(p) { all.push(p); }); });
        (tree.daemonsets || []).forEach(function(s) { (s.children || []).forEach(function(p) { all.push(p); }); });
        (tree.orphan_pods || []).forEach(function(p) { all.push(p); });
        all.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
        return all;
    }

    // SECTION_BUILDERS maps a section slug to the function that renders its
    // HTML. Builders are invoked per-tab; when a section appears in two tabs
    // (e.g. "all-pods" in workloads and deployments) we render twice but the
    // collapse state is keyed only by slug, so the two stay in sync.
    var SECTION_BUILDERS = {
        'jobs': function(ctx) {
            return sectionHierarchical('jobs', 'Jobs', ctx.tree.jobs || [], 'job');
        },
        'all-pods': function(ctx) {
            var pods = ctx.allPods;
            var body;
            if (pods.length > 0) {
                body = '<div class="table-wrapper"><table>' + tableHead() + '<tbody>';
                pods.forEach(function(pod) { body += parentRow('', pod, false); });
                body += '</tbody></table></div>';
            } else {
                body = '<div class="table-wrapper"><div class="empty-state">No pods found</div></div>';
            }
            return sectionShell('all-pods', 'All Pods', pods.length, body);
        },
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
        'ingresses': function(ctx) {
            return flatSection('ingresses', 'Ingresses', ctx.tree.ingresses || []);
        },
        'pvs': function(ctx) {
            return flatSection('pvs', 'PersistentVolumes', ctx.tree.persistentvolumes || []);
        },
        'pvcs': function(ctx) {
            return flatSection('pvcs', 'PersistentVolumeClaims', ctx.tree.persistentvolumeclaims || []);
        },
        'storageclasses': function(ctx) {
            return flatSection('storageclasses', 'StorageClasses', ctx.tree.storageclasses || []);
        },
        'configmaps': function(ctx) {
            return flatSection('configmaps', 'ConfigMaps', ctx.tree.configmaps || []);
        },
        'secrets': function(ctx) {
            return flatSection('secrets', 'Secrets', ctx.tree.secrets || []);
        }
    };

    function rebuildTables(tree) {
        var ctx = { tree: tree, allPods: buildAllPods(tree) };

        var warningsHTML = '';
        var warnings = tree.warnings || [];
        if (warnings.length > 0) {
            warningsHTML = '<div class="warnings-bar">';
            warnings.forEach(function(w) {
                warningsHTML += '<div class="warning-item">⚠ ' + escapeHtml(w) + '</div>';
            });
            warningsHTML += '</div>';
        }

        // Warnings appear at the top of the first tab only — they're a
        // cluster-level signal and would just be noise on every panel.
        for (var i = 0; i < TAB_CONFIG.length; i++) {
            var tab = TAB_CONFIG[i];
            var anchor = document.getElementById('tab-sections-' + tab.id);
            if (!anchor) continue;
            var html = (i === 0 ? warningsHTML : '');
            for (var j = 0; j < tab.sections.length; j++) {
                var builder = SECTION_BUILDERS[tab.sections[j]];
                if (builder) html += builder(ctx);
            }
            anchor.innerHTML = html;
        }
    }

    // ===== Section collapse/expand =====
    // Per-section collapsed state persists in localStorage so refreshes / SSE
    // re-renders don't lose user intent. Key: kro_collapsed_<slug>.
    var COLLAPSE_KEY_PREFIX = 'kro_collapsed_';

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
            items.forEach(function(item, i) {
                var parentId = idPrefix + '-' + i;
                var hasChildren = item.children && item.children.length > 0;
                body += parentRow(parentId, item, hasChildren);
                if (hasChildren) {
                    item.children.forEach(function(pod) {
                        body += childRow(parentId, pod, 'child-row');
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
            deploys.forEach(function(deploy, i) {
                var parentId = 'deploy-' + i;
                var hasChildren = deploy.children && deploy.children.length > 0;
                body += parentRow(parentId, deploy, hasChildren);
                if (hasChildren) {
                    deploy.children.forEach(function(rs, j) {
                        var rsId = parentId + '-rs-' + j;
                        var rsHasChildren = rs.children && rs.children.length > 0;
                        body += childRowExpandable(parentId, rsId, rs, rsHasChildren);
                        if (rsHasChildren) {
                            rs.children.forEach(function(pod) {
                                body += childRow(rsId, pod, 'grandchild-row');
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

    function tableHead() {
        return '<thead><tr>' +
            '<th></th><th>Name</th><th>Kind</th><th>Status</th><th>Ready / Completions</th>' +
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

    function parentRow(parentId, res, hasChildren) {
        var arrow = hasChildren
            ? '<span class="expand-arrow" id="arrow-' + parentId + '">▶</span>'
            : '<span class="expand-arrow"></span>';
        var onclick = hasChildren ? ' onclick="toggleChildren(\'' + parentId + '\')"' : '';
        var cls = hasChildren ? 'resource-row' : '';
        return '<tr class="' + cls + '"' + onclick + '>' +
            '<td>' + arrow + '</td>' +
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

    function childRow(parentId, res, rowClass) {
        return '<tr class="' + rowClass + '" data-parent="' + parentId + '">' +
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

    function childRowExpandable(parentId, rsId, res, hasChildren) {
        var arrow = hasChildren
            ? '<span class="expand-arrow" id="arrow-' + rsId + '">▶</span>'
            : '';
        var onclick = hasChildren ? ' onclick="event.stopPropagation(); toggleChildren(\'' + rsId + '\')"' : '';
        var cls = 'child-row' + (hasChildren ? ' resource-row' : '');
        return '<tr class="' + cls + '" data-parent="' + parentId + '"' + onclick + '>' +
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
    window.toggleChildren = function(parentId) {
        var rows = document.querySelectorAll('[data-parent="' + parentId + '"]');
        var arrow = document.getElementById('arrow-' + parentId);
        var isOpen = arrow && arrow.classList.contains('open');
        rows.forEach(function(row) {
            if (isOpen) {
                row.classList.remove('visible');
                var subId = row.getAttribute('data-parent');
                if (subId !== parentId) return;
                var rowId = getRowId(row);
                if (rowId) collapseDescendants(rowId);
            } else {
                row.classList.add('visible');
            }
        });
        if (arrow) arrow.classList.toggle('open');
    };

    function getRowId(row) {
        var arrowEl = row.querySelector('.expand-arrow');
        if (arrowEl && arrowEl.id) return arrowEl.id.replace('arrow-', '');
        return null;
    }

    function collapseDescendants(parentId) {
        var rows = document.querySelectorAll('[data-parent="' + parentId + '"]');
        rows.forEach(function(row) { row.classList.remove('visible'); });
        var arrow = document.getElementById('arrow-' + parentId);
        if (arrow) arrow.classList.remove('open');
    }

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

    window.viewLogs = function(name) {
        closeLogStream();
        openModal('Logs: ' + name, '', { wide: true, stream: true });
        startLogStream(name);
    };

    function startLogStream(name) {
        closeLogStream();
        logSourcePod = name;
        modalLastLvl = null;
        var content = document.getElementById('modal-content');
        if (!content) return;
        setStreamStatus('reconnecting', 'Connecting…');

        logSource = new EventSource('/sse/logs?name=' + encodeURIComponent(name));
        logSource.onopen = function() {
            setStreamStatus('connected', 'Connected');
        };
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
        if (atBottom && body && !selectionActiveIn(content)) body.scrollTop = body.scrollHeight;
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
            '-?\\b\\d+(?:\\.\\d+)?\\b',                                                // (no group) numbers
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
            '-?\\b\\d+(?:\\.\\d+)?\\b',
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

    // ===== Helpers =====
    function escapeHtml(str) {
        if (!str && str !== 0) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }

    // ===== SSE =====
    var HEARTBEAT_TIMEOUT_MS = 60000;
    var resourcesSource = null;
    var resourcesHeartbeatTimer = null;
    var resourcesStatus = null;

    function setStatus(state) {
        if (!resourcesStatus) return;
        resourcesStatus.className = 'log-status ' + state;
    }

    function resetHeartbeat() {
        clearTimeout(resourcesHeartbeatTimer);
        resourcesHeartbeatTimer = setTimeout(function() {
            if (resourcesSource) {
                resourcesSource.close();
                resourcesSource = null;
            }
            setStatus('reconnecting');
            setTimeout(initResourcesStream, 1000);
        }, HEARTBEAT_TIMEOUT_MS);
    }

    function initResourcesStream() {
        if (resourcesSource) {
            resourcesSource.close();
            resourcesSource = null;
        }
        resourcesSource = new EventSource('/sse/resources');

        resourcesSource.onmessage = function(e) {
            resetHeartbeat();
            try {
                // SetupSSE without Hub.Broadcast wrapping: data is the SSEvent.Data field directly.
                var tree = JSON.parse(e.data);
                applyTree(tree);
            } catch (err) {
                // heartbeat keepalive or unknown — ignore
            }
        };

        // The server sets event: resources_snapshot via SetupSSE's eventTypeOption.
        resourcesSource.addEventListener('resources_snapshot', function(e) {
            resetHeartbeat();
            try {
                var tree = JSON.parse(e.data);
                applyTree(tree);
            } catch (err) { /* ignore */ }
        });

        resourcesSource.onopen = function() {
            setStatus('connected');
            resetHeartbeat();
        };
        resourcesSource.onerror = function() {
            setStatus('reconnecting');
        };
    }

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
            // EventSource will retry; only treat as failure if we never saw 'done'.
            // If the process is still running on the server, retries are fine —
            // but if the server already closed (done sent), retries are noise.
            if (!termRunning) { termClose(); return; }
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
                    refreshResources();
                    initResourcesStream();
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
            refreshResources();
            initResourcesStream();
        });
    });
})();
