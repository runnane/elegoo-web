import path from 'path';
import { defineConfig, loadEnv } from 'vite';

/**
 * Extra hostnames the vite dev server will answer to, read from the environment
 * so that no deployment hostname or LAN address is committed to this public repo
 * (ELEG-82). Comma-separated, e.g.
 *
 *   VITE_ALLOWED_HOSTS=printer.example.internal,10.0.0.5
 *
 * Dev-server only: `server.*` has no effect on `vite build` or on production,
 * which serves from /opt/elegooweb under systemd and never runs vite.
 */
export function allowedHostsFrom(raw: string | undefined): string[] {
  const extra = (raw ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return [...new Set(['localhost', ...extra])];
}

export default defineConfig(({ mode }) => {
  // envDir is import.meta.dirname rather than process.cwd() so the value is the same
  // whichever directory vite was invoked from. Not `__dirname`: that is undefined
  // under `configLoader: 'native'`, which vite plans to make the default, and both
  // uses in this file have to change together — the warning only names the first
  // (ELEG-87).
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');

  return {
    resolve: {
      alias: {
        // Ensure only one copy of three.js is loaded (gcode-preview peer dep)
        three: path.resolve(import.meta.dirname, 'node_modules/three'),
      },
      dedupe: ['three'],
    },
    server: {
      allowedHosts: allowedHostsFrom(env.VITE_ALLOWED_HOSTS),
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/ws': {
          target: 'ws://localhost:8088',
          ws: true,
        },
        '/api': {
          target: 'http://localhost:8088',
        },
        '/mcp': {
          target: 'http://localhost:8088',
        },
        '/octoprint': {
          target: 'http://localhost:8088',
        },
        '/moonraker': {
          target: 'http://localhost:8088',
        },
        '/webcam': {
          target: 'http://localhost:8088',
        },
      },
    },
  };
});
