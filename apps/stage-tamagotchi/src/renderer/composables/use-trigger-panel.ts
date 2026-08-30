import type { Ref } from 'vue'

import { computed, shallowRef } from 'vue'

export interface TriggerPanelItem {
  id: string
  label: string
  description: string
  replacement: string
  badge?: string
  continueInput?: boolean
}

export interface TriggerPanelSection {
  id: string
  label?: string
  items: TriggerPanelItem[]
}

export interface TriggerPanelProvider {
  trigger: '/' | '@'
  /** A bracketed regular-expression character class, for example `[\\w-]`. */
  tokenCharacters: string
  getSections: (query: string) => Promise<TriggerPanelSection[]>
}

export interface TriggerPanelKeyEvent {
  key: string
  preventDefault: () => void
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Owns one trigger panel instance without coupling its state to another trigger. */
export function useTriggerPanel(messageInput: Ref<string>, provider: TriggerPanelProvider) {
  const tokenRegex = new RegExp(`(?<=^|\\s)${escapeRegex(provider.trigger)}(${provider.tokenCharacters}*)$`)
  const query = shallowRef<string>()
  const sections = shallowRef<TriggerPanelSection[]>([])
  const selectedIndex = shallowRef(0)
  let requestSequence = 0

  const items = computed(() => sections.value.flatMap(section => section.items))
  const isOpen = computed(() => query.value !== undefined)

  function close() {
    requestSequence += 1
    query.value = undefined
    sections.value = []
  }

  async function onInput() {
    const match = tokenRegex.exec(messageInput.value)
    if (!match) {
      close()
      return
    }

    if (query.value === undefined)
      selectedIndex.value = 0
    query.value = match[1]
    const requestId = ++requestSequence
    try {
      const nextSections = await provider.getSections(query.value)
      if (requestId !== requestSequence)
        return
      sections.value = nextSections
      if (selectedIndex.value >= items.value.length)
        selectedIndex.value = 0
    }
    catch {
      if (requestId === requestSequence)
        sections.value = []
    }
  }

  function move(delta: number) {
    if (items.value.length === 0)
      return
    selectedIndex.value = Math.min(items.value.length - 1, Math.max(0, selectedIndex.value + delta))
  }

  function select(item: TriggerPanelItem) {
    messageInput.value = messageInput.value.replace(tokenRegex, item.replacement)
    if (item.continueInput) {
      void onInput()
      return
    }
    close()
  }

  function onKeyDown(event: TriggerPanelKeyEvent): boolean {
    if (!isOpen.value)
      return false
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return true
    }
    if (event.key === 'Escape') {
      close()
      return true
    }
    if (event.key === 'Enter') {
      const item = items.value[selectedIndex.value]
      if (!item)
        return false
      event.preventDefault()
      select(item)
      return true
    }
    return false
  }

  return {
    sections,
    items,
    isOpen,
    selectedIndex,
    close,
    onInput,
    onKeyDown,
    select,
  }
}
