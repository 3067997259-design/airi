import { describe, expect, it } from 'vitest'
import { ref } from 'vue'

import { useSkillShelf } from './use-skill-shelf'

const SKILLS = [
  { toolId: 'flip-text', name: 'flip_text', description: 'Reverses a string.' },
  { toolId: 'clock', name: 'now', description: 'Tells the current time.' },
]

function setup(initialInput = '') {
  const messageInput = ref(initialInput)
  const shelf = useSkillShelf(messageInput, () => SKILLS)
  return { messageInput, shelf }
}

describe('useSkillShelf', () => {
  it('opens on a trailing slash token and filters as the query grows', () => {
    const { messageInput, shelf } = setup('hello /fl')
    shelf.onInput()
    expect(shelf.isOpen.value).toBe(true)
    expect(shelf.filteredSkills.value.map(skill => skill.name)).toEqual(['flip_text'])

    messageInput.value = 'hello /'
    shelf.onInput()
    expect(shelf.filteredSkills.value).toHaveLength(2)
  })

  it('matches the query against name, description, and toolId', () => {
    const { messageInput, shelf } = setup('/reverses')
    shelf.onInput()
    expect(shelf.filteredSkills.value.map(skill => skill.name)).toEqual(['flip_text'])

    messageInput.value = '/clock'
    shelf.onInput()
    expect(shelf.filteredSkills.value.map(skill => skill.name)).toEqual(['now'])
  })

  it('rewrites the slash token to the canonical name and closes on select', () => {
    const { messageInput, shelf } = setup('please /fl')
    shelf.onInput()
    shelf.select(shelf.filteredSkills.value[0]!)
    expect(messageInput.value).toBe('please /flip_text ')
    expect(shelf.isOpen.value).toBe(false)
  })

  it('keeps the leading whitespace outside the rewritten token', () => {
    const { messageInput, shelf } = setup('a\n/fl')
    shelf.onInput()
    shelf.select(shelf.filteredSkills.value[0]!)
    expect(messageInput.value).toBe('a\n/flip_text ')
  })

  it('closes when the slash token disappears', () => {
    const { messageInput, shelf } = setup('/fl')
    shelf.onInput()
    expect(shelf.isOpen.value).toBe(true)
    messageInput.value = '/fl and more text'
    shelf.onInput()
    expect(shelf.isOpen.value).toBe(false)
  })

  it('moves the selection with arrow keys and selects with Enter', () => {
    const { shelf } = setup('/')
    shelf.onInput()
    shelf.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
    expect(shelf.selectedIndex.value).toBe(1)
    shelf.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
    shelf.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
    expect(shelf.selectedIndex.value).toBe(0)

    let prevented = false
    const enter = {
      key: 'Enter',
      preventDefault: () => {
        prevented = true
      },
    }
    const consumed = shelf.onKeyDown(enter)
    expect(consumed).toBe(true)
    expect(prevented).toBe(true)
    expect(shelf.isOpen.value).toBe(false)
  })

  it('ignores keys while closed and lets Enter fall through with no selectable skill', () => {
    const { shelf } = setup('plain text')
    shelf.onInput()
    expect(shelf.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })).toBe(false)

    const { shelf: emptyShelf } = setup('/zzz')
    emptyShelf.onInput()
    expect(emptyShelf.filteredSkills.value).toHaveLength(0)
    expect(emptyShelf.onKeyDown({ key: 'Enter', preventDefault: () => {} })).toBe(false)
  })
})
