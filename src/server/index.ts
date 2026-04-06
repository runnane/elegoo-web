/**
 * Elegoo CC2 Service — single MQTT connection shared by all consumers.
 *
 * Architecture:
 *   Printer MQTT ←→ MqttBridge (singleton) ←→ StateStore
 *                                               ↓
 *                            ┌──────────────────┼──────────────────┐
 *                            WebSocket        REST/Camera      Telegram
 *                           (browsers)        (snapshots)       (bot)
 */

import { createServer } from 'http';
import { loadConfig, type ServiceConfig } from './config.js';
import { MqttBridge } from './mqtt-bridge.js';
import { StateStore } from './state-store.js';
import { WebSocketTransport } from './ws-transport.js';
import { createRestRouter } from './rest-api.js';
import { handleMcpRequest } from './mcp-server.js';
import { TelegramIntegration } from './telegram.js';
import { StatePersistence } from './state-persistence.js';
import { AIMonitor } from './ai-monitor.js';
import { initLogger, getLogger } from './logger.js';

const config = loadConfig();
const logger = initLogger(config.dataDir);
const log = getLogger('Service');

log.info('🖨  Elegoo CC2 Service');
log.info(`Printer: ${config.printerIp}`);
log.info(`Service: http://0.0.0.0:${config.servicePort}`);
log.info(`Camera:  ${config.cameraEnabled ? config.cameraUrl : 'disabled'}`);
log.info(`Data:    ${config.dataDir}`);
if (config.telegramEnabled) {
  log.info(`Telegram: enabled (progress every ${config.progressInterval}%)`);
}
if (config.aiEnabled) {
  log.info(`AI:       enabled (VLM: ${config.aiVlmEnabled ? config.aiVlmModel : 'off'}, Local: ${config.aiLocalEnabled ? 'on' : 'off'})`);
}

// --- MQTT Bridge (singleton connection to printer) ---
const bridge = new MqttBridge(config.printerIp, config.printerPassword);

// --- State Store (shared state for all consumers) ---
const store = new StateStore(bridge, config.progressInterval);

// --- State Persistence ---
const persistence = new StatePersistence(store, config.dataDir);

// --- Telegram Bot (optional) ---
let telegram: TelegramIntegration | null = null;
if (config.telegramEnabled) {
  telegram = new TelegramIntegration(store, bridge, config);
}

// --- AI Monitor (optional, created early so REST API can reference it) ---
let aiMonitor: AIMonitor | null = null;
if (config.aiEnabled) {
  aiMonitor = new AIMonitor(store, config);
}

// --- HTTP Server ---
const restHandler = createRestRouter(store, config, aiMonitor);
const httpServer = createServer((req, res) => {
  const url = req.url || '';
  if (url === '/mcp' || url.startsWith('/mcp?')) {
    // CORS for MCP endpoint
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    handleMcpRequest(req, res, store, bridge).catch((err) => {
      log.error('MCP request error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
    return;
  }
  restHandler(req, res);
});

// --- WebSocket Transport (for browser clients) ---
const wsTransport = new WebSocketTransport(httpServer, store, bridge);

// Provide service references for status panel
wsTransport.setServices({ telegram, aiMonitor });

// Forward AI events to WS clients
if (aiMonitor) {
  aiMonitor.on('analysis', (analysis: Record<string, unknown>) => {
    wsTransport.broadcast({ type: 'ai_analysis', ...analysis });
  });

  aiMonitor.on('alert', (alert: Record<string, unknown>) => {
    wsTransport.broadcast({ type: 'ai_alert', ...alert });
    // Also send to Telegram
    if (telegram) {
      telegram.sendAIAlert(alert as any);
    }
  });

  aiMonitor.on('ai_chart_data', (data: { t: number; motion: number; scores: Record<string, number> }) => {
    store.pushAIChartData(data);
  });
}

// --- Startup ---
async function start(): Promise<void> {
  // Restore persisted state before connecting
  await persistence.load();
  persistence.start();

  // Start MQTT connection
  bridge.connect();

  // Start HTTP + WebSocket server
  httpServer.listen(config.servicePort, '0.0.0.0', () => {
    log.info(`Listening on :${config.servicePort}`);
  });

  // Start Telegram bot if configured
  if (telegram) {
    await telegram.start();
  }

  // Start AI monitor if configured
  if (aiMonitor) {
    await aiMonitor.start();
  }
}

// Graceful shutdown
function shutdown(): void {
  log.info('Shutting down...');
  aiMonitor?.stop();
  persistence.stop();
  wsTransport.close();
  telegram?.stop();
  bridge.disconnect();
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
