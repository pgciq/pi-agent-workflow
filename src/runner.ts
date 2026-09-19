import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowArgs, WorkflowJobState, WorkflowRunOptions, WorkflowRunState, WorkflowSpec } from "./types.ts";

const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 180_000;

export const activeRuns = new Map<string, AbortController>();

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function runDirectory(ctx: ExtensionContext, runId: string): string {
  return resolve(ctx.cwd, ".pi/workflow-runs", runId);
}

async function saveState(ctx: ExtensionContext, state: WorkflowRunState): Promise<void> {
  const dir = runDirectory(ctx, state.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

async function logEvent(ctx: ExtensionContext, state: WorkflowRunState, event: Record<string, unknown>): Promise<void> {
  const dir = runDirectory(ctx, state.runId);
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ timestamp: now(), runId: state.runId, ...event })}\n`,
    "utf8",
  );
}

function render(ctx: ExtensionContext, state: WorkflowRunState): void {
  const running = state.jobs.filter((job) => job.status === "running" || job.status === "retrying").length;
  const queued = state.jobs.filter((job) => job.status === "queued").length;
  const summary = `${state.workflow} ${state.completedBatches}/${state.totalBatches} done | running ${running} | queued ${queued} | failed ${state.failedBatches}`;
  ctx.ui.setStatus("pi-workflow", summary);

  if (!ctx.hasUI) return;
  const lines = [
    `Workflow ${state.runId}`,
    `${state.status} | ${state.completedBatches}/${state.totalBatches} completed | failed ${state.failedBatches}`,
    "",
  ];
  for (const job of state.jobs.slice(0, 20)) {
    const marker = job.status === "completed" ? "✓" : job.status === "failed" ? "✗" : job.status === "running" ? "▶" : job.status === "retrying" ? "↻" : "○";
    const elapsed = job.elapsedMs === undefined ? "" : ` ${Math.round(job.elapsedMs / 100) / 10}s`;
    const detail = job.error || job.lastEvent || "";
    lines.push(`${marker} ${job.jobId} [${job.status}] attempt=${job.attempt}${elapsed} ${detail}`.trimEnd());
  }
  if (state.jobs.length > 20) lines.push(`... ${state.jobs.length - 20} more batches; see .pi/workflow-runs/${state.runId}/state.json`);
  ctx.ui.setWidget("pi-workflow", lines);
}

function assistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => String((part as { text?: unknown }).text || ""))
        .join("\n");
    }
  }
  throw new Error("child AgentSession returned no assistant text");
}

async function runBatch<TJob, TResult>(
  ctx: ExtensionContext,
  runtime: ModelRuntime,
  spec: WorkflowSpec<TJob, TResult>,
  batch: TJob[],
  args: WorkflowArgs,
  state: WorkflowRunState,
  jobState: WorkflowJobState,
  signal: AbortSignal,
): Promise<TResult[]> {
  const model = ctx.model || (await runtime.getAvailable())[0];
  if (!model) throw new Error("No available model. Configure /login or /model first.");

  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a child agent in a workflow. Follow the workflow prompt exactly and return only the requested structured result.",
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    tools: [],
  });
  const session = created.session;

  const unsubscribe = session.subscribe((event) => {
    const eventType = (event as { type?: string }).type || "unknown";
    jobState.lastEvent = eventType;
    if (eventType === "message_update") {
      const update = event as { assistantMessageEvent?: { type?: string; delta?: string } };
      if (update.assistantMessageEvent?.type === "text_delta") {
        jobState.preview = `${jobState.preview || ""}${update.assistantMessageEvent.delta || ""}`.slice(-200);
      }
    }
    void logEvent(ctx, state, { jobId: jobState.jobId, type: eventType });
    render(ctx, state);
  });

  try {
    const timer = setTimeout(() => { void session.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      await session.prompt(spec.buildPrompt(batch, args));
    } finally {
      clearTimeout(timer);
    }
    if (signal.aborted) throw new Error("workflow cancelled");
    return spec.parseResponse(assistantText(session.messages), batch);
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function runWorkflow<TJob, TResult>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: WorkflowSpec<TJob, TResult>,
  args: WorkflowArgs,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunState> {
  const controller = new AbortController();
  const runId = `${spec.name}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  activeRuns.set(runId, controller);

  const jobs = await spec.loadJobs(ctx, args);
  const batchSize = Math.max(1, options.batchSize ?? spec.batchSize ?? DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? spec.concurrency ?? DEFAULT_CONCURRENCY));
  const retries = Math.max(0, Math.min(10, options.retries ?? spec.retries ?? DEFAULT_RETRIES));
  const batches: TJob[][] = [];
  for (let i = 0; i < jobs.length; i += batchSize) batches.push(jobs.slice(i, i + batchSize));

  const state: WorkflowRunState = {
    runId,
    workflow: spec.name,
    args,
    status: "running",
    startedAt: now(),
    totalBatches: batches.length,
    completedBatches: 0,
    failedBatches: 0,
    jobs: batches.map((batch, index) => ({
      jobId: `batch-${String(index + 1).padStart(3, "0")}`,
      batchIndex: index,
      status: "queued",
      attempt: 0,
      questionCount: batch.length,
    })),
  };
  await saveState(ctx, state);
  render(ctx, state);

  if (options.dryRun) {
    state.status = "completed";
    state.finishedAt = now();
    await saveState(ctx, state);
    activeRuns.delete(runId);
    return state;
  }

  const runtime = await ModelRuntime.create();
  const results: TResult[] = [];
  let next = 0;

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= batches.length) return;
      const batch = batches[index];
      const jobState = state.jobs[index];
      const batchJobIds = batch.map((job) => spec.getJobId?.(job) || "job");
      let lastError = "";

      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        if (controller.signal.aborted) throw new Error("workflow cancelled");
        jobState.attempt = attempt;
        jobState.status = attempt === 1 ? "running" : "retrying";
        jobState.startedAt ||= now();
        jobState.lastEvent = `jobs: ${batchJobIds.slice(0, 3).join(", ")}${batchJobIds.length > 3 ? "..." : ""}`;
        await saveState(ctx, state);
        render(ctx, state);
        await logEvent(ctx, state, { jobId: jobState.jobId, type: "batch_start", attempt });

        try {
          const parsed = await runBatch(ctx, runtime, spec, batch, args, state, jobState, controller.signal);
          results.push(...parsed);
          jobState.status = "completed";
          jobState.finishedAt = now();
          jobState.elapsedMs = Date.parse(jobState.finishedAt) - Date.parse(jobState.startedAt!);
          state.completedBatches += 1;
          await logEvent(ctx, state, { jobId: jobState.jobId, type: "batch_completed", attempt, resultCount: parsed.length });
          break;
        } catch (error) {
          lastError = asError(error);
          jobState.error = lastError;
          await logEvent(ctx, state, { jobId: jobState.jobId, type: "batch_error", attempt, error: lastError });
          if (attempt <= retries) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * attempt));
        }
      }

      if (jobState.status !== "completed") {
        jobState.status = controller.signal.aborted ? "failed" : "failed";
        jobState.finishedAt = now();
        jobState.elapsedMs = Date.parse(jobState.finishedAt) - Date.parse(jobState.startedAt!);
        jobState.error = lastError || "batch failed";
        state.failedBatches += 1;
      }
      await saveState(ctx, state);
      render(ctx, state);
    }
  });

  try {
    await Promise.all(workers);
    if (controller.signal.aborted) {
      state.status = "cancelled";
    } else if (state.failedBatches > 0) {
      state.status = "failed";
    } else {
      await spec.applyResults(results, ctx, args);
      state.status = "completed";
    }
  } catch (error) {
    state.status = controller.signal.aborted ? "cancelled" : "failed";
    await logEvent(ctx, state, { type: "run_error", error: asError(error) });
    throw error;
  } finally {
    state.finishedAt = now();
    await saveState(ctx, state);
    render(ctx, state);
    activeRuns.delete(runId);
    await logEvent(ctx, state, { type: "run_finished", status: state.status });
  }

  return state;
}

export async function readRunState(cwd: string, runId: string): Promise<WorkflowRunState> {
  return JSON.parse(await readFile(join(resolve(cwd, ".pi/workflow-runs", runId), "state.json"), "utf8")) as WorkflowRunState;
}
