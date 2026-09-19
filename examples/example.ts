import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowSpec } from "../src/types.ts";

type ExampleJob = {
  id: string;
  input: string;
};

type ExampleResult = {
  id: string;
  result: string;
};

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型返回中没有 JSON 对象");
  return JSON.parse(candidate.slice(start, end + 1));
}

const workflow: WorkflowSpec<ExampleJob, ExampleResult> = {
  name: "example",
  description: "可复制改写的最小 WorkflowSpec 示例",
  batchSize: 3,
  concurrency: 4,
  retries: 2,

  async loadJobs(_ctx, args) {
    const count = Math.max(1, Math.min(100, Number(args[0]) || 9));
    return Array.from({ length: count }, (_, index) => ({
      id: `demo-${String(index + 1).padStart(3, "0")}`,
      input: `这是第 ${index + 1} 个示例任务`,
    }));
  },

  buildPrompt(batch) {
    return [
      "你是一个批处理子 Agent。请处理下面的任务。",
      "每个任务都必须返回一个结果。只返回 JSON，不要返回解释文字。",
      '格式：{"results":[{"id":"demo-001","result":"..."}]}',
      "",
      JSON.stringify({ jobs: batch }, null, 2),
    ].join("\n");
  },

  parseResponse(text, batch) {
    const parsed = extractJson(text) as { results?: unknown };
    if (!Array.isArray(parsed.results)) throw new Error("缺少 results 数组");

    const expected = new Set(batch.map((job) => job.id));
    const seen = new Set<string>();
    const results: ExampleResult[] = [];

    for (const item of parsed.results) {
      if (!item || typeof item !== "object") throw new Error("results 中存在非法元素");
      const id = String((item as { id?: unknown }).id || "");
      const result = String((item as { result?: unknown }).result || "").trim();
      if (!expected.has(id)) throw new Error(`未知任务 ID：${id}`);
      if (seen.has(id)) throw new Error(`任务重复：${id}`);
      if (!result) throw new Error(`任务结果为空：${id}`);
      seen.add(id);
      results.push({ id, result });
    }

    const missing = [...expected].filter((id) => !seen.has(id));
    if (missing.length > 0) throw new Error(`缺少任务结果：${missing.join(", ")}`);
    return results;
  },

  async applyResults(results, ctx) {
    // 实际项目中，把这里替换为数据库写回、patch 脚本或 API 调用。
    const outputDir = join(ctx.cwd, ".pi", "workflow-runs");
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "example-latest-results.json"),
      JSON.stringify(results, null, 2),
      "utf8",
    );
  },

  getJobId(job) {
    return job.id;
  },
};

export default workflow;
