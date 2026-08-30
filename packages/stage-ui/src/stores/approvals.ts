import { ref } from 'vue'

import { useJournalStore } from './journal'

/**
 * Pending approval requests (WIRING-BACKLOG §2 / §3).
 *
 * The main-process coding host emits approval requests; the app shell
 * installs a bridge port that feeds them into this window-scoped store.
 * The chat timeline renders one card per pending request; decisions are
 * forwarded back to the host.
 */
export interface ApprovalRequestView {
  requestId: string
  subject: string
  reason: string
  riskLevel: 'high' | 'medium' | 'low'
  expectedEvidence?: string
  stepId?: string
  planId?: string
}

export type ApprovalDecision = 'approved' | 'rejected' | 'hand-over'

export interface ApprovalsBridgePort {
  onRequest: (listener: (request: ApprovalRequestView) => void) => () => void
  onDecision?: (listener: (payload: { requestId: string, decision: ApprovalDecision, planId?: string }) => void) => () => void
  decide: (requestId: string, decision: ApprovalDecision) => void
}

let bridge: ApprovalsBridgePort | undefined
let disposeRequestListener: (() => void) | undefined
let disposeDecisionListener: (() => void) | undefined

const pending = ref<ApprovalRequestView[]>([])

/** Registers the app-shell bridge; each renderer process installs once. */
export function installApprovalsBridge(next: ApprovalsBridgePort): void {
  disposeRequestListener?.()
  disposeDecisionListener?.()
  bridge = next
  pending.value = []
  disposeRequestListener = next.onRequest((request) => {
    if (!pending.value.some(existing => existing.requestId === request.requestId))
      pending.value = [...pending.value, request]
    useJournalStore().appendActive({
      type: 'approval/asked',
      requestId: request.requestId,
      ...(request.stepId ? { stepId: request.stepId } : {}),
      ...(request.planId ? { planId: request.planId } : {}),
      riskLevel: request.riskLevel,
      reason: request.reason,
      subject: request.subject,
    })
  })
  disposeDecisionListener = next.onDecision?.((payload) => {
    useJournalStore().appendActive({
      type: 'approval/decided',
      requestId: payload.requestId,
      ...(payload.planId ? { planId: payload.planId } : {}),
      decision: payload.decision === 'approved' ? 'allowed-once' : payload.decision === 'rejected' ? 'rejected' : 'cancelled',
    })
    pending.value = pending.value.filter(request => request.requestId !== payload.requestId)
  })
}

export function useApprovalsStore() {
  function decide(requestId: string, decision: ApprovalDecision, planId?: string) {
    bridge?.decide(requestId, decision)
    useJournalStore().appendActive({
      type: 'approval/decided',
      requestId,
      ...(planId ? { planId } : {}),
      decision: decision === 'approved' ? 'allowed-once' : decision === 'rejected' ? 'rejected' : 'cancelled',
    })
    pending.value = pending.value.filter(request => request.requestId !== requestId)
  }

  return {
    pending,
    approve: (requestId: string, planId?: string) => decide(requestId, 'approved', planId),
    reject: (requestId: string, planId?: string) => decide(requestId, 'rejected', planId),
    handOver: (requestId: string, planId?: string) => decide(requestId, 'hand-over', planId),
  }
}
