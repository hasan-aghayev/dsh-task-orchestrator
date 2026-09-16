/**
 * Automatic plan-first multi-role execution for complex foreground requests.
 * The plugin composes the existing subagent and workflow services without
 * changing the agent loop.
 * @module dsh-task-orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContentBlock, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'
import {
  TASK_ROLES,
  type OrchestrationResult,
  type PlannedTask,
  type ReviewReport,
  type TaskPlan,
  type TaskRisk,
  type WorkerReport,
} from './types.js'
import { ResourceManager } from './resource-manager.js'

/** Plugin identifier used by the profile loader and durable notices. */
export const name = 'task-orchestrator'

/** Services required by the plugin. */
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt', 'agents']

/** Automatic orchestration mode. */
export type OrchestrationMode = 'off' | 'suggest' | 'hybrid' | 'auto'

/** Deployment policy for automatic task orchestration. */
export interface Config {
  /** Disable automation, show a plan first, or execute complex requests automatically. */
  mode?: OrchestrationMode
  /** Minimum deterministic complexity score that starts planning. */
  minComplexityScore?: number
  /** Provider used for the planner, workers, and reviewer. */
  subagentProvider?: string
  /** Optional model override for all orchestration children. */
  subagentModel?: string
  /** Preferred worker count passed to the planner. */
  preferredWorkers?: number
  /** Hard worker count ceiling returned by the planner. */
  maxWorkers?: number
  /** Total child-agent ceiling for one run, including planner and reviewer. */
  maxTotalAgents?: number
  /** Maximum concurrent worker children. */
  maxConcurrentAgents?: number
  /** Allow worker agents to modify the shared workspace. */
  allowWrites?: boolean
  /** Allow independent worker agents with declared write scopes to run together. */
  allowParallelWrites?: boolean
  /** Always run a final reviewer after worker execution. */
  requireReview?: boolean
  /** Maximum serialized plan or worker handoff size. */
  maxHandoffChars?: number
  /** Maximum characters added to the parent model's current request. */
  maxResultChars?: number
  /** Maximum model streams consumed at once by the local NInfer service. */
  maxActiveGenerations?: number
  /** Hard estimated input-token limit for one model request. */
  hardContextTokens?: number
  /** Queue wait interval after which a request gains one priority level. */
  priorityAgingMs?: number
}

/** Schemastery configuration for the task orchestrator plugin. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'suggest', 'hybrid', 'auto']).default('hybrid'),
  minComplexityScore: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(55),
  subagentProvider: z.string().default('spawn'),
  subagentModel: z.string(),
  preferredWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  maxWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6),
  maxTotalAgents: z.number().step(1).min(2).max(Number.MAX_SAFE_INTEGER).default(7),
  maxConcurrentAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  allowWrites: z.boolean().default(false),
  allowParallelWrites: z.boolean().default(false),
  requireReview: z.boolean().default(true),
  maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  hardContextTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(65_536),
  priorityAgingMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
})

interface ResolvedConfig {
  readonly mode: OrchestrationMode
  readonly minComplexityScore: number
  readonly subagentProvider: string
  readonly subagentModel: string | undefined
  readonly preferredWorkers: number
  readonly maxWorkers: number
  readonly maxTotalAgents: number
  readonly maxConcurrentAgents: number
  readonly allowWrites: boolean
  readonly allowParallelWrites: boolean
  readonly requireReview: boolean
  readonly maxHandoffChars: number
  readonly maxResultChars: number
  readonly maxActiveGenerations: number
  readonly hardContextTokens: number
  readonly priorityAgingMs: number
}

interface OrchestrationArgs {
  objective: string
  planOnly: boolean
  executeWrites: boolean
  preferredWorkers: number
  maxWorkers: number
  maxConcurrentAgents: number
  maxHandoffChars: number
  allowWrites: boolean
  allowParallelWrites: boolean
  requireReview: boolean
  subagentProvider: string
  subagentModel?: string
}

interface StartOptions {
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly objective: string
  readonly planOnly: boolean
  readonly executeWrites: boolean
  readonly preferredWorkers?: number
  readonly maxWorkers?: number
}

const COMPLEXITY_TERMS = [
  /frontend|front[- ]end|ui|ux|интерфейс|фронтенд|клиент/i,
  /backend|back[- ]end|api|database|db|сервер|бэкенд|база данных/i,
  /refactor|migration|архитектур|рефактор|миграц/i,
  /test|tests|e2e|ci|тест|провер/i,
  /document|docs|readme|документац/i,
  /review|audit|ревью|аудит/i,
  /all files|whole project|entire|весь проект|все файлы|полностью/i,
  /step by step|phases|dependencies|pipeline|этап|зависим|пайплайн/i,
]

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    requiresConfirmation: { type: 'boolean' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          role: { type: 'string', enum: [...TASK_ROLES] },
          prompt: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          readOnly: { type: 'boolean' },
          writeScopes: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'role', 'prompt', 'dependsOn', 'readOnly', 'writeScopes'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'risk', 'requiresConfirmation', 'tasks'],
  additionalProperties: false,
} as const

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['taskId', 'status', 'summary', 'evidence', 'changedFiles', 'tests', 'blockers', 'nextSteps'],
  additionalProperties: false,
} as const

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'changes_requested', 'blocked', 'failed'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'findings', 'checks', 'nextSteps'],
  additionalProperties: false,
} as const

const ORCHESTRATION_META = {
  name: 'task-orchestrator',
  description: 'Plan-first role-based execution with dependency-aware workers and a final reviewer.',
  phases: [
    { title: 'Planning', detail: 'One structured planner creates the task graph.' },
    { title: 'Execution', detail: 'Independent roles run in bounded batches after their dependencies.' },
    { title: 'Review', detail: 'One structured reviewer checks the collected evidence.' },
  ],
}

/** Score a request using cheap deterministic signals before spending a child call. */
export function scoreComplexity(text: string): number {
  const normalized = text.trim()
  if (normalized.length === 0) return 0
  let score = 0
  if (normalized.length >= 180) score += 15
  if (normalized.length >= 500) score += 15
  if (/[\n\r]/.test(normalized)) score += 8
  if (/[,:;]|\d+[.)]/.test(normalized)) score += 7
  if (/(?:^|\s)(?:and|и|then|затем|also|также)(?:\s|$)/i.test(normalized)) score += 5
  for (const term of COMPLEXITY_TERMS) if (term.test(normalized)) score += 10
  return Math.min(score, 100)
}

/** Return the text blocks from a user message in their original order. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Resolve defaults and reject invalid direct plugin use before a run starts. */
function resolveConfig(config: Config): ResolvedConfig {
  const mode = config.mode ?? 'hybrid'
  const minComplexityScore = config.minComplexityScore ?? 55
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const subagentModel = config.subagentModel
  const preferredWorkers = config.preferredWorkers ?? 3
  const maxWorkers = config.maxWorkers ?? 6
  const maxTotalAgents = config.maxTotalAgents ?? 7
  const maxConcurrentAgents = config.maxConcurrentAgents ?? 2
  const allowWrites = config.allowWrites ?? false
  const allowParallelWrites = config.allowParallelWrites ?? false
  const requireReview = config.requireReview ?? true
  const maxHandoffChars = config.maxHandoffChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 16_384
  const maxActiveGenerations = config.maxActiveGenerations ?? 2
  const hardContextTokens = config.hardContextTokens ?? 65_536
  const priorityAgingMs = config.priorityAgingMs ?? 30_000
  if (!['off', 'suggest', 'hybrid', 'auto'].includes(mode)) throw new TypeError(`unknown orchestration mode: ${mode}`)
  if (!Number.isSafeInteger(minComplexityScore) || minComplexityScore < 1) throw new TypeError('minComplexityScore must be a positive safe integer')
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) throw new TypeError('subagentProvider must be a non-empty normalized string')
  if (subagentModel !== undefined && (subagentModel.length === 0 || subagentModel !== subagentModel.trim())) throw new TypeError('subagentModel must be a non-empty normalized string when provided')
  const limits = { preferredWorkers, maxWorkers, maxTotalAgents, maxConcurrentAgents, maxHandoffChars, maxResultChars, maxActiveGenerations, hardContextTokens, priorityAgingMs }
  for (const [label, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  }
  if (preferredWorkers > maxWorkers) throw new TypeError('preferredWorkers cannot exceed maxWorkers')
  if (maxTotalAgents < 2) throw new TypeError('maxTotalAgents must allow planner and reviewer')
  if (maxConcurrentAgents > maxWorkers) throw new TypeError('maxConcurrentAgents cannot exceed maxWorkers')
  return {
    mode,
    minComplexityScore,
    subagentProvider,
    subagentModel,
    preferredWorkers,
    maxWorkers,
    maxTotalAgents,
    maxConcurrentAgents,
    allowWrites,
    allowParallelWrites,
    requireReview,
    maxHandoffChars,
    maxResultChars,
    maxActiveGenerations,
    hardContextTokens,
    priorityAgingMs,
  }
}

/** Require a fresh structured-output route for planner, worker, and reviewer calls. */
function requireStructuredProvider(ctx: Context, providerName: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) throw new Error(`task-orchestrator subagent provider "${providerName}" is not registered`)
  if (!provider.capabilities.outputSchema) throw new Error(`task-orchestrator provider "${providerName}" does not support structured output`)
  if (provider.inheritsParentContext) throw new Error(`task-orchestrator provider "${providerName}" inherits parent context; a fresh child provider is required`)
  return provider
}

/** Validate one request-side worker cap against the deployment policy. */
function resolveWorkerCap(requested: number | undefined, preferred: number, ceiling: number): number {
  const value = requested ?? preferred
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('maxWorkers must be a positive safe integer')
  if (value > ceiling) throw new TypeError(`maxWorkers ${value} exceeds the deployment ceiling ${ceiling}`)
  return value
}

/** Return true when an agent session is a nested orchestration child. */
function isSubagent(agent: Agent): boolean {
  return agent.session.header.origin === 'subagent'
}

/** Bound parent-facing text while retaining an explicit truncation marker. */
function boundResult(text: string, maxChars: number): string {
  const marker = '\n… [truncated]'
  if (text.length <= maxChars) return text
  if (maxChars <= marker.length) return marker.slice(0, maxChars)
  return `${text.slice(0, maxChars - marker.length)}${marker}`
}

/** Render a model-visible handoff that distinguishes planning from execution. */
function renderHandoff(value: OrchestrationResult, score: number, maxChars: number): string {
  const status = value.status === 'completed'
    ? 'completed'
    : value.status === 'plan-only'
      ? 'plan-only'
      : value.status
  const instruction = value.status === 'plan-only'
    ? 'The plan is awaiting explicit human approval. Do not claim that implementation was performed.'
    : 'Use the evidence below when answering the human. Do not describe an unverified worker claim as independently verified.'
  return boundResult([
    `Task orchestrator status: ${status}. Complexity score: ${score}. Agents started: ${value.agentsStarted}.`,
    instruction,
    JSON.stringify(value, null, 2),
  ].join('\n\n'), maxChars)
}

/** Make a durable user-role notice for the current request. */
function createHandoffMessage(value: OrchestrationResult, score: number, maxChars: number): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderHandoff(value, score, maxChars) }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: `orchestration ${value.status}` },
  })
}

/** Return a stable error string for an abnormal workflow stop. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `task-orchestrator workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `task-orchestrator workflow failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- WorkflowStopReason is closed; a future variant must fail loud here. */
    default:
      return `task-orchestrator workflow ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNormalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function readStringList(value: unknown): string[] {
  if (!isStringList(value)) throw new Error('task-orchestrator workflow returned a malformed string list')
  return value
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Decode the workflow result across the process boundary before rendering it. */
function readOrchestrationResult(value: unknown, maxHandoffChars: number): OrchestrationResult {
  if (!isRecord(value)
    || !['completed', 'plan-only', 'blocked', 'failed'].includes(String(value.status))
    || !hasNormalizedText(value.summary)
    || !Array.isArray(value.workers)
    || typeof value.agentsStarted !== 'number'
    || (value.plan !== null && !isRecord(value.plan))) {
    throw new Error('task-orchestrator workflow returned a malformed result')
  }
  if (typeof value.agentsStarted !== 'number' || !Number.isSafeInteger(value.agentsStarted) || value.agentsStarted < 1) {
    throw new Error('task-orchestrator workflow returned an invalid agentsStarted value')
  }
  for (const worker of value.workers) {
    if (!isRecord(worker)
      || !hasNormalizedText(worker.taskId)
      || !['completed', 'blocked', 'failed'].includes(String(worker.status))
      || !hasNormalizedText(worker.summary)) {
      throw new Error('task-orchestrator workflow returned a malformed worker report')
    }
    readStringList(worker.evidence)
    readStringList(worker.changedFiles)
    readStringList(worker.tests)
    readStringList(worker.blockers)
    readStringList(worker.nextSteps)
  }
  if (value.review !== null) {
    const review = value.review
    if (!isRecord(review)
      || !['approved', 'changes_requested', 'blocked', 'failed'].includes(String(review.status))
      || !hasNormalizedText(review.summary)) {
      throw new Error('task-orchestrator workflow returned a malformed review report')
    }
    readStringList(review.findings)
    readStringList(review.checks)
    readStringList(review.nextSteps)
  }
  const serialized = JSON.stringify(value)
  if (serialized.length > maxHandoffChars) throw new Error('task-orchestrator workflow returned an oversized result')
  return value as unknown as OrchestrationResult
}

const ORCHESTRATION_OUTPUT_PROPERTIES = {
  runId: { type: 'string', required: true },
  agentsStarted: { type: 'integer', required: true },
  result: { type: 'json', required: true },
} as const

/** Start one bounded orchestration run and dispose all child resources. */
async function startOrchestration(
  ctx: Context,
  resolved: ResolvedConfig,
  options: StartOptions,
): Promise<OrchestrationResult & { runId: string }> {
  const workerCap = resolveWorkerCap(options.maxWorkers, options.preferredWorkers ?? resolved.preferredWorkers, resolved.maxWorkers)
  const allowWrites = resolved.allowWrites || options.executeWrites
  const args: OrchestrationArgs = {
    objective: options.objective,
    planOnly: options.planOnly,
    executeWrites: options.executeWrites,
    preferredWorkers: options.preferredWorkers ?? resolved.preferredWorkers,
    maxWorkers: workerCap,
    maxConcurrentAgents: resolved.maxConcurrentAgents,
    maxHandoffChars: resolved.maxHandoffChars,
    allowWrites,
    allowParallelWrites: resolved.allowParallelWrites,
    requireReview: resolved.requireReview,
    subagentProvider: resolved.subagentProvider,
    ...(resolved.subagentModel === undefined ? {} : { subagentModel: resolved.subagentModel }),
  }
  void requireStructuredProvider(ctx, resolved.subagentProvider)
  const workflowEngine = ctx.get('workflowEngine')
  if (workflowEngine === undefined) throw new Error('task-orchestrator workflow engine is not registered')
  const run: WorkflowRun = workflowEngine.start({
    script: ORCHESTRATION_SCRIPT,
    meta: ORCHESTRATION_META,
    args,
    subagentProvider: resolved.subagentProvider,
    maxTotalAgents: resolved.maxTotalAgents,
    parent: options.parent,
    signal: options.signal,
  })
  const onAbort = (): void => { run.cancel('parent step aborted') }
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) run.cancel('parent step aborted')
  try {
    const settled = await run.result
    const error = stopReasonError(settled)
    if (error !== undefined) throw new Error(error)
    const value = readOrchestrationResult(settled.value, resolved.maxHandoffChars)
    return { runId: run.id, ...value, agentsStarted: settled.agentsStarted }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    await run.dispose()
  }
}

const DESCRIPTION = 'Inspect a complex request, create a strict role/dependency plan, run bounded '
  + 'research, backend, frontend, testing, or documentation workers when approved, and finish with '
  + 'one reviewer report. In automatic mode the plugin may call this workflow before the parent model '
  + 'answers. Use the explicit tool only after the human approves a displayed plan or explicitly asks '
  + 'for a multi-role team. Writes are disabled by default.'

function presentCall(args: { objective: string }): ToolCallView {
  return { card: 'generic', title: 'task orchestrator', rawInput: args.objective }
}

function presentResult(args: { objective: string }, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** Register the explicit tool and the automatic pre-step planner. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const resources = new ResourceManager({
    maxActiveGenerations: resolved.maxActiveGenerations,
    hardContextTokens: resolved.hardContextTokens,
    priorityAgingMs: resolved.priorityAgingMs,
  })
  void requireStructuredProvider(ctx, resolved.subagentProvider)
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => resources.stream(ctx, options, next))
  ctx.systemPrompt.section({
    name: 'tool:task-orchestrate',
    order: 150,
    text: 'The task_orchestrate tool is a bounded plan-first team workflow. Use it only after the human explicitly approves a displayed plan or explicitly requests a multi-role team. The automatic task-orchestrator may already have added a plan or execution report to the current request. Planner, workers, and reviewer return structured evidence; worker claims are not independent certification. Writes require the configured policy or an explicit human-approved executeWrites request.',
  })
  ctx.tools.register(defineTool({
    name: 'task_orchestrate',
    description: DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete objective that every role must keep in scope.',
      },
      planOnly: {
        type: 'boolean',
        description: 'Return a plan without starting worker roles. Use this for a human approval gate.',
      },
      executeWrites: {
        type: 'boolean',
        description: 'Allow declared write tasks only when the human explicitly approved implementation.',
      },
      maxWorkers: {
        type: 'number',
        description: 'Optional worker cap, never above the deployment setting.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: ORCHESTRATION_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => [{
        type: 'text',
        text: boundResult(JSON.stringify(value.result, null, 2), resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('task_orchestrate requires a calling agent')
      const objective = args.objective.trim()
      if (objective.length === 0) throw new Error('task_orchestrate objective must be non-empty')
      const value = await startOrchestration(ctx, resolved, {
        parent,
        signal: exec.signal,
        objective,
        planOnly: args.planOnly ?? false,
        executeWrites: args.executeWrites ?? false,
        ...(args.maxWorkers === undefined ? {} : { maxWorkers: args.maxWorkers }),
      })
      return {
        runId: value.runId,
        agentsStarted: value.agentsStarted,
        result: value as unknown as JsonValue,
      }
    },
    presentCall,
    presentResult,
  }))

  const active = new WeakSet<Agent>()
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (resolved.mode === 'off' || active.has(agent) || step !== 1 || isSubagent(agent)) return decision
    const objective = messages.map(messageText).join('\n\n').trim()
    const score = scoreComplexity(objective)
    if (score < resolved.minComplexityScore) return decision
    active.add(agent)
    try {
      const value = await startOrchestration(ctx, resolved, {
        parent: agent,
        signal,
        objective,
        planOnly: resolved.mode === 'suggest',
        executeWrites: false,
      })
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...decision.messages, createHandoffMessage(value, score, resolved.maxResultChars)] }
    } catch (error) {
      const failure: OrchestrationResult = {
        status: 'failed',
        summary: `Automatic orchestration was not started: ${String(error)}`,
        plan: null,
        workers: [],
        review: null,
        agentsStarted: 0,
      }
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...decision.messages, createHandoffMessage(failure, score, resolved.maxResultChars)] }
    } finally {
      active.delete(agent)
    }
  })
}

/** Fixed script executed in the workflow VM; user input is supplied only through args. */
const ORCHESTRATION_SCRIPT = String.raw`
const planSchema = ${JSON.stringify(PLAN_SCHEMA)}
const workerSchema = ${JSON.stringify(WORKER_SCHEMA)}
const reviewSchema = ${JSON.stringify(REVIEW_SCHEMA)}

function text(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function list(value) {
  return Array.isArray(value) && value.every(text)
}

function validatePlan(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('planner returned no object')
  if (!text(value.summary) || !['low', 'medium', 'high'].includes(value.risk) || typeof value.requiresConfirmation !== 'boolean') throw new Error('planner returned invalid summary, risk, or confirmation flag')
  const taskLimit = Math.max(1, args.maxWorkers - (args.requireReview ? 1 : 0))
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > taskLimit) throw new Error('planner returned an invalid task count')
  const ids = new Set()
  for (const task of value.tasks) {
    if (task === null || typeof task !== 'object' || Array.isArray(task) || !text(task.id) || !text(task.title) || !text(task.prompt) || !['researcher', 'architect', 'backend', 'frontend', 'tester', 'documentation'].includes(task.role) || typeof task.readOnly !== 'boolean' || !list(task.dependsOn) || !list(task.writeScopes)) throw new Error('planner returned an invalid task')
    if (ids.has(task.id)) throw new Error('planner returned duplicate task ids')
    ids.add(task.id)
  }
  for (const task of value.tasks) {
    if (task.dependsOn.includes(task.id) || task.dependsOn.some((dependency) => !ids.has(dependency))) throw new Error('planner returned an unknown or self dependency')
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error('planner returned a dependency cycle')
    if (visited.has(id)) return
    visiting.add(id)
    const task = value.tasks.find((item) => item.id === id)
    for (const dependency of task.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of value.tasks) visit(task.id)
  return bounded(value, 'planner handoff')
}

function validateWorker(value, taskId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.taskId !== taskId || !['completed', 'blocked', 'failed'].includes(value.status) || !text(value.summary) || !list(value.evidence) || !list(value.changedFiles) || !list(value.tests) || !list(value.blockers) || !list(value.nextSteps)) throw new Error('worker returned an invalid report')
  return bounded(value, 'worker handoff')
}

function validateReview(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !['approved', 'changes_requested', 'blocked', 'failed'].includes(value.status) || !text(value.summary) || !list(value.findings) || !list(value.checks) || !list(value.nextSteps)) throw new Error('reviewer returned an invalid report')
  return bounded(value, 'reviewer handoff')
}

function hasWrite(task) {
  return !task.readOnly || task.writeScopes.length > 0
}

function scopesOverlap(left, right) {
  function overlaps(leftScope, rightScope) {
    return leftScope === rightScope
      || leftScope.startsWith(rightScope + '/')
      || rightScope.startsWith(leftScope + '/')
      || leftScope.startsWith(rightScope + '\\')
      || rightScope.startsWith(leftScope + '\\')
  }
  return left.some((leftScope) => right.some((rightScope) => overlaps(leftScope, rightScope)))
}

function bounded(value, label) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || serialized.length > args.maxHandoffChars) throw new Error(label + ' exceeds maxHandoffChars')
  return value
}

function workerPrompt(task, reports) {
  return [
    'You are the ' + task.role + ' worker in a bounded multi-role task.',
    'Do not start another orchestration and do not invent work outside your task.',
    'Objective:\n' + args.objective,
    'Your task:\n' + task.title + '\n' + task.prompt,
    'Declared dependencies are complete. Treat their reports as leads and verify them in the workspace.',
    'Prior worker reports:\n' + JSON.stringify(reports),
    'Write permission: ' + (args.allowWrites ? 'allowed only inside declared writeScopes' : 'read-only; do not edit files'),
    'Declared write scopes: ' + JSON.stringify(task.writeScopes),
    'Return a strict structured report with concrete evidence, changedFiles, tests, blockers, and nextSteps. Do not claim a test passed unless you ran it or have durable evidence.',
  ].join('\n\n')
}

function reviewerPrompt(plan, workers) {
  return [
    'You are the final reviewer for a multi-role task.',
    'Objective:\n' + args.objective,
    'Plan:\n' + JSON.stringify(plan),
    'Worker reports:\n' + JSON.stringify(workers),
    'Inspect the current workspace and compare worker claims with evidence. Return approved only when the objective is adequately verified. Use changes_requested for actionable missing work and blocked for a human or external dependency.',
  ].join('\n\n')
}

function childOptions(label, phaseName, schema) {
  const options = { label, phase: phaseName, schema }
  if (args.subagentModel !== undefined) options.model = args.subagentModel
  return options
}

phase('Planning')
const plannerPrompt = [
  'You are the planning agent for a complex request.',
  'Create a small executable dependency graph for the objective below.',
  'Use separate roles where useful: researcher/architect for discovery, backend for services or data, frontend for UI, tester for verification, documentation for docs.',
  'The planner runs first. A task may depend on the researcher or architect when it needs a discovered contract. Independent read-only tasks may run in parallel. Keep the graph at or below ' + Math.max(1, args.maxWorkers - (args.requireReview ? 1 : 0)) + ' execution tasks; one of the six worker slots is reserved for the optional final reviewer.',
  'Every task must declare readOnly and writeScopes. Set requiresConfirmation true when implementation, deletion, migration, external mutation, or any other meaningful write is needed. If write permission is not enabled, still describe the needed work but it will remain plan-only.',
  'Objective:\n' + args.objective,
  'Return only the requested structured plan. Do not perform implementation in this planning call.',
].join('\n\n')
const planned = await agent(plannerPrompt, childOptions('Planner', 'Planning', planSchema))
if (planned === null) return { status: 'failed', summary: 'Planner failed before producing a plan.', plan: null, workers: [], review: null, agentsStarted: 1 }
const plan = validatePlan(planned)
const needsWriteApproval = plan.requiresConfirmation || plan.tasks.some(hasWrite)
if (args.planOnly || (needsWriteApproval && !args.allowWrites)) return { status: 'plan-only', summary: 'A plan was created and is awaiting explicit write approval.', plan, workers: [], review: null, agentsStarted: 1 }

phase('Execution')
const remaining = plan.tasks.slice()
const completed = new Map()
const workers = []
let workersStarted = 0
while (remaining.length > 0) {
  const ready = remaining.filter((task) => task.dependsOn.every((dependency) => completed.get(dependency)?.status === 'completed'))
  if (ready.length === 0) {
    for (const task of remaining) workers.push({ taskId: task.id, status: 'blocked', summary: 'Dependency did not complete.', evidence: [], changedFiles: [], tests: [], blockers: ['A required dependency failed or was blocked.'], nextSteps: [] })
    break
  }
  const batch = []
  for (const task of ready) {
    const conflicts = batch.some((selected) => scopesOverlap(selected.writeScopes, task.writeScopes))
    const batchHasWrite = batch.some(hasWrite)
    const canShareBatch = !hasWrite(task) && !batchHasWrite || args.allowParallelWrites && !conflicts
    if (batch.length === 0 || canShareBatch) batch.push(task)
    if (batch.length >= args.maxConcurrentAgents) break
    if (!args.allowParallelWrites && hasWrite(task)) break
  }
  workersStarted += batch.length
  const rawReports = await parallel(batch.map((task) => () => agent(workerPrompt(task, workers), childOptions(task.role + ': ' + task.title, 'Execution', workerSchema))))
  for (let index = 0; index < batch.length; index += 1) {
    const task = batch[index]
    const raw = rawReports[index]
    const report = raw === null ? { taskId: task.id, status: 'failed', summary: 'Worker failed before producing a report.', evidence: [], changedFiles: [], tests: [], blockers: ['No structured worker result was returned.'], nextSteps: [] } : validateWorker(raw, task.id)
    workers.push(report)
    completed.set(task.id, report)
    const position = remaining.indexOf(task)
    if (position >= 0) remaining.splice(position, 1)
  }
}

let review = null
if (args.requireReview) {
  phase('Review')
  const rawReview = await agent(reviewerPrompt(plan, workers), childOptions('Reviewer', 'Review', reviewSchema))
  review = rawReview === null ? { status: 'failed', summary: 'Reviewer failed before producing a report.', findings: ['No structured reviewer result was returned.'], checks: [], nextSteps: ['Review the worker reports manually.'] } : validateReview(rawReview)
}
const workerFailure = workers.some((worker) => worker.status !== 'completed')
const status = workerFailure || review?.status === 'blocked' || review?.status === 'failed' ? 'blocked' : review?.status === 'changes_requested' ? 'blocked' : 'completed'
return { status, summary: status === 'completed' ? 'All planned roles completed and the reviewer approved the result.' : 'The orchestration produced partial work or requires follow-up.', plan, workers, review, agentsStarted: 1 + workersStarted + (review === null ? 0 : 1) }
`

export type { OrchestrationResult, PlannedTask, ReviewReport, TaskPlan, TaskRisk, WorkerReport }
