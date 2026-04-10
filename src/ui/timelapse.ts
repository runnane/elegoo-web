/** Timelapse viewer — list and play timelapse videos from print history.
 *
 * The CC2 stores timelapse data per print history entry:
 *   time_lapse_video_status: 0=NotCaptured, 1=NotExported, 2=Exported, 3=Failed
 *   time_lapse_video_url: filename/URL for the video
 *
 * Method 1051 (GetTimeLapseVideoList) is actually used to *export* a specific
 * timelapse video — it takes { url: filename } and triggers video generation.
 * The video list itself comes from print history (method 1036).
 */

import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import { $, escapeHtml, escapeAttr } from './helpers';

let playerClient: CommandSender | null = null;

export function setTimelapseClient(client: CommandSender): void {
  playerClient = client;
}

export function renderTimelapse(state: PrinterState): void {
  const container = $('timelapse-list');
  if (!container) return;

  const videos = state.timelapseList;
  if (!videos || !videos.length) {
    container.innerHTML = '<div class="file-empty">No timelapse videos found. Click Refresh to load print history.</div>';
    return;
  }

  let html = '';
  for (const video of videos) {
    const name = String(video.filename || 'Unknown');
    const status = video.timelapse_status as number;
    const videoUrl = video.timelapse_url as string || '';
    const videoDuration = video.timelapse_duration as number || 0;
    const beginTime = video.begin_time as number | undefined;
    const time = beginTime ? new Date(beginTime * 1000).toLocaleString() : '';
    const durStr = videoDuration > 0 ? `${videoDuration}s` : '';
    const meta = [time, durStr].filter(Boolean).join(' · ');

    // Status 2 = already exported (has URL), status 1 = captured but needs export
    const isExported = status === 2 && videoUrl;
    const actionBtn = isExported
      ? `<button class="btn btn-sm btn-primary timelapse-play-btn" data-url="${escapeAttr(videoUrl)}">▶ Play</button>`
      : `<button class="btn btn-sm btn-ghost timelapse-export-btn" data-url="${escapeAttr(videoUrl || name)}">⬆ Export</button>`;

    html += `
      <div class="file-item timelapse-item" data-filename="${escapeAttr(name)}">
        <div class="file-icon">🎬</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(name)}</div>
          <div class="file-size">${meta}${isExported ? ' · ✅ Ready' : ' · ⏳ Needs export'}</div>
        </div>
        ${actionBtn}
      </div>`;
  }

  container.innerHTML = html;

  // Bind play buttons (for already-exported videos)
  container.querySelectorAll('.timelapse-play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url;
      if (url) showTimelapsePlayer(url);
    });
  });

  // Bind export buttons (triggers method 1051 to generate the video)
  container.querySelectorAll('.timelapse-export-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url;
      if (url && playerClient) {
        playerClient.sendCommand(1051, { url });
        (e.currentTarget as HTMLButtonElement).disabled = true;
        (e.currentTarget as HTMLButtonElement).textContent = '⏳ Exporting…';
      }
    });
  });
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function showTimelapsePlayer(url: string): void {
  const player = $('timelapse-player') as HTMLVideoElement;
  const container = $('timelapse-player-wrap');
  if (!player || !container) return;

  player.src = url;
  container.classList.remove('hidden');
  player.play().catch(() => {});
}

/** Fetch print history which populates timelapse list */
export function requestTimelapseList(): void {
  if (playerClient) {
    // Request print history — timelapse entries are extracted from history
    playerClient.sendCommand(1036, { page: 1, page_size: 100 });
  }
}
