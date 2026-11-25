/**
 * How many preview layers come before the printer's layer 1 (ELEG-120).
 *
 * gcode-preview builds its layers one of two ways, and since 3.0.0-alpha.6 the choice
 * depends on the file:
 *
 * - **No recognised slicer comments** — layers come from Z changes, and everything
 *   before the first layer (homing, the prime line) is a layer of its own. Printer
 *   layer N is then preview layer N+1. That was the only mode up to alpha.4, and the
 *   follow mode's old hard-coded `+ 1`.
 * - **Slicer layer comments** that the library recognises (`;LAYER_CHANGE` from the
 *   PrusaSlicer/OrcaSlicer family, among others) — layers come from the slicer, the
 *   preamble is no longer a layer of its own, and printer layer N is preview layer N.
 *   Keeping the `+ 1` there shows the layer *above* the one being printed. The CC2's
 *   slicer is Orca-derived, so its files very likely take this path; that is an
 *   assumption, not checked against a real print file — which is why the printer's
 *   own count decides first.
 *
 * Measured with a synthetic 10-layer file using PrusaSlicer-style comments: 11
 * preview layers without the comments, 10 with them, on alpha.7 (where the parser
 * reports `slicerName` only for the commented file); alpha.4 gave 11 for both.
 *
 * The printer's own layer count settles it when it is known, because it is a
 * measurement of the same file; the slicer detection is the fallback.
 */
export function previewLayerOffset(
  previewLayers: number,
  printerTotalLayers: number | null | undefined,
  slicerDetected: boolean,
): 0 | 1 {
  if (printerTotalLayers != null && printerTotalLayers > 0) {
    if (previewLayers === printerTotalLayers + 1) return 1;
    if (previewLayers === printerTotalLayers) return 0;
  }
  return slicerDetected ? 0 : 1;
}
