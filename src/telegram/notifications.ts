/**
 * Format BridgeEvents into human-readable Telegram messages (MarkdownV2).
 */

import type { BridgeEvent } from './mqtt-bridge.js';
import { CRITICAL_EXCEPTIONS } from '../types.js';

/** Escape special chars for Telegram MarkdownV2 (outside of code blocks) */
export function esc(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function progressBar(pct: number, length = 20): string {
  const filled = Math.round((pct / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

export function formatEvent(event: BridgeEvent): { text: string; urgent: boolean } {
  switch (event.type) {
    case 'connected':
      return {
        text: `🟢 *Connected to printer*\nSN: \`${event.sn}\``,
        urgent: false,
      };

    case 'disconnected':
      return {
        text: '🔴 *Printer disconnected*',
        urgent: true,
      };

    case 'print_started':
      return {
        text: `🚀 *Print Started*\n📄 ${esc(event.filename)}`,
        urgent: false,
      };

    case 'print_completed':
      return {
        text: `✅ *Print Completed\!*\n📄 ${esc(event.filename)}\n⏱ Duration: ${esc(formatDuration(event.duration))}`,
        urgent: false,
      };

    case 'print_failed':
      return {
        text: `❌ *Print Failed/Stopped*\n📄 ${esc(event.filename)}\n💬 ${esc(event.reason)}`,
        urgent: true,
      };

    case 'print_progress': {
      const bar = progressBar(event.progress);
      const layerStr = event.totalLayers
        ? `Layer ${event.layer} of ${event.totalLayers}`
        : `Layer ${event.layer}`;
      return {
        text: [
          `📊 *Print Progress: ${event.progress}%*`,
          `\`${bar}\``,
          `📄 ${esc(event.filename)}`,
          `📐 ${esc(layerStr)}`,
          `⏱ Remaining: ${esc(formatDuration(event.remaining))}`,
        ].join('\n'),
        urgent: false,
      };
    }

    case 'error': {
      const hasCritical = event.codes.some(c => CRITICAL_EXCEPTIONS.has(c));
      const lines = event.names.map((name, i) => {
        const code = event.codes[i];
        const icon = CRITICAL_EXCEPTIONS.has(code) ? '🚨' : '⚠️';
        return `${icon} ${esc(name)} \(${code}\)`;
      });
      return {
        text: `${hasCritical ? '🚨' : '⚠️'} *Printer Error*\n${lines.join('\n')}`,
        urgent: hasCritical,
      };
    }

    case 'filament_runout':
      return {
        text: '🧵 *Filament Runout Detected\!*\nPrinter is paused, please load new filament\.',
        urgent: true,
      };

    case 'first_layer_complete':
      return {
        text: `🥇 *First Layer Complete\!*\n📄 ${esc(event.filename)}\n⏱ Layer took: ${esc(formatDuration(event.durationSec))}`,
        urgent: false,
      };

    default:
      return { text: '', urgent: false };
  }
}
