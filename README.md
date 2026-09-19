# pi-agent-workflow

可复用的 Pi 分代理 Workflow 扩展。当前目录与业务项目同级，暂不修改任何业务项目。

## 目标

- 通过 `WorkflowSpec` 描述项目任务
- 每个 batch 使用一个独立的 Pi `AgentSession`
- 支持并发、重试、取消和 dry-run
- 使用 `session.subscribe()` 采集子 Agent 生命周期
- 在 TUI 中显示聚合状态和 batch 状态
- 将状态保存到当前项目的 `.pi/workflow-runs/<runId>/`
- 业务项目自己负责题目读取、结果校验和写回

## 临时测试

目录中的可复制示例：

```text
examples/example.ts
```

在任意项目中：

```bash
pi -e D:/dev/proj/repos/pi-workflow/extensions/pi-workflow.ts
```

运行示例：

```text
/workflow-run D:/dev/proj/repos/pi-workflow/examples/example.ts 9
```

示例会创建 9 个 demo job，每 3 个 job 交给一个子 Agent，并将结果写入当前项目：

```text
.pi/workflow-runs/example-latest-results.json
```

通用命令：

```text
/workflow-run .pi/workflows/example.ts arg1 arg2
/workflow-run .pi/workflows/example.ts 202609 --concurrency 4 --retries 2
/workflow-run .pi/workflows/example.ts 202609 --dry-run
/workflow-status
/workflow-status <runId>
/workflow-cancel <runId>
```

其它项目可以直接复制 `examples/example.ts` 到自己的 `.pi/workflows/`，然后替换 `Job`、`Result`、`loadJobs`、`buildPrompt`、`parseResponse` 和 `applyResults`。

当前还没有把 GESP Spec 放入本目录，也没有连接 `gesp-exam-prep`。

## WorkflowSpec 最小形式

```typescript
import type { WorkflowSpec } from "../../pi-workflow/src/types.ts";

type Job = { id: string; text: string };
type Result = { id: string; value: string };

const workflow: WorkflowSpec<Job, Result> = {
  name: "example",
  batchSize: 3,
  concurrency: 4,
  retries: 2,

  async loadJobs(_ctx, args) {
    return [{ id: args[0] || "demo", text: "..." }];
  },

  buildPrompt(batch) {
    return JSON.stringify(batch);
  },

  parseResponse(text, batch) {
    // 在这里解析并校验模型返回，必须校验 ID 和结果数量。
    return batch.map((job) => ({ id: job.id, value: text }));
  },

  async applyResults(results, _ctx) {
    // 由项目自己决定如何安全写回。
    console.log(results.length);
  },

  getJobId(job) {
    return job.id;
  },
};

export default workflow;
```

## 运行产物

```text
.pi/workflow-runs/<runId>/
├── state.json
└── events.jsonl
```

`events.jsonl` 只记录生命周期和错误元数据，不记录模型隐藏思维过程。
