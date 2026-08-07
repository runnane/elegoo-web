import 'dotenv/config';
import { parseAllowedChatIds } from './allowlist.js';

export interface BotConfig {
  telegramToken: string;
  chatId: string;
  /** Numeric sender ids permitted to issue bot commands; empty denies everyone (ELEG-3) */
  allowedChatIds: string[];
  printerIp: string;
  printerPassword: string;
  cameraEnabled: boolean;
  cameraUrl: string;
  progressInterval: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required env var: ${key}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
  return value;
}

export function loadConfig(): BotConfig {
  const printerIp = process.env['PRINTER_IP'] || '172.20.100.236';
  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  return {
    telegramToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId,
    // Defaults to TELEGRAM_CHAT_ID so an existing deployment gains the gate with no new
    // setting (ELEG-3).
    allowedChatIds: parseAllowedChatIds(process.env['TELEGRAM_ALLOWED_CHAT_IDS'], chatId),
    printerIp,
    printerPassword: process.env['PRINTER_PASSWORD'] || '123456',
    cameraEnabled: process.env['CAMERA_ENABLED'] !== 'false',
    cameraUrl: process.env['CAMERA_URL'] || `http://${printerIp}:8080`,
    progressInterval: parseInt(process.env['PROGRESS_INTERVAL'] || '25', 10) || 25,
  };
}
