import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installParentModelPolicy, resolveRoleModels, resolveChildModels, type RoleModels } from '../src/model-policy.ts'

describe('saved role model assignments', () => {
  const inherited = { provider: 'parent', model: 'main', reasoningEffort: ReasoningEffortId('high') }

  it('inherits the complete parent selection and keeps reviewer choices independent', () => {
    expect(resolveChildModels(resolveRoleModels({}), inherited)).toEqual({ worker: inherited, reviewer: inherited })
    const configured = resolveRoleModels({ subagentLlmProvider: 'local', subagentModel: 'small', subagentReasoningEffort: 'low',
      reviewerProvider: 'cloud', reviewerModel: 'review', reviewerReasoningEffort: 'medium' })
    expect(resolveChildModels(configured, inherited)).toEqual({
      worker: { provider: 'local', model: 'small', reasoningEffort: 'low' },
      reviewer: { provider: 'cloud', model: 'review', reasoningEffort: 'medium' },
    })
  })

  it('uses model defaults for explicit assignments without retaining parent reasoning, including the same model', () => {
    const configured = resolveRoleModels({ subagentLlmProvider: 'parent', subagentModel: 'main' })
    expect(resolveChildModels(configured, inherited)).toEqual({ worker: { provider: 'parent', model: 'main' }, reviewer: { provider: 'parent', model: 'main' } })
    expect(resolveChildModels(resolveRoleModels({ subagentModel: 'legacy' }), inherited).worker).toEqual({ provider: 'parent', model: 'legacy' })
  })

  it('rejects incomplete or whitespace assignments before execution', () => {
    for (const value of [{ orchestratorModel: 'main' }, { reviewerProvider: 'local' }, { subagentReasoningEffort: 'high' },
      { subagentLlmProvider: 'local', subagentModel: ' main ' }]) expect(() => resolveRoleModels(value)).toThrow(TypeError)
  })

  it('uses the native selector once per saved change and excludes children without installing a competing selector', async () => {
    const handlers = new Map<string, Function>(), selectModel = vi.fn(async () => ({})), effect = vi.fn()
    const ctx = { on: (name: string, handler: Function) => { handlers.set(name, handler) }, get: () => ({ selectModel }), effect }
    let configured = resolveRoleModels({ orchestratorProvider: 'local', orchestratorModel: 'main', orchestratorReasoningEffort: 'high' })
    installParentModelPolicy(ctx as never, () => configured)
    const agent = { id: SessionId('native-parent'), session: Session.create(SessionId('native-parent')) }
    const next = vi.fn(async () => ({ variables: { provider: 'native', model: 'selection' } }))
    const assemble = () => handlers.get('system-prompt/assemble')!({}, { agent }, next)
    await assemble(); await assemble()
    expect(selectModel).toHaveBeenCalledTimes(1)
    expect(selectModel).toHaveBeenLastCalledWith({ sessionId: agent.id, provider: 'local', model: 'main', reasoningEffort: 'high' })
    configured = resolveRoleModels({ orchestratorProvider: 'local', orchestratorModel: 'main', orchestratorReasoningEffort: 'low' })
    await assemble(); expect(selectModel).toHaveBeenCalledTimes(2)
    await handlers.get('system-prompt/assemble')!({}, { agent: { session: { header: { origin: 'subagent' } } } }, next)
    expect(selectModel).toHaveBeenCalledTimes(2); expect(effect).not.toHaveBeenCalled()
    configured = {}; await assemble(); expect(selectModel).toHaveBeenCalledTimes(2)
    expect(next).toHaveBeenCalledTimes(5)
  })

  it('stops before assembly when the native selector rejects an unavailable saved model', async () => {
    const handlers = new Map<string, Function>(), next = vi.fn()
    const ctx = { on: (name: string, handler: Function) => { handlers.set(name, handler) }, get: () => ({ selectModel: async () => { throw new Error('model unavailable') } }) }
    installParentModelPolicy(ctx as never, () => ({ orchestrator: inherited }))
    await expect(handlers.get('system-prompt/assemble')!({}, { agent: { id: 'missing', session: { header: {} } } }, next)).rejects.toThrow('model unavailable')
    expect(next).not.toHaveBeenCalled()
  })

  it('captures a parent choice before asynchronous prompt assembly and applies a changed choice to the next request', async () => {
    const ctx = new Context(), requests: GenerateOptions[] = []
    let selected: RoleModels = { orchestrator: inherited }
    let entered!: () => void, release!: () => void
    const assembling = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let blocked = false
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
      installParentModelPolicy(ctx, () => selected)
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        if (!blocked) { blocked = true; entered(); await gate }
        return next()
      })
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['fixture', 'parent', 'changed'], new Adapter())
      const parent = await harness.create(SessionId('assembly-policy'), { provider: 'fixture', model: 'fixture' })
      const prompt = () => createUserMessage({ content: [{ type: 'text', text: 'Reply briefly' }], source: { kind: 'user' } })
      parent.followup(prompt())
      const idle = parent.whenIdle()
      await Promise.race([assembling, idle.then(() => { throw new Error('Parent settled before assembly') })])
      selected = { orchestrator: { provider: 'changed', model: 'next' } }
      release(); await idle
      expect(requests[0]).toMatchObject({ provider: 'parent', model: 'main', reasoningEffort: 'high' })
      parent.followup(prompt()); await parent.whenIdle()
      expect(requests[1]).toMatchObject({ provider: 'changed', model: 'next' })
      expect(requests[1].reasoningEffort).toBeUndefined()
      expect(requests[1].messages.flatMap(message => message.content.flatMap(block => block.type === 'text' && block.text.startsWith('[model changed:') ? [block.text] : []))).toMatchInlineSnapshot(`
        [
          "[model changed: assistant turns above this point were generated by parent/main; the session continues with changed/next]",
        ]
      `)
      expect(parent.session.requestHeader()?.config).toMatchObject({ provider: 'changed', model: 'next' })
    } finally { release(); await ctx.fiber.dispose() }
  })
})
