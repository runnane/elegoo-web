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
