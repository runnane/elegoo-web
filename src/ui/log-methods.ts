/**
 * Human-readable names for CC2 MQTT method codes, for the log viewer.
 *
 * **Treat an entry here as a label, not as a citation.** Several were wrong, and
 * because this is the most readable list of methods in the repo it is where uncited
 * claims got copied from — ELEG-38 asked for a history delete on 1049, ELEG-30 for AI
 * detection on 2010/2011, and ELEG-32 for OTA on 1064, all of which trace back to this
 * table. `data/CC2_PROTOCOL_REFERENCE.md` is the citable source; ELEG-57 audits the
 * rest of this table against it.
 *
 * **But the reference is not the firmware either.** Where the two disagree, the running
 * code is the stronger evidence: this service sends 2006 for mono filament info and reads
 * a video URL out of 1050's reply, both of which the reference names differently. So a
 * row here only moves when the reference contradicts it *and* nothing in the code relies
 * on the old meaning (ELEG-85).
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
  1043: 'SetDeviceName',
  1047: 'DeleteFile',
  // The reference names 1048 GetCapacity, and the service sends it for storage capacity,
  // so the code agrees. It used to be labelled 'GetDiskInfo' while 1061 below claimed
  // 'GetCapacity' — the same operation under two numbers (ELEG-85).
  1048: 'GetCapacity',
  // Was 'DeleteHistory', which collided with 1038 above — one operation, two entries,
  // so one had to be wrong. Both protocol docs in `data/` say 1049 is UpdateToken, and
  // ELEG-38 nearly sent a history-delete payload to it (ELEG-38).
  1049: 'UpdateToken',
  1050: 'GetVideoUrl',
  1051: 'GetTimeLapse',
  // There is no 1060 in the reference. It was labelled 'SetDeviceName', which is 1043
  // above, and ELEG-39 was written against 1060 because of it (ELEG-85).
  //
  // 1061 was labelled 'GetCapacity', which is 1048. The reference names 1061
  // GetMonoFilamentInfo, but nothing here has seen it answer — and this firmware already
  // disagrees with the reference about mono filament (the service uses 2006) — so the
  // name carries a '?' like 1062's.
  1061: 'GetMonoFilamentInfo?',
  // NOT "GetSystemInfo" — that label was never verified against a real response, and
  // both protocol docs in data/ name 1062 GetAIDetectionSettings. A read-only probe of
  // the live printer answers:
  //
  //     { "id": 25, "method": 1062, "result": { "error_code": 1100 } }
  //
  // every time, so nothing here has ever seen what it returns. **error_code 1100 is
  // undocumented** — it is in no error table in this repo. Best guess, unconfirmed, is
  // "feature unavailable on this machine" rather than "unknown method"; seeing 1100 come
  // back from some *other* method would confirm that.
  //
  // This comment is the only committed record of the above: `data/` is gitignored in its
  // entirety, so the protocol references AGENTS.md tells you to cite are not in a clone
  // (ELEG-66).
  //
  // The service no longer sends 1062 (ELEG-55); this entry stays only so the log viewer
  // can label one if the touchscreen or some other client sends it. ELEG-56 is the
  // capture that would settle the real name. Do NOT send 1063 to find out what it does —
  // it is a `Set…`.
  1062: 'GetAIDetectionSettings?',
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
