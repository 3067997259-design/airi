import type { Live2DDiscoveredGroup, Live2DDiscoveredModelParameters, Live2DDiscoveredParameter, useLive2DCustomParameters } from '../../stores/custom-parameters'
import type { MotionManagerPlugin } from './motion-manager'

/** cdi3 DisplayInfo shape parsed by the zip loader into settings._cdiData. */
export interface Live2DCdiData {
  Parameters?: Array<{ Id?: string, Name?: string, GroupId?: string }>
  ParameterGroups?: Array<{ Id?: string, Name?: string }>
}

/** Minimal Cubism core parameter table exposed via CubismModel.getModel().parameters. */
interface CoreParameterTable {
  ids?: ArrayLike<string>
  minimumValues?: ArrayLike<number>
  maximumValues?: ArrayLike<number>
  defaultValues?: ArrayLike<number>
}

/** Parameters owned by other AIRI surfaces; never exposed in the custom panel. */
const SYSTEM_MANAGED_IDS = new Set([
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamEyeBallX',
  'ParamEyeBallY',
  'ParamEyeLOpen',
  'ParamEyeROpen',
  'ParamEyeSmile',
  'ParamBrowLX',
  'ParamBrowRX',
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamBrowLAngle',
  'ParamBrowRAngle',
  'ParamBrowLForm',
  'ParamBrowRForm',
  'ParamMouthOpenY',
  'ParamMouthForm',
  'ParamCheek',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'ParamBreath',
])
const SYSTEM_MANAGED_PATTERN = /^Param_Angle_Rotation_/

export function isSystemManagedParameter(id: string): boolean {
  return SYSTEM_MANAGED_IDS.has(id) || SYSTEM_MANAGED_PATTERN.test(id)
}

/**
 * Builds the per-model parameter catalog from cdi3 display info plus core ranges.
 *
 * Use when:
 * - A Live2D model finishes loading and its parameter surface should be
 *   surfaced in the settings panel.
 *
 * Expects:
 * - `cdiData` may be undefined (model without DisplayInfo); only core-known
 *   parameters are listed then, with raw ids as names.
 * - `coreModel.getModel()?.parameters` may be missing in exotic builds; ranges
 *   fall back to a -1..1 heuristic so sliders stay usable.
 *
 * Returns:
 * - Named parameters grouped by their cdi3 group, excluding ids owned by
 *   AIRI's built-in controls and physics pendulums.
 */
export function discoverCustomParameters(
  cdiData: Live2DCdiData | undefined,
  coreModel: { getModel?: () => { parameters?: CoreParameterTable } } | undefined,
): Live2DDiscoveredModelParameters {
  let coreParams: { ids?: ArrayLike<string>, minimumValues?: ArrayLike<number>, maximumValues?: ArrayLike<number>, defaultValues?: ArrayLike<number> } | undefined
  try {
    const model = coreModel?.getModel?.()
    coreParams = model?.parameters
  }
  catch (error) {
    console.warn('[custom-parameters] getModel() threw; falling back to heuristic ranges', error)
  }
  const ranges = new Map<string, { min: number, max: number, default: number }>()
  if (coreParams?.ids) {
    for (let i = 0; i < coreParams.ids.length; i++) {
      const id = coreParams.ids[i]
      if (!id)
        continue
      ranges.set(id, {
        min: coreParams.minimumValues?.[i] ?? -1,
        max: coreParams.maximumValues?.[i] ?? 1,
        default: coreParams.defaultValues?.[i] ?? 0,
      })
    }
  }

  const cdiById = new Map<string, { name: string, groupId: string | null }>()
  for (const parameter of cdiData?.Parameters ?? []) {
    if (parameter.Id)
      cdiById.set(parameter.Id, { name: parameter.Name ?? parameter.Id, groupId: parameter.GroupId ?? null })
  }

  const parameters: Live2DDiscoveredParameter[] = []
  const seen = new Set<string>()
  for (const id of ranges.keys()) {
    if (isSystemManagedParameter(id))
      continue
    seen.add(id)
    const range = ranges.get(id)!
    const display = cdiById.get(id)
    parameters.push({
      id,
      name: display?.name ?? id,
      groupId: display?.groupId ?? null,
      min: range.min,
      max: range.max,
      default: range.default,
    })
  }
  // cdi-only parameters (no core range found) still surface with heuristic ranges.
  for (const [id, display] of cdiById) {
    if (seen.has(id) || isSystemManagedParameter(id))
      continue
    parameters.push({ id, name: display.name, groupId: display.groupId, min: -1, max: 1, default: 0 })
  }

  const groups: Live2DDiscoveredGroup[] = (cdiData?.ParameterGroups ?? [])
    .filter(group => group.Id)
    .map(group => ({ id: group.Id!, name: group.Name ?? group.Id! }))

  return { parameters, groups }
}

/**
 * Re-asserts enabled custom parameter overrides every frame.
 *
 * Use when:
 * - Registering a 'final' motion-manager plugin so hairstyle/toggle choices
 *   survive idle motions and expression playback.
 */
export function useMotionUpdatePluginCustomParameters(
  store: ReturnType<typeof useLive2DCustomParameters>,
  modelId: string | undefined,
): MotionManagerPlugin {
  return (ctx) => {
    // The settings window can replace this object through a storage event.
    // Resolve it on each frame so the model uses the current cross-window state.
    const values = store.valuesFor(modelId)
    for (const [parameterId, entry] of Object.entries(values)) {
      if (!entry.enabled)
        continue
      ctx.model.setParameterValueById(parameterId, entry.value)
    }
  }
}
