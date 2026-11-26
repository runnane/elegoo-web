// @vitest-environment jsdom
/**
 * ELEG-182 — the Help tab's MQTT method table cannot drift from what the code sends.
 *
 * Each row is held to a line of *sending* code (not `log-methods.ts`, which is only a
 * display label): the regex must match in the named file and must contain the method
 * number, so a swapped number in either place fails here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderHelp } from '../ui/help';
import { MQTT_METHODS } from '../ui/mqtt-methods';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

interface Proof {
  method: number;
  name: string;
  /** file under src/ and a pattern tying the number to the action that sends it */
  file: string;
  pattern: RegExp;
}

const PROOFS: Proof[] = [
  {
    method: 1007,
    name: 'Emergency Stop',
    file: 'server/mcp-server.ts',
    pattern: /'emergency_stop'[\s\S]{0,300}sendCommand\(1007,/,
  },
  {
    method: 1021,
    name: 'Pause Print',
    file: 'server/mcp-server.ts',
    pattern: /'pause_print'[\s\S]{0,200}sendCommand\(1021,/,
  },
  {
    method: 1022,
    name: 'Stop Print',
    file: 'server/mcp-server.ts',
    pattern: /'stop_print'[\s\S]{0,200}sendCommand\(1022,/,
  },
  {
    method: 1023,
    name: 'Resume Print',
    file: 'server/mcp-server.ts',
    pattern: /'resume_print'[\s\S]{0,200}sendCommand\(1023,/,
  },
  {
    method: 1022,
    name: 'Stop Print',
    file: 'ui/controls.ts',
    pattern: /guardedSend\(client, 1022, \{\}, btnStop\)/,
  },
  {
    method: 1023,
    name: 'Resume Print',
    file: 'ui/controls.ts',
    pattern: /btnResume[\s\S]{0,80}guardedSend\(client, 1023,/,
  },
  {
    method: 1024,
    name: 'Load Filament',
    file: 'server/mcp-server.ts',
    pattern: /'load_filament', 1024/,
  },
  {
    method: 1025,
    name: 'Unload Filament',
    file: 'server/mcp-server.ts',
    pattern: /'unload_filament', 1025/,
  },
  {
    method: 1026,
    name: 'Home Axes',
    file: 'server/mcp-server.ts',
    pattern: /refuseWhilePrinting\('home', 1026/,
  },
  {
    method: 1026,
    name: 'Home Axes',
    file: 'ui/controls.ts',
    pattern: /guardedSend\(client, 1026, \{ homed_axes: 'xyz' \}/,
  },
  {
    method: 1027,
    name: 'Move Axis',
    file: 'server/mcp-server.ts',
    pattern: /refuseWhilePrinting\('move', 1027/,
  },
  {
    method: 1028,
    name: 'Set Temperature',
    file: 'server/mcp-server.ts',
    pattern: /refuseWhilePrinting\('set_temperature', 1028/,
  },
  {
    method: 1028,
    name: 'Set Temperature',
    file: 'ui/controls.ts',
    pattern: /guardedSend\(client, 1028, \{ extruder: val \}/,
  },
  {
    method: 1029,
    name: 'Set LED',
    file: 'server/mcp-server.ts',
    pattern: /sendCommand\(1029, \{ power:/,
  },
  {
    method: 1029,
    name: 'Set LED',
    file: 'ui/controls.ts',
    pattern: /guardedSend\(client, 1029, \{ power:/,
  },
  {
    method: 1030,
    name: 'Set Fan Speed',
    file: 'server/mcp-server.ts',
    pattern: /box_fan[\s\S]{0,120}sendCommand\(1030,/,
  },
  {
    method: 1030,
    name: 'Set Fan Speed',
    file: 'ui/controls.ts',
    pattern: /guardedSend\(client, 1030, \{ fan:/,
  },
  {
    method: 1031,
    name: 'Set Speed Mode',
    file: 'server/mcp-server.ts',
    pattern: /sendCommand\(1031, \{ mode:/,
  },
  { method: 1032, name: 'Auto Level', file: 'server/mcp-server.ts', pattern: /'auto_level', 1032/ },
  {
    method: 1033,
    name: 'Vibration Calibration',
    file: 'server/mcp-server.ts',
    pattern: /'vibration_calibrate', 1033/,
  },
  {
    method: 1034,
    name: 'PID Calibration',
    file: 'server/mcp-server.ts',
    pattern: /'pid_calibrate', 1034/,
  },
  { method: 1035, name: 'Self Check', file: 'server/mcp-server.ts', pattern: /'self_check', 1035/ },
  {
    method: 1045,
    name: 'Get Thumbnail',
    file: 'ui/files.ts',
    pattern: /sendCommand\(1045, \{ storage_media: currentSource, file_name:/,
  },
  {
    method: 1046,
    name: 'Get File Detail',
    file: 'server/state-store.ts',
    pattern: /sendCommand\(1046, \{ filename:/,
  },
  {
    method: 1047,
    name: 'Delete File',
    file: 'server/mcp-server.ts',
    pattern: /sendCommand\(1047, \{ storage_media/,
  },
  {
    method: 1048,
    name: 'Get Capacity',
    file: 'ui/files.ts',
    pattern: /sendCommand\(1048, \{ storage_media/,
  },
  {
    method: 1054,
    name: 'Live Stream',
    file: 'server/mqtt-bridge.ts',
    pattern: /sendCommand\(1054, \{ Enable: 1 \}/,
  },
  {
    method: 2004,
    name: 'Auto Refill',
    file: 'server/mcp-server.ts',
    pattern: /sendCommand\(2004, \{ auto_refill/,
  },
];

describe('Help tab MQTT method table', () => {
  it('has no duplicate method numbers', () => {
    const nums = MQTT_METHODS.map((m) => m.method);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('pins the six rows ELEG-182 found mislabelled', () => {
    const name = (n: number) => MQTT_METHODS.find((m) => m.method === n)?.name;
    expect(name(1022)).toBe('Stop Print');
    expect(name(1023)).toBe('Resume Print');
    expect(name(1026)).toBe('Home Axes');
    expect(name(1028)).toBe('Set Temperature');
    expect(name(1029)).toBe('Set LED');
    expect(name(1030)).toBe('Set Fan Speed');
  });

  describe('each row is held to the code that sends it', () => {
    for (const p of PROOFS) {
      it(`${p.method} ${p.name} (${p.file})`, () => {
        const row = MQTT_METHODS.find((m) => m.method === p.method);
        expect(row?.name, `Help row for ${p.method}`).toBe(p.name);
        expect(read(p.file), `${p.file} sends ${p.method} as ${p.name}`).toMatch(p.pattern);
      });
    }

    it('every sent method except the read-only/push ones has a proof', () => {
      const proven = new Set(PROOFS.map((p) => p.method));
      // 1001/1002/1044 are the connect-time reads (mqtt-bridge.ts), 1020 is start-print
      // (several senders), 2005 the canvas read and 6000 the push the printer sends.
      const unproven = MQTT_METHODS.map((m) => m.method).filter(
        (n) => !proven.has(n) && ![1001, 1002, 1020, 1044, 2005, 6000].includes(n),
      );
      expect(unproven).toEqual([]);
    });
  });

  describe('rendered markup', () => {
    let html = '';
    beforeAll(() => {
      document.body.innerHTML = '<div id="help-content"></div>';
      renderHelp();
      html = document.getElementById('help-content')?.innerHTML ?? '';
    });

    it('renders every row with its number and name', () => {
      for (const m of MQTT_METHODS) {
        expect(html, String(m.method)).toContain(`<tr><td>${m.method}</td><td>${m.name}</td>`);
      }
    });

    it('no longer carries the swapped labels', () => {
      expect(html).not.toContain('<td>1022</td><td>Resume Print</td>');
      expect(html).not.toContain('<td>1026</td><td>Set Temperature</td>');
      expect(html).not.toContain('<td>1030</td><td>Set LED</td>');
    });
  });
});
