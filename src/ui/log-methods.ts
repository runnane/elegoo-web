/**
 * Human-readable names for CC2 MQTT method codes, for the log viewer.
 *
 * **Treat an entry here as a label, not as a citation.** Several were wrong, and
 * because this is the most readable list of methods in the repo it is where uncited
 * claims got copied from — ELEG-38 asked for a history delete on 1049, ELEG-30 for AI
 * detection on 2010/2011, and ELEG-32 for OTA on 1064, all of which trace back to this
 * table. `data/CC2_PROTOCOL_REFERENCE.md` is the citable source; ELEG-57 audits the
 * rest of this table against it.
 */

export const METHOD_NAMES: Record<number, string> = {
  1001: 'GetAttributes',
  1002: 'GetStatus',
  1007: 'EmergencyStop',
  1020: 'StartPrint',
  1021: 'PausePrint',
  1022: 'CancelPrint',
  1023: 'ResumePrint',
  1026: 'HomeControl',
  1027: 'MoveControl',
  1028: 'TempControl',
  1029: 'LightSwitch',
  1030: 'FanControl',
  1031: 'SpeedControl',
  1032: 'AutoLevel',
  1033: 'VibrationOptimize',
  1034: 'PIDDetect',
  1035: 'SelfCheck',
  1036: 'PrintTaskList',
  1037: 'PrintTaskDetail',
  1038: 'HistoryDelete',
  1044: 'GetFileList',
  1045: 'GetThumbnail',
  1046: 'GetFileDetail',
  1047: 'DeleteFile',
  1048: 'GetDiskInfo',
  // Was 'DeleteHistory', which collided with 1038 above — one operation, two entries,
  // so one had to be wrong. Both protocol docs in `data/` say 1049 is UpdateToken, and
  // ELEG-38 nearly sent a history-delete payload to it (ELEG-38).
  1049: 'UpdateToken',
  1050: 'GetVideoUrl',
  1051: 'GetTimeLapse',
  1060: 'SetDeviceName',
  1061: 'GetCapacity',
  1062: 'GetSystemInfo',
  1063: 'MessageAutoReport',
  1064: 'OTAUpgrade',
  1065: 'GetHomeStatus',
  1066: 'GetFanInfo',
  2001: 'LoadFilament',
  2002: 'UnloadFilament',
  2003: 'SetFilamentInfo',
  2004: 'SetAutoRefill',
  2005: 'GetCanvasInfo',
  2006: 'GetMonoFilament',
  2007: 'SetMonoFilament',
  2010: 'AIDetectionGet',
  2011: 'AIDetectionSet',
  6000: 'StatusEvent',
};
