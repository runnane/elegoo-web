/** Timelapse viewer — list and play timelapse videos from the printer */

import type { CC2MqttClient } from '../mqtt-client';
import type { PrinterState } from '../printer-state';
import { $, escapeHtml, escapeAttr, formatTime } from './helpers';

let playerClient: CC2MqttClient | null = null;

export function setTimelapseClient(client: CC2MqttClient): void {
  playerClient = client;
}

export function renderTimelapse(state: PrinterState): void {
  const container = $('timelapse-list');
  if (!container) return;

  const videos = state.timelapseList;
  if (!videos || !videos.length) {
    container.innerHTML = '<div class="file-empty">No timelapse videos found</div>';
    return;
  }

  let html = '';
  for (const video of videos) {
    const name = String(video.filename || video.file_name || 'Unknown');
    const sizeVal = video.size as number | undefined;
    const size = sizeVal ? `${(sizeVal / (1024 * 1024)).toFixed(1)} MB` : '';
    const createTime = video.create_time as number | undefined;
    const time = createTime ? new Date(createTime * 1000).toLocaleString() : '';
    const meta = [size, time].filter(Boolean).join(' · ');

    html += `
      <div class="file-item timelapse-item" data-filename="${escapeAttr(name)}">
        <div class="file-icon">🎬</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(name)}</div>
          <div class="file-size">${meta}</div>
        </div>
        <button class="btn btn-sm btn-primary timelapse-play-btn">▶ Play</button>
      </div>`;
  }

  container.innerHTML = html;

  // Bind play buttons
  container.querySelectorAll('.timelapse-play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.timelapse-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && playerClient) {
        // Request video URL from printer
        playerClient.sendCommand(1050, { filename });
      }
    });
  });
}

export function showTimelapsePlayer(url: string): void {
  const player = $('timelapse-player') as HTMLVideoElement;
  const container = $('timelapse-player-wrap');
  if (!player || !container) return;

  player.src = url;
  container.classList.remove('hidden');
  player.play().catch(() => {});
}

export function requestTimelapseList(): void {
  if (playerClient) {
    playerClient.sendCommand(1051, {});
  }
}
