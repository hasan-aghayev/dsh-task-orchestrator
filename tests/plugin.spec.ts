import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.ts'

function plugin(overrides: Partial<Config> = {}) {
  const handlers = new Map<string, Function>()
  const tools = new Map<string, ToolDefinition>()
  const effects: Array<() => unknown> = []
  const sections: Array<string | (() => string)> = []
  const ctx = {
    on: (name: string, callback: Function) => { handlers.set(name, callback); return () => handlers.delete(name) },
    effect: (create: () => () => unknown) => { effects.push(create()); return () => undefined },
    agents: { get: () => undefined },
    tools: {
      get: (name: string) => tools.get(name),
      register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      guard: (callback: Function) => { handlers.set('guard', callback); return () => undefined },
    },
    systemPrompt: { section: (section: { text: string | (() => string) }) => { sections.push(section.text); return () => undefined } },
    subagents: { getProvider: () => undefined, start: () => { throw new Error('unexpected automatic child start') } },
  }
  apply(ctx as never, { ...Config({}), hardContextTokens: { get: () => 65_536 }, totalContextTokens: { get: () => 98_304 }, ...overrides } as never)
  return { handlers, tools, effects, sections }
}

describe('parent planning policy', () => {
  it('uses live mode changes for the next turn and updates the planning prompt', async () => {
    let mode: 'hybrid' | 'off' = 'hybrid'
    const f = plugin({ mode: { get: () => mode } as never })
    const agent = { session: Session.create('parent' as never) }
    const messages = [{ content: [{ type: 'text', text: 'Implement plugin backend, frontend, tests, docs and review the whole project.' }] }]
    const payload = { agent, turn: 1, step: 1, messages }
    expect((await f.handlers.get('agent/pre-step')!(payload, async () => ({ kind: 'enter', messages }))).messages).toHaveLength(2)
    mode = 'off'
    expect(typeof f.sections[0] === 'function' ? f.sections[0]() : '').toContain('Automatic orchestration is disabled')
    expect((await f.handlers.get('agent/pre-step')!({ ...payload, turn: 2 }, async () => ({ kind: 'enter', messages }))).messages).toHaveLength(1)
    expect(f.handlers.get('guard')!({ agent, name: 'write' })).toBeUndefined()
    await Promise.all(f.effects.map(dispose => dispose()))
  })
  it('requests a concrete parent plan without starting a keyword-generated child graph', async () => {
    const f = plugin(), session = Session.create('parent' as never)
    session.append('turn/start', { turn: 1 })
    const steering: unknown[] = []
    const agent = { session, steer: (message: unknown) => steering.push(message) }
    const payload = { agent, turn: 1, step: 1, messages: [{ content: [{ type: 'text', text: 'Исследуй API, затем сделай backend и frontend, добавь тесты, документацию и финальное ревью.' }] }] }
    const next = async () => ({ kind: 'enter', messages: payload.messages })
    const decision = await f.handlers.get('agent/pre-step')!(payload, next)
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1].content[0].text).toContain('at least 2 independent')
    expect(f.handlers.get('guard')!({ agent, name: 'write' })).toContain('Save an assigned plan')
    expect(f.handlers.get('guard')!({ agent, name: 'subagent' })).toContain('bypasses')
    expect(f.handlers.get('guard')!({ agent, name: 'task_orchestrate' })).toBeUndefined()
    await expect(f.tools.get('task_orchestrate')!.execute({ objective: 'Inspect' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow(/plan/)
    const stop = { agent, turn: 1, signal: new AbortController().signal }
    f.handlers.get('agent/turn-stopping')!(stop); f.handlers.get('agent/turn-stopping')!(stop)
    expect(steering).toHaveLength(2)
    expect(() => f.handlers.get('agent/turn-stopping')!(stop)).toThrow(/incomplete/)
    await Promise.all(f.effects.map(dispose => dispose()))
  })

  it('keeps short questions on the ordinary path and preserves a rejected pre-step', async () => {
    const f = plugin(), agent = { session: Session.create('parent' as never) }
    const messages = [{ content: [{ type: 'text', text: 'Show the current branch' }] }]
    const next = async () => ({ kind: 'enter', messages })
    expect((await f.handlers.get('agent/pre-step')!({ agent, turn: 1, step: 1, messages }, next)).messages).toHaveLength(1)
    expect(f.handlers.get('guard')!({ agent, name: 'write' })).toBeUndefined()
    const reject = { kind: 'reject', reason: 'stopped' }
    expect(await f.handlers.get('agent/pre-step')!({ agent, turn: 2, step: 1, messages }, async () => reject)).toBe(reject)
    await Promise.all(f.effects.map(dispose => dispose()))
  })
})
