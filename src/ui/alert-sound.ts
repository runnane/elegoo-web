/**
 * Audible alerts for print completion and errors (ELEG-46).
 *
 * Split deliberately in two halves, as the issue asked:
 *
 *  - `alertForEvent` is **pure** — event in, alert kind or null out — and is the half a
 *    unit test can reach. Every rule about *which* events sound lives there.
 *  - Everything below `--- playback ---` needs a browser: an `AudioContext`, a user
 *    gesture, and speakers. No gate can test it.
 *
 * Sound is **off by default** (`ui-settings.ts`), because a dashboard that starts making
 * noise is a bad first impression, and because the autoplay policy below means it would
 * often not work anyway until the user clicked something.
 */

import { CRITICAL_EXCEPTIONS } from '../types';
import { loadUISettings } from './ui-settings';

export type AlertKind = 'success' | 'failure';

/**
 * Decide whether an event should make a sound, and which.
 *
 * Pure: no DOM, no audio, no settings. The settings check lives in the caller so that
 * this stays a statement about the *events* alone and can be tested without stubbing
 * storage.
 *
 * `CRITICAL_EXCEPTIONS` is reused rather than a second severity rule being invented —
 * the issue is explicit about that, and a second list would drift from the first.
 */
export function alertForEvent(event: Record<string, unknown>): AlertKind | null {
  switch (event.type) {
    case 'print_completed':
      return 'success';
    case 'print_failed':
      return 'failure';
    case 'error': {
      // The server sends `codes: number[]` alongside `names: string[]`; the codes are
      // what CRITICAL_EXCEPTIONS is keyed on. A non-critical exception is a warning and
      // deliberately silent — otherwise the alert becomes noise and gets turned off,
      // which is the same as not having it.
      const codes = event.codes;
      if (!Array.isArray(codes)) return null;
      return codes.some((c) => typeof c === 'number' && CRITICAL_EXCEPTIONS.has(c))
        ? 'failure'
        : null;
    }
    default:
      return null;
  }
}

// --- playback -------------------------------------------------------------------
// Everything below here needs a real browser.

/** Why a sound did not play, for the UI to report rather than failing silently. */
export type PlaybackState = 'ok' | 'blocked' | 'unsupported';

let ctx: AudioContext | null = null;
let lastState: PlaybackState = 'ok';

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) {
    lastState = 'unsupported';
    return null;
  }
  ctx = new Ctor();
  return ctx;
}

/**
 * Whether the browser is currently refusing to play audio.
 *
 * Browsers block audio until the user has interacted with the page — and a dashboard
 * left open on a second monitor and never clicked is *exactly* the case this feature is
 * for, and also exactly the case where autoplay is refused. So this is surfaced in the
 * settings UI rather than left to fail silently.
 */
export function playbackState(): PlaybackState {
  if (lastState === 'unsupported') return 'unsupported';
  return ctx?.state === 'suspended' ? 'blocked' : lastState;
}

/** Tone pairs chosen to be distinguishable across a room without being alarming. */
const TONES: Record<AlertKind, Array<{ hz: number; ms: number }>> = {
  // Rising major third — reads as "finished".
  success: [
    { hz: 660, ms: 140 },
    { hz: 880, ms: 220 },
  ],
  // Falling, lower, three times — reads as "something is wrong".
  failure: [
    { hz: 440, ms: 160 },
    { hz: 350, ms: 160 },
    { hz: 260, ms: 320 },
  ],
};

/**
 * Play the alert for `kind`, honouring the saved volume.
 *
 * Returns the resulting `PlaybackState` so a caller (the test button) can tell the user
 * that the browser refused, instead of leaving them wondering whether it is broken.
 */
export async function playAlert(kind: AlertKind): Promise<PlaybackState> {
  const audio = context();
  if (!audio) return 'unsupported';

  // resume() is what converts "blocked" into "playing" once a gesture has happened. It
  // rejects if there has been no gesture at all, which is the blocked case.
  if (audio.state === 'suspended') {
    try {
      await audio.resume();
    } catch {
      lastState = 'blocked';
      return 'blocked';
    }
  }
  if (audio.state === 'suspended') {
    lastState = 'blocked';
    return 'blocked';
  }

  const volume = Math.min(1, Math.max(0, loadUISettings().alertVolume));
  let at = audio.currentTime;

  for (const tone of TONES[kind]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = tone.hz;

    const seconds = tone.ms / 1000;
    // Ramped rather than square, so it does not click on start and stop.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume * 0.3, at + 0.02);
    gain.gain.linearRampToValueAtTime(0, at + seconds);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(at);
    osc.stop(at + seconds);
    at += seconds;
  }

  lastState = 'ok';
  return 'ok';
}

/**
 * Sound an event if the user has alerts switched on.
 *
 * **Only ever call this for events arriving live.** The event log is restored on
 * connect, and firing a sound for a print that finished an hour ago would be a genuinely
 * bad first impression — so `main.ts` calls this from the live-event path and never from
 * `loadEventLogHistory`.
 */
export function maybeAlertForEvent(event: Record<string, unknown>): void {
  if (!loadUISettings().alertSound) return;
  const kind = alertForEvent(event);
  if (!kind) return;
  void playAlert(kind);
}
