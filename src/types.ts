/** Roles that the parent orchestrator may assign to worker agents. */
export const TASK_ROLES = [
  'researcher',
  'architect',
  'backend',
  'frontend',
  'tester',
  'documentation',
  'reviewer',
] as const

/** A role in the task execution graph. */
export type TaskRole = (typeof TASK_ROLES)[number]

/** Risk level returned by the planning agent. */
export type TaskRisk = 'low' | 'medium' | 'high'

/** Status returned by an individual worker. */
export type WorkerStatus = 'completed' | 'blocked' | 'failed' | 'needs_more_context'

/** Status returned by the final reviewer. */
export type ReviewStatus = 'approved' | 'changes_requested' | 'blocked' | 'failed'

/** One planned unit of work and its declared dependencies. */
export interface PlannedTask {
  id: string
  title: string
  role: TaskRole
  prompt: string
  dependsOn: string[]
  readOnly: boolean
  writeScopes: string[]
  /** Context tier selected by the parent orchestrator. */
  contextBudget?: 8192 | 16384 | 24576 | 32768 | 49152 | 65536 | 81920 | 98304
  /** Reserved output tokens used during admission. */
  outputReserveTokens?: number
  /** Additional safety reserve used during admission. */
  safetyReserveTokens?: number
  /** Isolated task packet sent to the worker. */
  taskPackage?: TaskPackage
}

/** Isolated worker input packet; fields are intentionally explicit. */
export interface TaskPackage {
  taskId: string
  goal: string
  relevantContext: string[]
  constraints: string[]
  knownFacts: string[]
  files: string[]
  dependencies: string[]
  expectedOutput: string
  doNot: string[]
}

/** Worker request for more context, a tool, or a review pass. */
export interface WorkerNeed {
  kind: 'NEED_FILE' | 'NEED_HISTORY' | 'NEED_MORE_CONTEXT' | 'NEED_DEPENDENCY' | 'NEED_BUDGET' | 'NEED_TOOL_RESULT' | 'NEED_MORE_TOOL' | 'NEED_REVIEW'
  reason: string
  requestedContextTokens?: 8192 | 16384 | 24576 | 32768 | 49152 | 65536 | 81920 | 98304
}

/** Durable state snapshot for one logical task. */
export interface TaskState {
  taskId: string
  state: 'CREATED' | 'QUEUED' | 'ACTIVE' | 'WAITING' | 'DONE' | 'FAILED' | 'CANCELLED' | 'PARKED'
  attempts: number
}

/** The strict result expected from the planning agent. */
export interface TaskPlan {
  summary: string
  risk: TaskRisk
  requiresConfirmation: boolean
  tasks: PlannedTask[]
}

/** Structured result expected from each worker agent. */
export interface WorkerReport {
  taskId: string
  status: WorkerStatus
  summary: string
  evidence: string[]
  changedFiles: string[]
  tests: string[]
  blockers: string[]
  nextSteps: string[]
  needs?: WorkerNeed[]
}

/** Structured result expected from the final reviewer agent. */
export interface ReviewReport {
  status: ReviewStatus
  summary: string
  findings: string[]
  checks: string[]
  nextSteps: string[]
}

/** Complete value returned by one orchestration run. */
export interface OrchestrationResult {
  status: 'completed' | 'plan-only' | 'blocked' | 'failed'
  summary: string
  plan: TaskPlan | null
  workers: WorkerReport[]
  review: ReviewReport | null
  agentsStarted: number
  taskStates?: TaskState[]
}
