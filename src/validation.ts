/** Parse model-authored plans and child reports before scheduling. @module */
import { CONTEXT_TIERS } from './adaptive.js'
import { TASK_ROLES, type PlannedTask, type TaskPlan, type WorkerReport, type ReviewReport, type WorkerNeed } from './types.js'

/** Require an object from model or durable JSON. */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected an object')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty text`)
  return value.trim()
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw new TypeError(`${field} must be a string list`)
  return [...value]
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const found = choices.find(item => item === value)
  if (found === undefined) throw new TypeError(`Invalid ${field}`)
  return found
}

/** Validate a whole-token limit received from the model. */
export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

/** Decode and validate a dependency graph; no children start on rejection. */
export function readPlan(value: unknown, maxChars: number): TaskPlan {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('An explicit parent plan is required')
  if (serialized.length > maxChars) throw new TypeError('Plan exceeds maxHandoffChars; shorten the task packets')
  const raw = record(value)
  if (typeof raw.requiresConfirmation !== 'boolean') throw new TypeError('requiresConfirmation must be a boolean')
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new TypeError('Plan must contain tasks')
  const tasks: PlannedTask[] = raw.tasks.map((value: unknown) => {
    const item = record(value)
    if (typeof item.readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean')
    const task: PlannedTask = {
      id: text(item.id, 'id'), title: text(item.title, 'title'), owner: text(item.owner, 'owner'),
      role: choice(item.role, TASK_ROLES, 'role'), prompt: text(item.prompt, 'prompt'),
      dependsOn: strings(item.dependsOn, 'dependsOn'), readOnly: item.readOnly,
      writeScopes: strings(item.writeScopes, 'writeScopes'),
      contextBudget: positiveInteger(item.contextBudget ?? 24_576, 'contextBudget'),
      outputReserveTokens: positiveInteger(item.outputReserveTokens ?? 2_048, 'outputReserveTokens'),
      safetyReserveTokens: positiveInteger(item.safetyReserveTokens ?? 1_024, 'safetyReserveTokens'),
    }
    if (!CONTEXT_TIERS.includes(task.contextBudget!)) throw new TypeError(`${task.id}: unsupported contextBudget`)
    if (task.outputReserveTokens! + task.safetyReserveTokens! >= task.contextBudget!) throw new TypeError(`${task.id}: reserves leave no input context`)
    if (task.readOnly && task.writeScopes.length !== 0) throw new TypeError(`${task.id}: read-only task cannot declare writes`)
    if (!task.readOnly && (task.writeScopes.length === 0 || task.writeScopes.some(scope => scope.trim().length === 0))) throw new TypeError(`${task.id}: write task must declare writeScopes`)
    if (item.taskPackage !== undefined) {
      const packet = record(item.taskPackage)
      task.taskPackage = {
        taskId: text(packet.taskId, 'taskPackage.taskId'), goal: text(packet.goal, 'taskPackage.goal'),
        relevantContext: strings(packet.relevantContext, 'relevantContext'), constraints: strings(packet.constraints, 'constraints'),
        knownFacts: strings(packet.knownFacts, 'knownFacts'), files: strings(packet.files, 'files'),
        dependencies: strings(packet.dependencies ?? task.dependsOn, 'dependencies'),
        expectedOutput: text(packet.expectedOutput, 'expectedOutput'), doNot: strings(packet.doNot, 'doNot'),
      }
      if (task.taskPackage.taskId !== task.id) throw new TypeError(`${task.id}: taskPackage.taskId mismatch`)
    }
    return task
  })
  const ids = new Set(tasks.map(task => task.id))
  if (ids.size !== tasks.length) throw new TypeError('Task ids must be unique')
  if (new Set(tasks.map(task => task.owner)).size !== tasks.length) throw new TypeError('Each task must have a unique assigned worker')
  for (const task of tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.some(id => !ids.has(id) || id === task.id)) throw new TypeError(`${task.id}: invalid dependency`)
  }
  const visited = new Set<string>()
  while (visited.size < tasks.length) {
    const ready = tasks.filter(task => !visited.has(task.id) && task.dependsOn.every(id => visited.has(id)))
    if (ready.length === 0) throw new TypeError('Task dependencies contain a cycle')
    for (const task of ready) visited.add(task.id)
  }
  return { summary: text(raw.summary, 'summary'), risk: choice(raw.risk, ['low', 'medium', 'high'], 'risk'), requiresConfirmation: raw.requiresConfirmation, tasks }
}

/** Decode one child report and require its assigned task identity. */
export function readWorker(value: unknown, taskId: string, maxChars: number): WorkerReport {
  if (JSON.stringify(value)?.length > maxChars) throw new TypeError('Worker report exceeds maxHandoffChars')
  const raw = record(value)
  if (raw.taskId !== taskId) throw new TypeError(`Worker report taskId must be exactly ${taskId}`)
  const report: WorkerReport = {
    taskId, status: choice(raw.status, ['completed', 'blocked', 'failed', 'needs_more_context'], 'worker status'),
    summary: text(raw.summary, 'summary'), evidence: strings(raw.evidence, 'evidence'), changedFiles: strings(raw.changedFiles, 'changedFiles'),
    tests: strings(raw.tests, 'tests'), blockers: strings(raw.blockers, 'blockers'), nextSteps: strings(raw.nextSteps, 'nextSteps'),
  }
  if (raw.needs !== undefined) {
    if (!Array.isArray(raw.needs)) throw new TypeError('needs must be an array')
    report.needs = raw.needs.map((value: unknown): WorkerNeed => {
      const need = record(value)
      return {
        kind: choice(need.kind, ['NEED_FILE', 'NEED_HISTORY', 'NEED_MORE_CONTEXT', 'NEED_DEPENDENCY', 'NEED_BUDGET', 'NEED_TOOL_RESULT', 'NEED_MORE_TOOL', 'NEED_REVIEW'], 'need kind'),
        reason: text(need.reason, 'need reason'),
        ...(need.requestedContextTokens === undefined ? {} : { requestedContextTokens: positiveInteger(need.requestedContextTokens, 'requestedContextTokens') }),
      }
    })
  }
  return report
}

/** Decode the independent review; only approval permits overall completion. */
export function readReview(value: unknown, maxChars: number): ReviewReport {
  if (JSON.stringify(value)?.length > maxChars) throw new TypeError('Review exceeds maxHandoffChars')
  const raw = record(value)
  return {
    status: choice(raw.status, ['approved', 'changes_requested', 'blocked', 'failed'], 'review status'),
    summary: text(raw.summary, 'summary'), findings: strings(raw.findings, 'findings'), checks: strings(raw.checks, 'checks'), nextSteps: strings(raw.nextSteps, 'nextSteps'),
  }
}

/** Bound the entire dependency handoff, including all lists and JSON overhead. */
export function compactReport(report: WorkerReport, maxChars: number): string {
  const serialized = JSON.stringify(report)
  if (serialized.length <= maxChars) return serialized
  const marker = ' … [compacted; full report remains in the parent session]'
  return serialized.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(0, maxChars)
}
