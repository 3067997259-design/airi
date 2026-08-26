import type { Tool } from '@xsai/shared-chat'

import type { McpToolDescriptor, McpToolRuntime } from './mcp'

import { describe, expect, it, vi } from 'vitest'

import { createMcpNativeTools, normalizeMcpInputSchema, sanitizeMcpToolName } from './mcp'

describe('sanitizeMcpToolName', () => {
  it('joins sanitized server and tool names with the mcp_ prefix', () => {
    expect(sanitizeMcpToolName('filesystem', 'search')).toBe('mcp_filesystem_search')
    expect(sanitizeMcpToolName('student-hub', 'get_dashboard')).toBe('mcp_student_hub_get_dashboard')
  })

  it('collapses unsupported characters and repeated separators', () => {
    expect(sanitizeMcpToolName('a b', 'c/d')).toBe('mcp_a_b_c_d')
    expect(sanitizeMcpToolName('游戏', '查课表')).toBe('mcp_x_x')
    expect(sanitizeMcpToolName('s..erver', 'tool::name')).toBe('mcp_s_erver_tool_name')
  })

  it('keeps names within the 64-character provider limit and stable across calls', () => {
    const long = sanitizeMcpToolName('a'.repeat(60), 'b'.repeat(80))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long.startsWith('mcp_')).toBe(true)
    expect(sanitizeMcpToolName('a'.repeat(60), 'b'.repeat(80))).toBe(long)
    expect(long).not.toBe(sanitizeMcpToolName('a'.repeat(60), 'b'.repeat(81)))
  })
})

describe('normalizeMcpInputSchema', () => {
  it('passes through a well-formed object schema', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    expect(normalizeMcpInputSchema(schema)).toEqual(schema)
  })

  it('forces type object and an object properties map', () => {
    expect(normalizeMcpInputSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(normalizeMcpInputSchema('nope' as unknown as Record<string, unknown>)).toEqual({ type: 'object', properties: {} })
    expect(normalizeMcpInputSchema([1, 2] as unknown as Record<string, unknown>)).toEqual({ type: 'object', properties: {} })
    expect(normalizeMcpInputSchema({ type: 'array' })).toEqual({ type: 'object', properties: {} })
    expect(normalizeMcpInputSchema({ properties: [] })).toEqual({ type: 'object', properties: {} })
  })

  it('drops a non-array required field', () => {
    expect(normalizeMcpInputSchema({ type: 'object', required: 'q' })).not.toHaveProperty('required')
  })
})

describe('createMcpNativeTools', () => {
  const toolOptions = {} as Parameters<Tool['execute']>[1]
  const runtime: McpToolRuntime = {
    listTools: vi.fn(),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  }

  it('creates one native tool per descriptor and forwards qualified names with object arguments', async () => {
    const descriptors: McpToolDescriptor[] = [
      {
        serverName: 'filesystem',
        name: 'filesystem::search',
        toolName: 'search',
        description: 'Search files.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]

    const tools = await Promise.all(createMcpNativeTools(descriptors, runtime))
    expect(tools).toHaveLength(1)
    expect(tools[0].function.name).toBe('mcp_filesystem_search')
    expect(tools[0].function.description).toContain('[MCP:filesystem]')
    expect(tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    })

    const result = await tools[0].execute?.({ query: 'hello' }, toolOptions)
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(runtime.callTool).toHaveBeenCalledWith({
      name: 'filesystem::search',
      arguments: { query: 'hello' },
    })
  })

  it('disambiguates sanitized name collisions with a counter suffix', async () => {
    const descriptors: McpToolDescriptor[] = [
      { serverName: 'a-b', name: 'a-b::c', toolName: 'c', inputSchema: {} },
      { serverName: 'a', name: 'a::b_c', toolName: 'b_c', inputSchema: {} },
    ]
    const tools = await Promise.all(createMcpNativeTools(descriptors, runtime))
    const names = tools.map(tool => tool.function.name)
    expect(names[0]).toBe('mcp_a_b_c')
    expect(names[1]).toBe('mcp_a_b_c_2')
    expect(new Set(names).size).toBe(2)
  })
})
