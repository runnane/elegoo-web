/**
 * The native REST routes the Help tab documents (ELEG-172). Data, not markup, so
 * `src/__tests__/help-api-routes.test.ts` can compare it with the routes the server
 * actually serves — a new `/api/*` route without a row here fails `pnpm gates`.
 *
 * `auth` mirrors `isGatedApiWrite` in `src/server/rest-api.ts`: every method other than
 * GET is a write that needs `SERVICE_API_KEY` (when one is configured) except
 * `POST /api/client-error`. Reads, including the camera and downloads, stay open.
 */
export interface ApiRoute {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  description: string;
  /** Needs SERVICE_API_KEY when the service has one set. */
  auth: boolean;
}

const r = (
  method: ApiRoute['method'],
  path: string,
  description: string,
  auth = method !== 'GET',
): ApiRoute => ({ method, path, description, auth });

export const REST_ROUTES: readonly ApiRoute[] = [
  r(
    'GET',
    '/api/health',
    'Service health check (MQTT status, camera state with its reason, deployed build)',
  ),
  r('GET', '/api/status', 'Full printer state (attributes, status, canvas, files)'),
  r('GET', '/api/snapshot', 'JPEG camera snapshot'),
  r('GET', '/api/stream', 'MJPEG camera stream proxy'),
  r('GET', '/api/stream/overlay', 'MJPEG stream with status overlay'),
  r('GET', '/api/metrics', 'Structured metrics as JSON'),
  r('GET', '/api/metrics/prometheus', 'Prometheus text exposition format'),
  r('GET', '/api/files/download', 'Download file from printer (?file=&source=local|u-disk)'),
  r('GET', '/api/files/cached', 'Filenames that have cached gcode'),
  r('POST', '/api/files/precache', 'Cache a file’s gcode ({file, source?})'),
  r('POST', '/api/files/upload', 'Upload file to printer (multipart, ?source=local|u-disk)'),
  r('GET', '/api/timelapse/video', 'Stream a timelapse video from the printer (?url=)'),
  r('GET', '/api/config/telegram', 'Telegram bot config'),
  r('POST', '/api/config/telegram', 'Update Telegram progress interval'),
  r('GET', '/api/config/ai-labels', 'AI label configurations'),
  r('POST', '/api/config/ai-labels', 'Update AI label configs'),
  r('DELETE', '/api/config/ai-labels', 'Reset AI labels to defaults'),
  r('POST', '/api/debug/capture', 'Start MQTT capture ({duration: 10-60})'),
  r('GET', '/api/debug/captures', 'List MQTT capture files'),
  r('GET', '/api/debug/captures/:file', 'Download capture file'),
  r('POST', '/api/debug/videostream/sdcp', 'Debug: enable the video stream over SDCP'),
  r(
    'POST',
    '/api/debug/videostream/mqtt',
    'Debug: enable the video stream over MQTT (method 1054)',
  ),
  r('DELETE', '/api/layer-data', 'Clear layer duration history'),
  r('GET', '/api/reports', 'List print reports'),
  r('GET', '/api/reports/:id', 'One print report as JSON'),
  r('GET', '/api/reports/:id/pdf', 'Print report as PDF'),
  r('GET', '/api/reports/:id/snapshot/:filename', 'Print report snapshot JPEG'),
  r('DELETE', '/api/reports/:id', 'Delete a print report'),
  r(
    'POST',
    '/api/client-error',
    'Browser error log line (size-capped; open even with a key set)',
    false,
  ),
  r('GET', '/api/queue', 'The print queue'),
  r('POST', '/api/queue/items', 'Add a file to the end of the queue ({filename, source?})'),
  r('DELETE', '/api/queue/items/:id', 'Remove one queued job'),
  r('POST', '/api/queue/items/:id/move', 'Reorder a queued job ({index})'),
  r('POST', '/api/queue/clear', 'Empty the waiting list'),
  r('POST', '/api/queue/resume', 'Release a queue hold (never starts a job)'),
  r('POST', '/api/queue/start-next', 'Start the head job ({id, bedCleared: true, config?})'),
  r('GET', '/api/printers', 'Connection presets'),
  r('POST', '/api/printers', 'Add a connection preset ({name, ip, password?})'),
  r('DELETE', '/api/printers/:id', 'Remove a connection preset'),
  r('POST', '/api/printers/:id/activate', 'Switch the service to a preset'),
];
