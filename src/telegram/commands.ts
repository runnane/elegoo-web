/**
 * Telegram bot command handlers: /status, /photo, /help
 */

import type { Context, MiddlewareFn } from 'grammy';
import { InputFile } from 'grammy';
import type { MqttBridge } from './mqtt-bridge.js';
import type { BotConfig } from './config.js';
import { fetchSnapshot } from './camera.js';
import { safeCaption } from './notifications.js';
import { isAllowedSender } from './allowlist.js';

export function registerCommands(
  bot: {
    command: (cmd: string, handler: (ctx: Context) => Promise<void>) => void;
    use: (middleware: MiddlewareFn<Context>) => unknown;
  },
  bridge: MqttBridge,
  config: BotConfig,
): void {
  // Sender gate, BEFORE any handler (ELEG-3) — see src/server/telegram.ts for the
  // reasoning. Silent drop; a reply would confirm the bot exists.
  bot.use(async (ctx, next) => {
    if (isAllowedSender(config.allowedChatIds, ctx.from?.id)) {
      await next();
      return;
    }
    console.warn(
      `[Telegram] Ignoring update from unauthorised sender ${ctx.from?.id ?? 'unknown'}`,
    );
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🖨 *Elegoo CC2 Telegram Bot*\n\n' +
        'Commands:\n' +
        '/status — Current printer status\n' +
        '/photo — Camera snapshot\n' +
        '/help — Show this message',
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '🖨 *Elegoo CC2 Telegram Bot*\n\n' +
        '/status — Current printer status\n' +
        '/photo — Camera snapshot',
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('status', async (ctx) => {
    const summary = safeCaption(bridge.getStatusSummary());

    if (config.cameraEnabled) {
      const photo = await fetchSnapshot(config.cameraUrl);
      if (photo) {
        await ctx.replyWithPhoto(new InputFile(photo, 'snapshot.jpg'), {
          caption: summary,
          parse_mode: 'MarkdownV2',
        });
        return;
      }
    }

    await ctx.reply(summary, { parse_mode: 'MarkdownV2' });
  });

  bot.command('photo', async (ctx) => {
    if (!config.cameraEnabled) {
      await ctx.reply('📷 Camera is disabled in config.');
      return;
    }

    const photo = await fetchSnapshot(config.cameraUrl);
    if (!photo) {
      await ctx.reply('📷 Could not fetch camera snapshot.');
      return;
    }

    await ctx.replyWithPhoto(new InputFile(photo, 'snapshot.jpg'), {
      caption: '📷 Camera snapshot',
    });
  });
}
