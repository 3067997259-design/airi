import type { Tool } from '@xsai/shared-chat'

import { useGithubConfigStore } from '@proj-airi/stage-ui/stores/github-config'
import { tool } from '@xsai/tool'
import { z } from 'zod'

// -- LLM Tools: github_* (COMMAND-PLAN follow-up: repo watch / PR babysitting)
//
// She watches her own repository through the GitHub REST API: a doorbell
// workflow drops events into an `airi-task` labeled issue, these tools let
// her read and answer them, and the long-goal loop (life tick → plan steps)
// decides when. Read-only without a token; posting comments needs a token
// with Issues write. Config lives in localStorage via the github-config
// store so the settings page and the tools share one source.

const API_BASE = 'https://api.github.com'
const MAX_BODY_CHARS = 6000
const MAX_LIST_ITEMS = 8

interface GithubFetchResult {
  ok: boolean
  status: number
  body: string
}

async function githubFetch(path: string, init?: { method?: string, body?: string }): Promise<GithubFetchResult> {
  const config = useGithubConfigStore()
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (config.pat.trim())
    headers.Authorization = `Bearer ${config.pat.trim()}`

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    body: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…(truncated)` : text,
  }
}

function repoPath(action: string): string | undefined {
  const repo = useGithubConfigStore().repo.trim()
  if (!repo.includes('/'))
    return undefined
  return `/repos/${repo}/${action}`
}

function notConfigured(): string {
  return 'GitHub is not configured. Set the repository (owner/name) in Settings → GitHub Watch; add a personal access token to post comments.'
}

function formatIssue(issue: { number: number, title: string, html_url?: string, body?: string | null, labels?: Array<{ name?: string }> }): string {
  const labels = (issue.labels ?? []).map(label => label.name).filter(Boolean).join(',')
  const body = (issue.body ?? '').slice(0, 300)
  return `#${issue.number} · ${issue.title}${labels ? ` [${labels}]` : ''}\n  ${issue.html_url ?? ''}\n  ${body}${body.length >= 300 ? '…' : ''}`
}

/** Lists the doorbell inbox: open issues labeled `airi-task`. */
export async function executeGithubListTaskIssues(): Promise<string> {
  const path = repoPath('issues?labels=airi-task&state=open&per_page=20')
  if (!path)
    return notConfigured()

  const { ok, status, body } = await githubFetch(path)
  if (!ok)
    return `GitHub list task issues failed (HTTP ${status}): ${body}`

  let issues: Array<{ number: number, title: string, html_url?: string, body?: string | null, labels?: Array<{ name?: string }> }> = []
  try {
    issues = JSON.parse(body)
  }
  catch {
    return `GitHub returned unexpected content: ${body.slice(0, 200)}`
  }
  if (issues.length === 0)
    return 'No open airi-task issues — the inbox is empty.'
  return issues.slice(0, MAX_LIST_ITEMS).map(formatIssue).join('\n\n')
}

/** Lists open pull requests in the watched repository. */
export async function executeGithubListOpenPrs(): Promise<string> {
  const path = repoPath('pulls?state=open&per_page=20')
  if (!path)
    return notConfigured()

  const { ok, status, body } = await githubFetch(path)
  if (!ok)
    return `GitHub list open PRs failed (HTTP ${status}): ${body}`

  let prs: Array<{ number: number, title: string, html_url?: string, draft?: boolean, user?: { login?: string } }> = []
  try {
    prs = JSON.parse(body)
  }
  catch {
    return `GitHub returned unexpected content: ${body.slice(0, 200)}`
  }
  if (prs.length === 0)
    return 'No open pull requests.'
  return prs.slice(0, MAX_LIST_ITEMS)
    .map(pr => `#${pr.number} · ${pr.title}${pr.draft ? ' [draft]' : ''} · by ${pr.user?.login ?? 'unknown'}\n  ${pr.html_url ?? ''}`)
    .join('\n\n')
}

/** Fetches one PR's description and per-file change summary. */
export async function executeGithubGetPr(input: { number: number }): Promise<string> {
  const basePath = repoPath(`pulls/${input.number}`)
  if (!basePath)
    return notConfigured()

  const pr = await githubFetch(basePath)
  if (!pr.ok)
    return `GitHub get PR failed (HTTP ${pr.status}): ${pr.body.slice(0, 300)}`

  let meta: { title?: string, state?: string, draft?: boolean, user?: { login?: string }, body?: string | null, head?: { sha?: string } } = {}
  try {
    meta = JSON.parse(pr.body)
  }
  catch {
    return `GitHub returned unexpected content: ${pr.body.slice(0, 200)}`
  }

  const files = await githubFetch(`${basePath}/files?per_page=20`)
  let filesText = '(files unavailable)'
  if (files.ok) {
    try {
      const list = JSON.parse(files.body) as Array<{ filename: string, additions: number, deletions: number, patch?: string }>
      filesText = list.map((file) => {
        const patch = file.patch ? `\n    ${file.patch.slice(0, 600).replaceAll('\n', '\n    ')}` : ''
        return `  ${file.filename} (+${file.additions}/-${file.deletions})${patch}`
      }).join('\n')
    }
    catch {
      filesText = files.body.slice(0, 500)
    }
  }

  return [
    `PR #${input.number}: ${meta.title ?? ''} (${meta.state ?? 'unknown'}, by ${meta.user?.login ?? 'unknown'})`,
    `head: ${meta.head?.sha ?? 'unknown'}`,
    `Description: ${(meta.body ?? '').slice(0, 800)}`,
    'Files:',
    filesText,
  ].join('\n')
}

/** Fetches CI status for one PR's head commit. */
export async function executeGithubGetPrChecks(input: { number: number }): Promise<string> {
  const basePath = repoPath(`pulls/${input.number}`)
  if (!basePath)
    return notConfigured()

  const pr = await githubFetch(basePath)
  if (!pr.ok)
    return `GitHub get PR failed (HTTP ${pr.status}): ${pr.body.slice(0, 300)}`
  let headSha = ''
  try {
    headSha = JSON.parse(pr.body).head?.sha ?? ''
  }
  catch {
    return `GitHub returned unexpected content: ${pr.body.slice(0, 200)}`
  }
  if (!headSha)
    return `PR #${input.number} has no head commit to check.`

  const checksPath = repoPath(`commits/${headSha}/check-runs?per_page=20`)
  if (!checksPath)
    return notConfigured()
  const checks = await githubFetch(checksPath)
  if (!checks.ok)
    return `GitHub get checks failed (HTTP ${checks.status}): ${checks.body.slice(0, 300)}`

  let runs: Array<{ name: string, status: string, conclusion?: string | null }> = []
  try {
    runs = (JSON.parse(checks.body).check_runs ?? [])
  }
  catch {
    return `GitHub returned unexpected content: ${checks.body.slice(0, 200)}`
  }
  if (runs.length === 0)
    return `No check runs recorded for ${headSha.slice(0, 7)}.`
  return runs.map(run => `${run.name}: ${run.conclusion ?? run.status}`).join('\n')
}

/** Posts one comment on a PR (PRs share the issue comment endpoint). */
export async function executeGithubPostPrComment(input: { number: number, body: string }): Promise<string> {
  const config = useGithubConfigStore()
  if (!config.pat.trim()) {
    return 'Posting comments requires a personal access token with Issues write. Set it in Settings → GitHub Watch; read-only tools work without it.'
  }
  const path = repoPath(`issues/${input.number}/comments`)
  if (!path)
    return notConfigured()

  const { ok, status, body } = await githubFetch(path, {
    method: 'POST',
    body: JSON.stringify({ body: input.body }),
  })
  if (!ok)
    return `GitHub post comment failed (HTTP ${status}): ${body.slice(0, 300)}`

  let url = ''
  try {
    url = JSON.parse(body).html_url ?? ''
  }
  catch {}
  return `Comment posted: ${url}`
}

// xsai's tool() resolves asynchronously, so the registration surface is a
// promise of the tool list — same shape as planTools().
const tools: Promise<Tool>[] = [
  tool({
    name: 'github_list_task_issues',
    description: 'List the open issues labeled airi-task in the watched repository — the doorbell inbox of events worth attention (new PRs, CI failures). Read-only.',
    execute: () => executeGithubListTaskIssues(),
    parameters: z.object({}),
  }),
  tool({
    name: 'github_list_open_prs',
    description: 'List open pull requests in the watched repository. Read-only.',
    execute: () => executeGithubListOpenPrs(),
    parameters: z.object({}),
  }),
  tool({
    name: 'github_get_pr',
    description: 'Read one pull request: description and per-file change summary. Use before commenting so the review quotes actual changes.',
    execute: ({ number }: { number: number }) => executeGithubGetPr({ number }),
    parameters: z.object({
      number: z.number().describe('The pull request number.'),
    }),
  }),
  tool({
    name: 'github_get_pr_checks',
    description: 'Read CI check runs for one pull request\'s head commit.',
    execute: ({ number }: { number: number }) => executeGithubGetPrChecks({ number }),
    parameters: z.object({
      number: z.number().describe('The pull request number.'),
    }),
  }),
  tool({
    name: 'github_post_pr_comment',
    description: 'Post one review comment on a pull request. Quote concrete files and lines; one comment per review instead of many small ones. Requires a configured token.',
    execute: ({ number, body }: { number: number, body: string }) => executeGithubPostPrComment({ number, body }),
    parameters: z.object({
      number: z.number().describe('The pull request number.'),
      body: z.string().describe('The comment text (Markdown).'),
    }),
  }),
]

export const githubTools = async (): Promise<Tool[]> => Promise.all(tools)
