# DSH Task Orchestrator

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自适应委派插件。父模型是唯一的 Orchestrator：它创建或验证小型依赖图，按上下文预算选择足够的 Worker，并可让一个普通 Worker 承担 Reviewer 角色。

作者：Hasan Aghayev  
许可证：MIT

## 安装

将公开 GitHub 包安装到 DSH profile：

```sh
pnpm dsh plugin --profile web add https://github.com/hasan-aghayev/dsh-task-orchestrator.git
```

包的 `package.json` 声明了 `dsh.bundle`，因此该命令会自动发现并应用 `cordis.patch.yml`。组合包会安装一个由本包拥有的委派组，其中包含工作流引擎以及面向模型的工具：`subagent`、`subagent_fork`、`send_message`、`interrupt_agent` 和 `list_agents`。它不会启用 DSH 独立的面向模型的 `workflow` 工具。标准 web profile 行会继续保持禁用，因此在 DSH Market 中关闭本插件时，该组及其全部工具会一起关闭。卸载：

```sh
pnpm dsh plugin --profile web remove dsh-task-orchestrator
```

如果 profile 已在运行，安装后请重启它。

## 功能

插件增加 `task_orchestrate` 工具并启用标准 DSH 委派工具。简单请求继续使用普通流程。复杂请求会通过确定性的检测器评分，然后经过以下阶段：

1. 父 Orchestrator 提供严格 JSON 计划；如果没有计划，插件创建不启动 Planner 子 Agent 的最小确定性图。
2. 每个 Worker 只收到明确的 `TASK`、`GOAL`、`RELEVANT CONTEXT`、`CONSTRAINTS`、`KNOWN FACTS`、`FILES / CODE`、`DEPENDENCIES`、`EXPECTED OUTPUT` 和 `DO NOT` 信息包。
3. Scheduler 只有在依赖完成后才启动角色，并按照上下文档位和活动生成上限组合安全批次。
4. Worker 返回证据、修改文件、测试、阻塞原因和后续步骤；也可以返回 `NEED_FILE`、`NEED_HISTORY`、`NEED_MORE_CONTEXT`、`NEED_DEPENDENCY`、`NEED_BUDGET` 或 `NEED_TOOL_RESULT`。只有 `NEED_MORE_CONTEXT` 会触发一次有限的上下文升级。
5. `reviewer` 是普通 Worker 角色，生成最终审核字段，不会创建第七个子 Agent。

支持的角色包括 `researcher`、`architect`、`backend`、`frontend`、`tester`、`documentation` 和 `reviewer`。插件使用 DSH 现有的 subagent 与 workflow 服务，不修改 agent loop。

模型还可以调用 `subagent` 创建新的子 Agent，调用 `subagent_fork` 继承父 Agent 已完成的轮次，并使用 `list_agents`、`send_message` 或 `interrupt_agent` 管理可继续的子 Agent。这些工具作为组合包拥有的组子项加载，而不是修改基础行；因此 Market 开关是原子的：关闭插件会关闭该组及其五个面向模型的工具，web profile 的标准行也会保持关闭。

## 安全默认值

默认模式是 `hybrid`：

- 简单请求不会启动子 Agent；
- 复杂只读请求可以自动执行；
- 需要写入的计划会停在 `plan-only`，等待人工批准；
- 写入和并行写入默认关闭；
- Planner、Worker 和 Reviewer 要求新的结构化输出 subagent provider；
- 最多六个 Worker；父 Orchestrator 不计入子 Agent 上限，因此逻辑上最多是一个父 Agent 加六个 Worker；
- 超大的计划、报告和父 Agent 通知会按配置限制拒绝或截断。

只有在 profile 自己具备审批和工作区策略时，才应开启自动写入：

```yaml
config:
  mode: hybrid
  minComplexityScore: 55
  subagentProvider: spawn
  preferredWorkers: 2
  maxWorkers: 6
  maxTotalAgents: 6
  maxConcurrentAgents: 2
  allowWrites: false
  allowParallelWrites: false
  requireReview: true
  maxActiveGenerations: 2
  hardContextTokens: 65536
  priorityAgingMs: 30000
  totalContextTokens: 98304
  minimumVramHeadroomGiB: 0.8
  parentOrchestratorOnly: true
```

`suggest` 模式总是先返回计划。`off` 会关闭自动规划，但保留显式工具。`auto` 适用于明确允许自动执行的部署。

`maxActiveGenerations` 限制父 Agent 和子 Agent 同时消费的模型流。只有正在消费输出的流占用一个槽位；等待工具或子任务的 Agent 不占用槽位。`priorityAgingMs` 让排队请求在达到设定时间后提升一级优先级，避免 worker 长时间等待。`hardContextTokens` 是分词前的保守检查，精确 token 数仍由 NInfer 决定。`totalContextTokens` 是批次预算，不保证 GPU 可以同时容纳所有请求；`minimumVramHeadroomGiB` 记录部署时的安全目标。

`task_orchestrate` 工具接受 `objective`、可选父模型 `plan`、可选的 `planOnly`、可选的 `executeWrites` 和可选的 `maxWorkers` 上限。请求级上限不能超过部署级上限。

## 开发

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

包会将 JavaScript 输出到 `lib/`，将声明文件输出到 `lib/types/`。发布包只包含构建后的运行时、声明文件、bundle patch 和成对的 README。

## 限制

- Worker 共享 profile 工作区。并行写入默认关闭，插件不会自动创建 git worktree。
- 复杂度检测使用词法信号，可能漏掉简短但困难的请求，也可能把较长的简单请求判为复杂。
- NInfer 本身不会强制任意 JSON 输出。DSH 会在每次模型响应后验证计划和 Worker 字段，但这不能替代人工审查。
- 写入范围会传给 Scheduler 和 Worker prompt；文件权限和审批策略仍由外层 DSH profile 负责。

## 仓库

源码：<https://github.com/hasan-aghayev/dsh-task-orchestrator>
