# elegoo-web Lessons Learned

## MQTT Bridge Reconnection (Fixed 2026-04-12)

- `mqtt.js client.end(true)` permanently destroys the client — no auto-reconnect possible
- For forced reconnects: removeAllListeners(), end(true), null the ref, setTimeout, then connect() fresh
- Registration code 3 = too many clients (max 2 MQTT slots on CC2 broker)
- Need slow retry (30s) for code-3 rejection, not just give up
- Never use `store.attributes` truthiness as proxy for MQTT connected state — persisted data survives disconnects
- Use `bridge.isConnected` / `bridge.brokerConnected` for real connection state

## Canvas/AMS Filament Swap Behavior (Fixed 2026-04-12)

### Observed Event Sequence (fw 01.03.01.89)
```
machine_status stays 2 (Printing) throughout swap
sub_status: 2075 → 1045 → 1066 → 2075 (repeats per color change)
Exception 1211 (Canvas Filament Runout) fires at swap start
extruder.filament_detected flips 1→0→1 during swap
```

### Key Insights
- Sub-status 1066 is UNDOCUMENTED — not in official app source, only seen on fw 01.03.01.89
- machine_status does NOT change during swap — only sub_status transitions
- Filament sensor physically reads "empty" during swaps (expected behavior)
- Exception 1211 fires during NORMAL swaps (not just real runouts)
- Use `isFilamentChangeSubStatus()` from types.ts to identify swap sub-statuses
- Swap sub-statuses: 1045, 1061-1066, 1133-1145, 1150-1166, 2505

### False Positive Prevention
- Filament runout detection: check `isFilamentChangeSubStatus(subStatus)` before emitting
- AI stall detection: reset `consecutiveLowMotion` when sub_status ≠ 2075 (skipping analysis)
- Still track sensor state (`wasFilamentDetected`) during swaps for correct edge detection when swap ends

## Architecture Notes

- Service (src/server/) maintains singleton MQTT connection via MqttBridge
- Browser connects to service via WebSocket (/ws), NOT directly to printer MQTT
- StateStore emits print_event for all subsystems (Telegram, AI, WS, event log)
- AI monitor only runs analysis when sub_status === 2075 (actively printing)
- PrintEvent 'filament_runout' triggers both Telegram notification and event log entry

## Client Memory Leak: gcode-preview 60fps animate() (Fixed 2026-04-12)

### Root Cause
The `gcode-preview` library's `WebGLPreview.animate()` runs a continuous 60fps `requestAnimationFrame` loop calling `renderer.render(scene, camera)` every frame. With a ~15MB gcode model loaded, each WebGL render allocates GPU-backed objects that leak ~23 MB/s of JS heap — GC cannot reclaim them fast enough, causing OOM crashes within minutes.

### Profiling Method
Used Playwright MCP to measure `performance.memory.usedJSHeapSize` over timed intervals:
- **Before fix**: 282 MB → 1,235 MB in 42s (+23 MB/s), 871 rAF calls/5s
- **rAF blocked entirely**: 0.23 MB growth in 20s (confirmed leak is 100% animation loops)
- **After fix**: 241 MB → 104 MB in 42s (GC reclaiming), 30 rAF calls/5s

### Fix Applied (src/ui/gcode-preview.ts)
1. After `processGCode()`, cancel library's `animationFrameId` and override `animate()` to no-op
2. Render on orbit control `change` events (user dragging) — direct `renderer.render(scene, camera)`
3. Throttle layer/nozzle renders to 2 FPS (500ms interval) via `throttledRender()` / `lightRender()`
4. `preview.render()` (geometry rebuild) only for layer changes; `renderer.render()` for nozzle moves

### Key Insight
Total WebSocket JSON input was ~50KB — the leak was NOT from data accumulation. It was purely from the rendering pipeline: Three.js WebGL `render()` calls at 60fps with a complex scene.

## Client Memory Leak: Event Listener Accumulation (Fixed 2026-04-12)

### Problem
Several render functions added `addEventListener` on every call (triggered ~1/sec by MQTT updates):
- `renderStructuredLog()`: per-row click/pin listeners on 500+ rows → thousands of listeners
- `renderCanvas()`: per-element listeners for toggles, buttons, spool clicks
- `renderFiles()`: per-item mouseenter/mouseleave/click for popovers

### Fix Applied
Replaced per-element listeners with event delegation (single listener on container, dispatch via `e.target.closest()`):
- `src/ui/structured-log.ts`: container-level delegation, bound once in `bindStructuredLogControls()`
- `src/ui/canvas.ts`: `canvasDelegationBound` flag, container click/change delegation
- `src/ui/files.ts`: `fileDelegationBound` flag, capture-phase mouseenter/mouseleave for popovers

### Additional Fixes
- `src/chart-store.ts`: Added `destroy()` to clear sampling interval
- `src/persistence.ts`: Track/remove `beforeunload` listener in `stopPersistence()`

## Client Memory Leak: requestAnimationFrame + Vite HMR (Fixed 2026-04-12)

### Problem
Chart draw loop used `requestAnimationFrame` with a module-level `let animating = false` guard. Vite HMR hot-reloads reset the guard to `false`, causing each hot-reload to start a NEW rAF loop without stopping the old one. After a few HMR cycles: observed 100+ rAF/s (multiple duplicate loops).

### Fix Applied (src/ui/charts.ts)
Replaced rAF loop with `setInterval(drawAllCharts, 100)` (10 FPS). The `drawTimer` handle is properly cleared before starting a new timer, preventing HMR duplication. Also added:
- `offsetParent !== null` check to skip hidden/off-screen charts
- Canvas 2D context caching (`ctxCache` Map) to avoid repeated `getContext('2d')` calls
