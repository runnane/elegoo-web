import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Ensure only one copy of three.js is loaded (gcode-preview peer dep)
      three: path.resolve(__dirname, 'node_modules/three'),
    },
    dedupe: ['three'],
  },
  server: {
    allowedHosts: [
      'localhost',
      'elegooweb.srv.jont.no',
      '172.20.100.9'
    ],
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
});
