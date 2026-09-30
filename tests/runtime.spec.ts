import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ReasoningEffortId, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Orchestrator from '../src/index.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function tool(name: string, args: object, id: string): StreamChunk[] {
  const callId = ToolCallId(id), json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('DSH production runtime', () => {
  it('isolates real spawn contexts, refills two lanes, enforces read-only tools, and returns to the parent', async () => {
    const ctx = new Context(), one = deferred(), two = deferred()
    const started = new Map<string, GenerateOptions>()
    const waiters: Array<{ count: number; resolve: () => void }> = []
    const waitFor = (count: number): Promise<void> => started.size >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve }))
    const childRequests: GenerateOptions[] = []
    const parentRequests: GenerateOptions[] = []
    const childHeaders: Array<{ provider: string; model: string; reasoningEffort?: string }> = []
    let active = 0, peak = 0, writes = 0, parentCalls = 0
    const calls = new Map<string, number>()
    const tasks = ['one', 'two', 'three', 'four'].map(id => ({ id, owner: `worker-${id}`, title: id, role: 'researcher', prompt: `Inspect ${id}`, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: 16_384, outputReserveTokens: 2_048, safetyReserveTokens: 1_024 }))
    const graph = { summary: 'Independent checks', risk: 'low', requiresConfirmation: false, tasks: [...tasks, { ...tasks[0], id: 'review', owner: 'reviewer', title: 'Final review', role: 'reviewer', dependsOn: tasks.map(task => task.id) }] }
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model,
        reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) },
      } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        active += 1; peak = Math.max(peak, active)
        try {
          const texts = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
          const id = texts.join('\n').match(/^Task: ([^.]+)\. Assigned worker:/m)?.[1]
          if (id === undefined) {
            parentRequests.push(options)
            parentCalls += 1
            if (parentCalls === 1) yield* tool('task_orchestrate', { objective: 'Check project', plan: graph }, 'parent-plan')
            else {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, text: 'All assigned checks reviewed.' }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: 'All assigned checks reviewed.' } }
              yield { type: 'finish', reason: { kind: 'stop' } }
            }
            return
          }
          childRequests.push(options)
          if (!started.has(id)) {
            started.set(id, options)
            for (const waiter of waiters) if (started.size >= waiter.count) waiter.resolve()
          }
          const count = (calls.get(id) ?? 0) + 1; calls.set(id, count)
          if (id === 'one') await one.promise
          if (id === 'two') await two.promise
          if (id === 'one' && count === 1) { yield* tool('write', {}, `${id}-${count}`); return }
          const value = id === 'review'
            ? { status: 'approved', summary: 'Reviewed', findings: [], checks: ['all evidence'], nextSteps: [] }
            : { taskId: id, status: 'completed', summary: `${id} checked`, evidence: [`${id} evidence`], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
          yield* tool('structured_output', value, `${id}-${count}`)
        } finally { active -= 1 }
      }
    }
    try {
      await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
      await ctx.plugin(Subagents)
      await ctx.plugin(Spawn, { providerName: 'spawn' })
      await ctx.plugin(Todo, { allowParallelInProgress: true })
      ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'Read a fixture', parameters: {}, execute: async () => [{ type: 'text', text: 'read' }] }))
      ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Forbidden mutation', parameters: {}, execute: async () => { writes += 1; return [{ type: 'text', text: 'written' }] } }))
      await ctx.plugin(Orchestrator, { maxPlanningReminders: 1,
        orchestratorProvider: 'planner-provider', orchestratorModel: 'planner', orchestratorReasoningEffort: 'high',
        subagentLlmProvider: 'worker-provider', subagentModel: 'worker', subagentReasoningEffort: 'low',
        reviewerProvider: 'review-provider', reviewerModel: 'review', reviewerReasoningEffort: 'medium',
      })
      ctx.on('agent/disposed', ({ agent }) => {
        if (agent.session.header.origin === 'subagent') {
          const config = agent.session.requestHeader()?.config
          if (config) childHeaders.push({ provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort })
        }
      })
      const harness = await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['fixture', 'planner-provider', 'worker-provider', 'review-provider'], new Adapter())
      const parent = await harness.create(SessionId('parent-runtime'), { provider: 'fixture', model: 'fixture' })
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Исследуй API, затем проверь backend и frontend, тесты, документацию и финальное ревью. PARENT_SECRET_HISTORY' }], source: { kind: 'user' } }))
      const idle = parent.whenIdle()
      // Fail fast on a settled parent error instead of waiting forever for children that were never created.
      await Promise.race([waitFor(2), idle.then(() => { throw new Error(JSON.stringify(parent.session.snapshotEvents().slice(-3))) })])
      expect(started.size).toBe(2)
      const before = parent.session.snapshotEvents().filter(event => event.type === 'todo/write')
      expect(before[0].data.todos.every(todo => todo.status === 'pending')).toBe(true)
      one.resolve(); await waitFor(3)
      expect(started.has('two')).toBe(true); expect(started.has('three')).toBe(true)
      two.resolve(); await idle
      expect(parentCalls).toBe(2); expect(started.size).toBe(5); expect(peak).toBe(2); expect(writes).toBe(0)
      expect(childRequests.every(request => request.maxTokens === 2_048)).toBe(true)
      expect(childRequests.every(request => !JSON.stringify(request.messages).includes('PARENT_SECRET_HISTORY'))).toBe(true)
      expect(childRequests.every(request => !(request.tools ?? []).some(tool => tool.name === 'write' || tool.name === 'task_orchestrate'))).toBe(true)
      expect(parentRequests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([
        ['planner-provider', 'planner', 'high'], ['planner-provider', 'planner', 'high'],
      ])
      for (const [id, request] of started) expect([request.provider, request.model, request.reasoningEffort]).toEqual(
        id === 'review' ? ['review-provider', 'review', 'medium'] : ['worker-provider', 'worker', 'low'])
      expect(childHeaders).toHaveLength(5)
      expect(childHeaders.filter(header => header.model === 'review')).toEqual([{ provider: 'review-provider', model: 'review', reasoningEffort: 'medium' }])
      expect(parent.session.requestHeader()?.config).toMatchObject({ provider: 'planner-provider', model: 'planner', reasoningEffort: 'high' })
      const finalTodo = [...parent.session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')!
      expect(finalTodo.data.todos.every(todo => todo.status === 'completed')).toBe(true)
      expect(ctx.agents.list()).toHaveLength(1)
      // A child with room for only 192 input tokens must be rejected before reaching the adapter.
      graph.tasks = [graph.tasks[0], graph.tasks[1], graph.tasks.at(-1)!]
      graph.tasks[0].contextBudget = 8_192
      graph.tasks[0].outputReserveTokens = 7_500
      graph.tasks[0].safetyReserveTokens = 500
      graph.tasks[2].dependsOn = ['one', 'two']
      parentCalls = 0; started.clear()
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Исследуй API, backend, frontend, тесты, документацию и ревью с ограниченным бюджетом.' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      expect(started.has('one')).toBe(false)
      expect(started.has('two')).toBe(true)
      const failed = [...parent.session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')!
      expect(JSON.stringify(failed.data)).toContain('assigned context budget')
      expect(ctx.agents.list()).toHaveLength(1)
    } finally {
      one.resolve(); two.resolve(); await ctx.fiber.dispose()
    }
  })
})
