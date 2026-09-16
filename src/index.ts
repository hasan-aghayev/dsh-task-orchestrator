/**
 * Adaptive parent-orchestrator execution for complex foreground requests.
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
import { buildAdaptivePlan, CONTEXT_TIERS } from './adaptive.js'
import { createOrchestrationScript } from './orchestration-script.js'

/** Plugin identifier used by the profile loader and durable notices. */
export const name = 'task-orchestrator'

/** Services required by the plugin. */
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt', 'agents']

/** Automatic orchestration mode. */
export type OrchestrationMode = 'off' | 'suggest' | 'hybrid' | 'auto'

/** Maximum active model streams allowed for requests up to one context size. */
export interface ContextConcurrency {
  maxContextTokens: number
  maxActiveGenerations: number
}

const DEFAULT_CONTEXT_CONCURRENCY: readonly ContextConcurrency[] = [
  { maxContextTokens: 8_192, maxActiveGenerations: 2 },
  { maxContextTokens: 16_384, maxActiveGenerations: 2 },
  { maxContextTokens: 24_576, maxActiveGenerations: 2 },
  { maxContextTokens: 32_768, maxActiveGenerations: 2 },
  { maxContextTokens: 49_152, maxActiveGenerations: 2 },
  { maxContextTokens: 65_536, maxActiveGenerations: 1 },
  { maxContextTokens: 81_920, maxActiveGenerations: 1 },
  { maxContextTokens: 98_304, maxActiveGenerations: 1 },
]

/** Deployment policy for automatic task orchestration. */
export interface Config {
  /** Disable automation, show a plan first, or execute complex requests automatically. */
  mode?: OrchestrationMode
  /** Minimum deterministic complexity score that starts planning. */
  minComplexityScore?: number
  /** Provider used for worker and reviewer children. */
  subagentProvider?: string
  /** Optional model override for all orchestration children. */
  subagentModel?: string
  /** Preferred starting worker count used by the parent when it creates a graph. */
  preferredWorkers?: number
  /** Hard worker count ceiling accepted from the parent-created graph. */
  maxWorkers?: number
  /** Total worker-child ceiling for one run; the calling orchestrator is outside this count. */
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
  /** Per-request concurrency ceilings selected by estimated input context. */
  concurrencyByContext?: ContextConcurrency[]
  /** Hard estimated input-token limit for one model request. */
  hardContextTokens?: number
  /** Queue wait interval after which a request gains one priority level. */
  priorityAgingMs?: number
  /** Total estimated context budget available to one worker batch. */
  totalContextTokens?: number
  /** Minimum free VRAM in GiB required before a multi-worker batch is admitted. */
  minimumVramHeadroomGiB?: number
  /** Maximum characters retained when a worker report is compacted for another task. */
  contextCompactionChars?: number
  /** Keep the parent as the only planner; no separate planner child is created. */
  parentOrchestratorOnly?: boolean
}

/** Schemastery configuration for the task orchestrator plugin. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'suggest', 'hybrid', 'auto']).default('hybrid'),
  minComplexityScore: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(55),
  subagentProvider: z.string().default('spawn'),
  subagentModel: z.string(),
  preferredWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  maxWorkers: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6),
  maxTotalAgents: z.number().step(1).min(1).max(6).default(6),
  maxConcurrentAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  allowWrites: z.boolean().default(false),
  allowParallelWrites: z.boolean().default(false),
  requireReview: z.boolean().default(true),
  maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  concurrencyByContext: z.array(z.object({
    maxContextTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxActiveGenerations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  })).default([...DEFAULT_CONTEXT_CONCURRENCY]),
  hardContextTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(65_536),
  priorityAgingMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
  totalContextTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(98_304),
  minimumVramHeadroomGiB: z.number().min(0).max(24).default(0.8),
  contextCompactionChars: z.number().step(1).min(128).max(Number.MAX_SAFE_INTEGER).default(4_096),
  parentOrchestratorOnly: z.boolean().default(true),
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
  readonly concurrencyByContext: readonly ContextConcurrency[]
  readonly hardContextTokens: number
  readonly priorityAgingMs: number
  readonly totalContextTokens: number
  readonly minimumVramHeadroomGiB: number
  readonly contextCompactionChars: number
  readonly parentOrchestratorOnly: boolean
}

interface OrchestrationArgs {
  objective: string
  planOnly: boolean
  executeWrites: boolean
  preferredWorkers: number
  maxWorkers: number
  maxConcurrentAgents: number
  concurrencyByContext: readonly ContextConcurrency[]
  maxHandoffChars: number
  allowWrites: boolean
  allowParallelWrites: boolean
  requireReview: boolean
  subagentProvider: string
  subagentModel?: string
  plan: TaskPlan
  totalContextTokens: number
  contextCompactionChars: number
  minimumVramHeadroomGiB: number
  parentOrchestratorOnly: boolean
}

interface StartOptions {
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly objective: string
  readonly planOnly: boolean
  readonly executeWrites: boolean
  readonly preferredWorkers?: number
  readonly maxWorkers?: number
  readonly plan?: TaskPlan
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
          contextBudget: { type: 'integer', enum: [...CONTEXT_TIERS] },
          outputReserveTokens: { type: 'integer' },
          safetyReserveTokens: { type: 'integer' },
          taskPackage: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              goal: { type: 'string' },
              relevantContext: { type: 'array', items: { type: 'string' } },
              constraints: { type: 'array', items: { type: 'string' } },
              knownFacts: { type: 'array', items: { type: 'string' } },
              files: { type: 'array', items: { type: 'string' } },
              dependencies: { type: 'array', items: { type: 'string' } },
              expectedOutput: { type: 'string' },
              doNot: { type: 'array', items: { type: 'string' } },
            },
            required: ['taskId', 'goal', 'relevantContext', 'constraints', 'knownFacts', 'files', 'expectedOutput', 'doNot'],
            additionalProperties: false,
          },
        },
        required: ['id', 'title', 'role', 'prompt', 'dependsOn', 'readOnly', 'writeScopes'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'risk', 'requiresConfirmation', 'tasks'],
  additionalProperties: false,
} as const

/**
 * Explicit tool schema for a parent-created graph.
 *
 * Keeping this as an object schema gives the model the fields it must place
 * directly under `plan`; a free-form JSON property made it easy to send a
 * second `{ plan: ... }` wrapper that the workflow cannot validate.
 */
const TOOL_PLAN_SCHEMA = {
  type: 'object',
  description: 'The task graph itself. Put summary, risk, requiresConfirmation, and tasks directly here; do not wrap them in another plan property.',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', required: true },
    risk: { type: 'string', enum: ['low', 'medium', 'high'], required: true },
    requiresConfirmation: { type: 'boolean', required: true },
    tasks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          role: { type: 'string', enum: [...TASK_ROLES], required: true },
          prompt: { type: 'string', required: true },
          dependsOn: { type: 'array', items: { type: 'string' }, required: true },
          readOnly: { type: 'boolean', required: true },
          writeScopes: { type: 'array', items: { type: 'string' }, required: true },
          contextBudget: { type: 'integer', enum: [...CONTEXT_TIERS] },
          outputReserveTokens: { type: 'integer' },
          safetyReserveTokens: { type: 'integer' },
          taskPackage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              taskId: { type: 'string', required: true },
              goal: { type: 'string', required: true },
              relevantContext: { type: 'array', items: { type: 'string' }, required: true },
              constraints: { type: 'array', items: { type: 'string' }, required: true },
              knownFacts: { type: 'array', items: { type: 'string' }, required: true },
              files: { type: 'array', items: { type: 'string' }, required: true },
              dependencies: { type: 'array', items: { type: 'string' }, required: true },
              expectedOutput: { type: 'string', required: true },
              doNot: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
        },
      },
    },
  },
} as const

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed', 'needs_more_context'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    needs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['NEED_FILE', 'NEED_HISTORY', 'NEED_MORE_CONTEXT', 'NEED_DEPENDENCY', 'NEED_BUDGET', 'NEED_TOOL_RESULT', 'NEED_MORE_TOOL', 'NEED_REVIEW'] },
          reason: { type: 'string' },
          requestedContextTokens: { type: 'integer', enum: [...CONTEXT_TIERS] },
        },
        required: ['kind', 'reason'],
        additionalProperties: false,
      },
    },
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
  description: 'One parent orchestrator with adaptive dependency-aware workers and an optional reviewer worker.',
  phases: [
    { title: 'Planning', detail: 'The parent orchestrator creates or validates a small task graph.' },
    { title: 'Execution', detail: 'Independent roles run in bounded batches after their dependencies.' },
    { title: 'Review', detail: 'A reviewer uses one ordinary worker slot when the plan requests a review.' },
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
  const maxTotalAgents = config.maxTotalAgents ?? 6
  const maxConcurrentAgents = config.maxConcurrentAgents ?? 2
  const allowWrites = config.allowWrites ?? false
  const allowParallelWrites = config.allowParallelWrites ?? false
  const requireReview = config.requireReview ?? true
  const maxHandoffChars = config.maxHandoffChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 16_384
  const maxActiveGenerations = config.maxActiveGenerations ?? 2
  const concurrencyByContext = config.concurrencyByContext ?? [...DEFAULT_CONTEXT_CONCURRENCY]
  const hardContextTokens = config.hardContextTokens ?? 65_536
  const priorityAgingMs = config.priorityAgingMs ?? 30_000
  const totalContextTokens = config.totalContextTokens ?? 98_304
  const minimumVramHeadroomGiB = config.minimumVramHeadroomGiB ?? 0.8
  const contextCompactionChars = config.contextCompactionChars ?? 4_096
  const parentOrchestratorOnly = config.parentOrchestratorOnly ?? true
  if (!['off', 'suggest', 'hybrid', 'auto'].includes(mode)) throw new TypeError(`unknown orchestration mode: ${mode}`)
  if (!Number.isSafeInteger(minComplexityScore) || minComplexityScore < 1) throw new TypeError('minComplexityScore must be a positive safe integer')
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) throw new TypeError('subagentProvider must be a non-empty normalized string')
  if (subagentModel !== undefined && (subagentModel.length === 0 || subagentModel !== subagentModel.trim())) throw new TypeError('subagentModel must be a non-empty normalized string when provided')
  const limits = { preferredWorkers, maxWorkers, maxTotalAgents, maxConcurrentAgents, maxHandoffChars, maxResultChars, maxActiveGenerations, hardContextTokens, priorityAgingMs, totalContextTokens, contextCompactionChars }
  for (const [label, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  }
  if (preferredWorkers > maxWorkers) throw new TypeError('preferredWorkers cannot exceed maxWorkers')
  if (maxWorkers > 6) throw new TypeError('maxWorkers cannot exceed six workers')
  if (maxTotalAgents > 6) throw new TypeError('maxTotalAgents cannot exceed six workers')
  if (maxTotalAgents < 1) throw new TypeError('maxTotalAgents must allow one worker')
  if (maxConcurrentAgents > maxWorkers || maxConcurrentAgents > 6) throw new TypeError('maxConcurrentAgents cannot exceed six workers')
  if (maxActiveGenerations > 6) throw new TypeError('maxActiveGenerations cannot exceed six model streams')
  let previousContext = 0
  for (const tier of concurrencyByContext) {
    if (!Number.isSafeInteger(tier.maxContextTokens) || tier.maxContextTokens <= previousContext) throw new TypeError('concurrencyByContext must be sorted by increasing maxContextTokens')
    if (!Number.isSafeInteger(tier.maxActiveGenerations) || tier.maxActiveGenerations < 1 || tier.maxActiveGenerations > maxActiveGenerations) throw new TypeError('concurrencyByContext has an invalid maxActiveGenerations value')
    previousContext = tier.maxContextTokens
  }
  if (concurrencyByContext.length === 0 || previousContext < hardContextTokens) throw new TypeError('concurrencyByContext must cover hardContextTokens')
  if (!Number.isFinite(minimumVramHeadroomGiB) || minimumVramHeadroomGiB < 0) throw new TypeError('minimumVramHeadroomGiB must be a non-negative finite number')
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
    concurrencyByContext,
    hardContextTokens,
    priorityAgingMs,
    totalContextTokens,
    minimumVramHeadroomGiB,
    contextCompactionChars,
    parentOrchestratorOnly,
  }
}

/** Require a fresh structured-output route for worker and reviewer calls. */
function requireStructuredProvider(ctx: Context, providerName: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) throw new Error(`task-orchestrator subagent provider "${providerName}" is not registered`)
  if (!provider.capabilities.outputSchema) throw new Error(`task-orchestrator provider "${providerName}" does not support structured output`)
  if (provider.inheritsParentContext) throw new Error(`task-orchestrator provider "${providerName}" inherits parent context; a fresh child provider is required`)
  return provider
}

/** Validate one request-side worker cap against the deployment policy. */
function resolveWorkerCap(requested: number | undefined, ceiling: number): number {
  const value = requested ?? ceiling
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
  if (typeof value.agentsStarted !== 'number' || !Number.isSafeInteger(value.agentsStarted) || value.agentsStarted < 0) {
    throw new Error('task-orchestrator workflow returned an invalid agentsStarted value')
  }
  for (const worker of value.workers) {
    if (!isRecord(worker)
      || !hasNormalizedText(worker.taskId)
      || !['completed', 'blocked', 'failed', 'needs_more_context'].includes(String(worker.status))
      || !hasNormalizedText(worker.summary)) {
      throw new Error('task-orchestrator workflow returned a malformed worker report')
    }
    readStringList(worker.evidence)
    readStringList(worker.changedFiles)
    readStringList(worker.tests)
    readStringList(worker.blockers)
    readStringList(worker.nextSteps)
    if (worker.needs !== undefined) {
      if (!Array.isArray(worker.needs)) throw new Error('task-orchestrator workflow returned malformed worker needs')
      for (const need of worker.needs) {
        if (!isRecord(need) || !['NEED_FILE', 'NEED_HISTORY', 'NEED_MORE_CONTEXT', 'NEED_DEPENDENCY', 'NEED_BUDGET', 'NEED_TOOL_RESULT', 'NEED_MORE_TOOL', 'NEED_REVIEW'].includes(String(need.kind)) || !hasNormalizedText(need.reason)) throw new Error('task-orchestrator workflow returned malformed worker need')
      }
    }
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
  const deploymentWorkerCeiling = Math.min(resolved.maxWorkers, resolved.maxTotalAgents)
  const workerCap = resolveWorkerCap(options.maxWorkers, deploymentWorkerCeiling)
  const allowWrites = resolved.allowWrites || options.executeWrites
  const preferredWorkers = Math.min(options.preferredWorkers ?? resolved.preferredWorkers, workerCap)
  const plan = options.plan ?? buildAdaptivePlan(options.objective, preferredWorkers, workerCap, resolved.requireReview)
  const args: OrchestrationArgs = {
    objective: options.objective,
    planOnly: options.planOnly,
    executeWrites: options.executeWrites,
    preferredWorkers,
    maxWorkers: workerCap,
    maxConcurrentAgents: resolved.maxConcurrentAgents,
    concurrencyByContext: resolved.concurrencyByContext,
    maxHandoffChars: resolved.maxHandoffChars,
    allowWrites,
    allowParallelWrites: resolved.allowParallelWrites,
    requireReview: resolved.requireReview,
    subagentProvider: resolved.subagentProvider,
    ...(resolved.subagentModel === undefined ? {} : { subagentModel: resolved.subagentModel }),
    plan,
    totalContextTokens: resolved.totalContextTokens,
    contextCompactionChars: resolved.contextCompactionChars,
    minimumVramHeadroomGiB: resolved.minimumVramHeadroomGiB,
    parentOrchestratorOnly: resolved.parentOrchestratorOnly,
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
  + 'research, backend, frontend, testing, or documentation workers when approved. The parent remains '
  + 'the only orchestrator; a reviewer is an ordinary worker when requested. Use the explicit tool only '
  + 'after the human approves a displayed plan or explicitly asks for a multi-role team. Writes are disabled by default.'

function presentCall(args: { objective: string }): ToolCallView {
  return { card: 'generic', title: 'task orchestrator', rawInput: args.objective }
}

function presentResult(args: { objective: string }, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** Register the explicit tool and the automatic pre-step orchestrator. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const resources = new ResourceManager({
    maxActiveGenerations: resolved.maxActiveGenerations,
    hardContextTokens: resolved.hardContextTokens,
    totalContextTokens: resolved.totalContextTokens,
    concurrencyByContext: resolved.concurrencyByContext,
    priorityAgingMs: resolved.priorityAgingMs,
  })
  void requireStructuredProvider(ctx, resolved.subagentProvider)
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => resources.stream(ctx, options, next))
  ctx.systemPrompt.section({
    name: 'tool:task-orchestrate',
    order: 150,
    text: 'The task_orchestrate tool is a bounded adaptive team workflow. The parent model is the only orchestrator and may provide a task graph; omitted graphs use a minimal deterministic plan without a planner child. Use the tool only after the human explicitly approves a displayed plan or explicitly requests a multi-role team. Workers, including an optional reviewer worker, return structured evidence; worker claims are not independent certification. Writes require the configured policy or an explicit human-approved executeWrites request.',
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
      plan: {
        ...TOOL_PLAN_SCHEMA,
        description: 'Optional parent-created task graph. Pass the graph object itself, with summary/risk/requiresConfirmation/tasks at its top level. When omitted, the plugin builds a minimal deterministic graph without a planner child.',
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
        ...(args.plan === undefined ? {} : { plan: args.plan as unknown as TaskPlan }),
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
const ORCHESTRATION_SCRIPT = createOrchestrationScript({ plan: PLAN_SCHEMA, worker: WORKER_SCHEMA, review: REVIEW_SCHEMA })

export type { OrchestrationResult, PlannedTask, ReviewReport, TaskPlan, TaskRisk, WorkerReport }
