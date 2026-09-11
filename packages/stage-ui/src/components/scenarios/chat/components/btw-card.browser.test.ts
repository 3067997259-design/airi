import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import BtwCard from './btw-card.vue'

import { useBtwStore } from '../../../../stores/btw'

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: {} },
  })
}

describe('btw card bounds', () => {
  it('keeps the exchange history scrollable and collapsible', async () => {
    // ROOT CAUSE (#10): the card grew with every exchange and pushed the chat
    // history and main composer out of the viewport.
    const pinia = createPinia()
    setActivePinia(pinia)
    const btw = useBtwStore()
    btw.state = {
      status: 'idle',
      exchanges: Array.from({ length: 8 }, (_, index) => ({ question: `question ${index}`, answer: `answer ${index}` })),
      streaming: '',
    }

    render(BtwCard, {
      props: { active: true },
      global: { plugins: [pinia, createTestI18n()] },
    })

    const card = document.querySelector('[data-testid="chat-btw-card"]') as HTMLElement | null
    const history = document.querySelector('[data-testid="chat-btw-history"]') as HTMLElement | null
    const toggle = document.querySelector('[data-testid="chat-btw-toggle"]') as HTMLButtonElement | null
    expect(card?.className).toContain('max-h-72')
    expect(history?.className).toContain('overflow-y-auto')
    expect(history?.style.display).not.toBe('none')
    expect(toggle).not.toBeNull()

    toggle!.click()
    await nextTick()
    expect(history?.style.display).toBe('none')

    toggle!.click()
    await nextTick()
    expect(history?.style.display).not.toBe('none')
  })
})
