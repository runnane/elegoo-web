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
import { $, escapeHtml, escapeAttr, formatBytes } from './helpers';
import { type ListControls, createListControls } from './list-controls';
import { nonZero } from './list-sort';

let playerClient: CommandSender | null = null;

export function setTimelapseClient(client: CommandSender): void {
  playerClient = client;
}

/** The list is `Record<string, unknown>[]`, so each field is read through an accessor. */
type TimelapseEntry = Record<string, unknown>;

const entryName = (v: TimelapseEntry): string => String(v.filename || 'Unknown');
const entryStatus = (v: TimelapseEntry): number => (v.timelapse_status as number) ?? 0;
const entrySize = (v: TimelapseEntry): number | undefined =>
  nonZero(v.timelapse_size as number | undefined);
const entryDuration = (v: TimelapseEntry): number | undefined =>
  nonZero(v.timelapse_duration as number | undefined);
const entryBegin = (v: TimelapseEntry): number | undefined =>
  nonZero(v.begin_time as number | undefined);

/** Status codes, from the file header: 0=NotCaptured, 1=NotExported, 2=Exported, 3=Failed */
const STATUS_EXPORTED = 2;
const STATUS_FAILED = 3;

/** Kept outside the render function — see `list-controls.ts` on why that matters. */
let timelapseControls: ListControls<TimelapseEntry> | null = null;
let lastTimelapseState: PrinterState | null = null;

function ensureTimelapseControls(): ListControls<TimelapseEntry> {
  if (timelapseControls) return timelapseControls;
  timelapseControls = createListControls<TimelapseEntry>({
    id: 'timelapse',
    container: $('timelapse-controls'),
    noun: 'videos',
    filterPlaceholder: 'Filter timelapses…',
    filterText: entryName,
    columns: [
      { key: 'name', label: 'Name', value: entryName },
      { key: 'time', label: 'Recorded', value: entryBegin, initialDirection: 'desc' },
      { key: 'duration', label: 'Length', value: entryDuration, initialDirection: 'desc' },
      { key: 'size', label: 'Size', value: entrySize, initialDirection: 'desc' },
    ],
    defaultSort: { key: 'time', dir: 'desc' },
    selects: [
      {
        // The timelapse analogue of Print History's failures filter, which this issue
        // asked to fold in if it was cheap. It was — the helper already does dropdowns.
        id: 'state',
        label: 'State',
        options: [
          { value: 'ready', label: 'ready to play' },
          { value: 'pending', label: 'needs export' },
          { value: 'failed', label: 'generation failed' },
        ],
        match: (v, value) => {
          const status = entryStatus(v);
          if (value === 'ready') return status === STATUS_EXPORTED && !!v.timelapse_url;
          if (value === 'failed') return status === STATUS_FAILED;
          return status !== STATUS_EXPORTED && status !== STATUS_FAILED;
        },
      },
    ],
    onChange: () => {
      if (lastTimelapseState) renderTimelapse(lastTimelapseState);
    },
  });
  return timelapseControls;
}

export function renderTimelapse(state: PrinterState): void {
  const container = $('timelapse-list');
  if (!container) return;
  lastTimelapseState = state;

  const controls = ensureTimelapseControls();
  const videos = controls.apply(state.timelapseList ?? []);

  if (!videos.length) {
    // "No timelapses at all" and "none match your filter" are different facts.
    container.innerHTML = controls.emptyHtml(
      'No timelapse videos found. Click Refresh to load print history.',
    );
    return;
  }

  let html = '';
  for (const video of videos) {
    const name = entryName(video);
    const status = entryStatus(video);
    const videoUrl = (video.timelapse_url as string) || '';
    const time = entryBegin(video) ? new Date(entryBegin(video)! * 1000).toLocaleString() : '';
    const videoDuration = entryDuration(video);
    const durStr = videoDuration ? `${videoDuration}s` : '';
    const size = entrySize(video);
    const sizeStr = size ? formatBytes(size) : '';
    const meta = [time, durStr, sizeStr].filter(Boolean).join(' · ');

    // Status 2 = already exported (has URL), status 1 = captured but needs export
    const isExported = status === STATUS_EXPORTED && videoUrl;
    const actionBtn = isExported
      ? `<button class="btn btn-sm btn-primary timelapse-play-btn" data-url="${escapeAttr(videoUrl)}">▶ Play</button>`
      : `<button class="btn btn-sm btn-ghost timelapse-export-btn" data-url="${escapeAttr(videoUrl || name)}">⬆ Export</button>`;

    html += `
      <div class="file-item timelapse-item" data-filename="${escapeAttr(name)}">
        <div class="file-icon">🎬</div>
        <div class="file-details">
          <div class="file-name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
          <div class="file-size">${meta}${isExported ? ' · ✅ Ready' : ' · ⏳ Needs export'}</div>
        </div>
        ${actionBtn}
      </div>`;
  }

  container.innerHTML = html;

  // Bind play buttons (for already-exported videos)
  container.querySelectorAll('.timelapse-play-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url;
      if (url) showTimelapsePlayer(url);
    });
  });

  // Bind export buttons (triggers method 1051 to generate the video)
  container.querySelectorAll('.timelapse-export-btn').forEach((btn) => {
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

function _formatDuration(seconds: number): string {
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
