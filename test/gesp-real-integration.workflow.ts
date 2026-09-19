import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowSpec } from "../src/types.ts";

type Question = {
  id: string;
  type: string;
  question: string;
  options?: string[];
  answer?: string;
};

type Result = { id: string; explanation: string };

function parseResponse(text: string): { explanations: Result[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`GESP response is not JSON: ${text.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start, end + 1)) as { explanations: Result[] };
}

const workflow: WorkflowSpec<Question, Result> = {
  name: "gesp-real-integration",
  batchSize: 3,
  concurrency: 1,
  retries: 1,

  async loadJobs(ctx) {
    const gespRoot = resolve(ctx.cwd, "..", "gesp-exam-prep");
    const file = join(gespRoot, "data", "raw", "cpp-l1-202609.json");
    const data = JSON.parse(await readFile(file, "utf8")) as { questions: Question[] };
    return data.questions.slice(0, 3);
  },

  buildPrompt(batch) {
    return [
      "你是 CCF GESP C++ 题目解析专家。",
      "请为以下三道题生成简体中文答案解析，每题不超过100字。",
      "单选题必须根据 answer 说明理由并以‘因此选 X’结尾。",
      "只返回 JSON，不要 Markdown：{\"explanations\":[{\"id\":\"题目ID\",\"explanation\":\"解析\"}]}。",
      JSON.stringify({ questions: batch }, null, 2),
    ].join("\n");
  },

  parseResponse(text, batch) {
    const parsed = parseResponse(text);
    if (parsed.explanations.length !== batch.length) throw new Error("GESP response count mismatch");
    const expected = new Set(batch.map((question) => question.id));
    const seen = new Set<string>();
    for (const item of parsed.explanations) {
      if (!expected.has(item.id)) throw new Error(`Unexpected question ID: ${item.id}`);
      if (seen.has(item.id)) throw new Error(`Duplicate question ID: ${item.id}`);
      if (!item.explanation.trim() || item.explanation.length > 100) throw new Error(`Invalid explanation length: ${item.id}`);
      seen.add(item.id);
    }
    if (seen.size !== expected.size) throw new Error("GESP response is incomplete");
    return parsed.explanations;
  },

  async applyResults(results) {
    if (results.length !== 3) throw new Error("Expected three validated explanations");
    // Integration-only workflow: deliberately does not modify the GESP project.
  },

  getJobId(question) {
    return question.id;
  },
};

export default workflow;
