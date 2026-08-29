import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { StorageSerializers } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpressionBlendMode = 'Add' | 'Multiply' | 'Overwrite'

/**
 * A single expression parameter entry tracked by the store.
 *
 * Each entry maps to a Live2D parameter that is controlled through the
 * expression system (either via exp3 files or direct parameter access).
 */
export interface ExpressionEntry {
  /** Human-readable name (Expression name or raw parameter ID). */
  name: string
  /** Live2D parameter ID (e.g. "ParamWatermarkOFF"). */
  parameterId: string
  /** How this value is applied on top of the base value. */
  blend: ExpressionBlendMode
  /** Runtime value that will be applied every frame. */
  currentValue: number
  /** Application-level default (may be overridden by the user via saveDefaults). */
  defaultValue: number
  /** Original default baked into the moc3 / exp3 file. */
  modelDefault: number
  /**
   * The exp3-specified target value for this parameter (e.g. -1, 1, 10).
   * Used by toggle to know what value to set when activating.
   * For parameters referenced by multiple groups, this stores the first
   * non-zero value encountered.
   */
  targetValue: number
}

/**
 * Per-entry metadata that does not change while a model stays loaded.
 *
 * `currentValue` is deliberately absent: runtime values live in the
 * cross-renderer `live2d/expression-values` record so a toggle in the settings
 * window reaches the stage window that owns the model.
 */
type ExpressionCatalogEntry = Omit<ExpressionEntry, 'currentValue'>

/**
 * Describes a named expression group loaded from model3.json / exp3.json.
 *
 * One expression group can contain multiple parameter entries (e.g. "Cry"
 * may set both "ParamTear" and "ParamEyeWet").
 */
export interface ExpressionGroupDefinition {
  /** Expression name as declared in model3.json Expressions[].Name. */
  name: string
  /** Parameter entries that belong to this expression group. */
  parameters: {
    parameterId: string
    blend: ExpressionBlendMode
    value: number
  }[]
}

/** Serialisable snapshot returned to the LLM. */
export interface ExpressionState {
  name: string
  value: number
  default: number
  active: boolean
  autoResetAt?: number
}

/** Reused so reactive getters never allocate a fresh fallback reference. */
const EMPTY_VALUES: Readonly<Record<string, number>> = Object.freeze({})

/** Unified tool result envelope. */
export interface ExpressionToolResult {
  success: boolean
  error?: string
  state?: ExpressionState | ExpressionState[]
  available?: string[]
}

// ---------------------------------------------------------------------------
// Persistence helpers  (localStorage – no extra dependency needed)
// ---------------------------------------------------------------------------

function persistenceKey(modelId: string): string {
  return `expression-defaults:${modelId}`
}

function loadPersistedDefaults(modelId: string): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(persistenceKey(modelId))
    if (!raw)
      return null
    return JSON.parse(raw) as Record<string, number>
  }
  catch {
    return null
  }
}

function savePersistedDefaults(modelId: string, defaults: Record<string, number>): void {
  try {
    localStorage.setItem(persistenceKey(modelId), JSON.stringify(defaults))
  }
  catch (err) {
    console.warn('[expression-store] Failed to persist defaults:', err)
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useExpressionStore = defineStore('live2d-expressions', () => {
  // ---- state ---------------------------------------------------------------

  /**
   * Static per-parameter metadata, keyed by expression/parameter name.
   * Rebuilt on every model load; never carries the live runtime value.
   */
  const catalog = ref<Map<string, ExpressionCatalogEntry>>(new Map())

  /** Currently loaded model ID (used for persistence scoping). */
  const modelId = ref<string>('')

  /**
   * Live parameter values, keyed by model id then parameter name.
   *
   * This is the cross-renderer source of truth. The stage window owns the model
   * and re-reads these values every frame; the settings window writes them.
   * localStorage is the bridge because the two windows are separate Electron
   * renderers with separate Pinia instances — the same mechanism the custom
   * parameter overrides use.
   */
  const valueRecord = useLocalStorageManualReset<Record<string, Record<string, number>>>('live2d/expression-values', {})

  /**
   * Auto-reset timers are renderer-local: only the window that scheduled a
   * timed expression owns its expiry, and handles are not serialisable.
   */
  const resetTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function currentValues(): Record<string, number> {
    if (!modelId.value)
      return EMPTY_VALUES
    return valueRecord.value[modelId.value] ?? EMPTY_VALUES
  }

  function valueOf(name: string): number {
    const stored = currentValues()[name]
    if (stored != null)
      return stored
    return catalog.value.get(name)?.defaultValue ?? 0
  }

  function writeValues(next: Record<string, number>) {
    if (!modelId.value)
      return
    valueRecord.value = { ...valueRecord.value, [modelId.value]: next }
  }

  /**
   * Materialises the catalog plus the live values into the shape consumers
   * (settings panel, expression-controller, LLM tools) already expect.
   */
  const expressions = computed<Map<string, ExpressionEntry>>(() => {
    const values = currentValues()
    const merged = new Map<string, ExpressionEntry>()
    for (const [name, entry] of catalog.value) {
      merged.set(name, {
        ...entry,
        currentValue: values[name] ?? entry.defaultValue,
      })
    }
    return merged
  })

  /**
   * Named expression groups parsed from model3.json + exp3.json.
   * Keyed by expression name.
   */
  const expressionGroups = ref<Map<string, ExpressionGroupDefinition>>(new Map())

  /**
   * Cross-window catalog mirror. The model (and therefore the expression
   * controller) usually loads in the main stage window while the settings
   * panel lives in the settings window — separate Electron renderers with
   * separate Pinia instances. localStorage (shared per origin, with VueUse
   * storage-event sync, the same mechanism `availableMotions` uses) bridges
   * the registration to windows that never loaded the model themselves.
   */
  interface SerializedExpressionCatalog {
    modelId: string
    groups: ExpressionGroupDefinition[]
    entries: ExpressionCatalogEntry[]
  }
  const catalogMirror = useLocalStorageManualReset<SerializedExpressionCatalog | null>('live2d/expression-catalog', null, {
    serializer: StorageSerializers.object,
  })

  /**
   * LLM exposure mode: 'all' exposes everything, 'none' exposes nothing,
   * 'custom' uses the per-group map below.
   *
   * Chosen in the settings window but read by the stage window, which owns the
   * tool executors, so this crosses renderers through localStorage like the
   * runtime values do.
   */
  const llmMode = useLocalStorageManualReset<'all' | 'none' | 'custom'>('live2d/expression-llm-mode', 'none')

  /** Per-group LLM exposure flags (only used when llmMode === 'custom'). */
  const llmExposedRecord = useLocalStorageManualReset<Record<string, boolean>>('live2d/expression-llm-exposed', {})
  const llmExposed = computed(() => new Map(Object.entries(llmExposedRecord.value)))

  // ---- internal helpers ----------------------------------------------------

  function clearAllTimers() {
    for (const timer of resetTimers.values())
      clearTimeout(timer)
    resetTimers.clear()
  }

  function stateOf(name: string): ExpressionState {
    const entry = catalog.value.get(name)
    const value = valueOf(name)
    const defaultValue = entry?.defaultValue ?? 0
    return {
      name,
      value,
      default: defaultValue,
      active: value !== defaultValue,
      autoResetAt: resetTimers.has(name) ? Date.now() : undefined,
    }
  }

  function allNames(): string[] {
    return Array.from(catalog.value.keys())
  }

  // ---- public API ----------------------------------------------------------

  /**
   * Register all expression entries parsed from the model.
   * Called by the expression-controller after parsing exp3 data.
   */
  function registerExpressions(
    id: string,
    groups: ExpressionGroupDefinition[],
    parameterEntries: ExpressionEntry[],
  ) {
    clearAllTimers()
    modelId.value = id
    expressionGroups.value = new Map(groups.map(group => [group.name, group]))

    const persisted = loadPersistedDefaults(id)
    const nextCatalog = new Map<string, ExpressionCatalogEntry>()
    for (const { currentValue: _currentValue, ...entry } of parameterEntries) {
      // A user-saved default overrides the exp3/moc3 default for both the
      // resting value and what a toggle-off returns to.
      const defaultValue = persisted?.[entry.name] ?? entry.defaultValue
      nextCatalog.set(entry.name, { ...entry, defaultValue })
    }
    catalog.value = nextCatalog

    // A reload of the same model keeps whatever the user had toggled; a
    // different model starts from its own defaults.
    if (valueRecord.value[id] == null)
      writeValues(Object.fromEntries([...nextCatalog].map(([name, entry]) => [name, entry.defaultValue])))

    // Publish the catalog so windows that never loaded the model (e.g. the
    // settings window hosting this panel) can still list its expressions.
    catalogMirror.value = {
      modelId: id,
      groups: groups.map(group => ({
        name: group.name,
        parameters: group.parameters.map(parameter => ({ ...parameter })),
      })),
      entries: [...nextCatalog.values()].map(entry => ({ ...entry })),
    }
  }

  // Hydrate (and cross-window sync) from the catalog mirror. Skips the write
  // originating from this window's own registerExpressions call.
  watch(catalogMirror, (next) => {
    if (!next || next.modelId === modelId.value)
      return
    clearAllTimers()
    modelId.value = next.modelId
    expressionGroups.value = new Map(next.groups.map(group => [group.name, group]))

    const persisted = loadPersistedDefaults(next.modelId)
    catalog.value = new Map(next.entries.map(entry => [
      entry.name,
      { ...entry, defaultValue: persisted?.[entry.name] ?? entry.defaultValue },
    ]))
  }, { immediate: true })

  /**
   * Resolve a name to either an expression group or a direct parameter entry.
   * Returns `'group'`, `'param'`, or `null`.
   */
  function resolve(name: string): { kind: 'group', group: ExpressionGroupDefinition } | { kind: 'param', entry: ExpressionEntry } | null {
    const group = expressionGroups.value.get(name)
    if (group)
      return { kind: 'group', group }

    const entry = expressions.value.get(name)
    if (entry)
      return { kind: 'param', entry }

    return null
  }

  /**
   * Commits one batch of parameter writes as a single record replacement.
   *
   * Group toggles touch several parameters at once; writing them together keeps
   * the cross-renderer record from emitting a partially-applied expression.
   */
  function applyValues(updates: Array<{ name: string, value: number }>, duration?: number) {
    const next = { ...currentValues() }
    for (const { name, value } of updates) {
      const timer = resetTimers.get(name)
      if (timer != null) {
        clearTimeout(timer)
        resetTimers.delete(name)
      }
      next[name] = value

      if (duration && duration > 0) {
        const resetTo = catalog.value.get(name)?.defaultValue ?? 0
        resetTimers.set(name, setTimeout(() => {
          resetTimers.delete(name)
          writeValues({ ...currentValues(), [name]: resetTo })
        }, duration * 1000))
      }
    }
    writeValues(next)
  }

  /**
   * Set an expression or parameter value.
   */
  function set(name: string, value: boolean | number, duration?: number): ExpressionToolResult {
    const resolved = resolve(name)

    if (!resolved) {
      return {
        success: false,
        error: `Expression or parameter "${name}" not found.`,
        available: allNames(),
      }
    }

    const numericValue = typeof value === 'boolean' ? (value ? 1 : 0) : value

    if (resolved.kind === 'group') {
      const names = resolved.group.parameters
        .map(param => param.parameterId)
        .filter(name => catalog.value.has(name))
      applyValues(names.map(name => ({ name, value: numericValue })), duration)
      return { success: true, state: names.map(stateOf) }
    }

    // Direct parameter
    applyValues([{ name: resolved.entry.name, value: numericValue }], duration)
    return { success: true, state: stateOf(resolved.entry.name) }
  }

  /**
   * Get expression state.
   */
  function get(name?: string): ExpressionToolResult {
    if (!name)
      return { success: true, state: allNames().map(stateOf) }

    const resolved = resolve(name)
    if (!resolved) {
      return {
        success: false,
        error: `Expression or parameter "${name}" not found.`,
        available: allNames(),
      }
    }

    if (resolved.kind === 'group') {
      const states = resolved.group.parameters
        .filter(param => catalog.value.has(param.parameterId))
        .map(param => stateOf(param.parameterId))
      return { success: true, state: states }
    }

    return { success: true, state: stateOf(resolved.entry.name) }
  }

  /**
   * Toggle an expression (flip between default and non-default).
   */
  function toggle(name: string, duration?: number): ExpressionToolResult {
    const resolved = resolve(name)
    if (!resolved) {
      return {
        success: false,
        error: `Expression or parameter "${name}" not found.`,
        available: allNames(),
      }
    }

    if (resolved.kind === 'group') {
      // A group is "active" when at least one of its non-zero (activation)
      // params is currently set to the exp3 value.  Zero-valued params are
      // "reset" instructions and are excluded from the active check.
      const isActive = resolved.group.parameters.some((p) => {
        if (p.value === 0)
          return false
        return catalog.value.has(p.parameterId) && valueOf(p.parameterId) === p.value
      })
      const updates = resolved.group.parameters
        .filter(param => catalog.value.has(param.parameterId))
        .map(param => ({
          name: param.parameterId,
          value: isActive ? catalog.value.get(param.parameterId)!.modelDefault : param.value,
        }))
      applyValues(updates, duration)
      return { success: true, state: updates.map(update => stateOf(update.name)) }
    }

    // Direct parameter toggle: flip between modelDefault and exp3 target value
    const entry = resolved.entry
    const newValue = entry.currentValue !== entry.modelDefault ? entry.modelDefault : entry.targetValue
    applyValues([{ name: entry.name, value: newValue }], duration)
    return { success: true, state: stateOf(entry.name) }
  }

  /**
   * Save current values as defaults (persisted across restarts).
   */
  function saveDefaults(): ExpressionToolResult {
    if (!modelId.value) {
      return { success: false, error: 'No model loaded.' }
    }

    const defaults: Record<string, number> = {}
    const nextCatalog = new Map(catalog.value)
    for (const [name, entry] of nextCatalog) {
      const value = valueOf(name)
      nextCatalog.set(name, { ...entry, defaultValue: value })
      defaults[name] = value
    }
    catalog.value = nextCatalog

    savePersistedDefaults(modelId.value, defaults)
    return { success: true }
  }

  /**
   * Reset all expressions to their default values.
   */
  function resetAll(): ExpressionToolResult {
    clearAllTimers()
    writeValues(Object.fromEntries([...catalog.value].map(([name, entry]) => [name, entry.modelDefault])))
    return { success: true, state: allNames().map(stateOf) }
  }

  /**
   * Releases this renderer's view of the loaded model. The persisted value
   * record survives so a reload (or the other window) keeps the user's toggles.
   */
  function dispose() {
    clearAllTimers()
    catalog.value = new Map()
    expressionGroups.value = new Map()
    modelId.value = ''
  }

  // ---- LLM exposure --------------------------------------------------------

  function setLlmMode(mode: 'all' | 'none' | 'custom') {
    llmMode.value = mode
  }

  function setLlmExposed(name: string, value: boolean) {
    llmExposedRecord.value = { ...llmExposedRecord.value, [name]: value }
  }

  /** Check if a specific expression group is exposed to LLM tools. */
  function isExposedToLlm(name: string): boolean {
    if (llmMode.value === 'all')
      return true
    if (llmMode.value === 'none')
      return false
    return llmExposedRecord.value[name] ?? false
  }

  /**
   * Expression groups the LLM may act on, plus their parameter shape.
   *
   * Tools use this instead of the raw catalog so an exposure choice made in the
   * settings window actually narrows what the model can reach.
   */
  const llmExposedGroups = computed(() => [...expressionGroups.value.values()]
    .filter(group => isExposedToLlm(group.name)))

  return {
    // State (read-only externally, but reactive)
    expressions,
    modelId,
    expressionGroups,
    llmMode,
    llmExposed,
    llmExposedGroups,

    // Actions
    registerExpressions,
    resolve,
    set,
    get,
    toggle,
    saveDefaults,
    resetAll,
    dispose,
    setLlmMode,
    setLlmExposed,
    isExposedToLlm,
  }
})
