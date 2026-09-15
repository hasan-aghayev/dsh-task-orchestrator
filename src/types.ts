/** Roles that the planner may assign to worker agents. */
export const TASK_ROLES = [
  'researcher',
  'architect',
  'backend',
  'frontend',
  'tester',
  'documentation',
] as const

/** A role in the task execution graph. */
export type TaskRole = (typeof TASK_ROLES)[number]

/** Risk level returned by the planning agent. */
export type TaskRisk = 'low' | 'medium' | 'high'

/** Status returned by an individual worker. */
export type WorkerStatus = 'completed' | 'blocked' | 'failed'

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
}
