/**
 * Pure timing maths for the print status card (ELEG-169).
 *
 * `print_duration` counts extrusion time only; `total_duration` also includes
 * preheat, auto-levelling and filament changes. The wall-clock start of a job
 * is therefore `now - total_duration`, falling back to `print_duration` only
 * when the printer did not report a usable total.
 */

export interface PrintTiming {
  /** Seconds since the job started, preparation included. */
  elapsedSec: number;
  /** Extrusion-only seconds, when reported. */
  printingSec: number | null;
  /** Wall-clock start of the job. */
  startedAt: Date;
}

export function computePrintTiming(
  ps: { print_duration?: number | null; total_duration?: number | null } | undefined | null,
  nowMs: number,
): PrintTiming | null {
  const printDur = ps?.print_duration;
  const totalDur = ps?.total_duration;
  const hasTotal = totalDur != null && totalDur > 0;
  const elapsedSec = hasTotal ? totalDur : printDur;
  if (elapsedSec == null) return null;
  return {
    elapsedSec,
    printingSec: printDur != null ? printDur : null,
    startedAt: new Date(nowMs - elapsedSec * 1000),
  };
}
