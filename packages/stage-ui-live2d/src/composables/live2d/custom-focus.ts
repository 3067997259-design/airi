import type { Live2DFocusEntry } from '../../stores/focus-config'

/** Minimal core-model surface the custom focus writer needs. */
export interface FocusParameterWriter {
  setParameterValueById: (id: string, value: number) => void
}

/**
 * Writes focus-driven parameter values from a configurable mapping.
 *
 * Use when:
 * - A model's custom eye rig misbehaves under the stock fixed `updateFocus`
 *   gains and needs per-parameter scaling or disabling.
 *
 * Expects:
 * - `focusX`/`focusY` in [-1, 1] (the pixi FocusController interpolants).
 *
 * Returns:
 * - Nothing; writes each enabled entry as `base * gain`, where the math keeps
 *   the result within `[-|gain|, |gain|]` because the base is clamped by
 *   construction.
 */
export function applyCustomFocus(
  coreModel: FocusParameterWriter,
  focusX: number,
  focusY: number,
  entries: Live2DFocusEntry[],
): void {
  for (const entry of entries) {
    if (!entry.enabled)
      continue
    const base = entry.axis === 'x'
      ? focusX
      : entry.axis === 'y'
        ? focusY
        : focusX * focusY
    coreModel.setParameterValueById(entry.id, base * entry.gain)
  }
}
