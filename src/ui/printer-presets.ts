/**
 * Settings → Printer connections (ELEG-95).
 *
 * Lists the saved printer addresses and lets the operator add, remove and switch the one
 * active printer through `/api/printers`. Built with DOM APIs rather than an HTML string:
 * a preset's name arrives from an unauthenticated API, so it is only ever `textContent`.
 *
 * The add form lives in a static sibling of the list, never inside it (AGENTS.md): the
 * list is rebuilt on every refresh, and a half-typed address must survive that.
 *
 * A successful switch needs no handling here — the service broadcasts `printer_switched`
 * and `ws-client.ts` reloads the page, which is what clears every chart and log.
 */

import { CONNECTION_PRESETS_API_ENV } from '../types';

interface PresetView {
  id: string;
  name: string;
  ip: string;
  sn: string | null;
  hasPassword: boolean;
  isDefault: boolean;
  active: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error page; `ok` still says what happened.
  }
  return { ok: res.ok, data };
}

export function mountPrinterPresets(root: HTMLElement): void {
  const list = el('div', 'settings-card-list');
  list.id = 'printer-presets-list';
  const controls = el('div');
  controls.id = 'printer-presets-controls';
  const status = el('div', 'settings-hint');
  status.setAttribute('role', 'status');
  root.replaceChildren(list, controls, status);

  let writable = false;
  const setStatus = (msg: string) => {
    status.textContent = msg;
  };
  const errorOf = (data: Record<string, unknown>, fallback: string) =>
    typeof data.error === 'string' ? data.error : fallback;

  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.maxLength = 64;
  nameInput.placeholder = 'Name';
  nameInput.setAttribute('aria-label', 'Printer name');
  const ipInput = el('input');
  ipInput.type = 'text';
  ipInput.inputMode = 'decimal';
  ipInput.placeholder = 'IPv4 address';
  ipInput.setAttribute('aria-label', 'Printer IPv4 address');
  const passwordInput = el('input');
  passwordInput.type = 'password';
  passwordInput.autocomplete = 'new-password';
  passwordInput.placeholder = 'Access code (optional)';
  passwordInput.setAttribute('aria-label', 'Printer access code');
  const addButton = el('button', 'btn btn-sm btn-ghost', 'Add printer');
  addButton.type = 'button';
  const formRow = el('div', 'settings-row');
  formRow.append(nameInput, ipInput, passwordInput, addButton);
  const lockedHint = el(
    'p',
    'settings-hint',
    `Adding, removing and switching printers here is turned off. Set ${CONNECTION_PRESETS_API_ENV}=true in the service environment and restart to turn it on — the API has no authentication, so anyone who can reach this page could then re-point the service.`,
  );
  controls.append(formRow, lockedHint);

  function renderList(presets: PresetView[]): void {
    list.replaceChildren(
      ...presets.map((p) => {
        const row = el('div', 'settings-card-row');
        const label = el('span', 'settings-card-label');
        const details = [p.ip, p.sn ? `SN ${p.sn}` : '', p.active ? 'active' : '']
          .filter(Boolean)
          .join(' · ');
        label.append(el('strong', '', p.name), document.createTextNode(` — ${details}`));
        row.append(label);

        if (!p.active) {
          const switchButton = el('button', 'btn btn-sm btn-ghost', 'Switch');
          switchButton.type = 'button';
          switchButton.disabled = !writable;
          switchButton.addEventListener('click', () => void activate(p));
          row.append(switchButton);
        }
        if (!p.isDefault && !p.active) {
          const removeButton = el('button', 'btn btn-sm btn-ghost', 'Remove');
          removeButton.type = 'button';
          removeButton.disabled = !writable;
          removeButton.addEventListener('click', () => void remove(p));
          row.append(removeButton);
        }
        return row;
      }),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const { ok, data } = await request('GET', '/api/printers');
      if (!ok || !Array.isArray(data.presets)) {
        setStatus(errorOf(data, 'Could not load printer presets.'));
        return;
      }
      writable = data.writable === true;
      for (const control of [nameInput, ipInput, passwordInput, addButton]) {
        control.disabled = !writable;
      }
      lockedHint.hidden = writable;
      renderList(data.presets as PresetView[]);
    } catch {
      setStatus('Could not load printer presets.');
    }
  }

  async function activate(p: PresetView): Promise<void> {
    const confirmed = window.confirm(
      `Switch the service to ${p.name} (${p.ip})?\n\nIt disconnects from the current printer and clears its charts, layer times and event log. Telegram, the AI monitor and Moonraker/OctoPrint clients all follow.`,
    );
    if (!confirmed) return;
    setStatus(`Switching to ${p.name}…`);
    const { ok, data } = await request(
      'POST',
      `/api/printers/${encodeURIComponent(p.id)}/activate`,
    );
    // On success the page reloads when the service announces the switch.
    setStatus(ok ? `Switched to ${p.name}.` : errorOf(data, 'Switch failed.'));
    if (!ok) void refresh();
  }

  async function remove(p: PresetView): Promise<void> {
    if (!window.confirm(`Remove the saved printer ${p.name} (${p.ip})?`)) return;
    const { ok, data } = await request('DELETE', `/api/printers/${encodeURIComponent(p.id)}`);
    setStatus(ok ? `Removed ${p.name}.` : errorOf(data, 'Remove failed.'));
    void refresh();
  }

  addButton.addEventListener('click', async () => {
    const { ok, data } = await request('POST', '/api/printers', {
      name: nameInput.value,
      ip: ipInput.value.trim(),
      password: passwordInput.value,
    });
    if (ok) {
      setStatus(`Saved ${nameInput.value.trim()}.`);
      nameInput.value = '';
      ipInput.value = '';
      passwordInput.value = '';
    } else {
      setStatus(errorOf(data, 'Could not save the printer.'));
    }
    void refresh();
  });

  void refresh();
}
