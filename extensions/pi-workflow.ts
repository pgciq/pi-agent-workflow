import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activeRuns, readRunState, runWorkflow } from "../src/runner.ts";
import type { WorkflowArgs, WorkflowRunOptions, WorkflowSpec } from "../src/types.ts";

type ParsedCommand = {
  specPath: string;
  args: string[];
  options: WorkflowRunOptions;
};

function parseCommand(raw: string): ParsedCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const specPath = tokens.shift() || "";
  const args: string[] = [];
  const options: WorkflowRunOptions = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--concurrency" && tokens[i + 1]) options.concurrency = Number(tokens[++i]) || undefined;
    else if (token === "--retries" && tokens[i + 1]) options.retries = Number(tokens[++i]) || undefined;
    else if (token === "--batch-size" && tokens[i + 1]) options.batchSize = Number(tokens[++i]) || undefined;
    else args.push(token);
  }
  return { specPath, args, options };
}

async function loadSpec(cwd: string, specPath: string): Promise<WorkflowSpec<any, any>> {
  if (!specPath) throw new Error("缺少 workflow spec 路径，例如 .pi/workflows/example.ts");
  const absolute = resolve(cwd, specPath);
  const module = await import(pathToFileURL(absolute).href) as {
    default?: WorkflowSpec<any, any>;
    workflow?: WorkflowSpec<any, any>;
  };
  const spec = module.default || module.workflow;
  if (!spec || typeof spec.loadJobs !== "function" || typeof spec.buildPrompt !== "function" || typeof spec.parseResponse !== "function" || typeof spec.applyResults !== "function") {
    throw new Error(`workflow spec 无效：${specPath}`);
  }
  return spec;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(text, level);
}

async function runFromCommand(raw: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const parsed = parseCommand(raw);
  const spec = await loadSpec(ctx.cwd, parsed.specPath);
  ctx.ui.setStatus("pi-workflow", `starting ${spec.name}...`);
  const state = await runWorkflow(pi, ctx, spec, parsed.args, parsed.options);
  const message = `${state.workflow}: ${state.status}, completed=${state.completedBatches}/${state.totalBatches}, failed=${state.failedBatches}`;
  notify(ctx, message, state.status === "completed" ? "info" : "warning");
}

export default function piWorkflow(pi: ExtensionAPI) {
  pi.registerCommand("workflow-run", {
    description: "Run a project WorkflowSpec with concurrent child AgentSessions: /workflow-run .pi/workflows/example.ts args",
    handler: async (args, ctx) => runFromCommand(args, ctx, pi),
  });

  pi.registerCommand("workflow-status", {
    description: "Show workflow run status, optionally /workflow-status <runId>",
    handler: async (args, ctx) => {
      const root = resolve(ctx.cwd, ".pi/workflow-runs");
      const runId = args.trim();
      try {
        if (runId) {
          const state = await readRunState(ctx.cwd, runId);
          ctx.ui.setWidget("pi-workflow-status", [
            `${state.runId}: ${state.status}`,
            `${state.completedBatches}/${state.totalBatches} completed, failed=${state.failedBatches}`,
            ...state.jobs.map((job) => `${job.status === "completed" ? "✓" : job.status === "failed" ? "✗" : "○"} ${job.jobId} ${job.status} attempt=${job.attempt} ${job.error || ""}`),
          ]);
          return;
        }
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        const runs = [] as string[];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try {
            const state = await readRunState(ctx.cwd, entry.name);
            runs.push(`${state.status.padEnd(10)} ${state.runId} ${state.completedBatches}/${state.totalBatches} failed=${state.failedBatches}`);
          } catch {
            // Ignore incomplete run directories.
          }
        }
        ctx.ui.setWidget("pi-workflow-status", runs.length ? runs.slice(-20) : ["No workflow runs found."]);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("workflow-cancel", {
    description: "Cancel an active workflow: /workflow-cancel <runId>",
    handler: async (args, ctx) => {
      const runId = args.trim();
      const controller = activeRuns.get(runId);
      if (!controller) {
        notify(ctx, `No active workflow found: ${runId || "(missing runId)"}`, "warning");
        return;
      }
      controller.abort();
      notify(ctx, `Cancellation requested: ${runId}`, "info");
    },
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Run Workflow",
    description: "Run a project WorkflowSpec with concurrent child AgentSessions.",
    parameters: Type.Object({
      spec: Type.String({ description: "WorkflowSpec path relative to cwd, e.g. .pi/workflows/example.ts" }),
      args: Type.Optional(Type.Array(Type.String())),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      batchSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const spec = await loadSpec(ctx.cwd, params.spec);
      const options: WorkflowRunOptions = {
        concurrency: params.concurrency,
        retries: params.retries,
        batchSize: params.batchSize,
        dryRun: params.dryRun,
      };
      const state = await runWorkflow(pi, ctx, spec, (params.args || []) as WorkflowArgs, options);
      onUpdate?.({ content: [{ type: "text", text: `${state.workflow}: ${state.status}` }] });
      return {
        content: [{ type: "text", text: `${state.workflow}: ${state.status}, completed=${state.completedBatches}/${state.totalBatches}, failed=${state.failedBatches}` }],
        details: state,
      };
    },
  });
}
