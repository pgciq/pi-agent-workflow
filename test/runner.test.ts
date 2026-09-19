import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readRunEvents, readRunState, runWorkflow } from "../src/runner.ts";
import type { WorkflowSpec } from "../src/types.ts";

type Job = { id: string };
type Result = { id: string; value: string };

function testContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "print",
    model: undefined,
    scopedModels: [],
    ui: {
      setStatus() {},
      setWidget() {},
      notify() {},
    },
  } as unknown as ExtensionContext;
}

function demoSpec(applyResults?: (results: Result[]) => Promise<void>): WorkflowSpec<Job, Result> {
  return {
    name: "runner-test",
    batchSize: 2,
    async loadJobs() {
      return [{ id: "a" }, { id: "b" }, { id: "c" }];
    },
    buildPrompt() {
      throw new Error("dry-run must not create child sessions");
    },
    parseResponse() {
      throw new Error("dry-run must not parse child responses");
    },
    async applyResults(results) {
      await applyResults?.(results);
    },
    getJobId(job) {
      return job.id;
    },
  };
}

test("dry-run creates state with deterministic batch count and no model call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-workflow-test-"));
  try {
    const state = await runWorkflow({} as ExtensionAPI, testContext(cwd), demoSpec(), [], { dryRun: true });
    assert.equal(state.status, "completed");
    assert.equal(state.totalBatches, 2);
    assert.equal(state.completedBatches, 0);
    assert.equal(state.failedBatches, 0);

    const persisted = await readRunState(cwd, state.runId);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.totalBatches, 2);
    await assert.rejects(readFile(join(cwd, ".pi", "workflow-runs", ".locks", "runner-test.lock")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow lock prevents a second run unless force is requested", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-workflow-lock-test-"));
  try {
    const lockDir = join(cwd, ".pi", "workflow-runs", ".locks", "runner-test.lock");
    await mkdir(lockDir, { recursive: true });
    await assert.rejects(
      runWorkflow({} as ExtensionAPI, testContext(cwd), demoSpec(), [], { dryRun: true }),
      /Workflow lock exists/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("readRunEvents returns the latest valid JSONL events", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-workflow-events-test-"));
  try {
    const dir = join(cwd, ".pi", "workflow-runs", "run-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), '{"type":"old"}\n{"type":"latest","jobId":"batch-001"}\npartial', "utf8");
    const events = await readRunEvents(cwd, "run-1", 1);
    assert.deepEqual(events, [{ type: "latest", jobId: "batch-001" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dry-run does not apply results", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-workflow-apply-test-"));
  let applied = false;
  try {
    await runWorkflow(
      {} as ExtensionAPI,
      testContext(cwd),
      demoSpec(async () => { applied = true; }),
      [],
      { dryRun: true },
    );
    assert.equal(applied, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
