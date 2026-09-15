import type { Tool } from '@xsai/shared-chat'

import type { ExecutableTool, ToolDefinition, ToolRegistration, ToolRegistrationInput } from './tools'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DuplicateToolRegistrationError, resolveEvidenceAuthor, useLlmToolsStore } from './tools'

function createExecutableTool(id: string, name = id): ExecutableTool {
  return {
    id,
    type: 'function',
    function: {
      name,
      description: `Execute ${name}.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    execute: vi.fn(async () => ({ ok: true })),
  }
}

function createRegistration(input: Partial<ToolRegistrationInput> & { toolId: string }): ToolRegistrationInput {
  return {
    toolId: input.toolId,
    toolName: input.toolName ?? input.toolId,
    ownerKind: input.ownerKind ?? 'plugin',
    ownerId: input.ownerId ?? 'owner-a',
    execution: input.execution ?? { kind: 'extension_host', chain: ['plugin', input.ownerId ?? 'owner-a'] },
    ...(input.approvedContentHash ? { approvedContentHash: input.approvedContentHash } : {}),
  }
}

describe('useLlmToolsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('stores serializable definitions and keeps executors outside Pinia state', async () => {
    const store = useLlmToolsStore()
    const executableTool = createExecutableTool('plugin:chess:play', 'play_chess')
    const toolOptions = {} as Parameters<Tool['execute']>[1]

    store.addTools(executableTool)

    expect(store.tools).toEqual([{
      id: 'plugin:chess:play',
      type: 'function',
      function: {
        name: 'play_chess',
        description: 'Execute play_chess.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    }])
    expect(JSON.stringify(store.$state)).not.toContain('execute')
    await expect(store.activeTools[0]?.execute({}, toolOptions)).resolves.toEqual({ ok: true })
  })

  it('replaces a registration owned by the same owner and keeps its list position', async () => {
    const store = useLlmToolsStore()
    const first = createExecutableTool('plugin:chess:play', 'play_chess')
    const second = createExecutableTool('plugin:chess:play', 'play_chess_v2')
    const other = createExecutableTool('mcp:list', 'builtIn_mcpListTools')

    await store.addRegisteredTools(
      { tool: first, registration: createRegistration({ toolId: 'plugin:chess:play', toolName: 'play_chess' }) },
      { tool: other, registration: createRegistration({ toolId: 'mcp:list', toolName: 'builtIn_mcpListTools', ownerKind: 'mcp', ownerId: 'demo-server', execution: { kind: 'remote', chain: ['mcp', 'demo-server'] } }) },
    )
    await store.addRegisteredTools({ tool: second, registration: createRegistration({ toolId: 'plugin:chess:play', toolName: 'play_chess' }) })

    expect(store.tools.map(tool => tool.id)).toEqual([
      'plugin:chess:play',
      'mcp:list',
    ])
    expect(store.tools[0]?.function.name).toBe('play_chess_v2')
    expect(store.registrations).toHaveLength(2)
    expect(store.registrations[0]?.toolName).toBe('play_chess')
  })

  it('rejects a second owner for the same toolId', async () => {
    const store = useLlmToolsStore()
    await store.addRegisteredTools({
      tool: createExecutableTool('plugin:chess:play', 'play_chess'),
      registration: createRegistration({ toolId: 'plugin:chess:play', ownerId: 'owner-a' }),
    })

    await expect(store.addRegisteredTools({
      tool: createExecutableTool('plugin:chess:play', 'play_chess'),
      registration: createRegistration({ toolId: 'plugin:chess:play', ownerId: 'owner-b' }),
    })).rejects.toThrow(DuplicateToolRegistrationError)

    await expect(store.addRegisteredTools({
      tool: createExecutableTool('plugin:chess:play', 'play_chess'),
      registration: createRegistration({ toolId: 'plugin:chess:play', ownerId: 'owner-b' }),
    })).rejects.toMatchObject({ conflicting: 'toolId', existingOwnerId: 'owner-a' })
    expect(store.registrations).toHaveLength(1)
  })

  it('rejects a model-facing name already owned by another toolId', async () => {
    const store = useLlmToolsStore()
    await store.addRegisteredTools({
      tool: createExecutableTool('plugin:chess:play', 'play_chess'),
      registration: createRegistration({ toolId: 'plugin:chess:play', toolName: 'play_chess' }),
    })

    await expect(store.addRegisteredTools({
      tool: createExecutableTool('plugin:chess:other', 'play_chess'),
      registration: createRegistration({ toolId: 'plugin:chess:other', toolName: 'play_chess' }),
    })).rejects.toMatchObject({ conflicting: 'toolName', existingOwnerId: 'owner-a' })
    expect(store.tools.map(tool => tool.id)).toEqual(['plugin:chess:play'])
  })

  it('commits registrations through cloneable state without executors', async () => {
    const store = useLlmToolsStore()
    await store.addRegisteredTools({
      tool: createExecutableTool('self-authored:demo', 'demo_tool'),
      registration: createRegistration({
        toolId: 'self-authored:demo',
        toolName: 'demo_tool',
        ownerKind: 'reviewed_skill',
        ownerId: 'demo',
        execution: { kind: 'coding_sandbox', chain: ['skill', 'demo'] },
        approvedContentHash: 'hash-a',
      }),
    })

    expect(store.registrations).toEqual([expect.objectContaining({
      toolId: 'self-authored:demo',
      toolName: 'demo_tool',
      ownerKind: 'reviewed_skill',
      ownerId: 'demo',
      approvedContentHash: 'hash-a',
      execution: { kind: 'coding_sandbox', chain: ['skill', 'demo'] },
    })])
    expect(store.registrations[0]?.registeredAt).toBeTypeOf('number')
    expect(JSON.stringify(store.$state)).not.toContain('execute')
  })

  it('removes one or many tools by id', () => {
    const store = useLlmToolsStore()
    store.addTools(
      createExecutableTool('plugin:chess:play'),
      createExecutableTool('plugin:chess:reset'),
      createExecutableTool('mcp:list'),
    )

    store.removeToolById('plugin:chess:play')
    expect(store.tools.map(tool => tool.id)).toEqual([
      'plugin:chess:reset',
      'mcp:list',
    ])

    store.removeToolsByIds('plugin:chess:reset', 'mcp:list')
    expect(store.tools).toEqual([])
    expect(store.activeTools).toEqual([])
  })

  it('aborts an in-flight call on removal and turns its late result into revoked', async () => {
    const store = useLlmToolsStore()
    let observedSignal: AbortSignal | undefined
    const tool = createExecutableTool('plugin:slow', 'slow_tool')
    tool.execute = vi.fn(async (_input: unknown, options?: { abortSignal?: AbortSignal }) => {
      observedSignal = options?.abortSignal
      return await new Promise((resolve) => {
        options?.abortSignal?.addEventListener('abort', () => resolve({ status: 'late-result' }), { once: true })
      })
    })
    await store.addRegisteredTools({ tool, registration: createRegistration({ toolId: 'plugin:slow', toolName: 'slow_tool' }) })

    const executing = store.activeTools[0]!.execute!({}, {} as Parameters<Tool['execute']>[1])
    await store.removeToolsByIds('plugin:slow')

    expect(observedSignal?.aborted).toBe(true)
    await expect(executing).resolves.toContain('"status":"revoked"')
    expect(store.registrations).toEqual([])
  })

  it('returns an unavailable executor when synchronized state has no local executor', () => {
    const store = useLlmToolsStore()
    const definition: ToolDefinition = {
      id: 'plugin:chess:play',
      type: 'function',
      function: {
        name: 'play_chess',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    }
    const toolOptions = {} as Parameters<Tool['execute']>[1]

    store.$patch((state) => {
      state.tools = [definition]
    })

    expect(store.activeTools[0]?.execute({}, toolOptions)).toBe('Tool "play_chess" is not available now.')
  })

  it('keeps explicit tools out of the default list and resolves them by name', () => {
    const store = useLlmToolsStore()
    const defaultTool = createExecutableTool('plugin:chess:play', 'play_chess')
    const explicitTool = {
      ...createExecutableTool('tamagotchi:journal', 'image_journal'),
      defaultActive: false,
    }

    store.addTools(defaultTool, explicitTool)

    expect(store.activeTools.map(tool => tool.function.name)).toEqual(['play_chess'])
    expect(store.getToolsByNames('image_journal').map(tool => tool.function.name)).toEqual(['image_journal'])
  })
})

describe('resolveEvidenceAuthor', () => {
  const reviewed = [{ toolId: 'skill-a', contentHash: 'hash-a' }]
  const registration = (overrides: Partial<ToolRegistration> & Pick<ToolRegistration, 'ownerKind' | 'ownerId'>): ToolRegistration => ({
    toolId: 'tool-1',
    toolName: 'tool_1',
    execution: { kind: 'host', chain: ['builtin'] },
    registeredAt: 0,
    ...overrides,
  })

  it('maps host, mcp, and game owners to their buckets', () => {
    expect(resolveEvidenceAuthor(registration({ ownerKind: 'builtin', ownerId: 'host' }), reviewed)).toBe('builtin')
    expect(resolveEvidenceAuthor(registration({ ownerKind: 'mcp', ownerId: 'server', execution: { kind: 'remote', chain: ['mcp', 'server'] } }), reviewed)).toBe('remote_agent')
    expect(resolveEvidenceAuthor(registration({ ownerKind: 'game_adapter', ownerId: 'game-host', execution: { kind: 'remote', chain: ['game-adapter', 'game-host'] } }), reviewed)).toBe('game')
  })

  it('grades a game receipt by its checked flag', () => {
    const gameRegistration = registration({ ownerKind: 'game_adapter', ownerId: 'game-host', execution: { kind: 'remote', chain: ['game-adapter', 'game-host'] } })
    expect(resolveEvidenceAuthor(gameRegistration, reviewed, JSON.stringify({ status: 'ok', checked: true }))).toBe('game_checked')
    expect(resolveEvidenceAuthor(gameRegistration, reviewed, JSON.stringify({ status: 'ok', checked: false }))).toBe('game')
    expect(resolveEvidenceAuthor(gameRegistration, reviewed, { status: 'ok', checked: true })).toBe('game_checked')
    expect(resolveEvidenceAuthor(gameRegistration, reviewed, 'not json')).toBe('game')
    expect(resolveEvidenceAuthor(gameRegistration, reviewed, undefined)).toBe('game')
  })

  it('never trusts an unregistered tool', () => {
    expect(resolveEvidenceAuthor(undefined, reviewed)).toBe('untrusted_plugin')
  })

  it('trusts a reviewed skill only while its approved hash matches', () => {
    const owned = registration({
      ownerKind: 'reviewed_skill',
      ownerId: 'skill-a',
      execution: { kind: 'coding_sandbox', chain: ['skill', 'skill-a'] },
      approvedContentHash: 'hash-a',
    })
    expect(resolveEvidenceAuthor(owned, reviewed)).toBe('reviewed_self_authored')
    expect(resolveEvidenceAuthor({ ...owned, approvedContentHash: 'old-hash' }, reviewed)).toBe('untrusted_plugin')
    expect(resolveEvidenceAuthor(owned, [])).toBe('untrusted_plugin')
  })

  it('does not let a plugin wrapper raise the trust of its execution chain', () => {
    const wrapper = registration({
      ownerKind: 'plugin',
      ownerId: 'adapter-x',
      execution: { kind: 'extension_host', chain: ['plugin', 'adapter-x', 'skill:skill-a'] },
      approvedContentHash: 'hash-a',
    })
    expect(resolveEvidenceAuthor(wrapper, reviewed)).toBe('reviewed_self_authored')
    // Without the approved hash, or with a stale one, the wrapper stays untrusted.
    expect(resolveEvidenceAuthor({ ...wrapper, approvedContentHash: undefined }, reviewed)).toBe('untrusted_plugin')
    expect(resolveEvidenceAuthor({ ...wrapper, approvedContentHash: 'stale' }, reviewed)).toBe('untrusted_plugin')

    const pluginOnly = registration({
      ownerKind: 'plugin',
      ownerId: 'plugin-a',
      execution: { kind: 'extension_host', chain: ['plugin', 'plugin-a'] },
    })
    expect(resolveEvidenceAuthor(pluginOnly, reviewed)).toBe('untrusted_plugin')
  })

  it('reads the package chain hash instead of the package digest', () => {
    const packageTool = registration({
      ownerKind: 'plugin',
      ownerId: 'demo-pack@1.0.0',
      execution: { kind: 'coding_sandbox', chain: ['plugin:demo-pack@package-digest', 'skill:skill-a@hash-a'] },
      approvedContentHash: 'package-digest',
    })
    expect(resolveEvidenceAuthor(packageTool, reviewed)).toBe('reviewed_self_authored')
    // A skill whose reviewed bytes moved on: the chain hash no longer matches.
    expect(resolveEvidenceAuthor(packageTool, [{ toolId: 'skill-a', contentHash: 'new-hash' }])).toBe('untrusted_plugin')
    // A chain without the embedded hash falls back to the registration hash.
    const adapterLike = registration({
      ownerKind: 'plugin',
      ownerId: 'demo-pack@1.0.0',
      execution: { kind: 'coding_sandbox', chain: ['plugin:demo-pack@package-digest', 'skill:skill-a'] },
      approvedContentHash: 'hash-a',
    })
    expect(resolveEvidenceAuthor(adapterLike, reviewed)).toBe('reviewed_self_authored')
    expect(resolveEvidenceAuthor({ ...adapterLike, approvedContentHash: 'package-digest' }, reviewed)).toBe('untrusted_plugin')
  })
})
