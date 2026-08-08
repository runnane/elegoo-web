import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import type { FileEntry } from '../types';
import {
  $,
  escapeHtml,
  formatBytes,
  escapeAttr,
  formatTime,
  applyDarkThumbnailCheck,
  THUMBNAIL_CLASS,
  THUMBNAIL_PLACEHOLDER_SRC,
} from './helpers';
import { requestPrintDialog } from './print-dialog';
import { type ListControls, createListControls } from './list-controls';

let currentSource: 'local' | 'u-disk' = 'local';
let currentDir = '/';

/** Set of full file paths that are cached on the server */
let cachedFiles = new Set<string>();
/** Map of full file path → base64 thumbnail */
const thumbnailCache = new Map<string, string>();
/** Queue of file paths waiting for thumbnail fetch */
let thumbnailQueue: string[] = [];
/** Currently fetching thumbnail for this file */
let thumbnailFetching: string | null = null;
export function currentFileSource(): string {
  return currentSource;
}
export function currentFileDir(): string {
  return currentDir;
}

/** Fetch which files are cached on the server and update markers */
let _fetchingCached = false;
async function fetchCachedStatus(
  files: { filename: string; type?: string }[],
  client: CommandSender,
): Promise<void> {
  if (_fetchingCached) return;
  const gcodeFiles = files
    .filter((f) => f.type !== 'folder' && f.filename.toLowerCase().endsWith('.gcode'))
    .map((f) =>
      currentDir === '/' ? f.filename : currentDir.replace(/^\//, '') + '/' + f.filename,
    );
  if (!gcodeFiles.length) {
    cachedFiles = new Set();
    return;
  }
  _fetchingCached = true;
  try {
    const params = gcodeFiles.map((f) => `file=${encodeURIComponent(f)}`).join('&');
    const resp = await fetch(`/api/files/cached?${params}`);
    if (resp.ok) {
      const data = (await resp.json()) as { cached: string[] };
      const newCached = new Set(data.cached);
      const changed =
        newCached.size !== cachedFiles.size || [...newCached].some((f) => !cachedFiles.has(f));
      cachedFiles = newCached;
      if (changed && cachedFiles.size > 0 && _lastState) {
        // Re-render to show cache markers in HTML
        renderFiles(_lastState, client);
      }
    }
  } catch {
    /* ignore */
  }
  _fetchingCached = false;
}

let _lastState: PrinterState | null = null;

/** Fetch inline thumbnails for visible gcode files (serialized via queue) */
let _thumbClient: CommandSender | null = null;
function fetchInlineThumbnails(
  files: { filename: string; type?: string }[],
  client: CommandSender,
): void {
  _thumbClient = client;
  for (const file of files) {
    if (file.type === 'folder') continue;
    if (!file.filename.toLowerCase().endsWith('.gcode')) continue;
    const fullPath =
      currentDir === '/' ? file.filename : currentDir.replace(/^\//, '') + '/' + file.filename;
    if (
      thumbnailCache.has(fullPath) ||
      thumbnailQueue.includes(fullPath) ||
      thumbnailFetching === fullPath
    )
      continue;
    thumbnailQueue.push(fullPath);
  }
  fetchNextThumbnail();
}

function fetchNextThumbnail(): void {
  if (thumbnailFetching || !_thumbClient) return;
  const next = thumbnailQueue.shift();
  if (!next) return;
  thumbnailFetching = next;
  // Method 1045 uses file_name (with underscore!)
  _lastState?.thumbnailRequestQueue.push('inline');
  _thumbClient.sendCommand(1045, { storage_media: currentSource, file_name: next });
}

/** Called when a thumbnail response arrives — update inline preview if applicable */
export function handleInlineThumbnail(base64: string | null): void {
  const fullPath = thumbnailFetching;
  thumbnailFetching = null;
  if (fullPath && base64) {
    thumbnailCache.set(fullPath, base64);
    // Find the DOM element and insert thumbnail
    document.querySelectorAll('.file-item[data-type="file"]').forEach((el) => {
      const fn = (el as HTMLElement).dataset.filename;
      if (!fn) return;
      const fp = currentDir === '/' ? fn : currentDir.replace(/^\//, '') + '/' + fn;
      if (fp !== fullPath) return;
      const iconEl = el.querySelector('.file-icon');
      // The guard skips a slot that already holds a *real* thumbnail. The placeholder
      // is not one, and must be replaced when the genuine preview arrives — treating it
      // as "already done" would leave every gcode file showing the placeholder forever
      // (ELEG-42).
      const existing = iconEl?.querySelector('img');
      if (iconEl && (!existing || existing.classList.contains('thumb-img-fallback'))) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${base64}`;
        img.alt = 'Thumbnail';
        img.className = `file-inline-thumb ${THUMBNAIL_CLASS}`;
        applyDarkThumbnailCheck(img, iconEl as HTMLElement);
        iconEl.textContent = '';
        iconEl.appendChild(img);
      }
    });
  }
  // Fetch next in queue
  fetchNextThumbnail();
}

// ── File detail popover on thumbnail hover ──────────────────────
let filePopover: HTMLElement | null = null;
let popoverTimeout: ReturnType<typeof setTimeout> | null = null;
/** Map filename → FileEntry for popover data lookup */
let _fileMap = new Map<string, FileEntry>();
let _popoverClient: CommandSender | null = null;

/** Try to extract filament info from ECC2 slicer filename pattern */
function parseFilamentFromName(filename: string): { types: string[]; count: number } | null {
  // Pattern: ECC2_nozzle_name_FilamentType_layerHeight_time.gcode
  // May have multiple filament segments separated by +
  // Examples: "Elegoo PLA " or "Elegoo PLA + Elegoo PETG "
  const base = filename.replace(/\.gcode$/i, '');
  const parts = base.split('_');
  // Find filament-like segments (contain known type keywords)
  const typeKeywords = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'PA', 'PC', 'HIPS', 'PVA', 'Nylon'];
  const found: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (typeKeywords.some((kw) => trimmed.toUpperCase().includes(kw))) {
      // Split on + for multi-filament
      trimmed.split('+').forEach((seg) => {
        const s = seg.trim();
        if (s) found.push(s);
      });
    }
  }
  if (found.length === 0) return null;
  return { types: [...new Set(found)], count: found.length };
}

function showFilePopover(file: FileEntry, anchor: HTMLElement): void {
  closeFilePopover();
  const fullPath =
    currentDir === '/' ? file.filename : currentDir.replace(/^\//, '') + '/' + file.filename;
  const thumb = thumbnailCache.get(fullPath);
  const isCached = cachedFiles.has(fullPath);
  const filamentInfo = parseFilamentFromName(file.filename);

  const el = document.createElement('div');
  el.className = 'file-popover';

  let html = '<div class="file-popover-inner">';
  if (thumb) {
    html += `<img class="file-popover-thumb ${THUMBNAIL_CLASS}" src="data:image/png;base64,${thumb}" alt="Preview">`;
  }
  html += '<div class="file-popover-details">';
  html += `<div class="file-popover-name">${escapeHtml(file.filename)}</div>`;
  html += '<table class="file-popover-table">';
  html += `<tr><td>Size</td><td>${formatBytes(file.size)}</td></tr>`;
  if (file.print_time)
    html += `<tr><td>Print time</td><td>${formatTime(file.print_time)}</td></tr>`;
  if (file.layer) html += `<tr><td>Layers</td><td>${file.layer}</td></tr>`;
  if (file.total_filament_used)
    html += `<tr><td>Filament</td><td>${file.total_filament_used.toFixed(1)}g</td></tr>`;
  if (filamentInfo) {
    html += `<tr><td>Material</td><td>${escapeHtml(filamentInfo.types.join(', '))}`;
    if (filamentInfo.count > 1) html += ` (${filamentInfo.count} filaments)`;
    html += `</td></tr>`;
  }
  // Show color map info if available from last file detail matching this file
  if (_lastState?.lastFileDetail?.filename === fullPath && _lastState.colorMap.length > 0) {
    const cm = _lastState.colorMap;
    const swatches = cm
      .map((c) => {
        const hex = c.color.startsWith('#') ? c.color : `#${c.color}`;
        return `<span class="filament-swatch" style="background:${escapeAttr(hex)}" title="${escapeAttr(c.name)}"></span>`;
      })
      .join(' ');
    html += `<tr><td>Filaments</td><td>${swatches} (${cm.length})</td></tr>`;
  }
  if (file.create_time) {
    const d = new Date(file.create_time * 1000);
    html += `<tr><td>Created</td><td>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</td></tr>`;
  }
  if (isCached) html += `<tr><td>Cache</td><td>⚡ Cached on server</td></tr>`;
  html += '</table>';

  // Action buttons
  html += '<div class="file-popover-actions">';
  html += `<button class="btn btn-sm btn-ghost file-popover-preview" title="Full preview">🖼️ Preview</button>`;
  html += `<button class="btn btn-sm btn-ghost file-popover-download" title="Download">📥 Download</button>`;
  html += `<button class="btn btn-sm btn-ghost file-popover-delete" title="Delete">🗑️ Delete</button>`;
  html += '</div>';

  html += '</div></div>';
  el.innerHTML = html;

  document.body.appendChild(el);

  // Bind popover action buttons
  const source = currentSource === 'u-disk' ? 'u-disk' : 'local';
  el.querySelector('.file-popover-preview')?.addEventListener('click', () => {
    closeFilePopover();
    pendingThumbnailFile = fullPath;
    pendingThumbnailAnchor = anchor;
    _lastState?.thumbnailRequestQueue.push('popup');
    _popoverClient?.sendCommand(1045, { storage_media: currentSource, file_name: fullPath });
  });
  el.querySelector('.file-popover-download')?.addEventListener('click', () => {
    closeFilePopover();
    const a = document.createElement('a');
    a.href = `/api/files/download?file=${encodeURIComponent(fullPath)}&source=${encodeURIComponent(source)}`;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  el.querySelector('.file-popover-delete')?.addEventListener('click', () => {
    closeFilePopover();
    if (confirm(`Delete ${file.filename}?`)) {
      _popoverClient?.sendCommand(1047, { storage_media: currentSource, file_path: [fullPath] });
      setTimeout(() => {
        _popoverClient?.sendCommand(1044, {
          storage_media: currentSource,
          dir: currentDir,
          offset: 0,
          limit: 200,
        });
        _popoverClient?.sendCommand(1048, { storage_media: currentSource });
      }, 500);
    }
  });

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  const popW = 320;
  const popH = el.offsetHeight || 200;
  let left = rect.right + 8;
  let top = rect.top;
  // Keep within viewport
  if (left + popW > window.innerWidth) left = rect.left - popW - 8;
  if (top + popH > window.innerHeight) top = Math.max(8, window.innerHeight - popH - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  // Apply dark thumbnail check if we have an image
  const img = el.querySelector('.file-popover-thumb') as HTMLImageElement | null;
  if (img) applyDarkThumbnailCheck(img, el);

  filePopover = el;

  // Close when mouse leaves the popover (with delay for moving back)
  el.addEventListener('mouseleave', () => {
    closePopoverTimeout = setTimeout(() => closeFilePopover(), 150);
  });
  el.addEventListener('mouseenter', () => {
    if (closePopoverTimeout) {
      clearTimeout(closePopoverTimeout);
      closePopoverTimeout = null;
    }
  });
}

function closeFilePopover(): void {
  if (popoverTimeout) {
    clearTimeout(popoverTimeout);
    popoverTimeout = null;
  }
  if (filePopover) {
    filePopover.remove();
    filePopover = null;
  }
}

let closePopoverTimeout: ReturnType<typeof setTimeout> | null = null;
let fileDelegationBound = false;

/** Bind delegated event listeners on the file list container (once) */
function ensureFileDelegation(container: HTMLElement): void {
  if (fileDelegationBound) return;
  fileDelegationBound = true;

  // Delegated mouseenter/mouseleave for file popovers (use capture for mouseenter)
  container.addEventListener(
    'mouseenter',
    (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest('.file-item[data-type="file"]') as HTMLElement | null;
      if (!item) return;
      if (target.closest('.file-print-btn')) return;
      const fn = item.dataset.filename;
      if (!fn) return;
      const file = _fileMap.get(fn);
      if (!file) return;

      if (closePopoverTimeout) {
        clearTimeout(closePopoverTimeout);
        closePopoverTimeout = null;
      }
      if (popoverTimeout) {
        clearTimeout(popoverTimeout);
        popoverTimeout = null;
      }
      if (filePopover) {
        showFilePopover(file, item);
      } else {
        popoverTimeout = setTimeout(() => showFilePopover(file, item), 300);
      }
    },
    true,
  );

  container.addEventListener(
    'mouseleave',
    (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest('.file-item[data-type="file"]') as HTMLElement | null;
      if (!item) return;
      if (popoverTimeout) {
        clearTimeout(popoverTimeout);
        popoverTimeout = null;
      }
      closePopoverTimeout = setTimeout(() => {
        if (filePopover && !filePopover.matches(':hover')) closeFilePopover();
      }, 150);
    },
    true,
  );

  // Delegated click for folders, breadcrumbs, and print buttons
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Print button
    const printBtn = target.closest('.file-print-btn') as HTMLElement | null;
    if (printBtn) {
      e.stopPropagation();
      const item = printBtn.closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && _lastState && _popoverClient) {
        const fullPath =
          currentDir === '/' ? filename : currentDir.replace(/^\//, '') + '/' + filename;
        requestPrintDialog(filename, fullPath, _popoverClient, _lastState);
      }
      return;
    }

    // Folder click
    const folder = target.closest('.file-item-folder') as HTMLElement | null;
    if (folder) {
      const dirname = folder.dataset.filename;
      if (!dirname || !_popoverClient) return;
      currentDir = currentDir === '/' ? '/' + dirname : currentDir + '/' + dirname;
      thumbnailQueue = [];
      thumbnailFetching = null;
      container.innerHTML = '<div class="loading">Loading...</div>';
      _popoverClient.sendCommand(1044, {
        storage_media: currentSource,
        dir: currentDir,
        offset: 0,
        limit: 200,
      });
      return;
    }

    // Breadcrumb nav
    const navBtn = target.closest('.file-nav-btn') as HTMLElement | null;
    if (navBtn) {
      const dir = navBtn.dataset.dir;
      if (dir == null || !_popoverClient) return;
      currentDir = dir;
      thumbnailQueue = [];
      thumbnailFetching = null;
      container.innerHTML = '<div class="loading">Loading...</div>';
      _popoverClient.sendCommand(1044, {
        storage_media: currentSource,
        dir: currentDir,
        offset: 0,
        limit: 200,
      });
    }
  });
}

function _bindFilePopovers(_container: HTMLElement): void {
  // No-op: popovers now handled by delegation in ensureFileDelegation
}

function renderBreadcrumb(_client: CommandSender): string {
  if (currentDir === '/') return '';
  const parts = currentDir.split('/').filter(Boolean);
  let html = '<div class="file-breadcrumb">';
  html += `<button class="btn btn-sm btn-ghost file-nav-btn" data-dir="/">🏠 Root</button>`;
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path += '/' + parts[i];
    const isLast = i === parts.length - 1;
    html += `<span class="breadcrumb-sep">/</span>`;
    if (isLast) {
      html += `<span class="breadcrumb-current">${escapeHtml(parts[i])}</span>`;
    } else {
      html += `<button class="btn btn-sm btn-ghost file-nav-btn" data-dir="${escapeAttr(path)}">${escapeHtml(parts[i])}</button>`;
    }
  }
  html += '</div>';
  return html;
}

function renderCapacityBar(state: PrinterState): string {
  const cap = state.storageCapacity;
  if (!cap || cap.total === 0) return '';
  const usedPct = Math.min(100, Math.round((cap.used / cap.total) * 100));
  const warn = usedPct > 90 ? ' capacity-warn' : usedPct > 75 ? ' capacity-high' : '';
  return `<div class="storage-capacity">
    <div class="capacity-bar"><div class="capacity-fill${warn}" style="width:${usedPct}%"></div></div>
    <span class="capacity-text">${formatBytes(cap.used)} / ${formatBytes(cap.total)} (${usedPct}%)</span>
  </div>`;
}

// Thumbnail popup state
let thumbnailPopup: HTMLElement | null = null;

function showThumbnailPopup(base64: string, anchor: HTMLElement): void {
  closeThumbnailPopup();
  const popup = document.createElement('div');
  popup.className = 'file-thumbnail-popup';
  const img = document.createElement('img');
  img.src = `data:image/png;base64,${base64}`;
  img.alt = 'Thumbnail';
  img.className = THUMBNAIL_CLASS;
  popup.appendChild(img);
  applyDarkThumbnailCheck(img, popup);
  document.body.appendChild(popup);

  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${Math.max(8, rect.top - 180)}px`;
  thumbnailPopup = popup;
}

function closeThumbnailPopup(): void {
  if (thumbnailPopup) {
    thumbnailPopup.remove();
    thumbnailPopup = null;
  }
}

// Close thumbnail popup on click outside
document.addEventListener('click', (e) => {
  if (
    thumbnailPopup &&
    !(e.target as HTMLElement).closest('.file-thumbnail-btn') &&
    !(e.target as HTMLElement).closest('.file-thumbnail-popup')
  ) {
    closeThumbnailPopup();
  }
});

let pendingThumbnailFile: string | null = null;
let pendingThumbnailAnchor: HTMLElement | null = null;

export function handleThumbnailResponse(thumbnail: string | null): void {
  if (thumbnail && pendingThumbnailFile && pendingThumbnailAnchor) {
    showThumbnailPopup(thumbnail, pendingThumbnailAnchor);
    pendingThumbnailFile = null;
    pendingThumbnailAnchor = null;
  }
}

/**
 * Sort and filter controls (ELEG-49). Created lazily on the first render because the
 * card may be hidden at startup, and once only — the bar lives in `#file-list-controls`,
 * a static sibling of `#file-list`, so nothing here is touched when the list repaints.
 */
let fileControls: ListControls<FileEntry> | null = null;

function ensureFileControls(): ListControls<FileEntry> {
  if (fileControls) return fileControls;
  fileControls = createListControls<FileEntry>({
    id: 'files',
    container: $('file-list-controls'),
    noun: 'files',
    filterPlaceholder: 'Filter files…',
    filterText: (file) => file.filename,
    // Folders first is a *grouping*, not a sort key: it holds whichever column is
    // active and in both directions, which is why it is not just another comparator.
    group: (file) => (file.type === 'folder' ? 0 : 1),
    columns: [
      { key: 'name', label: 'Name', value: (f) => f.filename },
      { key: 'size', label: 'Size', value: (f) => f.size, initialDirection: 'desc' },
      { key: 'time', label: 'Print time', value: (f) => f.print_time, initialDirection: 'desc' },
      { key: 'layers', label: 'Layers', value: (f) => f.layer, initialDirection: 'desc' },
      { key: 'created', label: 'Added', value: (f) => f.create_time, initialDirection: 'desc' },
    ],
    defaultSort: { key: 'name', dir: 'asc' },
    onChange: () => {
      if (_lastState && _popoverClient) renderFiles(_lastState, _popoverClient);
    },
  });
  return fileControls;
}

export function renderFiles(state: PrinterState, client: CommandSender): void {
  _lastState = state;
  _popoverClient = client;
  const container = $('file-list');
  const files = state.files;
  const controls = ensureFileControls();

  let html = renderCapacityBar(state);

  // Show USB not-connected warning
  if (currentSource === 'u-disk' && !state.status?.external_device?.u_disk) {
    html += '<div class="file-empty">⚠️ No USB drive detected</div>';
  }

  html += renderBreadcrumb(client);

  // Sorted client-side over the whole listing: 1044 returns the directory in one
  // response and offers no ordering, so there is no server-side sort to ask for.
  const sorted = controls.apply(files);

  if (!sorted.length) {
    html += controls.emptyHtml(
      `No files ${currentDir === '/' ? '' : 'in this folder '}on ${currentSource === 'u-disk' ? 'USB drive' : 'printer'}`,
    );
    container.innerHTML = html;
    ensureFileDelegation(container);
    return;
  }

  for (const file of sorted) {
    const isFolder = file.type === 'folder';
    const sizeMB = isFolder ? '' : (file.size / (1024 * 1024)).toFixed(1);
    const timeInfo = file.print_time ? formatTime(file.print_time) : '';
    const layerInfo = file.layer ? `${file.layer} layers` : '';
    const filamentInfo = file.total_filament_used
      ? `${file.total_filament_used.toFixed(1)}g filament`
      : '';
    const meta = isFolder
      ? 'Folder'
      : [sizeMB + ' MB', timeInfo, layerInfo, filamentInfo].filter(Boolean).join(' · ');

    const fullPath =
      currentDir === '/' ? file.filename : currentDir.replace(/^\//, '') + '/' + file.filename;
    const isCached = cachedFiles.has(fullPath);
    const cachedThumb = thumbnailCache.get(fullPath);
    const cacheMarker = isCached
      ? ' <span class="file-cache-marker" title="Cached on server">⚡</span>'
      : '';

    let iconHtml: string;
    if (isFolder) {
      iconHtml = '📁';
    } else if (cachedThumb) {
      iconHtml = `<img src="data:image/png;base64,${cachedThumb}" alt="Thumb" class="file-inline-thumb ${THUMBNAIL_CLASS}">`;
    } else if (file.filename.toLowerCase().endsWith('.gcode')) {
      // A gcode file whose thumbnail is queued, absent or unusable. Same placeholder
      // the error handler swaps in, so "no thumbnail" and "bad thumbnail" look alike
      // and deliberate rather than one being a mismatched emoji in a grid of previews
      // (ELEG-42). Replaced in place by handleInlineThumbnail when one arrives.
      iconHtml = `<img src="${THUMBNAIL_PLACEHOLDER_SRC}" alt="No preview" class="file-inline-thumb thumb-img-fallback">`;
    } else {
      iconHtml = '📄';
    }

    html += `
      <div class="file-item ${isFolder ? 'file-item-folder' : ''}" data-filename="${escapeAttr(file.filename)}" data-type="${isFolder ? 'folder' : 'file'}">
        <div class="file-name-row">
          <span class="file-name" title="${escapeAttr(file.filename)}">${escapeHtml(file.filename)}</span>${cacheMarker}
        </div>
        <div class="file-item-body">
          <div class="file-icon">${iconHtml}</div>
          <div class="file-details">
            <div class="file-size">${meta}</div>
          </div>
          <div class="file-actions">
            ${isFolder ? '' : `<button class="btn btn-sm btn-primary file-print-btn" title="Print">▶</button>`}
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = html;
  ensureFileDelegation(container);

  // Build file map for popover lookups
  _fileMap = new Map(sorted.filter((f) => f.type !== 'folder').map((f) => [f.filename, f]));

  // Close any stale popover from previous render
  closeFilePopover();

  // Fetch cached status and inline thumbnails asynchronously
  void fetchCachedStatus(sorted, client);
  fetchInlineThumbnails(sorted, client);
}

let fileControlsBound = false;

export function bindFileControls(client: CommandSender): void {
  if (fileControlsBound) return;
  fileControlsBound = true;

  document.querySelectorAll('.file-source-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const source = (tab as HTMLElement).dataset.source as 'local' | 'u-disk';
      currentSource = source;
      currentDir = '/';
      thumbnailQueue = [];
      thumbnailFetching = null;
      document.querySelectorAll('.file-source-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $('file-list').innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: source, dir: '/', offset: 0, limit: 200 });
      client.sendCommand(1048, { storage_media: source });
    });
  });

  // Upload handler
  const uploadInput = document.getElementById('file-upload-input') as HTMLInputElement | null;
  if (uploadInput) {
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      uploadInput.value = ''; // reset so same file can be re-selected
      uploadFile(file, client);
    });
  }
}

const ALLOWED_EXTENSIONS = ['.gcode', '.3mf'];
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

async function uploadFile(file: File, client: CommandSender): Promise<void> {
  const progressEl = document.getElementById('upload-progress');
  const fillEl = document.getElementById('upload-progress-fill');
  const textEl = document.getElementById('upload-progress-text');
  const labelEl = document.getElementById('file-upload-label');
  if (!progressEl || !fillEl || !textEl) return;

  // Client-side validation
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    progressEl.classList.remove('hidden');
    progressEl.classList.add('upload-error');
    fillEl.style.width = '0%';
    textEl.textContent = `✗ Invalid file type "${ext}" — only .gcode and .3mf allowed`;
    return;
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    progressEl.classList.remove('hidden');
    progressEl.classList.add('upload-error');
    fillEl.style.width = '0%';
    textEl.textContent = `✗ File too large (${(file.size / 1024 / 1024).toFixed(0)} MB) — max 500 MB`;
    return;
  }

  progressEl.classList.remove('hidden');
  fillEl.style.width = '0%';
  textEl.textContent = `Uploading ${file.name}...`;
  if (labelEl) labelEl.classList.add('disabled');

  const formData = new FormData();
  formData.append('file', file);

  const source = currentSource === 'u-disk' ? 'u-disk' : 'local';

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload?source=${encodeURIComponent(source)}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        fillEl.style.width = pct + '%';
        textEl.textContent = `Uploading ${file.name}... ${pct}% (${formatBytes(e.loaded)} / ${formatBytes(e.total)})`;
      }
    });

    await new Promise<void>((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          let msg = `Upload failed (HTTP ${xhr.status})`;
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {
            /* ignore */
          }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });

    fillEl.style.width = '100%';
    textEl.textContent = `✓ ${file.name} uploaded`;
    // Refresh file list
    client.sendCommand(1044, {
      storage_media: currentSource,
      dir: currentDir,
      offset: 0,
      limit: 200,
    });
    client.sendCommand(1048, { storage_media: currentSource });
  } catch (err) {
    textEl.textContent = `✗ ${(err as Error).message}`;
    fillEl.style.width = '0%';
    progressEl.classList.add('upload-error');
  } finally {
    if (labelEl) labelEl.classList.remove('disabled');
    // Auto-hide progress after 4 seconds on success
    setTimeout(() => {
      if (!progressEl.classList.contains('upload-error')) {
        progressEl.classList.add('hidden');
      }
    }, 4000);
  }
}
