import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import { $, escapeHtml, escapeAttr, formatTime, applyDarkThumbnailCheck } from './helpers';

let currentSource: 'local' | 'u-disk' = 'local';
let currentDir = '/';

export function currentFileSource(): string { return currentSource; }
export function currentFileDir(): string { return currentDir; }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function renderBreadcrumb(client: CommandSender): string {
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
  if (thumbnailPopup && !(e.target as HTMLElement).closest('.file-thumbnail-btn') && !(e.target as HTMLElement).closest('.file-thumbnail-popup')) {
    closeThumbnailPopup();
  }
});

let pendingThumbnailFile: string | null = null;
let pendingThumbnailAnchor: HTMLElement | null = null;

export function handleThumbnailResponse(state: PrinterState): void {
  if (state.thumbnail && pendingThumbnailFile && pendingThumbnailAnchor) {
    showThumbnailPopup(state.thumbnail, pendingThumbnailAnchor);
    pendingThumbnailFile = null;
    pendingThumbnailAnchor = null;
  }
}

export function renderFiles(state: PrinterState, client: CommandSender): void {
  const container = $('file-list');
  const files = state.files;

  let html = renderCapacityBar(state);

  // Show USB not-connected warning
  if (currentSource === 'u-disk' && !state.status?.external_device?.u_disk) {
    html += '<div class="file-empty">⚠️ No USB drive detected</div>';
  }

  html += renderBreadcrumb(client);

  if (!files.length) {
    html += `<div class="file-empty">No files ${currentDir === '/' ? '' : 'in this folder '}on ${currentSource === 'u-disk' ? 'USB drive' : 'printer'}</div>`;
    container.innerHTML = html;
    bindBreadcrumbNav(container, client);
    return;
  }

  // Sort: folders first, then by name
  const sorted = [...files].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.filename.localeCompare(b.filename);
  });

  for (const file of sorted) {
    const isFolder = file.type === 'folder';
    const sizeMB = isFolder ? '' : (file.size / (1024 * 1024)).toFixed(1);
    const timeInfo = file.print_time ? formatTime(file.print_time) : '';
    const layerInfo = file.layer ? `${file.layer} layers` : '';
    const filamentInfo = file.total_filament_used ? `${file.total_filament_used.toFixed(1)}g filament` : '';
    const meta = isFolder ? 'Folder' : [sizeMB + ' MB', timeInfo, layerInfo, filamentInfo].filter(Boolean).join(' · ');

    html += `
      <div class="file-item ${isFolder ? 'file-item-folder' : ''}" data-filename="${escapeAttr(file.filename)}" data-type="${isFolder ? 'folder' : 'file'}">
        <div class="file-icon">${isFolder ? '📁' : '📄'}</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.filename)}</div>
          <div class="file-size">${meta}</div>
        </div>
        <div class="file-actions">
          ${isFolder ? '' : `<button class="btn btn-sm btn-ghost file-thumbnail-btn" title="Preview">🖼️</button>`}
          ${isFolder ? '' : `<button class="btn btn-sm btn-ghost file-download-btn" title="Download">📥</button>`}
          ${isFolder ? '' : `<button class="btn btn-sm btn-primary file-print-btn" title="Print">▶</button>`}
          ${isFolder ? '' : `<button class="btn btn-sm btn-ghost file-delete-btn" title="Delete">🗑️</button>`}
        </div>
      </div>`;
  }

  container.innerHTML = html;
  bindBreadcrumbNav(container, client);

  // Folder click → navigate
  container.querySelectorAll('.file-item-folder').forEach(item => {
    item.addEventListener('click', () => {
      const dirname = (item as HTMLElement).dataset.filename;
      if (!dirname) return;
      currentDir = currentDir === '/' ? '/' + dirname : currentDir + '/' + dirname;
      container.innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
    });
  });

  // Print button
  container.querySelectorAll('.file-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && confirm(`Start printing ${filename}?`)) {
        const fullPath = currentDir === '/' ? filename : currentDir.replace(/^\//, '') + '/' + filename;
        client.sendCommand(1020, {
          storage_media: currentSource,
          filename: fullPath,
          config: {
            delay_video: false,
            printer_check: true,
            print_layout: 'A',
            bedlevel_force: false,
            slot_map: [],
          },
        });
      }
    });
  });

  // Delete button
  container.querySelectorAll('.file-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && confirm(`Delete ${filename}?`)) {
        const fullPath = currentDir === '/' ? filename : currentDir.replace(/^\//, '') + '/' + filename;
        client.sendCommand(1047, { storage_media: currentSource, file_path: [fullPath] });
        // Refresh file list after delete
        setTimeout(() => {
          client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
          client.sendCommand(1048, { storage_media: currentSource });
        }, 500);
      }
    });
  });

  // Download button
  container.querySelectorAll('.file-download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (!filename) return;
      const fullPath = currentDir === '/' ? filename : currentDir.replace(/^\//, '') + '/' + filename;
      const source = currentSource === 'u-disk' ? 'u-disk' : 'local';
      // Trigger browser download via the server proxy
      const a = document.createElement('a');
      a.href = `/api/files/download?file=${encodeURIComponent(fullPath)}&source=${encodeURIComponent(source)}`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });

  // Thumbnail preview button
  container.querySelectorAll('.file-thumbnail-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (!filename) return;
      const fullPath = currentDir === '/' ? filename : currentDir.replace(/^\//, '') + '/' + filename;
      pendingThumbnailFile = fullPath;
      pendingThumbnailAnchor = btn as HTMLElement;
      // Method 1045 uses file_name (with underscore!)
      client.sendCommand(1045, { storage_media: currentSource, file_name: fullPath });
    });
  });
}

function bindBreadcrumbNav(container: HTMLElement, client: CommandSender): void {
  container.querySelectorAll('.file-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = (btn as HTMLElement).dataset.dir;
      if (dir == null) return;
      currentDir = dir;
      container.innerHTML = '<div class="loading">Loading...</div>';
      client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
    });
  });
}

let fileControlsBound = false;

export function bindFileControls(client: CommandSender): void {
  if (fileControlsBound) return;
  fileControlsBound = true;

  document.querySelectorAll('.file-source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const source = (tab as HTMLElement).dataset.source as 'local' | 'u-disk';
      currentSource = source;
      currentDir = '/';
      document.querySelectorAll('.file-source-tab').forEach(t => t.classList.remove('active'));
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

async function uploadFile(file: File, client: CommandSender): Promise<void> {
  const progressEl = document.getElementById('upload-progress');
  const fillEl = document.getElementById('upload-progress-fill');
  const textEl = document.getElementById('upload-progress-text');
  const labelEl = document.getElementById('file-upload-label');
  if (!progressEl || !fillEl || !textEl) return;

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
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });

    fillEl.style.width = '100%';
    textEl.textContent = `✓ ${file.name} uploaded`;
    // Refresh file list
    client.sendCommand(1044, { storage_media: currentSource, dir: currentDir, offset: 0, limit: 200 });
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
