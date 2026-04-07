export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Format a Date as HH:MM local time (e.g. "14:35") */
export function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fanPct(speed: number): number {
  return Math.round((speed / 255) * 100);
}

export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Analyze thumbnail brightness and toggle a CSS class for dark images */
export function applyDarkThumbnailCheck(img: HTMLImageElement, container: HTMLElement): void {
  const check = () => {
    const canvas = document.createElement('canvas');
    const size = 32;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      count++;
    }
    const avg = count > 0 ? total / count : 128;
    container.classList.toggle('thumbnail-dark', avg < 50);
  };
  if (img.complete && img.naturalWidth > 0) check();
  else img.addEventListener('load', check, { once: true });
}
