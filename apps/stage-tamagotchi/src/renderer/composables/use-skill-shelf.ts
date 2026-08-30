import type { Ref } from 'vue'

import { computed, ref } from 'vue'

export interface SkillShelfItem {
  toolId: string
  name: string
  description: string
}

/**
 * Matches a trailing slash token like `/flip` or `/flip-text` at the end of
 * the input, preceded by the start of the text or whitespace. The boundary
 * sits in a lookbehind so inserting the chosen skill can keep it untouched.
 */
const SHELF_TRIGGER_REGEX = /(?<=^|\s)\/([\w-]*)$/

/** The only key aspects the shelf reacts to; satisfied by real keyboard events. */
export interface ShelfKeyEvent {
  key: string
  preventDefault: () => void
}

/**
 * State machine behind the chat input skill shelf: a trailing `/name` token
 * opens the shelf, further typing filters it, and selecting a skill rewrites
 * the token to the skill's canonical name — which the skills review store
 * matches at send time to inject the skill's prompt guidance.
 *
 * The composable owns only shelf state; keyboard events reach it through the
 * textarea's existing keydown handler, and rendering stays in the shelf
 * component.
 */
export function useSkillShelf(messageInput: Ref<string>, getSkills: () => SkillShelfItem[]) {
  const skills = computed(getSkills)
  const query = ref<string>()
  const selectedIndex = ref(0)

  const filteredSkills = computed(() => {
    const needle = query.value?.toLocaleLowerCase() ?? ''
    if (!needle)
      return skills.value
    return skills.value.filter(skill => [skill.name, skill.description, skill.toolId]
      .some(field => field.toLocaleLowerCase().includes(needle)))
  })

  const isOpen = computed(() => query.value !== undefined)

  function close() {
    query.value = undefined
  }

  /** Re-evaluates the shelf against the current input; call on every input. */
  function onInput() {
    const match = SHELF_TRIGGER_REGEX.exec(messageInput.value)
    if (!match) {
      close()
      return
    }
    if (query.value === undefined)
      selectedIndex.value = 0
    query.value = match[1]
    if (selectedIndex.value >= filteredSkills.value.length)
      selectedIndex.value = 0
  }

  function move(delta: number) {
    const total = filteredSkills.value.length
    if (total === 0)
      return
    selectedIndex.value = Math.min(total - 1, Math.max(0, selectedIndex.value + delta))
  }

  /**
   * Returns true when the key was consumed by the shelf, so the caller keeps
   * newline and send behavior out of the way while a selection is in
   * progress. Enter with no selectable skill falls through so the empty
   * shelf never traps the send key.
   */
  function onKeyDown(event: ShelfKeyEvent): boolean {
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
      const skill = filteredSkills.value[selectedIndex.value]
      if (!skill)
        return false
      event.preventDefault()
      select(skill)
      return true
    }
    return false
  }

  /** Rewrites the trailing slash token to the skill's canonical name. */
  function select(skill: SkillShelfItem) {
    messageInput.value = messageInput.value.replace(SHELF_TRIGGER_REGEX, `/${skill.name} `)
    close()
  }

  return {
    filteredSkills,
    isOpen,
    selectedIndex,
    close,
    onInput,
    onKeyDown,
    select,
  }
}
