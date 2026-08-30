import type { TriggerPanelProvider } from './use-trigger-panel'

import { describe, expect, it } from 'vitest'
import { ref } from 'vue'

import { useTriggerPanel } from './use-trigger-panel'

const slashProvider: TriggerPanelProvider = {
  trigger: '/',
  tokenCharacters: '[\\w-]',
  async getSections(query) {
    const items = [
      { id: 'command:plan', label: '/plan', description: 'Create a session plan.', replacement: '/plan ' },
      { id: 'skill:flip', label: 'flip_text', description: 'Reverse text.', replacement: '/flip_text ' },
    ].filter(item => `${item.label} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
    return [{ id: 'slash', items }]
  },
}

function setup(initialInput = '') {
  const messageInput = ref(initialInput)
  const panel = useTriggerPanel(messageInput, slashProvider)
  return { messageInput, panel }
}

describe('useTriggerPanel', () => {
  it('opens on a trailing provider token and filters asynchronously', async () => {
    const { panel } = setup('hello /plan')
    await panel.onInput()

    expect(panel.isOpen.value).toBe(true)
    expect(panel.items.value.map(item => item.label)).toEqual(['/plan'])
  })

  it('rewrites only the trailing token and keeps its boundary', async () => {
    const { messageInput, panel } = setup('hello\n/pl')
    await panel.onInput()
    panel.select(panel.items.value[0]!)

    expect(messageInput.value).toBe('hello\n/plan ')
    expect(panel.isOpen.value).toBe(false)
  })

  it('keeps a directory selection open for the next level', async () => {
    const messageInput = ref('@sr')
    const provider: TriggerPanelProvider = {
      trigger: '@',
      tokenCharacters: '[\\w\\-./]',
      async getSections(query) {
        return [{
          id: 'workspace',
          items: [{ id: 'dir:src', label: 'src/', description: 'Directory', replacement: `@${query === 'sr' ? 'src/' : query}`, continueInput: true }],
        }]
      },
    }
    const panel = useTriggerPanel(messageInput, provider)
    await panel.onInput()
    panel.select(panel.items.value[0]!)
    await Promise.resolve()

    expect(messageInput.value).toBe('@src/')
    expect(panel.isOpen.value).toBe(true)
  })

  it('uses arrow keys and lets Enter pass through when no item exists', async () => {
    const { panel } = setup('/')
    await panel.onInput()
    panel.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
    expect(panel.selectedIndex.value).toBe(1)

    const emptyProvider: TriggerPanelProvider = {
      ...slashProvider,
      async getSections() {
        return [{ id: 'empty', items: [] }]
      },
    }
    const empty = useTriggerPanel(ref('/missing'), emptyProvider)
    await empty.onInput()
    expect(empty.onKeyDown({ key: 'Enter', preventDefault() {} })).toBe(false)
  })
})
