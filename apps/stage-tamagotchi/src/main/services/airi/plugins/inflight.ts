/**
 * CP-2 in-flight plugin tool call registry.
 *
 * One AbortController per request; calls are indexed by their owning
 * extension so an unload, disable, revoke, or worker crash can terminate
 * every call of that extension in bounded time. Late results stay handled by
 * the existing registration-revocation semantics (`revoked` in the renderer).
 */
export interface InFlightCall {
  requestId: string
  ownerExtensionId: string
  controller: AbortController
}

export class InFlightCallRegistry {
  private readonly byRequest = new Map<string, InFlightCall>()
  private readonly byOwner = new Map<string, Set<string>>()

  register(requestId: string, ownerExtensionId: string): AbortController {
    const controller = new AbortController()
    this.byRequest.set(requestId, { requestId, ownerExtensionId, controller })
    const owned = this.byOwner.get(ownerExtensionId) ?? new Set<string>()
    owned.add(requestId)
    this.byOwner.set(ownerExtensionId, owned)
    return controller
  }

  /** Removes one finished call; safe for unknown ids. */
  settle(requestId: string): void {
    const call = this.byRequest.get(requestId)
    if (!call)
      return
    this.byRequest.delete(requestId)
    const owned = this.byOwner.get(call.ownerExtensionId)
    owned?.delete(requestId)
    if (owned?.size === 0)
      this.byOwner.delete(call.ownerExtensionId)
  }

  /** The controller for one request, when it is still in flight. */
  get(requestId: string): AbortController | undefined {
    return this.byRequest.get(requestId)?.controller
  }

  /** Aborts every in-flight call of one extension; returns how many were aborted. */
  abortByOwner(ownerExtensionId: string, reason: string): number {
    const owned = this.byOwner.get(ownerExtensionId)
    if (!owned)
      return 0
    let aborted = 0
    for (const requestId of [...owned]) {
      const call = this.byRequest.get(requestId)
      if (!call)
        continue
      call.controller.abort(new Error(reason))
      aborted += 1
    }
    return aborted
  }

  /** Aborts every in-flight call (host shutdown). */
  abortAll(reason: string): number {
    let aborted = 0
    for (const call of this.byRequest.values()) {
      call.controller.abort(new Error(reason))
      aborted += 1
    }
    return aborted
  }

  get size(): number {
    return this.byRequest.size
  }
}
