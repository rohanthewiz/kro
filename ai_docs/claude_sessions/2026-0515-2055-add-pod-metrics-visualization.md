# Add Pod Metrics Visualization — Session

**Date:** 2026-05-15 20:55
**Session ID:** a5238981-3734-4c47-8002-c4c68ff90250

## Scope

User wanted a realtime memory (and CPU) view for a pod, without `kubectl exec` — they may not have exec rights on the company cluster. Implemented a `kubectl top pod` equivalent: poll `metrics.k8s.io/v1beta1` server-side, stream samples via SSE, render small SVG sparklines in a modal. `go build ./...`, `go vet ./...`, and `go test ./kube/...` all clean. Not exercised in a browser.

---

## Design decisions (asked the user upfront)

- **Placement:** new modal opened by a per-row **Metrics** button (alongside Describe / Logs), rather than inline-collapsible row or tab inside Describe.
- **Scope:** memory + CPU + per-container breakdown (one colored line per container plus a thicker total line).
- **Poll cadence:** 10 s on the server. Metrics-server typically scrapes every ~15 s, so the chart steps — the hint text in the modal calls this out so users don't think the chart is broken.
- **No new Go deps:** raw `client.RESTClient().AbsPath(...)` call against `metrics.k8s.io/v1beta1`, decoded with locally-defined structs. `resource.ParseQuantity` is reachable transitively via `k8s.io/apimachinery`.

---

## Backend

### `kube/metrics.go` (new)

- `PodMetricsSample { Timestamp, Window, CPUMilli, MemBytes, Containers[] }` — CPU pre-converted to mCPU, memory to bytes, so the UI does no quantity math.
- `PodMetrics(ctx, client, ns, name)` issues
  `GET /apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods/<name>` via `client.RESTClient()`. Parses each container's `usage.cpu` / `usage.memory` with `resource.ParseQuantity`.
- `ErrMetricsUnavailable` returned (wrapped) on 404 / 503 so the frontend can render a friendly "metrics-server not installed" message rather than retry-spamming.

### `web/sse.go`

- New `MetricsSSE` handler mirroring `LogsSSE`'s per-request `rweb.SSEHub` pattern (so `OnDisconnect` cancels the polling goroutine).
- `produceMetricsStream(ctx, client, ns, name, hub)` calls `PodMetrics` once immediately, then ticks every `metricsPollInterval` (10 s).
- Success → `"metrics"` event with JSON sample. Failure → `"error"` event with `{"error": "..."}` payload (single fire, doesn't crash the loop — the next tick retries).

### `web/server.go`

- Wired `svr.Get("/sse/metrics", h.MetricsSSE(svr))`.

---

## Frontend (`web/embeds/resources.js`)

- `actionButtons(kind, name)` adds a `Metrics` button when `kind === 'Pod'`.
- `viewMetrics(name)`:
  - resets `metricsState` ring buffer + per-container color map,
  - opens the existing modal with `{ stream: true }` (reuses the connection-status pill via `setStreamStatus`),
  - injects a `metrics-panel` shell into `#modal-content` (memory sparkline, CPU sparkline, legend, status line).
- `startMetricsStream(name)` opens `EventSource('/sse/metrics?...')`:
  - `metrics` event → `pushMetricsSample` (FIFO-trim at 60 samples ≈ 10 min) → `renderMetrics`.
  - `error` event (server-sent) → writes the error into `#metrics-status` (orange/red).
  - `onerror` (transport) → flips the pill to "Reconnecting…".
- `drawChart(svgId, samples, seriesNames, totalFn, containerFn)`:
  - Auto-scales Y to the window max with 10% headroom (min floor of 1 so a zero-traffic pod still renders).
  - X position is proportional to sample index (visually equal spacing — not real-time x-axis).
  - Per-container lines first (thinner, palette-colored), total line drawn over the top (thicker, `#e6e6e6`) with an end-of-series dot.
  - Returns the assembled SVG via `innerHTML` — pure SVG, no chart library.
- Per-container colors are assigned in arrival order from `METRIC_PALETTE` (8 colors, cycles). The map is stable for the session so a container's color doesn't jump when the legend re-renders.
- `closeMetricsStream()` added; `closeModal` calls it alongside `closeLogStream`.

### Why an SVG sparkline (vs. canvas / chart lib)

Two charts, max 60 points each — SVG paths are cheap, easy to inline, and theme via CSS without extra plumbing. No build step, no new dep.

---

## Frontend (`web/embeds/resources.css`)

- `.btn-metrics` — blue (`#0984e3`) to differentiate from describe (purple) and logs (green).
- `.metrics-panel` + children: light-mode defaults (dark text on `#f4f5f7` cards) with `body.dark` overrides bringing in light text and the rgba glass-tinted cards already used by the dark theme.
- `.metrics-svg` uses a fixed dark background (`#1a1a2e`) in both themes — the per-container line colors are tuned for a dark plot area, so this keeps contrast consistent.
- `.metrics-swatch.total` gets a thin contrasting border so the white-ish total swatch is visible on a white legend background in light mode.

---

## Files changed

```
M  web/embeds/resources.css        # +.btn-metrics, +.metrics-* block, +dark overrides
M  web/embeds/resources.js         # +Metrics button, +viewMetrics flow, +drawChart, +formatBytes, +closeMetricsStream hook
M  web/server.go                   # +/sse/metrics route
M  web/sse.go                      # +metricsPollInterval, +MetricsSSE, +produceMetricsStream
A  kube/metrics.go                 # +PodMetrics, +PodMetricsSample, +ErrMetricsUnavailable
```

---

## What was NOT done

- **No browser smoke-test.** Only verified via `go build`, `go vet`, `go test ./kube/...`. Worth a manual click-through on a real cluster: confirm the chart renders, the legend matches container names, dark-mode contrast looks right, and the "metrics-server unavailable" path shows the error string instead of a blank chart.
- **No metric-resolution awareness.** We always poll at 10 s. If a cluster has tuned metrics-server to `--metric-resolution=30s` or `60s`, the chart will still step at that cadence — the hint text generically says "~15s" which may mislead. Could read the `window` field returned by the metrics API to drive an honest hint.
- **No x-axis time labeling.** Just "0 — max" for the y-axis. If the user wants timestamps on hover, would need a tooltip or an axis overlay.
- **No request/limit reference lines.** The original sketch mentioned drawing the pod's CPU/mem limit as a dashed reference line on each chart. Skipped for v1 — the pod's request/limit isn't on the metrics sample; we'd need a separate fetch (or piggyback on the existing resource tree, which has requests but not limits).
- **`EventSource` retries forever** on `ErrMetricsUnavailable`. If metrics-server is missing entirely, the user will see the error pill flicker every 10 s. Could one-shot-bail on `error` events whose payload indicates "unavailable" — open question for next session.

---

## Useful context for follow-ups

- The metrics API path is `/apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods/<name>` — list form (omit `<name>`) returns all pods in the namespace at once and would be cheaper if we ever want a multi-pod view (e.g., a sortable "top" table).
- The `resource.ParseQuantity` import was free (apimachinery already transitively in deps). Adding `k8s.io/metrics` for the official typed client would pull in a non-trivial chunk of code-gen for marginal benefit — the raw-JSON path is fine.
- The per-request `SSEHub` + `OnDisconnect` cancellation pattern (originally from `LogsSSE`) is now used in three places. If we add a fourth, worth extracting a helper.
