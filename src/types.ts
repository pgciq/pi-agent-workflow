import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type WorkflowArgs = string[];

export type WorkflowSpec<TJob = unknown, TResult = unknown> = {
  /** Stable workflow name used in run IDs and status output. */
  name: string;
  description?: string;
  /** Number of jobs sent to one child AgentSession. */
  batchSize?: number;
  /** Default child-session concurrency. */
  concurrency?: number;
  /** Default retry count per batch. */
  retries?: number;
  /** Load all work items for this invocation. */
  loadJobs(ctx: ExtensionContext, args: WorkflowArgs): Promise<TJob[]>;
  /** Build the user prompt for one child AgentSession. */
  buildPrompt(batch: TJob[], args: WorkflowArgs): string;
  /** Convert the final assistant text into validated results. */
  parseResponse(text: string, batch: TJob[]): TResult[];
  /** Apply validated results after all child sessions finish. */
  applyResults(results: TResult[], ctx: ExtensionContext, args: WorkflowArgs): Promise<void>;
  /** Human-readable job ID for the monitor. */
  getJobId?(job: TJob): string;
};

export type WorkflowRunOptions = {
  concurrency?: number;
  retries?: number;
  batchSize?: number;
  dryRun?: boolean;
};

export type WorkflowJobState = {
  jobId: string;
  batchIndex: number;
  status: "queued" | "running" | "retrying" | "completed" | "failed";
  attempt: number;
  questionCount: number;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  lastEvent?: string;
  preview?: string;
  error?: string;
};

export type WorkflowRunState = {
  runId: string;
  workflow: string;
  args: string[];
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  jobs: WorkflowJobState[];
};
