import 'dotenv/config';

export interface ServiceConfig {
  // Printer
  printerIp: string;
  printerPassword: string;

  // Service
  servicePort: number;

  // Camera
  cameraEnabled: boolean;
  cameraUrl: string;

  // Telegram (optional)
  telegramEnabled: boolean;
  telegramToken: string;
  telegramChatId: string;
  progressInterval: number;

  // Data persistence
  dataDir: string;

  // Moonraker compat server (optional)
  moonrakerPort: number;

  // AI monitoring (optional)
  aiEnabled: boolean;
  aiVlmEnabled: boolean;
  aiVlmProvider: 'openai' | 'ollama';
  aiVlmApiKey: string;
  aiVlmBaseUrl: string;
  aiVlmModel: string;
  aiLocalEnabled: boolean;
  aiLocalModel: string;
  aiIntervalSec: number;
  aiAlertThreshold: number;
  aiAlertCooldownSec: number;
}

function env(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validatePort(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${name}: ${value} (must be 1-65535)`);
  }
}

export function loadConfig(): ServiceConfig {
  const printerIp = env('PRINTER_IP', '172.20.100.236');

  // Validate required values
  if (!printerIp || !IP_RE.test(printerIp)) {
    throw new Error(`Invalid PRINTER_IP: "${printerIp}" (must be a valid IPv4 address)`);
  }
  const octets = printerIp.split('.').map(Number);
  if (octets.some(o => o > 255)) {
    throw new Error(`Invalid PRINTER_IP: "${printerIp}" (octet out of range)`);
  }

  const servicePort = parseInt(env('SERVICE_PORT', '8088'), 10);
  validatePort(servicePort, 'SERVICE_PORT');

  const moonrakerPort = parseInt(env('MOONRAKER_PORT', '7125'), 10);
  validatePort(moonrakerPort, 'MOONRAKER_PORT');

  const telegramToken = env('TELEGRAM_BOT_TOKEN');
  const telegramChatId = env('TELEGRAM_CHAT_ID');
  if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) {
    throw new Error(`Invalid TELEGRAM_CHAT_ID: "${telegramChatId}" (must be a numeric string)`);
  }

  return {
    printerIp,
    printerPassword: env('PRINTER_PASSWORD', '123456'),
    servicePort,
    cameraEnabled: env('CAMERA_ENABLED') !== 'false',
    cameraUrl: env('CAMERA_URL') || `http://${printerIp}:8080`,
    telegramEnabled: !!(telegramToken && telegramChatId),
    telegramToken,
    telegramChatId,
    progressInterval: parseInt(env('PROGRESS_INTERVAL', '25'), 10) || 25,
    dataDir: env('DATA_DIR') || './data',
    moonrakerPort,

    // AI monitoring
    aiEnabled: env('AI_ENABLED') === 'true',
    aiVlmEnabled: env('AI_VLM_ENABLED', 'true') !== 'false',
    aiVlmProvider: (env('AI_VLM_PROVIDER', 'ollama') as 'openai' | 'ollama'),
    aiVlmApiKey: env('AI_VLM_API_KEY'),
    aiVlmBaseUrl: env('AI_VLM_BASE_URL', 'http://172.20.100.9:3000'),
    aiVlmModel: env('AI_VLM_MODEL', 'llava'),
    aiLocalEnabled: env('AI_LOCAL_ENABLED', 'true') !== 'false',
    aiLocalModel: env('AI_LOCAL_MODEL', 'Xenova/siglip-base-patch16-224'),
    aiIntervalSec: parseInt(env('AI_INTERVAL', '60'), 10) || 60,
    aiAlertThreshold: parseInt(env('AI_ALERT_THRESHOLD', '3'), 10) || 3,
    aiAlertCooldownSec: parseInt(env('AI_ALERT_COOLDOWN', '300'), 10) || 300,
  };
}
