import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowArgs, WorkflowJobState, WorkflowRunOptions, WorkflowRunState, WorkflowSpec } from "./types.ts";

const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 180_000;

export type ActiveWorkflow = {
  runId: string;
  controller: AbortController;
  sessions: Set<AgentSession>;
  persistSessions: boolean;
  logQueue: Promise<void>;
  stateQueue: Promise<void>;
};

export const activeRuns = new Map<string, ActiveWorkflow>();

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "workflow";
}

function runRoot(ctx: ExtensionContext): string {
  return resolve(ctx.cwd, ".pi/workflow-runs");
}

function runDirectory(ctx: ExtensionContext, runId: string): string {
  return join(runRoot(ctx), runId);
}

async function saveState(ctx: ExtensionContext, state: WorkflowRunState): Promise<void> {
  const dir = runDirectory(ctx, state.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

function enqueueState(ctx: ExtensionContext, active: ActiveWorkflow, state: WorkflowRunState): Promise<void> {
  active.stateQueue = active.stateQueue.then(() => saveState(ctx, state));
  return active.stateQueue;
}

async function appendEvent(ctx: ExtensionContext, state: WorkflowRunState, event: Record<string, unknown>): Promise<void> {
  const dir = runDirectory(ctx, state.runId);
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ timestamp: now(), runId: state.runId, ...event })}\n`,
    "utf8",
  );
}

function enqueueEvent(ctx: ExtensionContext, active: ActiveWorkflow, state: WorkflowRunState, event: Record<string, unknown>): Promise<void> {
  active.logQueue = active.logQueue.then(() => appendEvent(ctx, state, event));
  return active.logQueue;
}

function render(ctx: ExtensionContext, state: WorkflowRunState): void {
  const running = state.jobs.filter((job) => job.status === "running" || job.status === "retrying").length;
  const queued = state.jobs.filter((job) => job.status === "queued").length;
  const summary = `${state.workflow} ${state.completedBatches}/${state.totalBatches} done | running ${running} | queued ${queued} | failed ${state.failedBatches}`;
  ctx.ui.setStatus("pi-workflow", summary);
  if (!ctx.hasUI) return;

  const priority = (job: WorkflowJobState): number => {
    if (job.status === "running" || job.status === "retrying") return 0;
    if (job.status === "queued") return 2;
    return 1;
  };
  const jobs = [...state.jobs].sort((a, b) => priority(a) - priority(b) || a.batchIndex - b.batchIndex);
  const lines = [
    `Workflow ${state.runId}`,
    `${state.status} | ${state.completedBatches}/${state.totalBatches} completed | failed ${state.failedBatches}`,
    "",
  ];
  for (const job of jobs.slice(0, 20)) {
    const marker = job.status === "completed" ? "✓" : job.status === "failed" ? "✗" : job.status === "cancelled" ? "⊘" : job.status === "running" ? "▶" : job.status === "retrying" ? "↻" : "○";
    const elapsed = job.elapsedMs === undefined ? "" : ` ${Math.round(job.elapsedMs / 100) / 10}s`;
    const detail = job.error || job.lastEvent || "";
    const resultCount = job.resultCount === undefined ? "" : ` results=${job.resultCount}`;
    lines.push(`${marker} ${job.jobId} [${job.status}] attempt=${job.attempt}${resultCount}${elapsed} ${detail}`.trimEnd());
  }
  if (jobs.length > 20) lines.push(`... ${jobs.length - 20} more batches; see .pi/workflow-runs/${state.runId}/state.json`);
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

async function acquireLock(ctx: ExtensionContext, workflowName: string, runId: string, force = false): Promise<() => Promise<void>> {
  const lockPath = join(runRoot(ctx), ".locks", `${safeName(workflowName)}.lock`);
  await mkdir(join(runRoot(ctx), ".locks"), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!force) {
      let details = "another run is active";
      try { details = await readFile(join(lockPath, "lock.json"), "utf8"); } catch { /* stale or unreadable lock */ }
      throw new Error(`Workflow lock exists for ${workflowName}: ${details}`);
    }
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
  }
  await writeFile(join(lockPath, "lock.json"), JSON.stringify({ workflow: workflowName, runId, pid: process.pid, startedAt: now() }, null, 2), "utf8");
  return async () => { await rm(lockPath, { recursive: true, force: true }); };
}

async function readPersistedResults<TResult>(runDir: string): Promise<Map<number, TResult[]>> {
  const results = new Map<number, TResult[]>();
  try {
    const text = await readFile(join(runDir, "results.jsonl"), "utf8");
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const item = JSON.parse(line) as { batchIndex?: number; results?: TResult[] };
      if (typeof item.batchIndex === "number" && Array.isArray(item.results)) results.set(item.batchIndex, item.results);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return results;
}

async function writeInitialResults<TResult>(runDir: string, records: Map<number, TResult[]>): Promise<void> {
  if (records.size === 0) return;
  await mkdir(runDir, { recursive: true });
  const text = [...records.entries()]
    .sort(([a], [b]) => a - b)
    .map(([batchIndex, results]) => JSON.stringify({ batchIndex, results }))
    .join("\n") + "\n";
  await writeFile(join(runDir, "results.jsonl"), text, "utf8");
}

async function appendResults<TResult>(runDir: string, batchIndex: number, results: TResult[]): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await appendFile(join(runDir, "results.jsonl"), `${JSON.stringify({ batchIndex, results })}\n`, "utf8");
}

export async function cancelWorkflow(runId: string): Promise<boolean> {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.controller.abort();
  await Promise.allSettled([...active.sessions].map((session) => session.abort()));
  return true;
}

async function runBatch<TJob, TResult>(
  ctx: ExtensionContext,
  active: ActiveWorkflow,
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

  const sessionDir = join(runDirectory(ctx, active.runId), "sessions");
  const sessionManager = active.persistSessions
    ? (await mkdir(sessionDir, { recursive: true }), SessionManager.create(ctx.cwd, sessionDir, { id: `${jobState.jobId}-attempt-${jobState.attempt}` }))
    : SessionManager.inMemory(ctx.cwd);
  const created = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager,
    tools: [],
  });
  const session = created.session;
  jobState.childSessionFile = sessionManager.getSessionFile();
  active.sessions.add(session);

  const unsubscribe = session.subscribe((event) => {
    const eventType = (event as { type?: string }).type || "unknown";
    jobState.lastEvent = eventType;
    if (eventType === "message_update") {
      const update = event as { assistantMessageEvent?: { type?: string; delta?: string } };
      if (update.assistantMessageEvent?.type === "text_delta") {
        jobState.preview = `${jobState.preview || ""}${update.assistantMessageEvent.delta || ""}`.slice(-200);
      }
    }
    void enqueueEvent(ctx, active, state, { jobId: jobState.jobId, type: eventType });
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
    active.sessions.delete(session);
    session.dispose();
  }
}

export async function runWorkflow<TJob, TResult>(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: WorkflowSpec<TJob, TResult>,
  args: WorkflowArgs,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunState> {
  const runId = `${safeName(spec.name)}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const active: ActiveWorkflow = {
    runId,
    controller: new AbortController(),
    sessions: new Set(),
    persistSessions: options.persistSessions === true,
    logQueue: Promise.resolve(),
    stateQueue: Promise.resolve(),
  };
  const releaseLock = await acquireLock(ctx, spec.name, runId, options.force);
  activeRuns.set(runId, active);
  let globalTimer: ReturnType<typeof setTimeout> | undefined;
  // The state is assigned after the lock and job loading steps. The assertion lets the
  // cleanup path handle failures that happen before state creation.
  let state = undefined as unknown as WorkflowRunState;

  try {
    const jobs = await spec.loadJobs(ctx, args);
    const previousState = options.resumeRunId ? await readRunState(ctx.cwd, options.resumeRunId) : undefined;
    const batchSize = Math.max(1, options.batchSize ?? spec.batchSize ?? DEFAULT_BATCH_SIZE);
    const concurrency = Math.max(1, Math.min(16, options.concurrency ?? spec.concurrency ?? DEFAULT_CONCURRENCY));
    const retries = Math.max(0, Math.min(10, options.retries ?? spec.retries ?? DEFAULT_RETRIES));
    const batches: TJob[][] = [];
    for (let i = 0; i < jobs.length; i += batchSize) batches.push(jobs.slice(i, i + batchSize));

    state = {
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
      specPath: options.specPath,
      persistSessions: options.persistSessions === true,
    };

    const resultRecords: Map<number, TResult[]> = options.resumeRunId
      ? await readPersistedResults<TResult>(runDirectory(ctx, options.resumeRunId))
      : new Map<number, TResult[]>();
    if (options.resumeRunId) state.resumedFrom = options.resumeRunId;
    await writeInitialResults(runDirectory(ctx, runId), resultRecords);
    const results: TResult[] = [...resultRecords.values()].flatMap((items) => items);
    for (const [batchIndex, batchResults] of resultRecords) {
      const job = state.jobs[batchIndex];
      if (!job) continue;
      job.status = "completed";
      job.attempt = 0;
      job.resultCount = batchResults.length;
      job.lastEvent = `resumed from ${options.resumeRunId}`;
      state.completedBatches += 1;
    }

    if (options.onlyBatches && options.onlyBatches.length > 0) {
      const selected = new Set(options.onlyBatches);
      for (let index = 0; index < state.jobs.length; index += 1) {
        if (resultRecords.has(index) || selected.has(index)) continue;
        const job = state.jobs[index];
        const previousJob = previousState?.jobs[index];
        job.status = previousJob?.status === "cancelled" ? "cancelled" : "failed";
        job.error = "not selected by single-batch retry";
        state.failedBatches += 1;
      }
    }

    await enqueueState(ctx, active, state);
    render(ctx, state);
    if (options.dryRun) {
      state.status = "completed";
      state.finishedAt = now();
      await enqueueState(ctx, active, state);
      return state;
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      globalTimer = setTimeout(() => { void cancelWorkflow(runId); }, options.timeoutMs);
    }

    const runtime = await ModelRuntime.create();
    const selectedBatches = options.onlyBatches ? new Set(options.onlyBatches) : undefined;
    const pending = batches
      .map((_, index) => index)
      .filter((index) => !resultRecords.has(index) && (!selectedBatches || selectedBatches.has(index)));
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, async () => {
      while (true) {
        const pendingIndex = next++;
        if (pendingIndex >= pending.length) return;
        const index = pending[pendingIndex];
        const batch = batches[index];
        const jobState = state.jobs[index];
        const batchJobIds = batch.map((job) => spec.getJobId?.(job) || "job");
        let lastError = "";

        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          if (active.controller.signal.aborted) {
            jobState.status = "cancelled";
            jobState.error = "workflow cancelled";
            break;
          }
          jobState.attempt = attempt;
          jobState.status = attempt === 1 ? "running" : "retrying";
          jobState.startedAt ||= now();
          jobState.lastEvent = `jobs: ${batchJobIds.slice(0, 3).join(", ")}${batchJobIds.length > 3 ? "..." : ""}`;
          await enqueueState(ctx, active, state);
          render(ctx, state);
          await enqueueEvent(ctx, active, state, { jobId: jobState.jobId, type: "batch_start", attempt });

          try {
            const parsed = await runBatch(ctx, active, runtime, spec, batch, args, state, jobState, active.controller.signal);
            await appendResults(runDirectory(ctx, runId), index, parsed);
            results.push(...parsed);
            jobState.status = "completed";
            jobState.resultCount = parsed.length;
            jobState.finishedAt = now();
            jobState.elapsedMs = Date.parse(jobState.finishedAt) - Date.parse(jobState.startedAt!);
            state.completedBatches += 1;
            await enqueueEvent(ctx, active, state, { jobId: jobState.jobId, type: "batch_completed", attempt, resultCount: parsed.length });
            break;
          } catch (error) {
            lastError = asError(error);
            jobState.error = lastError;
            await enqueueEvent(ctx, active, state, { jobId: jobState.jobId, type: "batch_error", attempt, error: lastError });
            if (active.controller.signal.aborted) {
              jobState.status = "cancelled";
              break;
            }
            if (attempt <= retries) {
              const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
            }
          }
        }

        if (jobState.status !== "completed" && jobState.status !== "cancelled") {
          jobState.status = "failed";
          jobState.finishedAt = now();
          jobState.elapsedMs = Date.parse(jobState.finishedAt) - Date.parse(jobState.startedAt!);
          jobState.error = lastError || "batch failed";
          state.failedBatches += 1;
        }
        await enqueueState(ctx, active, state);
        render(ctx, state);
      }
    });

    await Promise.all(workers);
    if (active.controller.signal.aborted) {
      for (const job of state.jobs) {
        if (job.status === "queued" || job.status === "running" || job.status === "retrying") {
          job.status = "cancelled";
          job.error ||= "workflow cancelled";
        }
      }
      state.status = "cancelled";
    } else if (state.failedBatches > 0 || state.completedBatches < state.totalBatches) {
      state.status = "failed";
      if (state.completedBatches < state.totalBatches) {
        state.failedBatches = Math.max(state.failedBatches, state.totalBatches - state.completedBatches);
      }
    } else {
      await spec.applyResults(results, ctx, args);
      state.status = "completed";
    }
    state.finishedAt = now();
    await enqueueState(ctx, active, state);
    return state;
  } catch (error) {
    const wasCancelled = active.controller.signal.aborted;
    active.controller.abort();
    if (state) {
      state.status = wasCancelled ? "cancelled" : "failed";
      state.finishedAt = now();
      await enqueueState(ctx, active, state);
    }
    await Promise.allSettled([...active.sessions].map((session) => session.abort()));
    throw error;
  } finally {
    if (globalTimer) clearTimeout(globalTimer);
    active.controller.abort();
    await Promise.allSettled([...active.sessions].map((session) => session.abort()));
    if (state && !state.finishedAt) {
      state.finishedAt = now();
      await enqueueState(ctx, active, state).catch(() => undefined);
    }
    await active.logQueue.catch(() => undefined);
    await active.stateQueue.catch(() => undefined);
    activeRuns.delete(runId);
    await releaseLock();
  }
}

export async function readRunState(cwd: string, runId: string): Promise<WorkflowRunState> {
  return JSON.parse(await readFile(join(resolve(cwd, ".pi/workflow-runs", runId), "state.json"), "utf8")) as WorkflowRunState;
}

export async function readRunEvents(cwd: string, runId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(resolve(cwd, ".pi/workflow-runs", runId), "events.jsonl"), "utf8");
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
    } catch {
      // Ignore a partially written final line.
    }
  }
  return events.slice(-Math.max(1, limit));
}
