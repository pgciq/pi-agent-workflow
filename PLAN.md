# pi-workflow 实现计划

## 阶段 1：通用 Runner 骨架（已完成）

- [x] `WorkflowSpec` 类型
- [x] batch 切分
- [x] 并发 worker
- [x] 子 `AgentSession`
- [x] retry
- [x] dry-run
- [x] `session.subscribe()` 生命周期采集
- [x] TUI status/widget
- [x] `state.json`
- [x] `events.jsonl`
- [x] `/workflow-run`
- [x] `/workflow-status`
- [x] `/workflow-cancel`
- [x] `workflow_run` 自定义工具

## 阶段 2：运行可靠性

- [ ] 为每个运行增加 lock，防止同一 Spec 重复执行
- [ ] 将结果按 batch 增量保存到 `results.jsonl`
- [ ] 从 `state.json` 恢复中断运行
- [ ] 让取消操作主动调用所有活动子 Session 的 `abort()`
- [ ] 增加单 batch 超时和全局超时
- [ ] 增加 API rate-limit/backoff
- [ ] 处理父进程退出时的子 Session 清理

## 阶段 3：监控体验

- [ ] Widget 显示最近运行的 batch，而不是固定前 20 个
- [ ] 增加运行详情视图
- [ ] 显示模型名、尝试次数、耗时、结果数量
- [ ] 增加 `/workflow-events <runId>`
- [ ] 增加 `/workflow-retry <runId> [batchId]`
- [ ] 可选保存完整 child session，默认仍使用 in-memory
- [ ] 只显示模型输出预览，不显示隐藏思维过程

## 阶段 4：项目适配

- [ ] 在 GESP 项目中新增独立 `.pi/workflows/gesp-explanations.ts`
- [ ] 在 GESP 项目中新增独立 `.pi/workflows/gesp-tags.ts`
- [ ] 将 GESP 数据读取、解析、标签校验、patch、build 逻辑放入 Spec
- [ ] 验证 Spec 不反向依赖 GESP Extension
- [ ] 当前 `gesp-exam-prep` 在确认迁移前保持不动

## 阶段 5：用户级安装

推荐方式：

1. 将本目录整理为 Pi package。
2. 通过 Git 或本地路径安装到用户级 Pi 配置。
3. 在 `~/.pi/agent/extensions/` 自动加载入口。
4. 其它项目只提供自己的 `.pi/workflows/*.ts`。

候选安装方式：

```bash
pi install -l D:/dev/proj/repos/pi-workflow
```

安装命令需要结合当前 Pi 版本实际验证；在正式安装前优先使用 `pi -e` 测试。

## 暂不做

- 不把 GESP 题库逻辑写入通用 Runner
- 不默认保存所有子 Agent 完整会话
- 不上传任何运行结果到外部服务
- 不自动修改业务项目的 `.pi` 配置
