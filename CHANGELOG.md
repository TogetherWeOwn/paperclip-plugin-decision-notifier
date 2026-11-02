# Changelog

## Unreleased

(nothing yet)

## 0.3.3

- Fixed the `decision-scan` job still making the host log a "host handler error" every minute after 0.3.2 on hosts that deny its calls. 0.3.2 made the event-driven scan do the periodic work and quieted the plugin's own logging to one warning per company, but the job kept *attempting* the denied per-company calls (and the wildcard `companies.list` refresh), and the host logs an error for each denied call the plugin makes. The scopes a scopeless job may act under are fixed when the worker loads, so a per-company scope denial cannot clear mid-session: the job now latches a company's denial for the session and makes no further calls for it, while event-driven scans are unaffected and a worker restart re-probes. The company-list refresh keeps its retry cadence while the job can scan at least one known company (a wildcard denial is transient), and is skipped only once every known company is latched — discovering more companies cannot give the job anything it may scan, and new companies are learned from events either way.

## 0.3.2

- Fixed the periodic scan still not running after 0.3.1 on hosts that gate worker calls by invocation scope. 0.3.1 removed the scan's dependence on the wildcard `companies.list`, but a scopeless job's per-company calls are admitted only for companies the host has authorized for proactive work — a set the host seeds from per-company plugin config. This plugin's config is instance-scoped, so that set can be empty, and then every per-company call from the job is denied ("missing, expired, or unknown invocation scope") while any event invocation is active; the job merely *looked* successful because per-company failures are caught. The scan now also runs from inside company-scoped event invocations, throttled to once a minute per company, where all of its calls are admitted. The job remains as a fallback for hosts that authorize it, logs one warning per company when the host denies it instead of an error every minute, and every completed scan logs `decision scan completed` with its source (`job` or `event`) and pending count. Event, catch-up and stream behavior is otherwise unchanged.

## 0.3.1

- Fixed the `decision-scan` job failing with "the worker referenced a missing, expired, or unknown invocation scope" on hosts that gate worker calls by invocation scope. A scheduled job runs scopeless, and the scan's first call, `companies.list`, is a wildcard call such hosts never grant to a scopeless caller while any scoped invocation (for example, an event delivery, whose scope outlives its handler) is still active — in a busy instance, effectively always. The scan now works from the companies the plugin has been invoked for (events, the catch-up route, and a new `company.created` subscription), persisted in instance-scoped state, and re-reads the full company list only as a refresh at most every 15 minutes, falling back to the remembered set when the list call is denied. Event, catch-up and stream behavior is unchanged.

## 0.3.0

- Also ships the previously unreleased `run_failure` grouping fix: a group that started with no error text now adopts the error the reconciliation later recovers for the same run, instead of splitting the failure mode in two.
- Decision events carry advisory routing fields: `audience` (`owner`/`board`/`anyone`, derived from the interaction addressee and resolver policy; approvals are `board`, owner cards are `owner`), `interactionKind`, and the issue's `originKind`/`originId` passed through verbatim (`null` for approvals). `RunFailureEvent` is unchanged. No new manifest capabilities: the host already returns these fields under `issues.read` + `issue.interactions.read`.
- Stored pending entries from 0.2.0 normalize on the way out (missing `audience` becomes `board`, the fail-safe; the rest become `null`), so a catch-up replay in the first minute after upgrade emits the full shape without re-announcing anything (dedupe keys are still `kind:id`).
- `paperclip-decision-wait` accepts and prints the new fields (validating them, capping `originId` at 200 characters) and adds `--audience <csv>` and `--exclude-origin-kind <csv>` filters: with neither flag behavior is exactly as before; a filtered-out event is neither announced nor marked seen; pruning still compares the seen file against the unfiltered pending set; events with no audience always pass the audience filter; `run_failure` ignores it.
- README documents the consumer rules: audience is advisory (re-read before acting), `plugin:board-council` origin means hands off, `owner` audience means only that user resolves, and `anyone` interactions in board-decision categories are instruction-compliance failures the operator bounces with a comment instead of resolving.

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
