/**
 * Filament densities (g/cm³) — the one table both halves read (ELEG-197).
 *
 * The service uses it to turn extruded millimetres into the grams recorded in every
 * print report; the browser uses it for the Spool Calculator, the Retroactive Spool
 * Estimator and the print-status card. There used to be four copies, which had already
 * drifted (only the calculator knew PLA+). Pure and dependency-free so both tsconfigs can
 * include it: the service imports it as `../filament-density.js`, the browser half
 * extensionless.
 *
 * Insertion order is the order the calculator's material dropdown shows.
 */
export const FILAMENT_DENSITY: Readonly<Record<string, number>> = {
  PLA: 1.24,
  'PLA+': 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PA: 1.14,
  'PA-CF': 1.17,
  'PA6-CF': 1.2,
  PC: 1.2,
  HIPS: 1.04,
  PVA: 1.23,
};

/** Density of PLA, the fallback for a type the table does not know. */
export const DEFAULT_FILAMENT_DENSITY = FILAMENT_DENSITY.PLA;

/** Density for a filament type, case-insensitive; `undefined` when the table lacks it. */
export function knownFilamentDensity(type: string): number | undefined {
  return FILAMENT_DENSITY[type.trim().toUpperCase()];
}

/** Density for a filament type, falling back to PLA's for an unknown type. */
export function filamentDensity(type: string): number {
  return knownFilamentDensity(type) ?? DEFAULT_FILAMENT_DENSITY;
}
