# Changelog

## 0.2.0

- New `run_failure` kind: failed and timed-out agent runs, grouped per normalised error signature and fixed window across agents (`runFailures.windowMinutes`, default 30). Each group is announced once and carries `count`, the agents involved (`agentIds`), first and last run IDs and times, the card identifier, `errorCode` when known, and a redacted error excerpt of at most 200 characters. At most 5 groups per company per window; further distinct failures share one overflow item. Cancelled runs are never announced.
- Sources: the `agent.run.failed` plugin event, plus a reconciliation in the scan job (every 5 minutes, cursor-based) that reads the runs of open agent-assigned cards, so a dropped event is still caught. Run IDs dedupe the two.
- Catch-up replays run failure groups from the last 24 hours alongside pending decisions.
- New config `runFailures.enabled` (default `true`) and `runFailures.windowMinutes`. New capability `issues.orchestration.read`.
- `paperclip-decision-wait` accepts and prints `run_failure` items, keeping only their documented fields. The existing kinds and their event shape are unchanged.

## 0.1.2

- `paperclip-decision-wait` reads the stream with `node:http` instead of `fetch`, so an idle stream no longer dies after 300 s. Only the wait for response headers and for the first frame keeps the `PAPERCLIP_DECISION_WAIT_TIMEOUT_MS` deadline; TCP keepalive catches a dead peer. The stream request no longer follows redirects.
- Stream read errors and bad URLs exit 1 with one `decision-wait: stream failed: …` line instead of a stack trace.
- Catch-up calls for a company within 10 s of its last catch-up scan, with unchanged config and issue prefix, replay the stored pending set instead of rescanning.

## 0.1.1

- `paperclip-decision-wait` falls back to polling the catch-up route every 30 s when the stream answers HTTP 501 (stock Paperclip 2026.1023.0 does not wire the plugin stream bus). Stream mode is unchanged on hosts that do.

## 0.1.0

- First release. Approval, thread-interaction and owner-card decisions on the `decisions` plugin stream, IDs and URLs only.
- `POST /api/plugins/togetherweown.decision-notifier/api/catch-up` replays everything pending onto the stream.
- `paperclip-decision-wait` client that blocks until an unseen decision arrives.
