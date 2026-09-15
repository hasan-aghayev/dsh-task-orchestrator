# DSH Task Orchestrator

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自动先规划再委派插件。插件会识别复杂请求，创建带依赖关系的结构化任务图，分配专注角色，运行有上限的 Worker，并把证据交给最终 Reviewer。

作者：Hasan Aghayev  
许可证：MIT

## 安装

将公开 GitHub 包安装到 DSH profile：

```sh
pnpm dsh plugin --profile web add https://github.com/hasan-aghayev/dsh-task-orchestrator.git
```

包的 `package.json` 声明了 `dsh.bundle`，因此该命令会自动发现并应用 `cordis.patch.yml`。卸载：

```sh
pnpm dsh plugin --profile web remove dsh-task-orchestrator
```

如果 profile 已在运行，安装后请重启它。

## 功能

插件增加 `task_orchestrate` 工具以及自动的第一步 Planner。简单请求继续使用普通流程。复杂请求会通过确定性的检测器评分，然后经过以下阶段：

1. Planner 返回严格 JSON 计划，其中包含摘要、风险、角色、依赖、只读状态和声明的写入范围。
2. Scheduler 只有在依赖完成后才启动角色。互不依赖的只读角色可以在有上限的批次中并行运行。
3. Worker 返回结构化的证据、修改文件、测试、阻塞原因和后续步骤。
4. 最终 Reviewer 将报告与当前工作区对照，并返回 `approved`、`changes_requested`、`blocked` 或 `failed`。

支持的角色包括 `researcher`、`architect`、`backend`、`frontend`、`tester` 和 `documentation`。插件使用 DSH 现有的 subagent 与 workflow 服务，不修改 agent loop。

## 安全默认值

默认模式是 `hybrid`：

- 简单请求不会启动子 Agent；
- 复杂只读请求可以自动执行；
- 需要写入的计划会停在 `plan-only`，等待人工批准；
- 写入和并行写入默认关闭；
- Planner、Worker 和 Reviewer 要求新的结构化输出 subagent provider；
- Planner 和 Reviewer 都计入 Agent 总上限；
- 超大的计划、报告和父 Agent 通知会按配置限制拒绝或截断。

只有在 profile 自己具备审批和工作区策略时，才应开启自动写入：

```yaml
config:
  mode: hybrid
  minComplexityScore: 55
  subagentProvider: spawn
  preferredWorkers: 3
  maxWorkers: 6
  maxTotalAgents: 8
  maxConcurrentAgents: 3
  allowWrites: false
  allowParallelWrites: false
  requireReview: true
```

`suggest` 模式总是先返回计划。`off` 会关闭自动规划，但保留显式工具。`auto` 适用于明确允许自动执行的部署。

`task_orchestrate` 工具接受 `objective`、可选的 `planOnly`、可选的 `executeWrites` 和可选的 `maxWorkers` 上限。请求级上限不能超过部署级上限。

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
- Planner 和 Reviewer 都是语言模型 Agent。严格 schema 和有上限的 handoff 可以减少格式错误，但不能替代人工审查。
- 写入范围会传给 Scheduler 和 Worker prompt；文件权限和审批策略仍由外层 DSH profile 负责。

## 仓库

源码：<https://github.com/hasan-aghayev/dsh-task-orchestrator>
