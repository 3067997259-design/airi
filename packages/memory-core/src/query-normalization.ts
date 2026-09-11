/**
 * Creates a shorter retrieval query from a natural-language request.
 *
 * The function removes only common request framing. It keeps negation clauses
 * and action words, so a long request does not become a different claim.
 *
 * @example
 * normalizeMemoryRetrievalQuery('我想在修改接口前先检查现有测试，避免协议已经变了。')
 * // => '修改接口前先检查现有测试；避免协议已经变了'
 */
export function normalizeMemoryRetrievalQuery(query: string): string {
  const compact = query.trim().replace(/\s+/g, ' ')
  if (!compact)
    return ''

  const clauses = compact
    .split(/[，。！？；,!?;]+/u)
    .map(clause => clause.trim())
    .filter(Boolean)

  const withoutRequestFraming = clauses.map((clause) => {
    let next = clause
    next = next.replace(/^(请问|请|麻烦你?|帮我|能否|可以吗|我想要?|我希望|这次|目前|最近|为了)\s*/u, '')
    next = next.replace(/^我们?(想|希望|需要|准备)\s*/u, '')
    next = next.replace(/^在(?=.*(之前|前))/u, '')
    return next.trim()
  }).filter(Boolean)

  if (withoutRequestFraming.length === 0)
    return compact

  // Retain every clause with a negation marker. These markers change the
  // meaning of a preference and must not be lost during normalization.
  const negationClauses = withoutRequestFraming.filter(clause => /[不没未无]|避免|禁止/u.test(clause))
  const actionClauses = withoutRequestFraming.filter(clause => /先|优先|检查|核对|确认|修改|使用|喜欢|习惯|偏好|需要|准备/u.test(clause))
  const selected = [...new Set([...actionClauses, ...negationClauses])]
  const normalized = (selected.length > 0 ? selected : withoutRequestFraming).join('；')

  return normalized.length <= 240 ? normalized : normalized.slice(0, 240)
}
