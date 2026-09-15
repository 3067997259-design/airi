<script setup lang="ts">
import type { ElectronMcpCallToolResult } from '../../../shared/eventa'
import type { ItemCount } from '../../../shared/mc2/explore'
import type { ModRef } from '../../../shared/mc2/knowledge'
/**
 * MC-2a devtools probe: read-only mod-jar ingestion + knowledge facts.
 *
 * Drives `mc2ReadJar` (main), the shared pure parsers, and the memory store:
 * candidates come from jar data, `markVerified` re-writes the same fact after
 * an in-game craft check, and `queryKnowledge` reports tier + modset freshness.
 */
import type { Mc2RecipeCandidate } from '../../../shared/mc2/recipe'
import type { WebLeadCandidate } from '../../../shared/mc2/web'

import { defineInvoke } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { onMounted, onUnmounted, ref } from 'vue'

import { electronMcpCallTool, electronMcpListTools, mc2ReadJar, webFetchInvoke } from '../../../shared/eventa'
import { classifyCraftDelta, classifyCraftObservation, craftExpectation, DEFAULT_EXPLORATION_BUDGET, finishExploration, knowledgeMatchesTarget, recordStep, shouldReuse, startExploration, stepAllowed, stopExploration, summarizeExploration } from '../../../shared/mc2/explore'
import { formatGuideKnowledgeCard, guideEntryPathCandidates, guideIdFromEntryPath, guideOriginId, parseGuideEntry } from '../../../shared/mc2/guide'
import { formatRecipeKnowledgeCard, knowledgeOriginId, knowledgeTags, modsetHash, parseKnowledgeMarker, parseKnowledgeTags } from '../../../shared/mc2/knowledge'
import { entryPathForRecipe, fitsPlayerGrid, parseRecipeCandidate } from '../../../shared/mc2/recipe'
import { extractWebLead, formatWebKnowledgeCard, parseWebMarker, webKnowledgeOriginId } from '../../../shared/mc2/web'
import { createLifeModeClient } from '../../bridges/life-mode'

interface GuideListEntry {
  entryId: string
  title: string
  path: string
  modId: string
}

interface KnowledgeEntry {
  id: string
  originId?: string
  content: string
  tier?: string
  modset?: string
  fresh: boolean
  stale?: boolean
  score?: number
}

declare global {
  interface Window {
    __AIRI_MC2_SMOKE__?: {
      setMods: (mods: ModRef[]) => void
      getModsetHash: () => string
      readJar: (jarPath: string, entryPaths?: string[]) => Promise<{ candidates: Mc2RecipeCandidate[], truncated: boolean }>
      readRecipe: (jarPath: string, recipeId: string) => Promise<{ candidate?: Mc2RecipeCandidate, fits: boolean }>
      listRecipes: (jarPath: string, pattern?: string) => Promise<{ count: number, sample: string[], truncated: boolean }>
      ingestRecipe: (jarPath: string, recipeId: string) => Promise<{ originId: string, card: string, tags: string[] }>
      listGuides: (jarPath: string, pattern?: string) => Promise<{ count: number, sample: GuideListEntry[], truncated: boolean }>
      ingestGuide: (jarPath: string, modId: string, entryId: string) => Promise<{ originId: string, card: string, tags: string[] }>
      webLearn: (urls: string[], terms?: string[]) => Promise<Array<{ originId: string, card: string, injectionSignals: string[] }>>
      webLearnText: (text: string, sourceUrl: string, terms?: string[]) => Promise<{ originId: string, card: string, injectionSignals: string[] }>
      promoteLead: (originId: string, jarPath: string, recipeId: string) => Promise<{ originId: string, card: string, tier: string }>
      markLeadVerified: (originId: string, how: string) => Promise<{ originId: string, card: string, tier: string }>
      markVerified: (jarPath: string, recipeId: string, how: string) => Promise<{ originId: string, card: string }>
      listKnowledge: () => Promise<KnowledgeEntry[]>
      queryKnowledge: (term: string) => Promise<KnowledgeEntry[]>
      exploreOnce: (request: { itemId: string, jarPath: string, modId?: string, allowWeb?: boolean, mode?: 'direct' | 'skill', budget?: { maxSteps?: number, maxDurationMs?: number, maxCraftAttempts?: number } }) => Promise<{ summary: string, phase: string, tier?: string, stopReason?: string, reused: boolean, plan: string[], steps: string[] }>
      exploreIdleOnce: (request: { itemId: string, jarPath: string, modId?: string, allowWeb?: boolean, webUrls?: string[], mode?: 'direct' | 'skill', budget?: { maxSteps?: number, maxDurationMs?: number, maxCraftAttempts?: number } }) => Promise<{ gated?: string, ran: boolean, budgetUsed?: number, result?: { summary: string, phase: string, tier?: string, stopReason?: string, reused: boolean, plan: string[], steps: string[] } }>
      exploreStop: () => { requested: boolean }
      lifeSnapshot: () => Promise<{ config: { mode: string, dailyBudget: number }, budgetUsed: number, budgetDateKey: string, lastGate?: string }>
      lifeSetMode: (mode: 'off' | 'respond' | 'autonomous') => Promise<{ config: { mode: string, dailyBudget: number }, budgetUsed: number, budgetDateKey: string, lastGate?: string }>
      exploreTrace: () => { summary: string, phase: string, tier?: string, stopReason?: string, steps: string[], reused: boolean } | null
      resetKnowledge: () => Promise<{ removed: number }>
    }
  }
}

const status = ref('idle')
let currentMods: ModRef[] = []
let exploreStopRequested = false
let lastExploration: { summary: string, phase: string, tier?: string, stopReason?: string, steps: string[], reused: boolean } | undefined

function modIdOf(recipeId: string): string {
  return recipeId.split(':')[0] ?? 'unknown'
}

function versionOf(modId: string): string {
  return currentMods.find(mod => mod.id === modId)?.version ?? 'unknown'
}

function currentHash(): string {
  return modsetHash(currentMods)
}

function toKnowledgeEntry(fragment: { id: string, originId?: string | null, content: string, tags?: string[] | null }, hash: string, score?: number): KnowledgeEntry {
  // v1: tier/modset come from the card marker; tags are also written to the
  // tag table on insert for a later join-based replacement.
  const parsed = parseKnowledgeMarker(fragment.content)
  const tagParsed = parseKnowledgeTags(fragment.tags ?? [])
  const modset = parsed.modset ?? tagParsed.modset
  const tier = parsed.tier ?? tagParsed.tier
  const fresh = modset === hash
  // A stale verified record degrades to candidate so it is never handled as
  // a fact; a stale lead is already unverified and keeps its tier.
  const downgraded = !fresh && tier === 'verified' ? 'candidate' : tier
  return {
    id: fragment.id,
    ...(fragment.originId ? { originId: fragment.originId } : {}),
    content: fragment.content,
    ...(downgraded ? { tier: downgraded } : {}),
    ...(modset ? { modset } : {}),
    fresh,
    ...(fresh ? {} : { stale: true }),
    ...(score !== undefined ? { score } : {}),
  }
}

onMounted(() => {
  const context = getElectronEventaContext()
  const readJar = defineInvoke(context, mc2ReadJar)
  const fetchPage = defineInvoke(context, webFetchInvoke)
  const mcpList = defineInvoke(context, electronMcpListTools)
  const mcpCall = defineInvoke(context, electronMcpCallTool)

  /** MCP results carry the RPC payload either structured or as one text JSON part. */
  const parseMcpJson = (result: ElectronMcpCallToolResult): Record<string, unknown> | undefined => {
    if (result.structuredContent && typeof result.structuredContent === 'object')
      return result.structuredContent as Record<string, unknown>
    const text = result.content?.find(part => typeof part.text === 'string')?.text
    if (typeof text !== 'string')
      return undefined
    try {
      return JSON.parse(text) as Record<string, unknown>
    }
    catch {
      return undefined
    }
  }

  const readInventoryItems = async (toolName: string): Promise<ItemCount[]> => {
    const result = await mcpCall({ requestId: crypto.randomUUID(), name: toolName, arguments: {} })
    const payload = parseMcpJson(result)
    const root = (payload?.result ?? payload) as { hotbar?: unknown, main?: unknown } | undefined
    const slots = [...(Array.isArray(root?.hotbar) ? root.hotbar : []), ...(Array.isArray(root?.main) ? root.main : [])]
    return slots.flatMap((slot) => {
      const record = slot as { id?: unknown, count?: unknown } | undefined
      return typeof record?.id === 'string' ? [{ id: record.id, count: Number(record.count) || 1 }] : []
    })
  }

  const craftOnce = async (toolName: string, recipeId: string): Promise<{ claimed: boolean, error?: string }> => {
    const result = await mcpCall({ requestId: crypto.randomUUID(), name: toolName, arguments: { recipeId } })
    const payload = parseMcpJson(result) ?? {}
    const root = (payload.result ?? payload) as Record<string, unknown>
    return {
      claimed: root.claimed === true,
      ...(typeof root.error === 'string' ? { error: root.error } : {}),
    }
  }

  const readCandidate = async (jarPath: string, recipeId: string): Promise<Mc2RecipeCandidate> => {
    const entryPath = entryPathForRecipe(recipeId)
    if (!entryPath)
      throw new Error('bad recipe id')
    const result = await readJar({ jarPath, entryPaths: [entryPath] })
    const entry = result.entries[0]
    const candidate = entry ? parseRecipeCandidate(entry.text, entry.path) : undefined
    if (!candidate)
      throw new Error(`recipe not found in jar: ${recipeId}`)
    return candidate
  }

  const removeExisting = async (originId: string): Promise<void> => {
    const memory = useMemoryStore()
    const fragments = await memory.list()
    for (const fragment of fragments.filter(item => item.originId === originId))
      await memory.remove(fragment.id)
  }

  /** Reads the fields a web card stores; used to re-tier without refetching. */
  const findWebFragment = async (originId: string): Promise<{ content: string, url: string }> => {
    const memory = useMemoryStore()
    const fragments = await memory.list()
    const fragment = fragments.find(item => item.originId === originId)
    if (!fragment)
      throw new Error(`web fact not found: ${originId}`)
    const url = parseWebMarker(fragment.content).url
    if (!url)
      throw new Error(`stored fact has no web source: ${originId}`)
    return { content: fragment.content, url }
  }

  /** Re-fetches a lead so promotion/verification rewrites carry fresh cards. */
  const refetchLead = async (url: string) => {
    const page = await fetchPage({ url, maxChars: 100_000 })
    return extractWebLead(page.text, page.finalUrl, Date.now())
  }

  /**
   * Session cache of extracted leads. Promotion and verification rewrite the
   * card and must not depend on a network round trip; after a restart the
   * cache is empty and the URL is re-fetched instead (fixture URLs then fail
   * honestly because they are not resolvable).
   */
  const leadCache = new Map<string, WebLeadCandidate>()

  const leadForRewrite = async (originId: string, url: string): Promise<WebLeadCandidate> => {
    return leadCache.get(originId) ?? await refetchLead(url)
  }

  const readGuideEntries = async (jarPath: string, entryPaths?: string[], patterns?: string[]): Promise<{ entries: ReturnType<typeof parseGuideEntry>[], truncated: boolean }> => {
    const result = await readJar({
      jarPath,
      ...(entryPaths ? { entryPaths } : {}),
      ...(patterns ? { patterns } : {}),
    })
    const guideEntries = result.entries
      .map(entry => ({ entry, identity: guideIdFromEntryPath(entry.path) }))
      .filter((item): item is { entry: { path: string, text: string }, identity: NonNullable<ReturnType<typeof guideIdFromEntryPath>> } => Boolean(item.identity))

    const langByMod = new Map<string, Record<string, string>>()
    for (const modId of new Set(guideEntries.map(item => item.identity.modId))) {
      const langResult = await readJar({ jarPath, entryPaths: [`assets/${modId}/lang/en_us.json`] })
      const langText = langResult.entries[0]?.text
      if (langText) {
        try {
          langByMod.set(modId, JSON.parse(langText))
        }
        catch {
          // A malformed lang file leaves keys visible; parsing continues.
        }
      }
    }

    return { entries: guideEntries.map(item => parseGuideEntry(item.entry.path, item.entry.text, langByMod.get(item.identity.modId) ?? {})), truncated: result.truncated }
  }

  const writeFact = async (card: string, tags: string[], originId: string): Promise<void> => {
    const memory = useMemoryStore()
    const chat = useChatStore()
    const written = await memory.captureTurn(
      {
        sessionId: 'mc2-ingest',
        userText: 'mc2 knowledge ingest',
        assistantText: '',
        scope: chat.memoryScope,
        sourceContext: { sessionId: 'mc2-ingest', sourceType: 'chat', messageId: 'mc2-ingest', neighbors: [] },
      },
      async () => [{
        content: card,
        category: 'life',
        memoryType: 'short_term',
        importance: 8,
        valence: 0,
        arousal: 0,
        tags,
        originId,
        reviewStatus: 'approved',
        factStatus: 'active',
      }],
    )
    // The store swallows persistence errors (it resets the DB and returns an
    // empty list), so a caller that reports success anyway would lie about the
    // fact being stored.
    if (written.length === 0)
      throw new Error('memory capture stored no fragment (embedding backend unavailable?)')
  }

  const ingestRecipeInternal = async (jarPath: string, recipeId: string): Promise<{ originId: string, card: string, tags: string[] }> => {
    const candidate = await readCandidate(jarPath, recipeId)
    const contextForCard = {
      modId: modIdOf(recipeId),
      modVersion: versionOf(modIdOf(recipeId)),
      modsetHash: currentHash(),
    }
    const card = formatRecipeKnowledgeCard(candidate, contextForCard)
    const tags = knowledgeTags(contextForCard)
    const originId = knowledgeOriginId(recipeId)
    await removeExisting(originId)
    await writeFact(card, tags, originId)
    return { originId, card, tags }
  }

  const queryEntries = async (term: string): Promise<KnowledgeEntry[]> => {
    const memory = useMemoryStore()
    const chat = useChatStore()
    const hits = await memory.retrieve(term, 'mc2-query', { scope: chat.memoryScope, recordAccess: false })
    return hits
      .filter(hit => String(hit.originId ?? '').startsWith('mc2:'))
      .map(hit => toKnowledgeEntry(hit, currentHash(), hit.score))
  }

  const markVerifiedInternal = async (jarPath: string, recipeId: string, how: string): Promise<{ originId: string, card: string }> => {
    const candidate = await readCandidate(jarPath, recipeId)
    const contextForCard = {
      modId: modIdOf(recipeId),
      modVersion: versionOf(modIdOf(recipeId)),
      modsetHash: currentHash(),
      verified: { at: Date.now(), how },
    }
    const card = formatRecipeKnowledgeCard(candidate, contextForCard)
    const tags = knowledgeTags(contextForCard)
    const originId = knowledgeOriginId(recipeId)
    await removeExisting(originId)
    await writeFact(card, tags, originId)
    return { originId, card }
  }

  const webLearnInternal = async (urls: string[], terms?: string[]): Promise<Array<{ originId: string, card: string, injectionSignals: string[] }>> => {
    const results: Array<{ originId: string, card: string, injectionSignals: string[] }> = []
    for (const url of urls) {
      const page = await fetchPage({ url, maxChars: 100_000 })
      const lead = extractWebLead(page.text, page.finalUrl, Date.now(), terms ?? [])
      const card = formatWebKnowledgeCard(lead, { modsetHash: currentHash(), webUrl: lead.sourceUrl })
      const tags = knowledgeTags({ modId: 'web', modVersion: 'web', modsetHash: currentHash(), kind: 'web', tier: 'lead' })
      const originId = webKnowledgeOriginId(lead.sourceUrl)
      await removeExisting(originId)
      await writeFact(card, tags, originId)
      leadCache.set(originId, lead)
      results.push({ originId, card, injectionSignals: lead.injectionSignals })
    }
    return results
  }

  const promoteLeadInternal = async (originId: string, jarPath: string, recipeId: string): Promise<{ originId: string, card: string, tier: string }> => {
    const { content, url } = await findWebFragment(originId)
    const lead = await leadForRewrite(originId, url)
    // Only a lead that already names the recipe can be crossed with jar data;
    // otherwise the "consistent" claim would have no basis.
    const namePart = (recipeId.split(':')[1] ?? recipeId).toLowerCase()
    const basis = (leadCache.has(originId) ? lead.excerpt : content).toLowerCase()
    const variants = [namePart, namePart.replace(/_/g, ' ')]
    if (!variants.some(variant => basis.includes(variant)))
      throw new Error('lead does not reference the recipe (no cross-check basis)')
    const candidate = await readCandidate(jarPath, recipeId)
    const card = formatWebKnowledgeCard(lead, {
      modsetHash: currentHash(),
      webUrl: lead.sourceUrl,
      crossedWith: candidate.sourcePath,
    })
    const tags = knowledgeTags({ modId: 'web', modVersion: 'web', modsetHash: currentHash(), kind: 'web', tier: 'candidate' })
    await removeExisting(originId)
    await writeFact(card, tags, originId)
    return { originId, card, tier: 'candidate' }
  }

  /**
   * Deterministic MC-2c loop: reuse fresh knowledge, else read the jar, try the
   * optional web cross-check, run one bounded MCP craft with an inventory
   * check, and record the best tier reached. Budget and user stops are checked
   * between steps; a failed step never produces `verified`.
   */
  const runExploration = async (request: { itemId: string, jarPath: string, modId?: string, allowWeb?: boolean, webUrls?: string[], mode?: 'direct' | 'skill', budget?: { maxSteps?: number, maxDurationMs?: number, maxCraftAttempts?: number } }): Promise<{ summary: string, phase: string, tier?: string, stopReason?: string, reused: boolean, plan: string[], steps: string[] }> => {
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, ...request.budget }
    const target = { itemId: request.itemId, modId: request.modId ?? modIdOf(request.itemId) }
    let state = startExploration(target, budget, { allowWeb: Boolean(request.webUrls?.length), jarReadable: true, craftable: true })
    exploreStopRequested = false

    const guard = (): boolean => {
      if (exploreStopRequested) {
        state = stopExploration(state, 'user')
        return false
      }
      const verdict = stepAllowed(state)
      if (!verdict.allowed) {
        state = stopExploration(state, verdict.reason)
        return false
      }
      return true
    }

    const finish = (reused: boolean) => {
      lastExploration = {
        summary: summarizeExploration(state),
        phase: state.phase,
        ...(state.tier ? { tier: state.tier } : {}),
        ...(state.stopReason ? { stopReason: state.stopReason } : {}),
        steps: state.steps.map(step => step.note ? `${step.kind}:${step.status}:${step.note}` : `${step.kind}:${step.status}`),
        reused,
      }
      return {
        summary: lastExploration.summary,
        phase: state.phase,
        ...(state.tier ? { tier: state.tier } : {}),
        ...(state.stopReason ? { stopReason: state.stopReason } : {}),
        reused,
        plan: state.plan.map(step => step.kind),
        steps: lastExploration.steps,
      }
    }

    if (!guard())
      return finish(false)

    const hits = await queryEntries(target.itemId)
    // Retrieval is semantic; only a fact about this exact recipe may be reused.
    const targetHits = hits.filter(hit => knowledgeMatchesTarget(hit, target))
    if (shouldReuse(targetHits)) {
      const tier = targetHits.some(hit => hit.tier === 'verified') ? 'verified' as const : 'candidate' as const
      state = recordStep(state, 'reuse-check', 'done', Date.now(), `reused ${tier}`)
      state = finishExploration(state, tier)
      return finish(true)
    }
    state = recordStep(state, 'reuse-check', 'done', Date.now(), 'no fresh knowledge')

    if (!guard())
      return finish(false)

    let candidate: Mc2RecipeCandidate
    try {
      candidate = await readCandidate(request.jarPath, target.itemId)
      await ingestRecipeInternal(request.jarPath, target.itemId)
      state = recordStep(state, 'jar', 'done', Date.now(), 'candidate recorded')
    }
    catch (error) {
      const note = (errorMessageFrom(error) ?? 'ingest failed').slice(0, 200)
      state = recordStep(state, 'jar', 'failed', Date.now(), note)
      state = stopExploration(state, 'error')
      return finish(false)
    }

    if (state.plan.some(step => step.kind === 'web')) {
      if (!guard())
        return finish(false)
      try {
        const terms = (target.itemId.split(':')[1] ?? target.itemId).split('_')
        const leads = await webLearnInternal(request.webUrls ?? [], terms)
        let crossed = 0
        for (const lead of leads) {
          try {
            await promoteLeadInternal(lead.originId, request.jarPath, target.itemId)
            crossed += 1
          }
          catch {
            // A lead without a matching recipe stays a lead; not an error.
          }
        }
        state = recordStep(state, 'web', crossed > 0 ? 'done' : 'skipped', Date.now(), `${leads.length} lead(s), ${crossed} crossed`)
      }
      catch (error) {
        state = recordStep(state, 'web', 'failed', Date.now(), (errorMessageFrom(error) ?? 'web failed').slice(0, 200))
      }
    }
    else {
      state = recordStep(state, 'web', 'skipped', Date.now(), 'no web sources provided')
    }

    const expectation = craftExpectation(candidate)
    if (!expectation.expectation) {
      state = recordStep(state, 'craft', 'skipped', Date.now(), expectation.unsupported ?? 'unsupported recipe')
    }
    else if (!fitsPlayerGrid(candidate)) {
      state = recordStep(state, 'craft', 'skipped', Date.now(), 'needs a crafting table (out of the 2x2 grid)')
    }
    else if (request.mode === 'skill') {
      if (!guard())
        return finish(false)
      // MC-2d: the experiment runs through the reviewed `learn-recipe` skill,
      // so the sandboxed program (not the probe) owns the game-side work.
      const skills = useSkillsReviewStore()
      const approved = skills.reviewedSkills.find(skill => skill.toolId === 'learn-recipe')
      if (!approved) {
        state = recordStep(state, 'craft', 'failed', Date.now(), 'skill not approved: learn-recipe')
        state = stopExploration(state, 'error')
        return finish(false)
      }
      try {
        const skillResult = await skills.executeReviewedSkill('learn-recipe', { recipeId: target.itemId })
        const receipt = skillResult as { output?: { id?: string, count?: number }, inventoryDelta?: Record<string, number>, attempts?: number } | string
        if (typeof receipt !== 'object' || receipt === null || !receipt.output?.id || !receipt.inventoryDelta) {
          state = recordStep(state, 'craft', 'failed', Date.now(), `skill returned no craft receipt: ${String(skillResult).slice(0, 160)}`)
          state = stopExploration(state, 'error')
          return finish(false)
        }
        const verdict = classifyCraftDelta(receipt.inventoryDelta, expectation.expectation)
        if (verdict === 'verified') {
          const tagNote = expectation.tagMaterials.length > 0 ? `；tag 材料未计数：${expectation.tagMaterials.join('、')}` : ''
          await markVerifiedInternal(request.jarPath, target.itemId, `技能实验（learn-recipe）：回执 output=${receipt.output.id}×${receipt.output.count}、delta=${JSON.stringify(receipt.inventoryDelta)}${tagNote}`)
          state = recordStep(state, 'craft', 'done', Date.now(), `skill receipt verified (attempts=${receipt.attempts ?? '?'})`)
          state = recordStep(state, 'record', 'done', Date.now(), 'tier=verified')
          state = finishExploration(state, 'verified')
          return finish(false)
        }
        state = recordStep(state, 'craft', 'failed', Date.now(), `skill receipt verdict=${verdict}`)
      }
      catch (error) {
        state = recordStep(state, 'craft', 'failed', Date.now(), (errorMessageFrom(error) ?? 'skill run failed').slice(0, 200))
        state = stopExploration(state, 'error')
        return finish(false)
      }
    }
    else {
      if (!guard())
        return finish(false)
      const tools = await mcpList()
      const craftTool = tools.find(tool => tool.toolName === 'craft_by_recipe')
      const inventoryTool = tools.find(tool => tool.toolName === 'get_inventory')
      if (!craftTool || !inventoryTool) {
        state = recordStep(state, 'craft', 'failed', Date.now(), 'MCP tool missing (craft_by_recipe/get_inventory)')
        state = stopExploration(state, 'error')
        return finish(false)
      }
      const before = await readInventoryItems(inventoryTool.name)
      let claimed = false
      let lastError: string | undefined
      let attempts = 0
      for (attempts = 1; attempts <= budget.maxCraftAttempts; attempts++) {
        if (exploreStopRequested) {
          state = stopExploration(state, 'user')
          return finish(false)
        }
        const attempt = await craftOnce(craftTool.name, target.itemId)
        if (attempt.error) {
          lastError = attempt.error
          break
        }
        if (attempt.claimed) {
          claimed = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 400))
      }
      if (!claimed) {
        state = recordStep(state, 'craft', 'failed', Date.now(), lastError ?? `not claimed in ${attempts - 1} attempt(s)`)
        state = stopExploration(state, lastError ? 'error' : 'craft-attempts')
        return finish(false)
      }
      const after = await readInventoryItems(inventoryTool.name)
      const verdict = classifyCraftObservation(before, after, expectation.expectation)
      if (verdict === 'verified') {
        const tagNote = expectation.tagMaterials.length > 0 ? `；tag 材料未计数：${expectation.tagMaterials.join('、')}` : ''
        await markVerifiedInternal(request.jarPath, target.itemId, `探索循环实测：MCP 合成 + 库存前后核对${tagNote}`)
        state = recordStep(state, 'craft', 'done', Date.now(), 'inventory delta matched')
        state = recordStep(state, 'record', 'done', Date.now(), 'tier=verified')
        state = finishExploration(state, 'verified')
        return finish(false)
      }
      state = recordStep(state, 'craft', verdict === 'inconclusive' ? 'skipped' : 'failed', Date.now(), `inventory verdict=${verdict}`)
    }

    if (exploreStopRequested) {
      state = stopExploration(state, 'user')
      return finish(false)
    }
    state = recordStep(state, 'record', 'done', Date.now(), 'tier=candidate')
    state = finishExploration(state, 'candidate')
    return finish(false)
  }

  window.__AIRI_MC2_SMOKE__ = {
    setMods: (mods) => {
      currentMods = [...mods]
    },
    getModsetHash: currentHash,
    readJar: async (jarPath, entryPaths) => {
      const result = await readJar({ jarPath, ...(entryPaths ? { entryPaths } : {}) })
      return { candidates: result.candidates, truncated: result.truncated }
    },
    readRecipe: async (jarPath, recipeId) => {
      const entryPath = entryPathForRecipe(recipeId)
      if (!entryPath)
        throw new Error('bad recipe id')
      const result = await readJar({ jarPath, entryPaths: [entryPath] })
      const entry = result.entries[0]
      const candidate = entry ? parseRecipeCandidate(entry.text, entry.path) : undefined
      return { ...(candidate ? { candidate } : {}), fits: candidate ? fitsPlayerGrid(candidate) : false }
    },
    listRecipes: async (jarPath, pattern) => {
      const result = await readJar({ jarPath, patterns: [pattern ?? '/recipe/'] })
      return { count: result.candidates.length, sample: result.candidates.slice(0, 5).map(candidate => candidate.recipeId), truncated: result.truncated }
    },
    listGuides: async (jarPath, pattern) => {
      const { entries, truncated } = await readGuideEntries(jarPath, undefined, [pattern ?? 'ae2guide'])
      const parsed = entries.filter(entry => Boolean(entry))
      return {
        count: parsed.length,
        sample: parsed.slice(0, 10).map(entry => ({ entryId: entry!.entryId, title: entry!.title, path: entry!.sourcePath, modId: entry!.modId })),
        truncated,
      }
    },
    ingestGuide: async (jarPath, modId, entryId) => {
      const paths = guideEntryPathCandidates(modId, entryId)
      if (paths.length === 0)
        throw new Error('bad guide entry id')
      const { entries } = await readGuideEntries(jarPath, paths)
      const entry = entries.find(item => item?.entryId === entryId)
      if (!entry)
        throw new Error(`guide entry not found in jar: ${modId}:${entryId}`)
      const contextForCard = {
        modId,
        modVersion: versionOf(modId),
        modsetHash: currentHash(),
        kind: 'guide' as const,
      }
      const card = formatGuideKnowledgeCard(entry, contextForCard)
      const tags = knowledgeTags(contextForCard)
      const originId = guideOriginId(modId, entryId)
      await removeExisting(originId)
      await writeFact(card, tags, originId)
      return { originId, card, tags }
    },
    ingestRecipe: ingestRecipeInternal,
    markVerified: async (jarPath, recipeId, how) => {
      const candidate = await readCandidate(jarPath, recipeId)
      const contextForCard = {
        modId: modIdOf(recipeId),
        modVersion: versionOf(modIdOf(recipeId)),
        modsetHash: currentHash(),
        verified: { at: Date.now(), how },
      }
      const card = formatRecipeKnowledgeCard(candidate, contextForCard)
      const tags = knowledgeTags(contextForCard)
      const originId = knowledgeOriginId(recipeId)
      await removeExisting(originId)
      await writeFact(card, tags, originId)
      return { originId, card }
    },
    webLearn: async (urls, terms) => {
      const results: Array<{ originId: string, card: string, injectionSignals: string[] }> = []
      for (const url of urls) {
        const page = await fetchPage({ url, maxChars: 100_000 })
        const lead = extractWebLead(page.text, page.finalUrl, Date.now(), terms ?? [])
        const card = formatWebKnowledgeCard(lead, { modsetHash: currentHash(), webUrl: lead.sourceUrl })
        const tags = knowledgeTags({ modId: 'web', modVersion: 'web', modsetHash: currentHash(), kind: 'web', tier: 'lead' })
        const originId = webKnowledgeOriginId(lead.sourceUrl)
        await removeExisting(originId)
        await writeFact(card, tags, originId)
        leadCache.set(originId, lead)
        results.push({ originId, card, injectionSignals: lead.injectionSignals })
      }
      return results
    },
    // Feed saved fixture text through the same extraction and card-write path;
    // the network fetch itself is covered by `webLearn` and the main-process
    // SSRF-guarded fetcher.
    webLearnText: async (text, sourceUrl, terms) => {
      const lead = extractWebLead(text, sourceUrl, Date.now(), terms ?? [])
      const card = formatWebKnowledgeCard(lead, { modsetHash: currentHash(), webUrl: lead.sourceUrl })
      const tags = knowledgeTags({ modId: 'web', modVersion: 'web', modsetHash: currentHash(), kind: 'web', tier: 'lead' })
      const originId = webKnowledgeOriginId(lead.sourceUrl)
      await removeExisting(originId)
      await writeFact(card, tags, originId)
      leadCache.set(originId, lead)
      return { originId, card, injectionSignals: lead.injectionSignals }
    },
    promoteLead: async (originId, jarPath, recipeId) => {
      const { content, url } = await findWebFragment(originId)
      const lead = await leadForRewrite(originId, url)
      // Only a lead that already names the recipe can be crossed with jar data;
      // otherwise the "consistent" claim would have no basis.
      const namePart = (recipeId.split(':')[1] ?? recipeId).toLowerCase()
      const basis = (leadCache.has(originId) ? lead.excerpt : content).toLowerCase()
      const variants = [namePart, namePart.replace(/_/g, ' ')]
      if (!variants.some(variant => basis.includes(variant)))
        throw new Error('lead does not reference the recipe (no cross-check basis)')
      const candidate = await readCandidate(jarPath, recipeId)
      const card = formatWebKnowledgeCard(lead, {
        modsetHash: currentHash(),
        webUrl: lead.sourceUrl,
        crossedWith: candidate.sourcePath,
      })
      const tags = knowledgeTags({ modId: 'web', modVersion: 'web', modsetHash: currentHash(), kind: 'web', tier: 'candidate' })
      await removeExisting(originId)
      await writeFact(card, tags, originId)
      return { originId, card, tier: 'candidate' }
    },
    markLeadVerified: async (originId, how) => {
      const { url } = await findWebFragment(originId)
      const lead = await leadForRewrite(originId, url)
      const card = formatWebKnowledgeCard(lead, {
        modsetHash: currentHash(),
        webUrl: lead.sourceUrl,
        verified: { at: Date.now(), how },
      })
      const tags = knowledgeTags({ modId: 'web', modVersion: 'web', modsetHash: currentHash(), kind: 'web' })
      await removeExisting(originId)
      await writeFact(card, tags, originId)
      return { originId, card, tier: 'verified' }
    },
    listKnowledge: async () => {
      const memory = useMemoryStore()
      const fragments = await memory.list('short_term')
      return fragments
        .filter(fragment => String(fragment.originId ?? '').startsWith('mc2:'))
        .map(fragment => toKnowledgeEntry(fragment, currentHash()))
    },
    queryKnowledge: queryEntries,
    resetKnowledge: async () => {
      const memory = useMemoryStore()
      const fragments = await memory.list()
      const targets = fragments.filter(fragment => String(fragment.originId ?? '').startsWith('mc2:'))
      for (const fragment of targets)
        await memory.remove(fragment.id)
      return { removed: targets.length }
    },
    exploreOnce: runExploration,
    exploreIdleOnce: async (request) => {
      const life = createLifeModeClient()
      const snapshot = await life.getSnapshot()
      if (snapshot.config.mode === 'off')
        return { gated: 'mode', ran: false }
      const waitHeartbeat = new Promise<string | undefined>((resolve) => {
        let off: (() => void) | undefined
        const timer = setTimeout(() => {
          off?.()
          resolve(undefined)
        }, 5000)
        off = life.onHeartbeat((payload) => {
          clearTimeout(timer)
          off?.()
          resolve(payload.heartbeatId)
        })
      })
      const test = await life.requestTestHeartbeat()
      if (!test.emitted)
        return { gated: test.gate ?? 'not-emitted', ran: false }
      const heartbeatId = await waitHeartbeat
      if (!heartbeatId)
        return { gated: 'stale-heartbeat', ran: false }
      const claim = await life.claimDecision(heartbeatId)
      if (!claim.claimed)
        return { gated: claim.gate ?? 'claimed-elsewhere', ran: false, budgetUsed: claim.snapshot.budgetUsed }
      const result = await runExploration(request)
      return { ran: true, budgetUsed: claim.snapshot.budgetUsed, result }
    },
    exploreStop: () => {
      exploreStopRequested = true
      return { requested: true }
    },
    lifeSnapshot: async () => {
      const life = createLifeModeClient()
      return await life.getSnapshot()
    },
    lifeSetMode: async (mode) => {
      const life = createLifeModeClient()
      return await life.setConfig({ mode })
    },
    exploreTrace: () => lastExploration ?? null,
  }
  status.value = 'probe ready'
})

onUnmounted(() => {
  delete window.__AIRI_MC2_SMOKE__
})
</script>

<template>
  <div :class="['p-4', 'space-y-2']">
    <h1 :class="['text-lg', 'font-semibold']">
      MC-2 Mod Data
    </h1>
    <p :class="['text-sm', 'text-neutral-500']">
      {{ status }}
    </p>
  </div>
</template>
