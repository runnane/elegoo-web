/**
 * MCP.md ↔ mcp-server.ts drift test (ELEG-7).
 *
 * `MCP.md` is the contract an agent reads to decide what to call, and nothing used to
 * check it against the code. A renamed tool or a dropped resource is drift no gate
 * catches and no reviewer is likely to spot.
 *
 * This asserts against the **real registered surface** rather than a hand-maintained
 * list: it stands the server up over an in-memory transport and asks it, exactly as a
 * client would. A second list in the repo would be a third thing to keep in sync.
 *
 * No printer, no network, no MQTT connection — `createMcpServer` only stores the
 * references it is given and registers closures; listing never invokes a handler. The
 * stubs below are deliberately empty for that reason.
 *
 * This file lives under `src/server/` on purpose: `tsconfig.json` excludes that
 * directory, so a test importing server code from `src/__tests__/` would drag Node-only
 * modules into the browser typecheck. Here it is covered by `pnpm service:check`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { StateStore } from '../state-store.js';
import { createMcpServer } from '../mcp-server.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

/** Registration never touches these; see the file header. */
const stubStore = {} as unknown as StateStore;
const stubBridge = {} as unknown as MqttBridge;

/**
 * Names in the first column of a markdown table, within `slice`.
 *
 * Skips the header and the `|---|` separator by requiring the cell to be a single
 * backticked token — which every real row is and neither delimiter row is.
 */
function firstColumnNames(slice: string, pattern: RegExp): string[] {
  const names: string[] = [];
  for (const line of slice.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1]?.trim() ?? '';
    const m = cell.match(pattern);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Text between a `## heading` and the next `## ` heading (or end of file). */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`MCP.md has no "## ${heading}" section`);
  const after = start + 1;
  const next = md.indexOf('\n## ', after);
  return md.slice(after, next === -1 ? undefined : next);
}

let registeredTools: string[];
let registeredResources: string[];

beforeAll(async () => {
  const server = createMcpServer(stubStore, stubBridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'doc-parity-test', version: '1.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  registeredTools = (await client.listTools()).tools.map((t) => t.name).sort();
  registeredResources = (await client.listResources()).resources.map((r) => r.uri).sort();

  await client.close();
});

describe('MCP.md documents exactly the registered tools', () => {
  it('matches in both directions', () => {
    const documented = firstColumnNames(section(read('MCP.md'), 'Tools'), /^`([a-z_]+)`$/).sort();

    // Set equality, but asserted as two directed differences so a failure names the
    // drifted tool instead of printing two 31-element arrays side by side.
    const undocumented = registeredTools.filter((t) => !documented.includes(t));
    const phantom = documented.filter((t) => !registeredTools.includes(t));

    expect({ undocumented, phantom }).toEqual({ undocumented: [], phantom: [] });
    expect(documented).toEqual(registeredTools);
  });

  it('lists each tool exactly once', () => {
    const documented = firstColumnNames(section(read('MCP.md'), 'Tools'), /^`([a-z_]+)`$/);
    const dupes = documented.filter((t, i) => documented.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('MCP.md documents exactly the registered resources', () => {
  it('matches in both directions', () => {
    const documented = firstColumnNames(
      section(read('MCP.md'), 'Resources'),
      /^`(printer:\/\/[a-z]+)`$/,
    ).sort();

    const undocumented = registeredResources.filter((r) => !documented.includes(r));
    const phantom = documented.filter((r) => !registeredResources.includes(r));

    expect({ undocumented, phantom }).toEqual({ undocumented: [], phantom: [] });
    expect(documented).toEqual(registeredResources);
  });
});

describe('the counts quoted in prose are the real ones', () => {
  // These are what a reader trusts before reading any table, and they are the first
  // thing to rot: they live in files nobody edits when adding a tool.
  const quoted = [
    { file: 'README.md', label: 'README.md' },
    { file: '.agents/mcp.md', label: '.agents/mcp.md' },
  ];

  for (const { file, label } of quoted) {
    it(`${label} quotes the real resource and tool counts`, () => {
      const text = read(file);

      const resourceCount = text.match(/\*{0,2}(\d+)\*{0,2} resources/)?.[1];
      const toolCount = text.match(/\*{0,2}(\d+)\*{0,2}\s*\n?\s*tools/)?.[1];

      expect(
        resourceCount,
        `${label} does not state a resource count — the assertion below would pass vacuously`,
      ).toBeDefined();
      expect(
        toolCount,
        `${label} does not state a tool count — the assertion below would pass vacuously`,
      ).toBeDefined();

      expect(Number(resourceCount)).toBe(registeredResources.length);
      expect(Number(toolCount)).toBe(registeredTools.length);
    });
  }
});
