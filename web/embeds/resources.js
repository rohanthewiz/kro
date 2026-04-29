// KRo — k8s resources page (vanilla JS, no frameworks)

(function() {
    'use strict';

    // ===== Dark Mode =====
    function initDarkMode() {
        if (localStorage.getItem('darkMode') === 'true') {
            document.body.classList.add('dark');
            var btn = document.getElementById('btn-dark-toggle');
            if (btn) btn.textContent = '☀️';
        }
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
        input.style.display = '';
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
            refreshResources();
            initResourcesStream();
        });
    }

    function onContextChange() {
        var ctx = document.getElementById('ctx-select').value;
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

    // ===== Resource Display =====
    function applyTree(tree) {
        var container = document.getElementById('resources-content');
        if (!container) return;
        if (tree.error) {
            container.innerHTML = '<div class="empty-state">' + escapeHtml(tree.error) + '</div>';
            updateSummary(0, 0, 0, 0);
            return;
        }
        rebuildTables(container, tree);
        var totalPods = countPods(tree);
        updateSummary(
            (tree.jobs || []).length,
            (tree.deployments || []).length,
            totalPods,
            (tree.services || []).length
        );
    }

    window.refreshResources = function() {
        var container = document.getElementById('resources-content');
        if (!container) return;
        container.innerHTML = '<div class="loading">Loading resources</div>';

        fetch('/api/resources')
        .then(function(r) { return r.json(); })
        .then(applyTree)
        .catch(function(err) {
            container.innerHTML = '<div class="empty-state">Failed to fetch resources: ' + escapeHtml(err.message) + '</div>';
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

    function rebuildTables(container, tree) {
        var html = '';

        var warnings = tree.warnings || [];
        if (warnings.length > 0) {
            html += '<div class="warnings-bar">';
            warnings.forEach(function(w) {
                html += '<div class="warning-item">⚠ ' + escapeHtml(w) + '</div>';
            });
            html += '</div>';
        }

        // Jobs
        html += sectionHierarchical('jobs', 'Jobs', tree.jobs || [], 'job');

        // Deployments + ReplicaSets + Pods
        html += sectionDeployments(tree.deployments || []);

        // StatefulSets / DaemonSets
        html += sectionHierarchical('statefulsets', 'StatefulSets', tree.statefulsets || [], 'sts');
        html += sectionHierarchical('daemonsets', 'DaemonSets', tree.daemonsets || [], 'ds');

        // Other pods
        var orphans = tree.orphan_pods || [];
        if (orphans.length > 0) {
            var orphanBody = '<div class="table-wrapper"><table>' + tableHead() + '<tbody>';
            orphans.forEach(function(pod) { orphanBody += parentRow('', pod, false); });
            orphanBody += '</tbody></table></div>';
            html += sectionShell('pods-orphan', 'Pods (orphan)', orphans.length, orphanBody);
        }

        // Flat all pods
        var allPods = [];
        (tree.jobs || []).forEach(function(job) { (job.children || []).forEach(function(p) { allPods.push(p); }); });
        (tree.deployments || []).forEach(function(d) { (d.children || []).forEach(function(rs) { (rs.children || []).forEach(function(p) { allPods.push(p); }); }); });
        (tree.statefulsets || []).forEach(function(s) { (s.children || []).forEach(function(p) { allPods.push(p); }); });
        (tree.daemonsets || []).forEach(function(s) { (s.children || []).forEach(function(p) { allPods.push(p); }); });
        orphans.forEach(function(p) { allPods.push(p); });
        allPods.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });

        var allPodsBody;
        if (allPods.length > 0) {
            allPodsBody = '<div class="table-wrapper"><table>' + tableHead() + '<tbody>';
            allPods.forEach(function(pod) { allPodsBody += parentRow('', pod, false); });
            allPodsBody += '</tbody></table></div>';
        } else {
            allPodsBody = '<div class="table-wrapper"><div class="empty-state">No pods found</div></div>';
        }
        html += sectionShell('all-pods', 'All Pods', allPods.length, allPodsBody);

        // Read-only sections (no children)
        html += flatSection('services', 'Services', tree.services || []);
        html += flatSection('ingresses', 'Ingresses', tree.ingresses || []);
        html += flatSection('configmaps', 'ConfigMaps', tree.configmaps || []);
        html += flatSection('secrets', 'Secrets', tree.secrets || []);

        container.innerHTML = html;
    }

    // ===== Section collapse/expand =====
    // Per-section collapsed state persists in localStorage so refreshes / SSE
    // re-renders don't lose user intent. Key: kro_collapsed_<slug>.
    var COLLAPSE_KEY_PREFIX = 'kro_collapsed_';

    function isCollapsed(slug) {
        return localStorage.getItem(COLLAPSE_KEY_PREFIX + slug) === '1';
    }

    window.toggleSection = function(slug) {
        var el = document.querySelector('[data-section="' + slug + '"]');
        if (!el) return;
        var nowCollapsed = !el.classList.contains('collapsed');
        el.classList.toggle('collapsed', nowCollapsed);
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
            '<th>Age</th><th>CPU</th><th>Memory</th><th>Node</th><th>Restarts</th><th>Actions</th>' +
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

    window.viewLogs = function(name) {
        openModal('Logs: ' + name, 'Loading...');
        fetch('/api/logs?name=' + encodeURIComponent(name))
        .then(function(r) { return r.text(); })
        .then(function(text) { setModalContent(text); })
        .catch(function(err) { setModalContent('Error: ' + err.message); });
    };

    function openModal(title, content) {
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
                '<button class="modal-copy" id="modal-copy" onclick="copyModalContent(this)" title="Copy to clipboard">⧉</button>' +
                '<button class="modal-close" onclick="closeModal()">&times;</button>' +
                '</div>' +
                '</div>' +
                '<div class="modal-body">' +
                '<pre class="modal-content" id="modal-content"></pre>' +
                '</div>' +
                '</div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) closeModal();
            });
        }
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-content').textContent = content;
        overlay.classList.add('active');
    }

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

    // ===== Init =====
    document.addEventListener('DOMContentLoaded', function() {
        initDarkMode();
        resourcesStatus = document.getElementById('resources-sse-status');

        document.getElementById('ctx-select').addEventListener('change', onContextChange);
        document.getElementById('ns-select').addEventListener('change', onNamespaceChange);
        document.getElementById('btn-ns-add').addEventListener('click', showNsAddInput);
        document.getElementById('btn-ns-remove').addEventListener('click', onRemoveNamespace);
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

        // Initial bootstrap: load contexts → namespaces → resources → SSE.
        loadContexts().then(function() {
            return loadNamespaces();
        }).then(function() {
            refreshResources();
            initResourcesStream();
        });
    });
})();
