import { describe, it, expect } from 'vitest';
import {
  detectZone,
  isFilamentChangeSubStatus,
  classifyCommandOutcome,
  describeCommandError,
  COMMAND_METHOD_NAMES,
  ERROR_CODE_NAMES,
  BUSY_ERROR_CODES,
  REJECTED_ERROR_CODES,
  powerLossState,
  mqttPhase,
  mqttPhaseMessage,
  mqttBannerHeadline,
  formatBuildVersion,
  buildVersionLabel,
  UNKNOWN_VERSION_LABEL,
} from '../types';

describe('detectZone', () => {
  it('returns cutter_area for cutter coordinates', () => {
    expect(detectZone(254, 3.5)).toBe('cutter_area');
  });

  it('returns purge_area for purge coordinates', () => {
    expect(detectZone(52.5, 264)).toBe('purge_area');
  });

  it('returns print_area for normal bed coordinates', () => {
    expect(detectZone(128, 128)).toBe('print_area');
    expect(detectZone(0, 0)).toBe('print_area');
    expect(detectZone(256, 256)).toBe('print_area');
  });

  it('returns outside for out-of-bounds coordinates', () => {
    expect(detectZone(-10, -10)).toBe('outside');
    expect(detectZone(300, 300)).toBe('outside');
  });
});

describe('isFilamentChangeSubStatus', () => {
  it('returns true for filament change sub-statuses', () => {
    expect(isFilamentChangeSubStatus(1045)).toBe(true);
    expect(isFilamentChangeSubStatus(1061)).toBe(true);
    expect(isFilamentChangeSubStatus(1066)).toBe(true);
    expect(isFilamentChangeSubStatus(1150)).toBe(true);
    expect(isFilamentChangeSubStatus(1166)).toBe(true);
  });

  it('returns false for non-filament-change sub-statuses', () => {
    expect(isFilamentChangeSubStatus(0)).toBe(false);
    expect(isFilamentChangeSubStatus(1000)).toBe(false);
    expect(isFilamentChangeSubStatus(2075)).toBe(false);
  });
});

describe('classifyCommandOutcome', () => {
  it('treats 0 as success', () => {
    expect(classifyCommandOutcome(0)).toBe('ok');
  });

  it('treats an absent code as success', () => {
    // Several methods answer with no error_code at all; classifying that as a failure
    // would toast an error on every one of them.
    expect(classifyCommandOutcome(undefined)).toBe('ok');
    expect(classifyCommandOutcome(null)).toBe('ok');
  });

  it('classifies 1009 as busy rather than as an error', () => {
    // The whole point of ELEG-40: "busy" is transient and must not read as a failure.
    expect(classifyCommandOutcome(1009)).toBe('busy');
  });

  it('classifies understood-but-refused codes as rejected', () => {
    expect(classifyCommandOutcome(1003)).toBe('rejected'); // invalid parameter
    expect(classifyCommandOutcome(1010)).toBe('rejected'); // not currently printing
    expect(classifyCommandOutcome(1021)).toBe('rejected'); // file not found
    expect(classifyCommandOutcome(1026)).toBe('rejected'); // needs levelling first
  });

  it('classifies genuine failures as errors', () => {
    expect(classifyCommandOutcome(1004)).toBe('error'); // file write failed
    expect(classifyCommandOutcome(1013)).toBe('error'); // database failure
    expect(classifyCommandOutcome(9999)).toBe('error');
  });

  it('falls back to error for a code the table has never seen', () => {
    expect(classifyCommandOutcome(4242)).toBe('error');
  });
});

describe('describeCommandError', () => {
  it('names a known code', () => {
    expect(describeCommandError(1009)).toBe('Printer busy');
    expect(describeCommandError(1021)).toBe('File not found');
  });

  it('falls back to the raw number for an unknown code', () => {
    expect(describeCommandError(4242)).toBe('error 4242');
  });

  it('describes an absent code without rendering "undefined"', () => {
    expect(describeCommandError(undefined)).toBe('unknown error');
  });
});

describe('command tables', () => {
  it('names every busy/rejected code it classifies', () => {
    // A code classified but unnamed would surface to the user as a bare number, which
    // is the thing describeCommandError exists to avoid. Derived from the sets rather
    // than a second copy of them, so adding a code cannot pass this by omission.
    for (const code of [...BUSY_ERROR_CODES, ...REJECTED_ERROR_CODES]) {
      expect(ERROR_CODE_NAMES[code], `code ${code} has no name`).toBeTruthy();
    }
  });

  it('lists only writes, never the polled reads', () => {
    // A read that comes back busy is re-polled seconds later; toasting it is noise.
    for (const readMethod of [1002, 1036, 1044, 1045, 1046, 1048, 1050]) {
      expect(COMMAND_METHOD_NAMES[readMethod], `read ${readMethod} must not toast`).toBeUndefined();
    }
    expect(COMMAND_METHOD_NAMES[1027]).toBe('Move');
    expect(COMMAND_METHOD_NAMES[1032]).toBe('Auto-level');
  });
});

describe('powerLossState', () => {
  it('reports none for any status that is not 15', () => {
    for (const status of [0, 1, 2, 14, undefined, null]) {
      expect(powerLossState(status, 0)).toBe('none');
    }
  });

  it('reports awaiting_decision for a bare status 15', () => {
    // The printer is sitting on a half-finished job with nobody having told it what to
    // do. This is the state that must prompt.
    expect(powerLossState(15, 0)).toBe('awaiting_decision');
    expect(powerLossState(15, undefined)).toBe('awaiting_decision');
  });

  it('reports resuming once 2405 arrives, so it stops prompting', () => {
    // Prompting again here would invite a second resume on a print already recovering.
    expect(powerLossState(15, 2405)).toBe('resuming');
  });

  it('reports resumed on 2406', () => {
    expect(powerLossState(15, 2406)).toBe('resumed');
  });

  it('does not confuse a normal resume sub-status with a power-loss one', () => {
    // 2401/2402 are an ordinary resume and never accompany status 15.
    expect(powerLossState(2, 2401)).toBe('none');
    expect(powerLossState(15, 2401)).toBe('awaiting_decision');
  });
});

describe('mqttPhase — telling the two broker_only cases apart (ELEG-59)', () => {
  const base = { brokerConnected: true, registered: false, snKnown: false, rejected: false };

  it('reports disconnected whenever the broker is down, whatever else is set', () => {
    // Guards against a stale flag outliving the connection it described.
    expect(mqttPhase({ ...base, brokerConnected: false })).toBe('disconnected');
    expect(mqttPhase({ ...base, brokerConnected: false, snKnown: true })).toBe('disconnected');
    expect(mqttPhase({ ...base, brokerConnected: false, rejected: true })).toBe('disconnected');
    expect(mqttPhase({ ...base, brokerConnected: false, registered: true })).toBe('disconnected');
  });

  it('separates "printer never spoke" from "registering" by whether an SN is known', () => {
    // THE distinction this exists for. Both were `broker_only`, and the UI said
    // `registering…` for both — pointing the diagnosis at the service when the fault was
    // a printer whose control application had stopped.
    expect(mqttPhase({ ...base, snKnown: false })).toBe('awaiting_sn');
    expect(mqttPhase({ ...base, snKnown: true })).toBe('registering');
  });

  it('reports rejected in preference to registering, because a refusal is more specific', () => {
    expect(mqttPhase({ ...base, snKnown: true, rejected: true })).toBe('rejected');
  });

  it('lets a successful registration win over a stale rejection', () => {
    // A refusal followed by a slow-retry that succeeded must read `connected`, not
    // `rejected` — otherwise a working service reports a fault forever.
    expect(mqttPhase({ ...base, snKnown: true, rejected: true, registered: true })).toBe(
      'connected',
    );
  });
});

describe('mqttBannerHeadline — the warning that could never fire (ELEG-59)', () => {
  it('warns immediately when the printer never spoke, with zero attempts', () => {
    // The regression this pins. The old rule was `broker_only && attempts >= 3`, but in
    // this phase registration is never attempted, so the counter stays 0 for ever and the
    // banner was structurally unreachable for the one case that most needed it.
    expect(mqttBannerHeadline('awaiting_sn', 0)).toBe('Printer not responding');
  });

  it('warns immediately on a refusal, which does not improve by waiting', () => {
    expect(mqttBannerHeadline('rejected', 0)).toBe('Registration refused');
  });

  it('stays quiet while registration is merely young, then speaks up', () => {
    // A few seconds of registering is normal startup and must not shout.
    expect(mqttBannerHeadline('registering', 0)).toBeNull();
    expect(mqttBannerHeadline('registering', 2)).toBeNull();
    expect(mqttBannerHeadline('registering', 3)).toBe('Printer not answering');
    expect(mqttBannerHeadline('registering', 12)).toBe('Printer not answering');
  });

  it('never warns about the two phases that are not problems', () => {
    for (const attempts of [0, 3, 99]) {
      expect(mqttBannerHeadline('connected', attempts)).toBeNull();
      expect(mqttBannerHeadline('disconnected', attempts)).toBeNull();
    }
  });
});

describe('mqttPhaseMessage', () => {
  it('gives every phase a distinct, non-empty sentence', () => {
    const phases = ['disconnected', 'awaiting_sn', 'registering', 'rejected', 'connected'] as const;
    const seen = new Set(phases.map((p) => mqttPhaseMessage(p)));
    expect(seen.size).toBe(phases.length);
    for (const p of phases) expect(mqttPhaseMessage(p).length).toBeGreaterThan(0);
  });

  it('tells the operator what to actually do in the two actionable phases', () => {
    // These two sentences are the entire content of the 2026-08-08 incident.
    expect(mqttPhaseMessage('awaiting_sn')).toMatch(/power cycle/i);
    expect(mqttPhaseMessage('rejected')).toMatch(/two clients/i);
  });
});

describe('formatBuildVersion — x.y.z+aa, the way RCP renders it (ELEG-48)', () => {
  it('emits the commit DISTANCE, not a short sha', () => {
    // The issue described `+aa` as "a short build/commit suffix", which is what it looks
    // like. RCP's formatVersion actually emits the number of commits since the tag, and
    // a near-miss would defeat the point of the request.
    expect(formatBuildVersion({ describe: 'v0.2.1-58-g5b00442' })).toBe('0.2.1+58');
  });

  it('drops the suffix when sitting exactly on a tag', () => {
    // Matches RCP, which returns the bare version rather than `+0`.
    expect(formatBuildVersion({ describe: 'v0.3.0' })).toBe('0.3.0');
    expect(formatBuildVersion({ describe: 'v0.3.0-0-gabc1234' })).toBe('0.3.0');
  });

  it('strips a leading v so the result is valid semver', () => {
    expect(formatBuildVersion({ describe: 'v1.2.3-4-gdeadbee' })).toBe('1.2.3+4');
    expect(formatBuildVersion({ describe: '1.2.3-4-gdeadbee' })).toBe('1.2.3+4');
  });

  it('records a dirty install, which RCP never sees', () => {
    // contrib/install.sh runs `describe --tags --always --dirty`; RCP uses `--long`.
    // Installed from a modified checkout is worth surfacing, and `+58.dirty` is still
    // valid semver build metadata.
    expect(formatBuildVersion({ describe: 'v0.2.1-58-g5b00442-dirty' })).toBe('0.2.1+58.dirty');
    expect(formatBuildVersion({ describe: 'v0.3.0-dirty' })).toBe('0.3.0+dirty');
  });

  it('keeps a prerelease tag intact', () => {
    expect(formatBuildVersion({ describe: 'v1.2.3-rc.1' })).toBe('1.2.3-rc.1');
  });

  it('falls back to package.json rather than rendering a bare sha as a version', () => {
    // `--always` with no reachable tag yields just a sha. That is not a version, and
    // showing it as one would be exactly the silently-wrong string this exists to avoid.
    expect(formatBuildVersion({ describe: '5b00442', version: '0.2.1' })).toBe('0.2.1');
    expect(formatBuildVersion({ describe: 'not-a-version', version: '0.2.1' })).toBe('0.2.1');
  });

  it('returns null when there is nothing trustworthy to show', () => {
    // The all-null stamp the issue calls out: normal for `pnpm dev`, and for any deploy
    // predating ELEG-10. Absent beats wrong.
    expect(formatBuildVersion({ describe: null, version: null })).toBeNull();
    expect(formatBuildVersion({})).toBeNull();
    expect(formatBuildVersion(null)).toBeNull();
    expect(formatBuildVersion(undefined)).toBeNull();
    expect(formatBuildVersion({ describe: '   ', version: '  ' })).toBeNull();
  });

  it('never renders the string "null"', () => {
    // The specific failure the issue names: `null+null` reaching the page.
    for (const stamp of [null, undefined, {}, { describe: null, version: null }]) {
      expect(String(formatBuildVersion(stamp))).not.toContain('null+');
    }
  });
});

describe('buildVersionLabel', () => {
  it('always gives the caller something renderable', () => {
    expect(buildVersionLabel({ describe: 'v0.2.1-58-g5b00442' })).toBe('0.2.1+58');
    expect(buildVersionLabel(null)).toBe(UNKNOWN_VERSION_LABEL);
    expect(buildVersionLabel({})).toBe(UNKNOWN_VERSION_LABEL);
  });

  it('says "unknown" rather than "dev", because it cannot tell them apart', () => {
    // An all-null stamp means pnpm dev, OR a deploy predating ELEG-10, OR an installer
    // that failed to write the file. Claiming "dev" for the last two would be a lie.
    expect(UNKNOWN_VERSION_LABEL).toBe('unknown');
    expect(buildVersionLabel({})).not.toMatch(/dev/i);
  });
});
