import 'dotenv/config';
import { CONNECTION_PRESETS_API_ENV } from '../types.js';
import { parseAllowedChatIds } from './allowlist.js';
import { type CorsPolicy, parseCorsPolicy } from './cors.js';

export interface ServiceConfig {
  // Printer
  printerIp: string;
  printerPassword: string;
  /**
   * Optional serial-number override. Normally discovered and then cached, but a
   * printer that is silent at startup can never be discovered — so this lets a first
   * start register immediately (ELEG-60). Empty means "discover it".
   */
  printerSn: string;

  // Service
  servicePort: number;
  /**
   * The interface both HTTP servers (the main service and the separate Moonraker
   * `:7125` server) bind to. Defaults to `0.0.0.0` — today's behaviour, unchanged —
   * because who *should* be able to reach this is a decision for a human (ELEG-27,
   * ELEG-94), not something this issue forces. Also reported back to Moonraker compat
   * clients in `server.config` responses, since that is what real Moonraker does.
   */
  bindAddress: string;

  // Camera
  cameraEnabled: boolean;
  cameraUrl: string;

  /** Cross-origin policy for every HTTP surface; defaults to same-origin (ELEG-24) */
  corsPolicy: CorsPolicy;

  // Telegram (optional)
  telegramEnabled: boolean;
  telegramToken: string;
  telegramChatId: string;
  /** Numeric sender ids permitted to issue bot commands; empty denies everyone (ELEG-3) */
  telegramAllowedChatIds: string[];
  progressInterval: number;

  // Data persistence
  dataDir: string;

  // Moonraker compat server (optional)
  moonrakerPort: number;

  /**
   * Allow adding, removing and switching printer connection presets over the REST API
   * (ELEG-95). Off by default: the API has no authentication, and switching re-points
   * every consumer and makes the service dial an address a request chose.
   */
  connectionPresetsApi: boolean;

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

/**
 * The one dotted-quad IPv4 predicate for the whole service — `PRINTER_IP`,
 * `BIND_ADDRESS` and saved connection presets (`connection-presets.ts`) all hold
 * addresses to this shape (ELEG-106; previously three separate copies). Exported so
 * `connection-presets.ts` can reuse it rather than keep its own.
 *
 * IPv6 (`::`, `::1`) is deliberately out of scope: every example, test fixture and the
 * TEST-NET convention this repo uses (`.agents/testing.md`) is IPv4-only, and `0.0.0.0`
 * / `127.0.0.1` already cover both binds this issue asks for. Extending validation to
 * IPv6 is future work if a real need for it shows up — not a silent accept-anything.
 */
export function isValidIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || !IP_RE.test(value)) return false;
  return value.split('.').every((o) => Number(o) <= 255);
}

/**
 * Validates a dotted-quad IPv4 address, the same shape `PRINTER_IP` requires. Throws
 * with an actionable message rather than letting a bad value reach `listen()`, where a
 * malformed bind address surfaces as an opaque `EADDRNOTAVAIL` (or, worse, a value that
 * happens to resolve to something else entirely). Built on `isValidIPv4` above so the
 * refusal and the predicate can never drift apart.
 */
export function validateIPv4(value: string, name: string): void {
  if (!IP_RE.test(value)) {
    throw new Error(
      `Invalid ${name}: "${value}" (must be a valid IPv4 address, e.g. 0.0.0.0 or ` +
        '127.0.0.1 — IPv6 is not supported)',
    );
  }
  // The octet-range rule lives only in isValidIPv4 — this is the shape check above
  // plus that one predicate, not a second copy of the range test.
  if (!isValidIPv4(value)) {
    throw new Error(`Invalid ${name}: "${value}" (octet out of range)`);
  }
}

export function loadConfig(): ServiceConfig {
  // No default. It used to fall back to a real address on the maintainer's own LAN,
  // which shipped in a public image (ELEG-73) — so a user who forgot to set this got a
  // service that started cleanly and then dialled a machine they had never heard of.
  //
  // Required rather than a placeholder: without a printer the service cannot do anything
  // useful, and failing at startup with a clear message beats sitting in `awaiting_sn`
  // (ELEG-59) looking like it is still trying.
  const printerIp = env('PRINTER_IP');

  if (!printerIp) {
    throw new Error(
      "PRINTER_IP is not set. Set it to your printer's IPv4 address, e.g. " +
        'PRINTER_IP=192.168.1.150 (see .env.example).',
    );
  }
  validateIPv4(printerIp, 'PRINTER_IP');

  const servicePort = parseInt(env('SERVICE_PORT', '8088'), 10);
  validatePort(servicePort, 'SERVICE_PORT');

  // Default unchanged from today's behaviour (ELEG-93). What production SHOULD bind is
  // a human decision (ELEG-94) — this only makes the value configurable.
  const bindAddress = env('BIND_ADDRESS', '0.0.0.0');
  validateIPv4(bindAddress, 'BIND_ADDRESS');

  const moonrakerPort = parseInt(env('MOONRAKER_PORT', '7125'), 10);
  validatePort(moonrakerPort, 'MOONRAKER_PORT');

  const telegramToken = env('TELEGRAM_BOT_TOKEN');
  const telegramChatId = env('TELEGRAM_CHAT_ID');
  if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) {
    throw new Error(`Invalid TELEGRAM_CHAT_ID: "${telegramChatId}" (must be a numeric string)`);
  }
  // Who may *send* commands. Defaults to TELEGRAM_CHAT_ID, so an existing deployment
  // gains the gate without a new setting (ELEG-3).
  const telegramAllowedChatIds = parseAllowedChatIds(
    env('TELEGRAM_ALLOWED_CHAT_IDS'),
    telegramChatId,
  );
  if (env('TELEGRAM_ALLOWED_CHAT_IDS') && telegramAllowedChatIds.length === 0) {
    throw new Error(
      'TELEGRAM_ALLOWED_CHAT_IDS is set but contains no valid numeric id — refusing to start ' +
        'rather than fall back to a bot that answers everyone',
    );
  }

  return {
    printerIp,
    printerPassword: env('PRINTER_PASSWORD', '123456'),
    printerSn: env('PRINTER_SN', '').trim(),
    servicePort,
    bindAddress,
    cameraEnabled: env('CAMERA_ENABLED') !== 'false',
    cameraUrl: env('CAMERA_URL') || `http://${printerIp}:8080`,
    corsPolicy: parseCorsPolicy(env('CORS_ALLOWED_ORIGINS')),
    telegramEnabled: !!(telegramToken && telegramChatId),
    telegramToken,
    telegramChatId,
    telegramAllowedChatIds,
    progressInterval: parseInt(env('PROGRESS_INTERVAL', '25'), 10) || 25,
    dataDir: env('DATA_DIR') || './data',
    moonrakerPort,
    connectionPresetsApi: env(CONNECTION_PRESETS_API_ENV) === 'true',

    // AI monitoring
    aiEnabled: env('AI_ENABLED') === 'true',
    // Opt-in, exactly like aiEnabled above it. It used to default ON, so setting only
    // AI_ENABLED=true — which is how the README says to turn on AI monitoring — silently
    // started POSTing camera frames to the VLM endpoint as well (ELEG-72).
    aiVlmEnabled: env('AI_VLM_ENABLED') === 'true',
    aiVlmProvider: env('AI_VLM_PROVIDER', 'ollama') as 'openai' | 'ollama',
    aiVlmApiKey: env('AI_VLM_API_KEY'),
    // localhost, and ollama's actual port. The previous default was a hardcoded private
    // LAN address on the maintainer's own network, which shipped in a public image: every
    // user who enabled AI sent pictures of their printer to whatever held that IP on
    // THEIR network. It also could never have worked against a stock ollama, which
    // listens on 11434 rather than the 3000 that was hardcoded.
    aiVlmBaseUrl: env('AI_VLM_BASE_URL', 'http://localhost:11434'),
    aiVlmModel: env('AI_VLM_MODEL', 'llava'),
    aiLocalEnabled: env('AI_LOCAL_ENABLED', 'true') !== 'false',
    aiLocalModel: env('AI_LOCAL_MODEL', 'Xenova/siglip-base-patch16-224'),
    aiIntervalSec: parseInt(env('AI_INTERVAL', '60'), 10) || 60,
    aiAlertThreshold: parseInt(env('AI_ALERT_THRESHOLD', '3'), 10) || 3,
    aiAlertCooldownSec: parseInt(env('AI_ALERT_COOLDOWN', '300'), 10) || 300,
  };
}
