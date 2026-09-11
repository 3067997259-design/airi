import { describe, expect, it } from 'vitest'

import { normalizeMemoryRetrievalQuery } from './query-normalization'

describe('normalizeMemoryRetrievalQuery', () => {
  it('removes request framing and keeps the retrieval action', () => {
    expect(normalizeMemoryRetrievalQuery('我想在修改 Student Hub 的接口之前，先看一下现有测试，避免协议已经变了。'))
      .toBe('修改 Student Hub 的接口之前；先看一下现有测试；避免协议已经变了')
  })

  it('preserves negation clauses', () => {
    expect(normalizeMemoryRetrievalQuery('请帮我找出我不想成为创业者的相关记忆。'))
      .toContain('不想成为创业者')
  })

  it('returns short queries without inventing content', () => {
    expect(normalizeMemoryRetrievalQuery('奖学金材料')).toBe('奖学金材料')
    expect(normalizeMemoryRetrievalQuery('')).toBe('')
  })
})
