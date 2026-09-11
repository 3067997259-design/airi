import type { PlanSpec, PlanState } from '@proj-airi/core-agent'

import type { PlanView } from '../../../../stores/plans'

import en from '@proj-airi/i18n/locales/en'

import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'

import ChatPlanCenter from './plan-center.vue'

function createEnglishI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
  })
}

const STEPS: PlanSpec['steps'] = [{
  id: 'verify',
  lane: 'coding',
  intent: 'Run the focused tests',
  allowedTools: ['bash'],
  expectedEvidence: [{ source: 'tool_result', description: 'tests pass' }],
  riskLevel: 'low',
  approvalRequired: false,
}]

function planView(
  id: string,
  goal: string,
  options: {
    horizon?: PlanSpec['horizon']
    sessionId?: string
    status?: PlanView['status']
    unverified?: string[]
    longGoal?: PlanState['longGoal']
  } = {},
): PlanView {
  return {
    id,
    goal,
    spec: { goal, horizon: options.horizon ?? 'session', steps: STEPS },
    state: {
      ...(options.longGoal ? { longGoal: options.longGoal } : {}),
      currentStepId: 'verify',
      completedSteps: [],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
      ...(options.unverified ? { unverifiedSteps: options.unverified } : {}),
    } as PlanState,
    status: options.status ?? 'in_progress',
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    updatedAt: 1,
  }
}

async function renderCenter(plans: PlanView[], sessionId = 'current') {
  const screen = await render(ChatPlanCenter, {
    props: { plans, sessionId, sessionLabels: { 'session-old': 'Old conversation' } },
    global: { plugins: [createPinia(), createEnglishI18n()] },
  })
  return screen
}

describe('chat plan center', () => {
  it('counts active and history lanes without rendering archived cards yet', async () => {
    const screen = await renderCenter([
      planView('live', 'Live current work', { sessionId: 'current' }),
      planView('live-other', 'Running elsewhere', { horizon: 'long', sessionId: 'session-old', longGoal: { lifecycle: 'running', constraintVersion: 1 } }),
      planView('done', 'Finished goal', { horizon: 'long', sessionId: 'current', status: 'completed', longGoal: { lifecycle: 'completed', constraintVersion: 1 } }),
    ])

    await expect.element(screen.getByTestId('chat-plan-center-toggle')).toBeVisible()
    expect(screen.container.textContent).toContain('2 active')
    expect(screen.container.textContent).toContain('History 1')
    // Archived cards stay out of the surface until the history section opens,
    // but they are never dropped: ending work moves evidence, it does not
    // delete it.
    await expect.element(screen.getByText('Finished goal')).not.toBeInTheDocument()
  })

  it('groups other-session goals under their source and emits navigation', async () => {
    const screen = await renderCenter([
      planView('live-other', 'Running elsewhere', { horizon: 'long', sessionId: 'session-old', longGoal: { lifecycle: 'running', constraintVersion: 1 } }),
    ])

    await screen.getByTestId('chat-plan-center-toggle').click()
    await expect.element(screen.getByTestId('chat-plan-center-other-sessions')).toBeVisible()
    const source = screen.getByTestId('chat-plan-open-source')
    await expect.element(source).toHaveTextContent('Old conversation')
    await source.click()

    expect(screen.emitted('openSession')).toEqual([['session-old']])
  })

  it('keeps a finished card inspectable in the history section', async () => {
    const screen = await renderCenter([
      planView('done', 'Finished goal', { horizon: 'long', sessionId: 'current', status: 'completed', longGoal: { lifecycle: 'completed', constraintVersion: 1 } }),
    ])

    await screen.getByTestId('chat-plan-center-toggle').click()
    await screen.getByTestId('chat-plan-history-toggle').click()

    // The archived record keeps its steps and evidence; archiving moves the
    // card between surfaces, it does not delete the work record.
    await screen.getByText('Finished goal').click()
    await expect.element(screen.getByText('verify · Run the focused tests')).toBeVisible()
  })

  it('counts completed plans that still lack verification on the collapsed bar', async () => {
    const screen = await renderCenter([
      planView('done-unverified', 'Done without evidence', {
        horizon: 'long',
        sessionId: 'current',
        status: 'completed',
        unverified: ['verify'],
        longGoal: { lifecycle: 'completed', constraintVersion: 1 },
      }),
    ])

    // Invariant 6: the record must not read as a clean success. It leaves the
    // timeline but the bar names the unverified count, and the collapsed
    // history card carries the amber flag inside the archive.
    await expect.element(screen.getByTestId('chat-plan-center-unverified-count')).toHaveTextContent('1 unverified')
    expect(screen.container.textContent).toContain('History 1')
    await screen.getByTestId('chat-plan-center-toggle').click()
    await screen.getByTestId('chat-plan-history-toggle').click()
    await expect.element(screen.getByTestId('chat-plan-unverified-flag')).toBeVisible()
  })

  it('offers Run now on a live long goal', async () => {
    const screen = await renderCenter([
      planView('live-long', 'Live long goal', { horizon: 'long', sessionId: 'current', longGoal: { lifecycle: 'running', constraintVersion: 1 } }),
    ])

    await screen.getByTestId('chat-plan-center-toggle').click()
    await expect.element(screen.getByTestId('chat-plan-center-current')).toBeVisible()

    // The card is collapsed until its header is clicked; the action lives in
    // the expanded body.
    await screen.getByText('Live long goal').click()
    await expect.element(screen.getByTestId('chat-plan-run-now')).toBeVisible()
  })
})
