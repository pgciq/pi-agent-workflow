# Changelog

## 0.2.1

- Use Node 24 and the current npm Trusted Publishing workflow.
- Disable package-manager caching in release builds.

## 0.2.0

- Add per-workflow lock files.
- Persist successful batch results to `results.jsonl`.
- Add resume support with `--resume <runId>`.
- Abort active child AgentSessions during cancellation.
- Add optional global timeout with `--timeout`.
- Add exponential retry backoff with jitter.
- Add `/workflow-retry <runId> <batchId>`.
- Add `/workflow-events <runId> [limit]`.
- Add optional persisted child sessions with `--persist-sessions`.
- Add opt-in real child AgentSession integration test (`PI_WORKFLOW_INTEGRATION=1`).
- Add basic Runner tests and `npm run check`.
- Improve live batch status rendering.

## 0.1.0

- Initial reusable Pi workflow runner.
- Concurrent child AgentSessions.
- Retry, dry-run, status widget, and JSONL event logging.
