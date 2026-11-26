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
 * **But the reference is not the firmware either.** The strongest local evidence is the
 * firmware's own method enum (`method.h`, ELEG-100); after that, a method the service sends
 * and the printer answers — it sends 2006 for mono filament info, which neither the
 * reference nor the enum lists. Code that merely *reads* a reply is not evidence: until
 * ELEG-186 this file kept 1050 as 'GetVideoUrl' because the code read a video URL out of
 * 1050's reply, when nothing ever sent 1050 and the enum names it GET_TOKEN. So a row here
 * moves when the enum or the reference contradicts it and no sent-and-answered behaviour
 * supports the old name (ELEG-85, ELEG-186).
 */

export const METHOD_NAMES: Record<number, string> = {
  1001: 'GetAttributes',
  1002: 'GetStatus',
  // The firmware's own method enum (`method.h`, ELEG-100) names 1004 GET_FAN_STATUS; the
  // reference agrees (GetFanInfo). Was 1066 below, which is the 'Filament Change'
  // sub-status (SUB_STATUS_NAMES in src/types.ts) with an unrelated name pasted onto it.
  1004: 'GetFanStatus',
  // Same shape: the firmware enum names 1006 GET_HOME_STATUS, the reference agrees. Was
  // 1065 below, which is not a method in the firmware enum at all.
  1006: 'GetHomeStatus',
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
  // The firmware enum names 1039 OTA_UPGRADING and the reference agrees. Was labelled at
  // 1064 below, which is the 'Extruder Unload Complete' sub-status (SUB_STATUS_NAMES in
  // src/types.ts), not a method — ELEG-32 was written against 1064 because of this row
  // (ELEG-100). Do NOT send 1039 — it starts a firmware flash.
  1039: 'OTAUpgrade',
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
  // The firmware enum (`method.h`) reads, in order: `XX(1049, UPDATE_TOKEN, update token)`,
  // `XX(1050, GET_TOKEN, get token)`, `XX(1051, EXPORT_TIMELAPSE_VIDEO, export timelapse
  // video)`, `XX(1053, SET_TOKEN_SWITCH, set token switch)`; the reference agrees on 1050
  // (GetToken). 1050 was labelled 'GetVideoUrl' and 1051 'GetTimeLapse' (ELEG-186).
  // Do NOT send 1050 — by its name it returns the printer's auth token (the reply shape is
  // documented nowhere locally, so nobody has checked). Nothing here sends it, and
  // the service redacts 1049/1050/1053 payloads from `/ws` and the debug capture
  // (`src/server/secret-payload.ts`).
  1050: 'GetToken',
  1051: 'ExportTimelapseVideo',
  // Turns the printer's token authentication on or off. Do NOT send 1053.
  1053: 'SetTokenSwitch',
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
  // Was 'MessageAutoReport', but the auto-report is 6000 on every source: the only local
  // MQTT capture, the reference (MessageAutoReport), and the firmware enum (POST_INFO).
  // The reference instead names 1063 SetAIDetectionSettings; the firmware enum has no
  // 1063 as a method at all — only as the 'Extruder Load Complete' sub-status
  // (SUB_STATUS_NAMES in src/types.ts). Carries the same '?' convention as 1061/1062,
  // since nothing here has seen it answer (ELEG-100). Do NOT send 1063 — it is a `Set…`.
  1063: 'SetAIDetectionSettings?',
  2001: 'LoadFilament',
  2002: 'UnloadFilament',
  2003: 'SetFilamentInfo',
  2004: 'SetAutoRefill',
  2005: 'GetCanvasInfo',
  2006: 'GetMonoFilament',
  // Absent from the reference and from the firmware enum — but so is 2006 above, which
  // this service sends and the printer answers, so absence alone is not enough to delete
  // it. Carries the '?' convention pending ELEG-56's capture (ELEG-100).
  2007: 'SetMonoFilament?',
  // 2010 and 2011 ('AIDetectionGet'/'AIDetectionSet') removed: absent from the reference,
  // from the firmware enum, and from every local capture. ELEG-30 tracks the feature these
  // were guessed for; ELEG-56 is the capture that could resurrect them with evidence
  // (ELEG-100).
  6000: 'StatusEvent',
};
