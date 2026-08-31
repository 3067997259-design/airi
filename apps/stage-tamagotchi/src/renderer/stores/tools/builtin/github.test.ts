import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executeGithubGetPr, executeGithubListTaskIssues, executeGithubPostPrComment, githubTools } from './github'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

describe('github watch tools', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fetchMock.mockReset()
  })

  it('registers the five watch tools', async () => {
    const tools = await githubTools()
    expect(tools.map(tool => tool.function.name)).toEqual([
      'github_list_task_issues',
      'github_list_open_prs',
      'github_get_pr',
      'github_get_pr_checks',
      'github_post_pr_comment',
    ])
  })

  it('guides to configuration when the repo is unset', async () => {
    const { useGithubConfigStore } = await import('@proj-airi/stage-ui/stores/github-config')
    useGithubConfigStore().repo = ''

    const result = await executeGithubListTaskIssues()

    expect(result).toContain('GitHub is not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists doorbell issues compactly and sends the auth header when a token exists', async () => {
    const { useGithubConfigStore } = await import('@proj-airi/stage-ui/stores/github-config')
    useGithubConfigStore().pat = 'ghp_test'
    fetchMock.mockResolvedValue(jsonResponse([
      { number: 7, title: 'PR inbox (PR inbox)', html_url: 'https://github.com/x/y/issues/7', labels: [{ name: 'airi-task' }], body: 'PR #5 opened' },
    ]))

    const result = await executeGithubListTaskIssues()

    expect(result).toContain('#7 · PR inbox')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer ghp_test' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/issues?labels=airi-task')
  })

  it('summarizes a PR with its file changes', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/pulls/5'))
        return Promise.resolve(jsonResponse({ title: 'Add footer', state: 'open', user: { login: 'zero' }, body: 'Adds the footer', head: { sha: 'abc123' } }))
      if (String(url).includes('/pulls/5/files'))
        return Promise.resolve(jsonResponse([{ filename: 'src/Footer.vue', additions: 10, deletions: 2, patch: '@@ -1 +1 @@' }]))
      return Promise.resolve(jsonResponse({}, false, 404))
    })

    const result = await executeGithubGetPr({ number: 5 })

    expect(result).toContain('PR #5: Add footer')
    expect(result).toContain('src/Footer.vue (+10/-2)')
  })

  it('refuses to post comments without a token', async () => {
    const { useGithubConfigStore } = await import('@proj-airi/stage-ui/stores/github-config')
    useGithubConfigStore().pat = ''

    const result = await executeGithubPostPrComment({ number: 5, body: 'hi' })

    expect(result).toContain('requires a personal access token')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
