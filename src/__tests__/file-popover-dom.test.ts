// @vitest-environment jsdom
/**
 * ELEG-191 — the file row's ⋯ button (from PR #181), through the real `renderFiles` and its
 * delegated listeners on the real index.html markup.
 *
 * The ⋯ button exists for screens without hover. A tap there also fires emulated mouse
 * events, so the row's hover handler may already have opened the popover when the click
 * arrives. The ⋯ click therefore *pins* the popover rather than toggling it shut, and a
 * pinned popover ignores hover: mouseleave does not close it and another row's hover does
 * not replace it. A second ⋯ tap, the ×, or a tap outside closes it.
 *
 * `files.ts` binds its delegation once per module, so each case re-imports it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrinterState } from '../printer-state';
import type { FileEntry } from '../types';
import type { CommandSender } from '../ws-client';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));

const file = (filename: string): FileEntry =>
  ({ filename, type: 'file', size: 2048, print_time: 600, layer: 10 }) as unknown as FileEntry;

const state = {
  files: [file('alpha.gcode'), file('beta.gcode')],
  storageCapacity: null,
  status: {},
  colorMap: [],
  lastFileDetail: null,
  thumbnailRequestQueue: [],
} as unknown as PrinterState;

const client = { sendCommand: vi.fn() } as unknown as CommandSender;

const row = (name: string) =>
  document.querySelector<HTMLElement>(`.file-item[data-filename="${name}"]`)!;
const infoBtn = (name: string) => row(name).querySelector<HTMLElement>('.file-info-btn')!;
const popovers = () => [...document.querySelectorAll<HTMLElement>('.file-popover')];
const hover = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mouseenter'));
const leave = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mouseleave'));

beforeEach(async () => {
  vi.useFakeTimers();
  document.body.outerHTML = `${body}</body>`;
  vi.resetModules();
  const { renderFiles } = await import('../ui/files');
  renderFiles(state, client);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('file row ⋯ button (ELEG-191)', () => {
  it('renders a ⋯ button on file rows', () => {
    expect(infoBtn('alpha.gcode').getAttribute('aria-label')).toBe('Details and actions');
  });

  it('hover still opens an unpinned popover after its delay, and leaving closes it', () => {
    hover(row('alpha.gcode'));
    vi.advanceTimersByTime(300);
    expect(popovers()).toHaveLength(1);
    expect(popovers()[0].dataset.pinned).toBeUndefined();
    leave(row('alpha.gcode'));
    vi.advanceTimersByTime(200);
    expect(popovers()).toHaveLength(0);
  });

  it('⋯ on a hover-opened popover pins it instead of closing it; a second ⋯ closes it', () => {
    hover(row('alpha.gcode'));
    vi.advanceTimersByTime(300);
    expect(popovers()).toHaveLength(1);

    infoBtn('alpha.gcode').click();
    expect(popovers()).toHaveLength(1);
    expect(popovers()[0].dataset.pinned).toBe('true');
    expect(popovers()[0].dataset.filename).toBe('alpha.gcode');

    infoBtn('alpha.gcode').click();
    expect(popovers()).toHaveLength(0);
  });

  it('⋯ cancels a pending hover open, so a tap does not end in a second popover', () => {
    hover(row('alpha.gcode'));
    infoBtn('alpha.gcode').click();
    vi.advanceTimersByTime(1000);
    expect(popovers()).toHaveLength(1);
    expect(popovers()[0].dataset.pinned).toBe('true');
  });

  it('a pinned popover survives mouseleave and another row’s hover', () => {
    infoBtn('alpha.gcode').click();
    leave(row('alpha.gcode'));
    leave(popovers()[0]);
    vi.advanceTimersByTime(500);
    expect(popovers()).toHaveLength(1);

    hover(row('beta.gcode'));
    vi.advanceTimersByTime(500);
    expect(popovers()).toHaveLength(1);
    expect(popovers()[0].dataset.filename).toBe('alpha.gcode');
  });

  it('a tap outside closes it, and so does its ×', () => {
    infoBtn('alpha.gcode').click();
    document.getElementById('app-header')!.click();
    expect(popovers()).toHaveLength(0);

    infoBtn('beta.gcode').click();
    popovers()[0].querySelector<HTMLElement>('.file-popover-close')!.click();
    expect(popovers()).toHaveLength(0);
  });

  it('positions through the two custom properties, not inline left/top', () => {
    infoBtn('alpha.gcode').click();
    const el = popovers()[0];
    expect(el.style.getPropertyValue('--popover-left')).toMatch(/^\d+px$/);
    expect(el.style.getPropertyValue('--popover-top')).toMatch(/^\d+px$/);
    expect(el.style.left).toBe('');
    expect(el.style.top).toBe('');
  });
});
