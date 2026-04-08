#!/usr/bin/env node
/**
 * Elegoo CC2 Telegram Bot — main entry point.
 *
 * Connects to the printer via MQTT and sends notifications to Telegram.
 * Run: pnpm bot
 */

import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import { loadConfig } from './config.js';
import { MqttBridge, type BridgeEvent } from './mqtt-bridge.js';
import { registerCommands } from './commands.js';
import { formatEvent } from './notifications.js';
import { fetchSnapshot } from './camera.js';

const config = loadConfig();

console.log('🖨  Elegoo CC2 Telegram Bot');
console.log(`   Printer: ${config.printerIp}`);
console.log(`   Camera:  ${config.cameraEnabled ? config.cameraUrl : 'disabled'}`);
console.log(`   Progress notifications every ${config.progressInterval}%`);
console.log('');

// --- Telegram Bot ---
const bot = new Bot(config.telegramToken);

// --- MQTT Bridge ---
const bridge = new MqttBridge(config.printerIp, config.printerPassword, config.progressInterval);

// Register interactive commands
registerCommands(bot, bridge, config);

// --- Live message tracking ---
// We keep one "live" message per print that gets updated in place.
let liveMessageId: number | null = null;

async function sendNewMessage(text: string, photo: Buffer | null, urgent: boolean): Promise<number | null> {
  if (photo) {
    const msg = await bot.api.sendPhoto(config.chatId, new InputFile(photo, 'snapshot.jpg'), {
      caption: text,
      parse_mode: 'MarkdownV2',
    });
    return msg.message_id;
  }
  const msg = await bot.api.sendMessage(config.chatId, text, {
    parse_mode: 'MarkdownV2',
    disable_notification: !urgent,
  });
  return msg.message_id;
}

async function updateLiveMessage(text: string, photo: Buffer | null): Promise<boolean> {
  if (!liveMessageId) return false;
  try {
    if (photo) {
      const media = InputMediaBuilder.photo(new InputFile(photo, 'snapshot.jpg'), {
        caption: text,
        parse_mode: 'MarkdownV2',
      });
      await bot.api.editMessageMedia(config.chatId, liveMessageId, media);
    } else {
      await bot.api.editMessageCaption(config.chatId, liveMessageId, {
        caption: text,
        parse_mode: 'MarkdownV2',
      });
    }
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    // "message is not modified" is fine — no real change
    if (msg.includes('message is not modified')) return true;
    console.warn(`[Telegram] Edit failed, will send new: ${msg}`);
    return false;
  }
}

// --- Notification dispatch ---
async function sendNotification(event: BridgeEvent): Promise<void> {
  const { text, urgent } = formatEvent(event);
  if (!text) return;

  try {
    const wantPhoto = config.cameraEnabled && [
      'print_started', 'print_completed', 'print_failed', 'print_progress', 'first_layer_complete',
    ].includes(event.type);
    const photo = wantPhoto ? await fetchSnapshot(config.cameraUrl) : null;

    // Events that should update the live message in-place
    if (event.type === 'print_progress') {
      const edited = await updateLiveMessage(text, photo);
      if (!edited) {
        // Live message gone — send a new one and track it
        liveMessageId = await sendNewMessage(text, photo, urgent);
      }
      return;
    }

    // Print started: send new message and pin it as the live one
    if (event.type === 'print_started') {
      liveMessageId = await sendNewMessage(text, photo, urgent);
      return;
    }

    // Print ended: final update of the live message, then clear tracking
    if (event.type === 'print_completed' || event.type === 'print_failed') {
      const edited = await updateLiveMessage(text, photo);
      if (!edited) {
        await sendNewMessage(text, photo, urgent);
      }
      liveMessageId = null;
      return;
    }

    // All other events (errors, filament runout, connect/disconnect): send as new message
    await sendNewMessage(text, photo, urgent);
  } catch (err) {
    console.error(`[Telegram] Failed to send: ${(err as Error).message}`);
  }
}

bridge.on('event', (event: BridgeEvent) => {
  console.log(`[Event] ${event.type}`);
  sendNotification(event);
});

// --- Startup ---
async function start(): Promise<void> {
  // Start MQTT connection to printer
  bridge.connect();

  // Start Telegram bot (long polling)
  console.log('[Telegram] Starting bot...');
  bot.start({
    onStart: () => console.log('[Telegram] Bot is running ✓'),
  });
}

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down...');
  bridge.disconnect();
  bot.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
