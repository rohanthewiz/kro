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
            appendLogLine(content, '— disconnected, retrying —');
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

    function appendLogLine(content, line) {
        var body = content.parentNode; // .modal-body is the scroll container
        var atBottom = !body || (body.scrollHeight - body.scrollTop - body.clientHeight < 30);
        var span = document.createElement('span');
        span.innerHTML = highlightLogLine(line) + '\n';
        content.appendChild(span);
        // If a search is active, highlight matches in this newly-arrived line
        // and refresh the count display without re-scanning the whole buffer.
        if (searchState.open && searchState.query) {
            var added = highlightMatchesIn(span);
            if (added > 0) {
                searchState.matchCount += added;
                refreshSearchCountLabel();
            }
        }
        if (atBottom && body) body.scrollTop = body.scrollHeight;
    }

    // Colorize a single log line. Handles two styles seen in pod logs:
    //   structured Go logs:  time="..." level=info msg="..."
    //   legacy/python logs:  INFO -- 05/01/2026 ... 'string' 'string'
    // Levels get conventional colors, dates/times are green, positive numbers
    // cyan, negatives orange, true/false get the same cyan/orange treatment,
    // and on error-level lines msg="..." is highlighted in maroon.
    function highlightLogLine(line) {
        var escaped = escapeHtml(line);
        var isError = /\blevel=(error|err|fatal)\b/i.test(line) ||
                      /\b(ERROR|FATAL)\b/.test(line);

        // Order matters: date/time alts come before bare numbers so a date's
        // digit groups aren't picked off as standalone numbers.
        var re = new RegExp([
            '\\bmsg=(&quot;.*?&quot;)',                                                // 1: msg val (only used when isError)
            '(\\w+)=(?=&quot;)',                                                       // 2: key before quoted value
            '\\blevel=([A-Za-z]+)',                                                    // 3: unquoted level value
            '\\b(INFO|WARN(?:ING)?|ERROR|DEBUG|FATAL|TRACE)\\b',                       // 4: bare level token
            '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?',
            '\\d{2}/\\d{2}/\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2}(?:\\s*[AP]M)?',
            '\\d{4}-\\d{2}-\\d{2}',
            '\\d{2}/\\d{2}/\\d{4}',
            '\\d{1,2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:\\s*[AP]M)?',
            '\\b(true|false)\\b',                                                      // 5: bool
            '-?\\b\\d+(?:\\.\\d+)?\\b',                                                // (no group) numbers
        ].join('|'), 'g');

        return escaped.replace(re, function(m, msgVal, key, lvlVal, bareLvl, boolVal) {
            if (msgVal !== undefined) {
                if (isError) return '<span class="log-msg-err">msg=' + msgVal + '</span>';
                return '<span class="log-key">msg</span>=' + highlightInner(msgVal);
            }
            if (key !== undefined) return '<span class="log-key">' + key + '</span>=';
            if (lvlVal) return '<span class="log-key">level</span>=<span class="log-level log-level-' + lvlVal.toLowerCase() + '">' + lvlVal + '</span>';
            if (bareLvl) return '<span class="log-level log-level-' + bareLvl.toLowerCase() + '">' + bareLvl + '</span>';
            if (boolVal !== undefined) return '<span class="log-bool log-bool-' + boolVal + '">' + boolVal + '</span>';
            // Whatever remains is a date/time or number — disambiguate by content.
            if (/^-/.test(m)) return '<span class="log-num-neg">' + m + '</span>';
            if (/^\d+(?:\.\d+)?$/.test(m)) return '<span class="log-num">' + m + '</span>';
            return '<span class="log-time">' + m + '</span>';
        });
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

    function closeLogStream() {
        if (logSource) {
            logSource.close();
            logSource = null;
        }
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

    function buildSearchRegex() {
        if (!searchState.query) return null;
        var flags = searchState.caseSensitive ? 'g' : 'gi';
        try {
            if (searchState.regex) {
                return new RegExp(searchState.query, flags);
            }
            var pat = searchState.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (searchState.wholeWord) pat = '\\b' + pat + '\\b';
            return new RegExp(pat, flags);
        } catch (e) {
            return false; // signal invalid regex
        }
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
        var nodes = [];
        var n;
        while ((n = walker.nextNode())) nodes.push(n);

        var count = 0;
        for (var i = 0; i < nodes.length; i++) {
            var textNode = nodes[i];
            var text = textNode.nodeValue;
            rx.lastIndex = 0;
            var matches = [];
            var m;
            while ((m = rx.exec(text)) !== null) {
                if (m[0].length === 0) { rx.lastIndex++; continue; }
                matches.push([m.index, m.index + m[0].length]);
            }
            if (!matches.length) continue;
            var parent = textNode.parentNode;
            var frag = document.createDocumentFragment();
            var last = 0;
            for (var j = 0; j < matches.length; j++) {
                var s = matches[j][0], e = matches[j][1];
                if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s)));
                var mk = document.createElement('mark');
                mk.className = 'log-match';
                mk.textContent = text.slice(s, e);
                frag.appendChild(mk);
                last = e;
                count++;
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            parent.replaceChild(frag, textNode);
        }
        return count;
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
        searchState.matchCount = highlightMatchesIn(content);
        refreshSearchCountLabel();
        if (searchState.matchCount > 0) navigateMatch(0, false);
    }

    function navigateMatch(delta, wrap) {
        var marks = document.querySelectorAll('#modal-content mark.log-match');
        if (!marks.length) return;
        var cur = -1;
        for (var i = 0; i < marks.length; i++) {
            if (marks[i].classList.contains('current')) { cur = i; break; }
        }
        var next;
        if (cur === -1) {
            next = delta >= 0 ? 0 : marks.length - 1;
        } else {
            next = cur + delta;
            if (wrap !== false) {
                next = ((next % marks.length) + marks.length) % marks.length;
            } else {
                next = Math.max(0, Math.min(marks.length - 1, next));
            }
            marks[cur].classList.remove('current');
        }
        marks[next].classList.add('current');
        marks[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
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
        if (!el) return;
        el.textContent = (currentCtx || '?') + ' / ' + (currentNs || '?');
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
            '<span class="term-exit running">running…</span>' +
            TERM_BLK_TOOLBAR_HTML;
        block.appendChild(cmdRow);

        var out = document.createElement('pre');
        out.className = 'term-block-out';
        block.appendChild(out);

        termBlocks.appendChild(block);
        termBlocks.scrollTop = termBlocks.scrollHeight;

        applyTermBlockFont(out);

        return {
            cmd: cmd,
            el: block,
            cmdRow: cmdRow,
            outEl: out,
            exitEl: cmdRow.querySelector('.term-exit'),
            searchCtl: null
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
            if (!st.query) return null;
            var flags = st.caseSensitive ? 'g' : 'gi';
            try {
                if (st.regex) return new RegExp(st.query, flags);
                var pat = st.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (st.wholeWord) pat = '\\b' + pat + '\\b';
                return new RegExp(pat, flags);
            } catch (_) { return false; }
        }
        function refreshCount() {
            if (st.invalidRegex) { countEl.textContent = 'invalid regex'; countEl.classList.add('error'); return; }
            countEl.classList.remove('error');
            if (!st.query) { countEl.textContent = ''; return; }
            if (st.matchCount === 0) { countEl.textContent = 'no matches'; return; }
            countEl.textContent = (st.currentIndex + 1) + ' / ' + st.matchCount;
        }
        function navigate(delta, wrap) {
            var marks = outEl.querySelectorAll('mark.log-match');
            if (!marks.length) return;
            var cur = -1;
            for (var i = 0; i < marks.length; i++) {
                if (marks[i].classList.contains('current')) { cur = i; break; }
            }
            var nx;
            if (cur === -1) nx = delta >= 0 ? 0 : marks.length - 1;
            else {
                nx = cur + delta;
                if (wrap !== false) nx = ((nx % marks.length) + marks.length) % marks.length;
                else nx = Math.max(0, Math.min(marks.length - 1, nx));
                marks[cur].classList.remove('current');
            }
            marks[nx].classList.add('current');
            marks[nx].scrollIntoView({ block: 'center', behavior: 'smooth' });
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

    function termAppendOutput(block, kind, line) {
        if (!block) return;
        var out = block.outEl;
        var atBottom = (out.scrollHeight - out.scrollTop - out.clientHeight) < 30;
        var span = document.createElement('span');
        if (kind === 'stderr') span.className = 'term-stderr';
        else if (kind === 'info') span.className = 'term-info';
        span.innerHTML = highlightLogLine(line || '') + '\n';
        out.appendChild(span);
        var ctl = blockSearchByEl.get(block.el);
        if (ctl) ctl.onAppend(span);
        if (atBottom) out.scrollTop = out.scrollHeight;
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
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') hideTermCtxMenu();
        });
        window.addEventListener('scroll', hideTermCtxMenu, true);

        refreshTermHighlight();
        autosizeTermInput();
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
