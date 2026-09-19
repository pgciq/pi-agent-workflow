import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../src/runner.ts";
import type { WorkflowSpec } from "../src/types.ts";

type Job = { id: string; input: string };
type Result = { id: string; result: string };

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "print",
    model: undefined,
    scopedModels: [],
    ui: { setStatus() {}, setWidget() {}, notify() {} },
  } as unknown as ExtensionContext;
}

const integrationSpec: WorkflowSpec<Job, Result> = {
  name: "integration-test",
  batchSize: 1,
  concurrency: 1,
  retries: 0,
  async loadJobs() {
    return [{ id: "integration-1", input: "return the word pong" }];
  },
  buildPrompt(batch) {
    return [
      "Return only JSON.",
      'Format: {"results":[{"id":"integration-1","result":"pong"}]}',
      JSON.stringify(batch),
    ].join("\n");
  },
  parseResponse(text, batch) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(start, end + 1)) as { results: Result[] };
    assert.equal(parsed.results.length, batch.length);
    assert.equal(parsed.results[0]?.id, batch[0]?.id);
    return parsed.results;
  },
  async applyResults(results) {
    assert.deepEqual(results, [{ id: "integration-1", result: "pong" }]);
  },
};

test("real child AgentSession integration", { skip: !process.env.PI_WORKFLOW_INTEGRATION }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-workflow-integration-"));
  try {
    const state = await runWorkflow({} as ExtensionAPI, context(cwd), integrationSpec, [], {
      timeoutMs: 180_000,
      specPath: "test/integration.test.ts",
    });
    assert.equal(state.status, "completed");
    assert.equal(state.completedBatches, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
