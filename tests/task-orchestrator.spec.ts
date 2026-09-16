import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Config, scoreComplexity } from '../src/index.ts'
import { ResourceManager, estimateInputTokens } from '../src/resource-manager.ts'
import { CONTEXT_TIERS, buildAdaptivePlan, estimateTaskBudget, packReadyTasks, selectContextTier } from '../src/adaptive.ts'
import { createOrchestrationScript } from '../src/orchestration-script.ts'

describe('DSH Task Orchestrator', () => {
  it('does not delegate a short, single-purpose request', () => {
    expect(scoreComplexity('Show the current branch')).toBeLessThan(55)
  })

  it('detects a multi-role request', () => {
    expect(scoreComplexity('Исследуй API, затем сделай backend и frontend, добавь тесты, документацию и финальное ревью.')).toBeGreaterThanOrEqual(55)
  })

  it('keeps the score bounded', () => {
    expect(scoreComplexity('frontend backend test docs review '.repeat(100))).toBeLessThanOrEqual(100)
  })

  it('keeps default context concurrency within the default global ceiling', () => {
    const defaults = Config({})
    expect(defaults.maxActiveGenerations).toBe(2)
    expect(defaults.concurrencyByContext?.every(tier => tier.maxActiveGenerations <= (defaults.maxActiveGenerations ?? 0))).toBe(true)
  })

  it('selects the smallest supported context tier through the 96K ceiling', () => {
    expect(selectContextTier(8_193)).toBe(16_384)
    expect(selectContextTier(65_537)).toBe(81_920)
    expect(selectContextTier(98_305)).toBeUndefined()
    expect(CONTEXT_TIERS).toEqual([8_192, 16_384, 24_576, 32_768, 49_152, 65_536, 81_920, 98_304])
  })

  it('packs only the largest safe ready tasks into the available generation budget', () => {
    const task = (id: string, contextTokens: 8192 | 16384 | 24576) => ({
      task: { id, title: id, role: 'researcher' as const, prompt: id, dependsOn: [], readOnly: true, writeScopes: [], contextBudget: contextTokens },
      budget: estimateTaskBudget(contextTokens, 0, 0),
      package: { taskId: id, goal: id, relevantContext: [], constraints: [], knownFacts: [], files: [], dependencies: [], expectedOutput: id, doNot: [] },
    })
    const result = packReadyTasks([task('large', 24_576), task('small-a', 8_192), task('small-b', 8_192)], { maxWorkers: 6, maxActiveGenerations: 2, totalContextTokens: 32_768, safetyReserveTokens: 0 })
    expect(result.selected.map(item => item.task.id)).toEqual(['large', 'small-a'])
    expect(result.deferred.map(item => item.task.id)).toEqual(['small-b'])
  })

  it('builds a minimal parent plan with a reviewer inside the worker ceiling', () => {
    const plan = buildAdaptivePlan('Исследуй API, добавь тесты и документацию.', 3, 6, true)
    expect(plan.tasks.length).toBe(5)
    expect(plan.tasks.at(-1)?.role).toBe('reviewer')
    expect(plan.tasks.at(-1)?.dependsOn).toEqual(plan.tasks.slice(0, -1).map(task => task.id))
    expect(plan.tasks.every(task => task.taskPackage?.taskId === task.id)).toBe(true)
  })

  it('estimates prompt and tool text for the hard request limit', () => {
    const options = {
      provider: 'test', model: 'test', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(400) }] }],
      tools: [{ name: 'lookup', description: 'Read a file', parameters: { type: 'object' } }],
    } as never
    expect(estimateInputTokens(options)).toBeGreaterThanOrEqual(100)
  })

  it('rejects a request above the configured hard context limit', () => {
    const manager = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: 10 })
    const context = { agents: { get: () => undefined } } as never
    expect(() => manager.stream(context, {
      provider: 'test', model: 'test', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(100) }] }],
    } as never, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })).toThrow(/exceeds hard context limit/)
  })

  it('limits consumed streams to the configured active lanes', async () => {
    const manager = new ResourceManager({ maxActiveGenerations: 2, hardContextTokens: 1000 })
    const context = { agents: { get: () => undefined } } as never
    let active = 0
    let peak = 0
    const stream = () => (async function* () {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { type: 'finish', reason: { kind: 'stop' } }
      active -= 1
    })()
    const requests = Array.from({ length: 4 }, () => manager.stream(context, { provider: 'test', model: 'test', messages: [] }, stream))
    await Promise.all(requests.map(async request => { for await (const _chunk of request) { /* consume */ } }))
    expect(peak).toBe(2)
    expect(manager.activeGenerations).toBe(0)
    expect(manager.queuedGenerations).toBe(0)
  })

  it('raises concurrency for small requests while preserving the shared budget', async () => {
    const manager = new ResourceManager({
      maxActiveGenerations: 6,
      hardContextTokens: 8_192,
      totalContextTokens: 10_000,
      concurrencyByContext: [{ maxContextTokens: 8_192, maxActiveGenerations: 6 }],
    })
    const context = { agents: { get: () => undefined } } as never
    let active = 0
    let peak = 0
    const stream = () => (async function* () {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { type: 'finish', reason: { kind: 'stop' } }
      active -= 1
    })()
    const requests = Array.from({ length: 6 }, () => manager.stream(context, { provider: 'test', model: 'test', messages: [] }, stream))
    await Promise.all(requests.map(async request => { for await (const _chunk of request) { /* consume */ } }))
    expect(peak).toBe(6)
    expect(manager.activeGenerations).toBe(0)
    expect(manager.activeContextBudget).toBe(0)
  })

  it('refills a free worker slot before the slow sibling settles', async () => {
    const script = createOrchestrationScript({ plan: {}, worker: {}, review: {} })
    const tasks = ['one', 'two', 'three', 'four'].map((id) => ({
      id,
      title: id,
      role: 'researcher' as const,
      prompt: id,
      dependsOn: [],
      readOnly: true,
      writeScopes: [],
      contextBudget: 8_192 as const,
      outputReserveTokens: 0,
      safetyReserveTokens: 0,
      taskPackage: { taskId: id, goal: id, relevantContext: [], constraints: [], knownFacts: [], files: [], dependencies: [], expectedOutput: id, doNot: [] },
    }))
    const started = new Map<string, number>()
    const finished = new Map<string, number>()
    const context = {
      args: { objective: 'Run independent checks.', planOnly: false, allowWrites: false, allowParallelWrites: false, maxWorkers: 6, maxConcurrentAgents: 2, maxHandoffChars: 16_384, totalContextTokens: 98_304, plan: { summary: 'Dynamic queue.', risk: 'low', requiresConfirmation: false, tasks } },
      phase: (): void => undefined,
      parallel: async (): Promise<never> => { throw new Error('legacy batch parallelism was used') },
      agent: async (_prompt: string, options: { label: string }): Promise<unknown> => {
        const id = options.label.split(': ').at(-1) as string
        started.set(id, Date.now())
        const delay = id === 'one' ? 20 : id === 'two' ? 100 : 5
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        finished.set(id, Date.now())
        return { taskId: id, status: 'completed', summary: id, evidence: [], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
      },
      setTimeout,
    }
    const result = await runInNewContext(`(async () => {\n${script}\n})()`, context) as Promise<{ status: string; agentsStarted: number; workers: Array<{ status: string }> }>
    expect(result.status).toBe('completed')
    expect(result.agentsStarted).toBe(4)
    expect(result.workers).toHaveLength(4)
    expect(started.get('three')).toBeLessThan(finished.get('two') ?? Number.POSITIVE_INFINITY)
  })

  it('starts with the preferred workers and expands a small-context plan after results', async () => {
    const script = createOrchestrationScript({ plan: {}, worker: {}, review: {} })
    const tasks = Array.from({ length: 6 }, (_, index) => {
      const id = `worker-${index + 1}`
      return {
        id,
        title: id,
        role: 'researcher' as const,
        prompt: id,
        dependsOn: [],
        readOnly: true,
        writeScopes: [],
        contextBudget: 8_192 as const,
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        taskPackage: { taskId: id, goal: id, relevantContext: [], constraints: [], knownFacts: [], files: [], dependencies: [], expectedOutput: id, doNot: [] },
      }
    })
    const started: string[] = []
    let active = 0
    let peak = 0
    const context = {
      args: {
        objective: 'Run independent checks.',
        planOnly: false,
        allowWrites: false,
        allowParallelWrites: false,
        preferredWorkers: 2,
        maxWorkers: 6,
        maxConcurrentAgents: 6,
        concurrencyByContext: [{ maxContextTokens: 8_192, maxActiveGenerations: 6 }],
        contextCompactionChars: 512,
        maxHandoffChars: 16_384,
        totalContextTokens: 98_304,
        plan: { summary: 'Dynamic queue.', risk: 'low', requiresConfirmation: false, tasks },
      },
      phase: (): void => undefined,
      agent: async (_prompt: string, options: { label: string }): Promise<unknown> => {
        const id = options.label.split(': ').at(-1) as string
        started.push(id)
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>(resolve => setTimeout(resolve, id === 'worker-1' || id === 'worker-2' ? 10 : 30))
        active -= 1
        return { taskId: id, status: 'completed', summary: id, evidence: [], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
      },
    }
    const result = await runInNewContext(`(async () => {\n${script}\n})()`, context) as Promise<{ status: string; agentsStarted: number; workers: Array<{ status: string }> }>
    expect(result.status).toBe('completed')
    expect(result.agentsStarted).toBe(6)
    expect(result.workers).toHaveLength(6)
    expect(started.slice(0, 2)).toEqual(['worker-1', 'worker-2'])
    expect(peak).toBeGreaterThan(2)
  })

  it('compacts dependency reports before handing them to a later worker', async () => {
    const script = createOrchestrationScript({ plan: {}, worker: {}, review: {} })
    const tasks = [
      {
        id: 'source', title: 'source', role: 'researcher' as const, prompt: 'source', dependsOn: [], readOnly: true, writeScopes: [], contextBudget: 8_192 as const, outputReserveTokens: 0, safetyReserveTokens: 0,
        taskPackage: { taskId: 'source', goal: 'source', relevantContext: [], constraints: [], knownFacts: [], files: [], dependencies: [], expectedOutput: 'source', doNot: [] },
      },
      {
        id: 'consumer', title: 'consumer', role: 'tester' as const, prompt: 'consumer', dependsOn: ['source'], readOnly: true, writeScopes: [], contextBudget: 8_192 as const, outputReserveTokens: 0, safetyReserveTokens: 0,
        taskPackage: { taskId: 'consumer', goal: 'consumer', relevantContext: [], constraints: [], knownFacts: [], files: [], dependencies: ['source'], expectedOutput: 'consumer', doNot: [] },
      },
    ]
    let consumerPrompt = ''
    const context = {
      args: {
        objective: 'Run dependent checks.', planOnly: false, allowWrites: false, allowParallelWrites: false,
        preferredWorkers: 2, maxWorkers: 2, maxConcurrentAgents: 2, contextCompactionChars: 512,
        maxHandoffChars: 16_384, totalContextTokens: 98_304,
        plan: { summary: 'Compaction.', risk: 'low', requiresConfirmation: false, tasks },
      },
      phase: (): void => undefined,
      agent: async (prompt: string, options: { label: string }): Promise<unknown> => {
        const id = options.label.split(': ').at(-1) as string
        if (id === 'consumer') consumerPrompt = prompt
        return { taskId: id, status: 'completed', summary: id, evidence: [id === 'source' ? 'x'.repeat(5_000) : 'ok'], changedFiles: [], tests: [], blockers: [], nextSteps: [] }
      },
    }
    const result = await runInNewContext(`(async () => {\n${script}\n})()`, context) as Promise<{ status: string }>
    expect(result.status).toBe('completed')
    expect(consumerPrompt).toContain('[compacted]')
    expect(consumerPrompt.length).toBeLessThan(4_000)
  })

  it('removes an aborted request that is waiting for a lane', async () => {
    const manager = new ResourceManager({ maxActiveGenerations: 1, hardContextTokens: 1000 })
    const context = { agents: { get: () => undefined } } as never
    let unblock!: () => void
    const first = manager.stream(context, { provider: 'test', model: 'test', messages: [] }, () => (async function* () {
      await new Promise<void>(resolve => { unblock = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const firstDone = (async () => { for await (const _chunk of first) { /* consume */ } })()
    await Promise.resolve()
    await Promise.resolve()
    const controller = new AbortController()
    const second = manager.stream(context, { provider: 'test', model: 'test', messages: [], signal: controller.signal }, () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const secondDone = (async () => { for await (const _chunk of second) { /* consume */ } })()
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.queuedGenerations).toBe(1)
    controller.abort()
    await expect(secondDone).rejects.toThrow(/cancelled while waiting/)
    expect(manager.queuedGenerations).toBe(0)
    unblock()
    await firstDone
    expect(manager.activeGenerations).toBe(0)
  })

  it('enables the workflow engine required by the bundle', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: task-orchestrator-workflow')
    expect(patch).toContain("name: '@deepseek-ai/dsh-workflow-ptc'")
    expect(patch).toContain('provider: spawn')
  })

  it('owns the model-facing delegation tools in one disableable group', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('- id: task-orchestrator-suite')
    expect(patch).toContain('name: cordis:group')
    expect(patch).toContain('workflowEngine: true')
    for (const id of [
      'task-orchestrator-tool-subagent-control',
      'task-orchestrator-tool-subagent-list-agents',
      'task-orchestrator-tool-subagent',
      'task-orchestrator-tool-subagent-fork',
      'task-orchestrator-workflow',
    ]) {
      expect(patch).toContain(`- id: ${id}`)
    }
    expect(patch).toContain('toolName: subagent')
    expect(patch).toContain('toolName: subagent_fork')
    for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']) {
      expect(patch).toContain(`- id: ${id}\n  disabled: true`)
    }
  })

  it('admits a worker in the workflow script with the configured batch budget', async () => {
    const script = createOrchestrationScript({ plan: {}, worker: {}, review: {} })
    const context = {
      args: {
        objective: 'Read the plugin package manifest.',
        planOnly: false,
        allowWrites: false,
        allowParallelWrites: false,
        maxWorkers: 1,
        maxConcurrentAgents: 2,
        maxHandoffChars: 16_384,
        totalContextTokens: 98_304,
        plan: {
          summary: 'Compatibility check.',
          risk: 'low',
          requiresConfirmation: false,
          tasks: [{
            id: 'compat-read',
            title: 'Read package manifest',
            role: 'researcher',
            prompt: 'Read package.json and report its peer versions.',
            dependsOn: [],
            readOnly: true,
            writeScopes: [],
            contextBudget: 24_576,
            outputReserveTokens: 2_048,
            safetyReserveTokens: 1_024,
            taskPackage: {
              taskId: 'compat-read',
              goal: 'Read the plugin package manifest.',
              relevantContext: [],
              constraints: [],
              knownFacts: [],
              files: ['package.json'],
              dependencies: [],
              expectedOutput: 'A structured report.',
              doNot: [],
            },
          }],
        },
      },
      phase: (): void => undefined,
      parallel: async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => Promise.all(thunks.map(thunk => thunk())),
      agent: async (): Promise<unknown> => ({
        taskId: 'compat-read',
        status: 'completed',
        summary: 'Peer versions are compatible.',
        evidence: ['The profile uses versions accepted by the plugin.'],
        changedFiles: [],
        tests: ['workflow script admission'],
        blockers: [],
        nextSteps: [],
      }),
    }
    const result = await runInNewContext(`(async () => {\n${script}\n})()`, context) as Promise<{ status: string; agentsStarted: number; workers: Array<{ status: string }> }>
    expect(result.status).toBe('completed')
    expect(result.agentsStarted).toBe(1)
    expect(result.workers).toHaveLength(1)
    expect(result.workers[0]?.status).toBe('completed')
  })
})
