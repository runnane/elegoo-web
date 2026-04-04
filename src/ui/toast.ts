/** Simple toast notification system */

const TOAST_DURATION = 4000;
const MAX_TOASTS = 5;

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  timer: ReturnType<typeof setTimeout>;
}

let nextId = 0;
const toasts: Toast[] = [];
let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

function render(): void {
  const el = ensureContainer();
  el.innerHTML = toasts.map(t =>
    `<div class="toast toast-${t.level}" data-id="${t.id}">` +
    `<span class="toast-icon">${iconFor(t.level)}</span>` +
    `<span class="toast-msg">${escapeHtml(t.message)}</span>` +
    `<button class="toast-close">✕</button>` +
    `</div>`
  ).join('');

  el.querySelectorAll('.toast-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt((btn.parentElement as HTMLElement).dataset.id ?? '0');
      dismiss(id);
    });
  });
}

function iconFor(level: ToastLevel): string {
  switch (level) {
    case 'success': return '✅';
    case 'warning': return '⚠️';
    case 'error': return '❌';
    default: return 'ℹ️';
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function dismiss(id: number): void {
  const idx = toasts.findIndex(t => t.id === id);
  if (idx >= 0) {
    clearTimeout(toasts[idx].timer);
    toasts.splice(idx, 1);
    render();
  }
}

export function toast(message: string, level: ToastLevel = 'info'): void {
  const id = nextId++;
  const timer = setTimeout(() => dismiss(id), TOAST_DURATION);

  toasts.push({ id, message, level, timer });

  // Cap visible toasts
  while (toasts.length > MAX_TOASTS) {
    const old = toasts.shift()!;
    clearTimeout(old.timer);
  }

  render();
}
