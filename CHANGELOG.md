# Changelog

## 0.2.0

- Add per-workflow lock files.
- Persist successful batch results to `results.jsonl`.
- Add resume support with `--resume <runId>`.
- Abort active child AgentSessions during cancellation.
- Add optional global timeout with `--timeout`.
- Add exponential retry backoff with jitter.
- Add `/workflow-retry <runId> <batchId>`.
- Add basic Runner tests and `npm run check`.
- Improve live batch status rendering.

## 0.1.0

- Initial reusable Pi workflow runner.
- Concurrent child AgentSessions.
- Retry, dry-run, status widget, and JSONL event logging.
