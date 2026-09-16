/** Fixed workflow VM script used by the parent orchestrator. */
export const createOrchestrationScript = (schemas: { plan: unknown; worker: unknown; review: unknown }): string => String.raw`
const planSchema = ${JSON.stringify(schemas.plan)}
const workerSchema = ${JSON.stringify(schemas.worker)}
const reviewSchema = ${JSON.stringify(schemas.review)}
const contextTiers = [8192, 16384, 24576, 32768, 49152, 65536, 81920, 98304]
const concurrencyTiers = Array.isArray(args.concurrencyByContext) ? args.concurrencyByContext : [{ maxContextTokens: 98304, maxActiveGenerations: args.maxConcurrentAgents }]

function text(value) { return typeof value === 'string' && value.length > 0 && value === value.trim() }
function list(value) { return Array.isArray(value) && value.every(text) }
function bounded(value, label) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || serialized.length > args.maxHandoffChars) throw new Error(label + ' exceeds maxHandoffChars')
  return value
}
function compactText(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value
  const marker = '… [compacted]'
  if (limit <= marker.length) return marker.slice(0, limit)
  return value.slice(0, limit - marker.length) + marker
}
function compactReport(report) {
  const limit = Math.max(128, Math.floor((args.contextCompactionChars || args.maxHandoffChars) / 6))
  const compactList = (items) => items.slice(0, 8).map((item) => compactText(item, limit))
  return {
    taskId: report.taskId,
    status: report.status,
    summary: compactText(report.summary, limit * 2),
    evidence: compactList(report.evidence),
    changedFiles: compactList(report.changedFiles),
    tests: compactList(report.tests),
    blockers: compactList(report.blockers),
    nextSteps: compactList(report.nextSteps),
    ...(report.needs === undefined ? {} : { needs: report.needs.map((need) => ({ kind: need.kind, reason: compactText(need.reason, limit) })) }),
  }
}
function fallbackPackage(task) {
  return { taskId: task.id, goal: args.objective, relevantContext: [], constraints: ['Keep the task isolated from other workers.'], knownFacts: [], files: task.writeScopes || [], dependencies: task.dependsOn || [], expectedOutput: 'A structured report with findings, evidence, risks, and next steps.', doNot: ['Do not start another orchestration.', 'Do not claim unverified work as complete.'] }
}
function validateTaskPackage(task, packageValue) {
  const packet = packageValue === undefined ? fallbackPackage(task) : packageValue
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet) || packet.taskId !== task.id || !text(packet.goal) || !list(packet.relevantContext) || !list(packet.constraints) || !list(packet.knownFacts) || !list(packet.files) || (packet.dependencies !== undefined && !list(packet.dependencies)) || !text(packet.expectedOutput) || !list(packet.doNot)) throw new Error('parent supplied an invalid task package')
  return packet.dependencies === undefined ? { ...packet, dependencies: task.dependsOn || [] } : packet
}
function validatePlan(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('parent orchestrator returned no plan')
  if (!text(value.summary) || !['low', 'medium', 'high'].includes(value.risk) || typeof value.requiresConfirmation !== 'boolean') throw new Error('parent orchestrator returned invalid summary, risk, or confirmation flag')
  const taskLimit = Math.min(6, args.maxWorkers)
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > taskLimit) throw new Error('parent orchestrator returned an invalid task count')
  const ids = new Set()
  for (const task of value.tasks) {
    if (task === null || typeof task !== 'object' || Array.isArray(task) || !text(task.id) || !text(task.title) || !text(task.prompt) || !['researcher', 'architect', 'backend', 'frontend', 'tester', 'documentation', 'reviewer'].includes(task.role) || typeof task.readOnly !== 'boolean' || !list(task.dependsOn) || !list(task.writeScopes)) throw new Error('parent orchestrator returned an invalid task')
    if (ids.has(task.id)) throw new Error('parent orchestrator returned duplicate task ids')
    ids.add(task.id)
    if (task.contextBudget !== undefined && !contextTiers.includes(task.contextBudget)) throw new Error('parent orchestrator returned an unsupported context tier')
    task.contextBudget = task.contextBudget || 24576
    task.outputReserveTokens = Number.isSafeInteger(task.outputReserveTokens) && task.outputReserveTokens >= 0 ? task.outputReserveTokens : 2048
    task.safetyReserveTokens = Number.isSafeInteger(task.safetyReserveTokens) && task.safetyReserveTokens >= 0 ? task.safetyReserveTokens : 1024
    task.taskPackage = validateTaskPackage(task, task.taskPackage)
  }
  for (const task of value.tasks) if (task.dependsOn.includes(task.id) || task.dependsOn.some((dependency) => !ids.has(dependency))) throw new Error('parent orchestrator returned an unknown or self dependency')
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error('parent orchestrator returned a dependency cycle')
    if (visited.has(id)) return
    visiting.add(id)
    const task = value.tasks.find((item) => item.id === id)
    for (const dependency of task.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of value.tasks) visit(task.id)
  return bounded(value, 'parent plan')
}
function validateWorker(value, taskId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.taskId !== taskId || !['completed', 'blocked', 'failed', 'needs_more_context'].includes(value.status) || !text(value.summary) || !list(value.evidence) || !list(value.changedFiles) || !list(value.tests) || !list(value.blockers) || !list(value.nextSteps)) throw new Error('worker returned an invalid report')
  if (value.needs !== undefined && (!Array.isArray(value.needs) || value.needs.some((need) => need === null || typeof need !== 'object' || !['NEED_FILE', 'NEED_HISTORY', 'NEED_MORE_CONTEXT', 'NEED_DEPENDENCY', 'NEED_BUDGET', 'NEED_TOOL_RESULT', 'NEED_MORE_TOOL', 'NEED_REVIEW'].includes(need.kind) || !text(need.reason) || (need.requestedContextTokens !== undefined && !contextTiers.includes(need.requestedContextTokens))))) throw new Error('worker returned an invalid need request')
  return bounded(value, 'worker handoff')
}
function hasWrite(task) { return !task.readOnly || task.writeScopes.length > 0 }
function scopesOverlap(left, right) {
  function overlaps(leftScope, rightScope) { return leftScope === rightScope || leftScope.startsWith(rightScope + '/') || rightScope.startsWith(leftScope + '/') || leftScope.startsWith(rightScope + '\\') || rightScope.startsWith(leftScope + '\\') }
  return left.some((leftScope) => right.some((rightScope) => overlaps(leftScope, rightScope)))
}
function taskCost(task) { return task.contextBudget + task.outputReserveTokens + task.safetyReserveTokens }
function taskConcurrency(task) {
  const tier = concurrencyTiers.find((entry) => task.contextBudget <= entry.maxContextTokens)
  return tier === undefined ? 1 : Math.min(args.maxConcurrentAgents, tier.maxActiveGenerations)
}
function workerPrompt(task, reports) {
  const dependencyReports = reports.filter((report) => task.dependsOn.includes(report.taskId)).map((report) => JSON.stringify(compactReport(report)))
  const packet = { ...task.taskPackage, relevantContext: [...task.taskPackage.relevantContext, ...dependencyReports], constraints: [...task.taskPackage.constraints, args.allowWrites ? 'Writes are allowed only inside declared writeScopes.' : 'Read-only: do not edit files.'] }
  return ['You are one isolated ' + task.role + ' worker.', 'Do not start another orchestration.', 'TASK:\\n' + task.title + '\\n' + task.prompt, 'GOAL:\\n' + packet.goal, 'RELEVANT CONTEXT:\\n' + JSON.stringify(packet.relevantContext), 'CONSTRAINTS:\\n' + JSON.stringify(packet.constraints), 'KNOWN FACTS:\\n' + JSON.stringify(packet.knownFacts), 'FILES / CODE:\\n' + JSON.stringify(packet.files), 'DEPENDENCIES:\\n' + JSON.stringify(packet.dependencies), 'EXPECTED OUTPUT:\\n' + packet.expectedOutput, 'DO NOT:\\n' + JSON.stringify(packet.doNot), 'Declared write scopes:\\n' + JSON.stringify(task.writeScopes), 'Before requesting more context, compact the current evidence into the structured fields; do not repeat raw logs or the full parent history.', 'Return a strict structured report. If the packet is insufficient, return status needs_more_context and a NEED_MORE_CONTEXT item instead of guessing.'].join('\\n\\n')
}
function nextTier(current, requested) {
  if (requested !== undefined && requested > current) return requested
  return contextTiers.find((tier) => tier > current && tier <= args.totalContextTokens)
}
function reviewFromWorker(report) {
  return { status: report.status === 'completed' ? 'approved' : report.status === 'blocked' ? 'blocked' : 'changes_requested', summary: report.summary, findings: report.evidence.concat(report.blockers), checks: report.tests, nextSteps: report.nextSteps }
}
function childOptions(label, phaseName, schema) {
  const options = { label, phase: phaseName, schema }
  if (args.subagentModel !== undefined) options.model = args.subagentModel
  return options
}

phase('Planning')
const plan = validatePlan(args.plan)
const needsWriteApproval = plan.requiresConfirmation || plan.tasks.some(hasWrite)
if (args.planOnly || (needsWriteApproval && !args.allowWrites)) return { status: 'plan-only', summary: 'A plan was created and is awaiting explicit write approval.', plan, workers: [], review: null, taskStates: plan.tasks.map((task) => ({ taskId: task.id, state: 'CREATED', attempts: 0 })), agentsStarted: 0 }

phase('Execution')
const remaining = plan.tasks.slice()
const completed = new Map()
const workers = []
const attempts = new Map(plan.tasks.map((task) => [task.id, 0]))
const states = new Map(plan.tasks.map((task) => [task.id, 'CREATED']))
const running = []
let usedContext = 0
let workersStarted = 0
let targetWorkers = Math.min(Number.isSafeInteger(args.preferredWorkers) ? args.preferredWorkers : args.maxWorkers, args.maxWorkers)
const admittedWorkers = new Set()
let review = null
function canShareActive(task) {
  const conflicts = running.some((entry) => scopesOverlap(entry.task.writeScopes, task.writeScopes))
  const activeHasWrite = running.some((entry) => hasWrite(entry.task))
  return (!hasWrite(task) && !activeHasWrite) || (args.allowParallelWrites && !conflicts)
}
function launch(task) {
  const cost = taskCost(task)
  usedContext += cost
  workersStarted += 1
  const entry = { task, cost, promise: Promise.resolve().then(() => agent(workerPrompt(task, workers), childOptions(task.role + ': ' + task.title, 'Execution', workerSchema))).catch(() => null) }
  running.push(entry)
}
function consume(task, raw) {
  const report = raw === null ? { taskId: task.id, status: 'failed', summary: 'Worker failed before producing a report.', evidence: [], changedFiles: [], tests: [], blockers: ['No structured worker result was returned.'], nextSteps: [] } : validateWorker(raw, task.id)
  const need = (report.needs || []).find((item) => item.kind === 'NEED_MORE_CONTEXT')
  const escalated = report.status === 'needs_more_context' || need !== undefined
  const requested = need === undefined ? undefined : need.requestedContextTokens
  const higher = nextTier(task.contextBudget, requested)
  if (escalated && higher !== undefined && (attempts.get(task.id) || 0) < 3) { task.contextBudget = higher; task.taskPackage = { ...task.taskPackage, relevantContext: [...task.taskPackage.relevantContext, 'Compacted previous worker attempt:\\n' + JSON.stringify(compactReport(report))] }; remaining.push(task); states.set(task.id, 'WAITING'); return }
  workers.push(report)
  completed.set(task.id, report)
  states.set(task.id, report.status === 'completed' ? 'DONE' : 'FAILED')
  if (task.role === 'reviewer') review = reviewFromWorker(report)
  if (admittedWorkers.size < args.maxWorkers && remaining.length > 0) targetWorkers = Math.min(args.maxWorkers, Math.max(targetWorkers + 1, taskConcurrency(task)))
}
while (remaining.length > 0 || running.length > 0) {
  for (const task of remaining) if (states.get(task.id) === 'CREATED') states.set(task.id, 'QUEUED')
  while (running.length < args.maxConcurrentAgents) {
    const ready = remaining.filter((task) => task.dependsOn.every((dependency) => completed.get(dependency)?.status === 'completed'))
    const candidates = ready.slice().sort((left, right) => taskCost(right) - taskCost(left))
    const candidate = candidates.find((task) => (admittedWorkers.has(task.id) || admittedWorkers.size < targetWorkers) && canShareActive(task) && running.length < taskConcurrency(task) && usedContext + taskCost(task) <= args.totalContextTokens)
    if (candidate === undefined) break
    const position = remaining.indexOf(candidate)
    if (position >= 0) remaining.splice(position, 1)
    states.set(candidate.id, 'ACTIVE')
    attempts.set(candidate.id, (attempts.get(candidate.id) || 0) + 1)
    admittedWorkers.add(candidate.id)
    launch(candidate)
  }
  if (running.length === 0) {
    const ready = remaining.filter((task) => task.dependsOn.every((dependency) => completed.get(dependency)?.status === 'completed'))
    if (ready.length === 0) {
      for (const task of remaining) { states.set(task.id, 'FAILED'); workers.push({ taskId: task.id, status: 'blocked', summary: 'Dependency did not complete.', evidence: [], changedFiles: [], tests: [], blockers: ['A required dependency failed or was blocked.'], nextSteps: [] }) }
      break
    }
    const task = ready[0]
    remaining.splice(remaining.indexOf(task), 1)
    states.set(task.id, 'FAILED')
    workers.push({ taskId: task.id, status: 'blocked', summary: 'Task exceeds the available context budget.', evidence: [], changedFiles: [], tests: [], blockers: ['Reduce the requested context tier or increase totalContextTokens.'], nextSteps: [] })
    continue
  }
  const settled = await Promise.race(running.map((entry) => entry.promise.then((raw) => ({ entry, raw }))))
  const position = running.indexOf(settled.entry)
  if (position >= 0) running.splice(position, 1)
  usedContext = Math.max(0, usedContext - settled.entry.cost)
  consume(settled.entry.task, settled.raw)
}
const workerFailure = workers.some((worker) => worker.status !== 'completed')
const status = workerFailure || review?.status === 'blocked' || review?.status === 'changes_requested' || review?.status === 'failed' ? 'blocked' : 'completed'
return { status, summary: status === 'completed' ? 'All selected workers completed; the optional reviewer used an ordinary worker slot.' : 'The orchestration produced partial work or requires follow-up.', plan, workers, review, taskStates: plan.tasks.map((task) => ({ taskId: task.id, state: states.get(task.id), attempts: attempts.get(task.id) || 0 })), agentsStarted: workersStarted }
`
