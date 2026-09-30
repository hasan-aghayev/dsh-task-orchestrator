import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { runPlan, type RunnerHost, type RunnerPolicy } from '../src/runner.ts'
import { readPlan, compactReport } from '../src/validation.ts'
import type { TaskPlan, WorkerReport } from '../src/types.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function report(id: string, fields: Partial<WorkerReport> = {}): WorkerReport {
  return { taskId: id, status: 'completed', summary: `${id} checked`, evidence: [`${id} evidence`], changedFiles: [], tests: [], blockers: [], nextSteps: [], ...fields }
}

function plan(ids = ['one', 'two', 'three', 'four']): TaskPlan {
  const tasks = ids.map(id => ({ id, owner: `worker-${id}`, title: id, role: 'researcher' as const, prompt: `Inspect ${id}`, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: 8_192, outputReserveTokens: 2_048, safetyReserveTokens: 1_024 }))
  return readPlan({ summary: 'Independent checks and review', risk: 'low', requiresConfirmation: false,
    tasks: [...tasks, { ...tasks[0], id: 'review', owner: 'final-reviewer', title: 'Review evidence', role: 'reviewer', dependsOn: ids }],
  }, 16_384)
}

const policy: RunnerPolicy = {
  maxWorkers: 6, minParallelTasks: 2, maxConcurrentAgents: 2, maxChildStarts: 12, maxAttemptsPerTask: 2,
  allowWrites: false, allowParallelWrites: false, requireReview: true, maxHandoffChars: 16_384,
  contextCompactionChars: 512, concurrencyByContext: [{ maxContextTokens: 49_152, maxActiveGenerations: 2 }, { maxContextTokens: 150_000, maxActiveGenerations: 1 }],
}

function fixture(seed?: ReturnType<Session['snapshotEvents']>, signal = new AbortController().signal) {
  const session = Session.create('parent' as never, seed)
  session.append('turn/start', { turn: 1 })
  const starts: Array<{ id: string; request: SubagentStartRequest; result: ReturnType<typeof deferred<unknown>> }> = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  let disposed = 0
  const host: RunnerHost = {
    parent: { session } as never, signal, readOnlyFilter: { allow: ['read', 'grep'] }, writeFilter: { deny: ['subagent'] }, childIsLive: () => false,
    start: async (request, task) => {
      const result = deferred<unknown>()
      starts.push({ id: task.id, request, result })
      for (const waiter of waiters) if (starts.length >= waiter.count) waiter.resolve()
      request.signal.addEventListener('abort', () => result.reject(new Error('cancelled')), { once: true })
      return {
        id: `child-${task.id}-${starts.length}` as never, localAgent: undefined,
        result: result.promise.then(structured => ({ stopReason: 'completed' as const, output: [], structured })),
        dispose: async () => { disposed += 1 },
      }
    },
  }
  const started = async (count: number) => {
    if (starts.length >= count) return
    await new Promise<void>(resolve => waiters.push({ count, resolve }))
  }
  const finish = (id: string, output: unknown = id === 'review' ? { status: 'approved', summary: 'Evidence checked', findings: [], checks: ['reports and files checked'], nextSteps: [] } : report(id)) => {
    [...starts].reverse().find(start => start.id === id)!.result.resolve(output)
  }
  const state = () => {
    const event = [...session.snapshotEvents()].reverse().find(event => event.type === 'todo/write')!
    return event.data as { todos: Array<{ content: string; status: string }>; orchestration: { result: { taskStates: Array<{ taskId: string; state: string; reason: string }> } } }
  }
  return { session, host, starts, started, finish, state, get disposed() { return disposed } }
}

describe('saved TODO execution', () => {
  it('saves assigned TODO before any child and runs four tasks as two active, two queued', async () => {
    const f = fixture()
    const pending = runPlan(f.host, policy, { objective: 'Check project', plan: plan(), planOnly: false, executeWrites: false })
    await f.started(2)
    const firstTodo = f.session.snapshotEvents().find(event => event.type === 'todo/write')!
    expect(firstTodo.data.todos.every(todo => todo.status === 'pending')).toBe(true)
    expect(firstTodo.data.todos[0].content).toContain('worker-one')
    expect(f.starts.map(start => start.id)).toEqual(['one', 'two'])
    expect(f.state().orchestration.result.taskStates.map(task => task.state)).toEqual(['ACTIVE', 'ACTIVE', 'QUEUED', 'QUEUED', 'QUEUED'])
    f.finish('two')
    await f.started(3)
    expect(f.starts.at(-1)?.id).toBe('three')
    expect(f.state().orchestration.result.taskStates.find(task => task.taskId === 'one')?.state).toBe('ACTIVE')
    f.finish('three')
    await f.started(4)
    f.finish('one'); f.finish('four')
    await f.started(5)
    expect(f.starts.at(-1)?.id).toBe('review')
    f.finish('review')
    const result = await pending
    expect(result.status).toBe('completed')
    expect(result.agentsStarted).toBe(5)
    expect(f.disposed).toBe(5)
    expect(f.state().todos.every(todo => todo.status === 'completed')).toBe(true)
    expect(f.starts[0].request.agentOptions?.maxTokens).toBe(2_048)
    expect(f.starts[0].request.toolFilter).toEqual({ allow: ['read', 'grep'] })
    expect(f.starts[0].request.prompt[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Task: one.') })
    // The native log reader accepts checkpoint metadata without a custom required event type.
    expect(Session.create('restored' as never, f.session.snapshotEvents()).snapshotEvents().slice(0, f.session.snapshotEvents().length)).toEqual(f.session.snapshotEvents())
    expect(f.state().todos.map(todo => `${todo.status}: ${todo.content}`)).toMatchInlineSnapshot(`
      [
        "completed: [one] one — worker-one (completed)",
        "completed: [two] two — worker-two (completed)",
        "completed: [three] three — worker-three (completed)",
        "completed: [four] four — worker-four (completed)",
        "completed: [review] Review evidence — final-reviewer (Evidence checked)",
      ]
    `)
  })

  it('starts no child for a missing reviewer, cyclic graph, or fewer than two independent tasks', async () => {
    const f = fixture()
    const graph = plan(['one', 'two'])
    graph.tasks = graph.tasks.filter(task => task.role !== 'reviewer')
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })).rejects.toThrow(/reviewer/)
    const chain = plan(['one', 'two']); chain.tasks[1].dependsOn = ['one']
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: chain, planOnly: false, executeWrites: false })).rejects.toThrow(/independent/)
    const cycle = plan(['one', 'two']); cycle.tasks[0].dependsOn = ['two']; cycle.tasks[1].dependsOn = ['one']
    expect(() => readPlan(cycle, 16_384)).toThrow(/cycle/)
    const duplicate = plan(['one', 'two']); duplicate.tasks[1].prompt = duplicate.tasks[0].prompt
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: duplicate, planOnly: false, executeWrites: false })).rejects.toThrow(/duplicate prompts/)
    expect(f.starts).toHaveLength(0)
  })

  it('keeps a plan-only TODO and starts it only on a later explicit run', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const saved = await runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: true, executeWrites: false })
    expect(saved.status).toBe('plan-only'); expect(f.starts).toHaveLength(0)
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: saved.runId })
    await f.started(2); f.finish('one'); f.finish('two'); await f.started(3); f.finish('review')
    expect((await pending).status).toBe('completed')
  })

  it('returns a precise missing-file request and resumes only that task when new data arrives', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    f.finish('one', report('one', { status: 'needs_more_context', summary: 'File required', needs: [{ kind: 'NEED_FILE', reason: 'Provide config.json' }] }))
    f.finish('two')
    const blocked = await pending
    expect(blocked.status).toBe('blocked'); expect(blocked.agentsStarted).toBe(2)
    expect(blocked.taskStates?.find(state => state.taskId === 'one')?.reason).toContain('NEED_FILE')
    const noData = await runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: blocked.runId })
    expect(noData.agentsStarted).toBe(2)
    expect(f.starts).toHaveLength(2)
    f.host.childIsLive = () => true
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: blocked.runId, resumeContext: { one: 'new data' } })).rejects.toThrow(/still live/)
    f.host.childIsLive = () => false
    const resume = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: blocked.runId, resumeContext: { one: 'config.json contents: enabled=true' } })
    await f.started(3)
    expect(f.starts.at(-1)?.id).toBe('one')
    expect(f.starts.at(-1)?.request.prompt[0]).toMatchObject({ text: expect.stringContaining('enabled=true') })
    f.finish('one'); await f.started(4); f.finish('review')
    const result = await resume
    expect(result.status).toBe('completed'); expect(result.agentsStarted).toBe(4)
    expect(f.starts.filter(start => start.id === 'two')).toHaveLength(1)
  })

  it('keeps successful evidence when a sibling returns invalid JSON', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2); f.finish('one'); f.finish('two', { taskId: 'wrong' })
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.workers.find(worker => worker.taskId === 'one')?.evidence).toEqual(['one evidence'])
    expect(result.workers.find(worker => worker.taskId === 'two')?.blockers[0]).toContain('taskId')
    expect(f.disposed).toBe(2)
  })

  it('requires actual reviewer approval before marking the run complete', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2); f.finish('one'); f.finish('two'); await f.started(3)
    f.finish('review', { status: 'changes_requested', summary: 'Missing test', findings: ['Add test'], checks: [], nextSteps: ['Fix and review'] })
    const result = await pending
    expect(result.status).toBe('blocked'); expect(result.review?.status).toBe('changes_requested')
  })

  it('cancels and disposes active children while preserving the saved TODO', async () => {
    const controller = new AbortController(), f = fixture(undefined, controller.signal)
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: plan(), planOnly: false, executeWrites: false })
    await f.started(2); controller.abort()
    const result = await pending
    expect(result.status).toBe('failed'); expect(f.disposed).toBe(2); expect(f.starts).toHaveLength(2)
    expect(result.taskStates?.every(state => state.state === 'CANCELLED')).toBe(true)
  })

  it('runs a large-context task alone, then fills both slots immediately', async () => {
    const f = fixture(), graph = plan(['one', 'two', 'three'])
    graph.tasks[0].contextBudget = 65_536
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(1); expect(f.starts).toHaveLength(1)
    f.finish('one'); await f.started(3); expect(f.starts.map(start => start.id)).toEqual(['one', 'two', 'three'])
    f.finish('two'); f.finish('three'); await f.started(4); f.finish('review')
    expect((await pending).status).toBe('completed')
  })

  it('bounds the whole compacted report rather than each list item', () => {
    const long = Array.from({ length: 8 }, () => 'x'.repeat(200))
    expect(compactReport(report('one', { evidence: long, tests: long, blockers: long, changedFiles: long, nextSteps: long }), 512).length).toBeLessThanOrEqual(512)
  })

  it('recovers a saved interrupted task without repeating completed siblings', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    f.finish('two')
    // Simulate the durable snapshot at a crash: one child is active, the other has already finished.
    await new Promise<void>((resolve, reject) => {
      let checks = 0
      const check = () => {
        if (f.state().orchestration.result.taskStates.find(state => state.taskId === 'two')?.state === 'DONE') resolve()
        else if (++checks > 64) reject(new Error('Completed sibling did not publish its checkpoint'))
        else queueMicrotask(check)
      }
      check()
    })
    const seed = f.session.snapshotEvents()
    const checkpoint = JSON.parse(JSON.stringify(f.state().orchestration))
    f.finish('one'); await f.started(3); f.finish('review'); await pending
    const restored = fixture(seed)
    const stopped = await runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: checkpoint.runId })
    expect(stopped.status).toBe('blocked'); expect(restored.starts).toHaveLength(0)
    expect(stopped.taskStates?.find(state => state.taskId === 'one')?.reason).toContain('interrupted')
    const resume = runPlan(restored.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false, runId: checkpoint.runId, resumeContext: { one: 'Previous process stopped; finish the remaining check.' } })
    await restored.started(1); expect(restored.starts[0].id).toBe('one')
    restored.finish('one'); await restored.started(2); restored.finish('review')
    expect((await resume).status).toBe('completed')
    expect(restored.starts.some(start => start.id === 'two')).toBe(false)
  })

  it('accepts a corrected budget for unfinished work while retaining completed evidence', async () => {
    const f = fixture(), graph = plan(['one', 'two'])
    const pending = runPlan(f.host, policy, { objective: 'Check', plan: graph, planOnly: false, executeWrites: false })
    await f.started(2)
    f.finish('one', report('one', { status: 'needs_more_context', needs: [{ kind: 'NEED_BUDGET', reason: 'Need 16K', requestedContextTokens: 16_384 }] })); f.finish('two')
    const saved = await pending
    const revised = structuredClone(graph); revised.tasks[0].contextBudget = 16_384
    const resume = runPlan(f.host, policy, { objective: 'Check', plan: revised, planOnly: false, executeWrites: false, runId: saved.runId })
    await f.started(3)
    expect(f.starts.at(-1)?.request.prompt[0]).toMatchObject({ text: expect.stringContaining('Context ceiling including output and safety: 16384') })
    f.finish('one'); await f.started(4); f.finish('review')
    expect((await resume).status).toBe('completed')
    expect(f.starts.filter(start => start.id === 'two')).toHaveLength(1)
    revised.tasks[1].prompt = 'Different completed goal'
    await expect(runPlan(f.host, policy, { objective: 'Check', plan: revised, planOnly: false, executeWrites: false, runId: saved.runId })).rejects.toThrow(/cannot change/)
  })
})
