/**
 * Print queue card — the DOM half (ELEG-35). The decisions live in `print-queue-view.ts`.
 *
 * Follows the list-view rule in AGENTS.md: the buttons and the hint live in the STATIC
 * `#print-queue-controls`, mounted once, while `#print-queue-list` is replaced wholesale
 * whenever the queue changes and its row buttons are handled by one delegated listener.
 *
 * **"Start next" opens the existing print dialog** for the head job — the same filament
 * mapping, plate and timelapse options as the Files card's ▶ — with a bed-clear checkbox
 * the human must tick. Its ▶ Print posts the dialog's 1020 `config` to
 * `/api/queue/start-next`, and the service decides whether it may start. Nothing in this
 * module or the service starts a job without that click.
 */

import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import type { QueueSnapshot } from '../print-queue-shared';
import { escapeAttr, escapeHtml, fetchTimeout } from './helpers';
import { toast } from './toast';
import { requestPrintDialog } from './print-dialog';
import { baseName, queueRows, startNextView } from './print-queue-view';

let queue: QueueSnapshot | null = null;
/** The snapshot the list was last built from — the list is rebuilt only when it changes. */
let renderedQueue: QueueSnapshot | null | undefined;
let queueClient: CommandSender | null = null;
let lastState: PrinterState | null = null;
let controls: {
  start: HTMLButtonElement;
  resume: HTMLButtonElement;
  clear: HTMLButtonElement;
  hint: HTMLElement;
} | null = null;

type QueueResponse = { ok: boolean; body: Record<string, unknown> };

async function queueRequest(path: string, init?: RequestInit): Promise<QueueResponse> {
  try {
    const res = await fetchTimeout(path, init);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.queue) handlePrintQueueUpdate(body.queue);
    return { ok: res.ok, body };
  } catch (err) {
    toast(`Print queue unavailable: ${(err as Error).message}`, 'error');
    return { ok: false, body: {} };
  }
}

function post(path: string, body: unknown = {}): Promise<QueueResponse> {
  return queueRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A queue snapshot from a REST answer or a `print_queue` WebSocket message. */
export function handlePrintQueueUpdate(data: unknown): void {
  if (!data || typeof data !== 'object' || !Array.isArray((data as QueueSnapshot).items)) return;
  queue = data as QueueSnapshot;
  render();
}

export async function refreshPrintQueue(): Promise<void> {
  await queueRequest('/api/queue');
}

/** Called from the Files card's ＋ button. Queues the file; never starts it. */
export async function addToPrintQueue(filename: string, source: string): Promise<void> {
  const { ok, body } = await post('/api/queue/items', { filename, source });
  if (ok) toast(`Queued: ${baseName(filename)}`, 'success');
  else
    toast(
      `Could not queue ${baseName(filename)}: ${String(body.error ?? 'unknown error')}`,
      'error',
    );
}

export function bindPrintQueue(client: CommandSender, state: PrinterState): void {
  queueClient = client;
  lastState = state;
  if (controls) return;
  const container = document.getElementById('print-queue-controls');
  const list = document.getElementById('print-queue-list');
  if (!container || !list) return;

  container.innerHTML = `
    <button type="button" class="btn btn-sm btn-primary" id="print-queue-start" disabled>▶ Start next…</button>
    <button type="button" class="btn btn-sm btn-ghost hidden" id="print-queue-resume">⏯ Resume queue</button>
    <button type="button" class="btn btn-sm btn-ghost" id="print-queue-clear" disabled>Clear</button>
    <div class="print-queue-hint" id="print-queue-hint" aria-live="polite"></div>`;
  controls = {
    start: container.querySelector('#print-queue-start') as HTMLButtonElement,
    resume: container.querySelector('#print-queue-resume') as HTMLButtonElement,
    clear: container.querySelector('#print-queue-clear') as HTMLButtonElement,
    hint: container.querySelector('#print-queue-hint') as HTMLElement,
  };

  controls.start.addEventListener('click', startNext);
  controls.resume.addEventListener('click', () => void post('/api/queue/resume'));
  controls.clear.addEventListener('click', () => {
    if (confirm('Remove every job from the print queue?')) void post('/api/queue/clear');
  });
  list.addEventListener('click', onListClick);

  render();
  void refreshPrintQueue();
}

function startNext(): void {
  const head = queue?.items[0];
  if (!queue || !head || !queueClient || !lastState) return;
  const finished = queue.lastFinished?.filename;
  requestPrintDialog(baseName(head.filename), head.filename, queueClient, lastState, {
    source: head.source,
    lastFinished: finished ? baseName(finished) : null,
    start: async (config, bedCleared) => {
      const { ok, body } = await post('/api/queue/start-next', {
        id: head.id,
        bedCleared,
        config,
      });
      if (!ok) toast(`Not started: ${String(body.error ?? 'the service refused')}`, 'warning');
      return ok;
    },
  });
}

function onListClick(event: Event): void {
  const btn = (event.target as HTMLElement).closest('[data-queue-action]') as HTMLElement | null;
  if (!btn || !queue) return;
  const id = btn.dataset.id;
  if (!id) return;
  const index = queue.items.findIndex((item) => item.id === id);
  if (index < 0) return;
  const itemPath = `/api/queue/items/${encodeURIComponent(id)}`;
  switch (btn.dataset.queueAction) {
    case 'up':
      void post(`${itemPath}/move`, { index: index - 1 });
      break;
    case 'down':
      void post(`${itemPath}/move`, { index: index + 1 });
      break;
    case 'remove':
      void queueRequest(itemPath, { method: 'DELETE' });
      break;
  }
}

/** Cheap enough for every scheduled render: the list is only rebuilt when the queue changed. */
export function renderPrintQueue(state: PrinterState): void {
  lastState = state;
  render();
}

function render(): void {
  if (!controls) return;
  const ms = lastState?.status?.machine_status;
  const view = startNextView(queue, ms?.status, ms?.sub_status);
  controls.start.disabled = !view.enabled;
  if (controls.hint.textContent !== view.hint) controls.hint.textContent = view.hint;
  controls.hint.classList.toggle('is-warning', view.warning);
  controls.resume.classList.toggle('hidden', !queue?.hold);
  controls.clear.disabled = !queue || queue.items.length === 0;

  if (renderedQueue === queue) return;
  renderedQueue = queue;
  const list = document.getElementById('print-queue-list');
  if (!list) return;

  const activeHtml = queue?.active
    ? `<div class="print-queue-active">Started from the queue: ${escapeHtml(baseName(queue.active.item.filename))}</div>`
    : '';
  const rows = queueRows(queue);
  if (rows.length === 0) {
    list.innerHTML = `${activeHtml}<div class="file-empty">No jobs queued</div>`;
    return;
  }
  list.innerHTML =
    activeHtml +
    rows
      .map((row) => {
        const id = escapeAttr(row.id);
        const name = escapeAttr(row.name);
        const detail = row.path !== row.name ? ` · ${escapeHtml(row.path)}` : '';
        return `
      <div class="file-item print-queue-item" data-id="${id}">
        <div class="file-item-body">
          <span class="print-queue-pos">${row.position}</span>
          <div class="file-details">
            <div class="file-name" title="${escapeAttr(row.path)}">${escapeHtml(row.name)}</div>
            <div class="file-size">${escapeHtml(row.source)}${detail}</div>
          </div>
          <div class="file-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-queue-action="up" data-id="${id}" title="Move up" aria-label="Move ${name} up"${row.canMoveUp ? '' : ' disabled'}>↑</button>
            <button type="button" class="btn btn-sm btn-ghost" data-queue-action="down" data-id="${id}" title="Move down" aria-label="Move ${name} down"${row.canMoveDown ? '' : ' disabled'}>↓</button>
            <button type="button" class="btn btn-sm btn-ghost" data-queue-action="remove" data-id="${id}" title="Remove from queue" aria-label="Remove ${name} from queue">✕</button>
          </div>
        </div>
      </div>`;
      })
      .join('');
}
