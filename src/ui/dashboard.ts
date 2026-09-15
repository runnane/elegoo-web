/**
 * Re-export all UI modules from a single entry point
 * so that main.ts imports remain unchanged.
 */
export { renderDashboard, renderHeader, toggleCameraOverlay } from './print-status';
export { renderCanvas, setCanvasClient } from './canvas';
export {
  renderFiles,
  bindFileControls,
  currentFileSource,
  currentFileDir,
  handleThumbnailResponse,
  handleInlineThumbnail,
} from './files';
export { bindControls, onCommandResponse } from './controls';
export { registerChart, initCharts } from './charts';
export { renderStructuredLog, bindStructuredLogControls } from './structured-log';
export { toast } from './toast';
export { fetchTimeout } from './helpers';
export { renderSystemInfo, updateServiceStatus } from './service-status';
export {
  renderTimelapse,
  setTimelapseClient,
  requestTimelapseList,
  showTimelapsePlayer,
} from './timelapse';
export { renderGcodePreview, bindGcodePreviewControls, loadGcode } from './gcode-preview';
export { renderLayerTimeChart } from './layer-chart';
export { handleAIAnalysis, handleAIAlert, renderAIPanel, updateAIStatus } from './ai-panel';
export {
  openSettings,
  applyCardLayout,
  renderSettingsContent,
  switchToTab,
  toggleCardCollapse,
} from './settings';
export { handleEventLog, loadEventLogHistory, renderEventLog } from './event-log';
export {
  renderPrintHistory,
  bindHistoryControls,
  setHistoryClient,
  requestHistory,
} from './print-history';
export { renderMaintenance, bindMaintenanceControls, setMaintenanceClient } from './maintenance';
export { renderReports, refreshReports, bindReportControls } from './print-reports';
export { requestPrintDialog, handleFileDetailForPrint } from './print-dialog';
export { renderDebugPanel, bindDebugPanel, trackStateChanges } from './debug-panel';
export { bindKeyboardShortcuts } from './keyboard-shortcuts';
